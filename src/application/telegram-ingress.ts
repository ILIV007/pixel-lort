/**
 * Telegram ingress pipeline (Phase 2A, corrected by ADR-0027, lifecycle
 * completed by ADR-0030/0031/0032) — the durable update lifecycle with
 * RETRYABLE/PERMANENT failure semantics and lease-based claim recovery.
 *
 * Orchestrates, for one verified and parsed Update:
 *   1. durable claim by update_id — SIX claim outcomes (ADR-0030/0031):
 *        claimed (new, lease set) | reclaimed_retryable (failed-retryable ->
 *        claimed) | reclaimed_stale (expired-lease -> claimed) — each won by
 *        exactly one concurrent caller | already_processed (terminal, ack) |
 *        permanently_failed (terminal, ack, never re-executed) | in_flight
 *        (an ACTIVE lease is held elsewhere). Duplicates of PROCESSED updates
 *        are acknowledged WITHOUT reprocessing; in-flight claims are NOT
 *        acknowledged as success (safe 503 semantics so Telegram keeps
 *        redelivering until the lease resolves); a FAILED row is atomically
 *        reclaimable when retryable, or terminal when permanent, so a
 *        temporary failure can never permanently lose an update and a
 *        permanent failure can never execute twice.
 *   2. routing of the claimed update (command/authorization contracts are
 *      wired by their owning slices) producing TYPED actions (send_message /
 *      denied / answer_callback / noop). An authorization DENIAL is a
 *      successfully handled action, never a processing failure.
 *   3. a stable terminal transition: processed, or failed with the persisted
 *      failure class. A transient internal failure therefore never ends up
 *      marked processed.
 *   4. FAILURE CLASSIFICATION (ADR-0031):
 *        - RETRYABLE failures (Telegram timeout/network/429/5xx, database
 *          and service-unavailability, unknown internal errors) mark the row
 *          `failed` with failure_class='retryable' (lease cleared) and
 *          PROPAGATE a safe AppError with HTTP 503 semantics — the webhook
 *          does NOT answer 200, so Telegram redelivers and the failed row is
 *          reclaimed (exactly one concurrent reclaim wins).
 *        - PERMANENT failures (Telegram 4xx client errors, configuration
 *          errors, deterministic internal rejections) mark the row `failed`
 *          with failure_class='permanent' (lease cleared) and are
 *          ACKNOWLEDGED with 200 — no infinite retry loop, and the persisted
 *          class makes the row TERMINAL: reclaim is impossible, every later
 *          delivery observes permanently_failed without executing.
 *        - If even the failure marking fails, the row stays `claimed` with a
 *          lease; the original 503 still propagates, and after lease expiry a
 *          later delivery reclaims the abandoned claim (reclaimed_stale,
 *          ADR-0030).
 *   5. MISSING OUTBOUND CLIENT: a noop action completes safely without a
 *      Bot API client (offline mode). An OUTBOUND action (send_message /
 *      denied / answer_callback) without a client is a retryable
 *      `service_unavailable` — never silently skipped-and-acked, so the
 *      absence of BOT_TOKEN can never falsely produce successful processing.
 *
 * DELIVERY GUARANTEE — HONEST WORDING (ADR-0032): this pipeline provides
 * DURABLE AT-LEAST-ONCE PROCESSING with duplicate suppression BEFORE
 * execution, plus BOUNDED DUPLICATE RISK for ambiguous external side
 * effects. Exactly-once DATABASE claim ownership does NOT imply exactly-once
 * TELEGRAM MESSAGE DELIVERY: if Telegram accepts a sendMessage but the Worker
 * loses the response or the processed transition fails, the next delivery may
 * send the same message again (Telegram's Bot API offers no
 * application-provided idempotency key). The durable claim makes every
 * EXECUTION DECISION a single winner; it cannot make an external side effect
 * retractable. Publishing-side duplicate mitigation and reconciliation are a
 * recorded roadmap requirement before autonomous channel publishing is
 * enabled.
 *
 * The claim happens FIRST and is durable in D1 — there is no in-memory-only
 * deduplication and KV is never the authority (ADR-0025). Concurrent
 * duplicate deliveries produce exactly one execution winner; losers see the
 * existing row's state.
 *
 * Logging discipline: only update_id (the idempotency key), stable event
 * names, status words, action types, and role names are logged. Telegram
 * payload fields (text, chat ids, user ids, callback data) never become
 * log fields.
 */
import type { DbExecutor } from '../adapters/db/db-executor';
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
  type TelegramUpdateFailureClass,
} from '../adapters/telegram/update-claims';
import { TelegramApiError } from '../adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../adapters/telegram/update-parser';
import type { ActorResolution, AuthorizationService } from '../admin/authorization';
import type { CommandRouter, TelegramAction } from '../admin/command-router';
import { isSafeTelegramHtml, type TelegramSafeHtml } from '../admin/telegram-html';
import type { TelegramBotApiClient } from '../adapters/telegram/bot-api-client';
import { AppError, toAppError, type AppErrorCode } from '../shared/errors/app-error';
import type { Clock } from '../shared/time/clock';
import type { Logger } from '../observability/logger';

export type TelegramUpdateOutcome = 'processed' | 'duplicate' | 'failed';

/** How a processing failure must be handled at the lifecycle boundary. */
export type ProcessingFailureClass = TelegramUpdateFailureClass;

/**
 * AppError codes that describe DETERMINISTIC conditions: retrying the same
 * delivery cannot succeed, so the update is marked failed (failure_class =
 * 'permanent' — TERMINAL, ADR-0031) and acknowledged (200) to avoid an
 * infinite redelivery loop.
 *
 * Everything else — database and service-availability codes, and any
 * UNKNOWN error shape — is classified RETRYABLE by default (fail-safe
 * toward redelivery): a transient outage must never permanently lose an
 * update. The cost of a wrong retryable guess is bounded (durable claims
 * prevent double execution decisions and Telegram's redelivery window is
 * finite); the cost of a wrong permanent guess is permanent update loss.
 */
const PERMANENT_APP_ERROR_CODES: ReadonlySet<AppErrorCode> = new Set([
  'bad_request',
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'config_invalid',
  // Deliberate deterministic rejections (e.g. a failed Telegram-safe HTML
  // gate) throw this code — retrying cannot change the outcome.
  'internal_error',
]);

/**
 * Classify a processing failure. A denied command is NOT a failure — the
 * router returns a typed `denied` action for it, which executes normally.
 */
export function classifyProcessingFailure(error: unknown): ProcessingFailureClass {
  if (error instanceof TelegramApiError) {
    // The Bot API client already carries the authoritative classification:
    // timeout/network/429/5xx retryable; 4xx and malformed responses permanent.
    return error.retryable ? 'retryable' : 'permanent';
  }
  if (error instanceof AppError) {
    return PERMANENT_APP_ERROR_CODES.has(error.code) ? 'permanent' : 'retryable';
  }
  // Unknown thrown values (driver errors not yet mapped, runtime faults)
  // default to retryable — bounded redelivery instead of permanent loss.
  return 'retryable';
}

export interface TelegramIngressDeps {
  readonly executor: DbExecutor;
  readonly authorization: AuthorizationService;
  readonly commandRouter: CommandRouter;
  /** Optional: absent (no BOT_TOKEN) means offline mode — noop actions
   *  complete; outbound actions fail as retryable service_unavailable. */
  readonly botApi?: TelegramBotApiClient;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface TelegramIngress {
  /**
   * Run the durable lifecycle for one parsed update.
   * Resolves with a terminal outcome (`processed` | `duplicate` | `failed`)
   * — or REJECTS with an AppError (HTTP 503 semantics) when processing
   * failed retryably OR when the update is still in-flight under an active
   * claim lease, so the caller never acknowledges a lost or ambiguous
   * update with a false success.
   */
  processUpdate(update: ParsedUpdate): Promise<TelegramUpdateOutcome>;
}

export function createTelegramIngress(deps: TelegramIngressDeps): TelegramIngress {
  const { executor, authorization, commandRouter, botApi, clock, logger } = deps;

  /**
   * An outbound action REQUIRES a client: without one the action is not
   * silently skipped — it fails retryably so the update is not falsely
   * marked processed (BOT_TOKEN absence never fakes success).
   */
  function requireBotApi(actionType: string): TelegramBotApiClient {
    if (botApi === undefined) {
      logger.warn('telegram.action.outbound_unavailable', { action: actionType });
      throw new AppError('service_unavailable');
    }
    return botApi;
  }

  async function sendSafely(
    chatId: number,
    text: TelegramSafeHtml,
    actionType: string,
  ): Promise<void> {
    const client = requireBotApi(actionType);
    // Defense-in-depth: only builder-composed text may reach the Bot API.
    if (!isSafeTelegramHtml(text)) {
      logger.error('telegram.action.html_rejected', { action: actionType });
      throw new AppError('internal_error');
    }
    await client.sendMessage({ chatId, text });
  }

  /** Execute a routed action against the injected Bot API client. */
  async function executeAction(action: TelegramAction): Promise<void> {
    switch (action.type) {
      case 'noop':
        return;
      case 'send_message':
        await sendSafely(action.chatId, action.text, 'send_message');
        return;
      case 'denied':
        await sendSafely(action.chatId, action.text, 'denied');
        return;
      case 'answer_callback':
        await requireBotApi('answer_callback').answerCallbackQuery({
          callbackQueryId: action.callbackQueryId,
        });
        return;
    }
  }

  async function processUpdate(update: ParsedUpdate): Promise<TelegramUpdateOutcome> {
    let claim: Awaited<ReturnType<typeof claimTelegramUpdate>>;
    try {
      claim = await claimTelegramUpdate(executor, update.updateId, clock.now());
    } catch (error) {
      // Transient claim failure: the update was NOT durably claimed, so
      // nothing is marked and Telegram's redelivery will retry. The mapped
      // AppError surfaces as a safe 5xx via the worker error path.
      logger.warn('telegram.update.claim_failed', { errorCode: toAppError(error).code });
      throw error;
    }

    switch (claim.kind) {
      case 'already_processed':
        // Terminal success: a safe, successful duplicate (200).
        logger.info('telegram.update.duplicate', {
          updateId: update.updateId,
          existingStatus: 'processed',
        });
        return 'duplicate';
      case 'in_flight':
        // An ACTIVE lease is held by another delivery. This is deliberately
        // NOT acknowledged as a successful duplicate: if the lease holder
        // dies before completing, Telegram must KEEP redelivering until the
        // lease expires and the abandoned claim is reclaimable (ADR-0030).
        // A 200 here could stop redelivery and permanently lose the update.
        logger.warn('telegram.update.in_flight', { updateId: update.updateId });
        throw new AppError('service_unavailable');
      case 'permanently_failed':
        // Terminal failure (ADR-0031): acknowledge WITHOUT executing — the
        // action must never run again for this update.
        logger.info('telegram.update.permanently_failed', { updateId: update.updateId });
        return 'failed';
      case 'claimed':
      case 'reclaimed_retryable':
      case 'reclaimed_stale':
        // This delivery owns the execution decision.
        break;
    }

    logger.info('telegram.update.claimed', {
      updateId: update.updateId,
      reclaimed: claim.kind !== 'claimed',
      reclaimedStale: claim.kind === 'reclaimed_stale',
    });

    try {
      const actor: ActorResolution =
        update.kind === 'unsupported'
          ? { kind: 'unauthorized' }
          : await authorization.resolveActor(update.fromUserId);
      const action = commandRouter.route(update, actor);
      await executeAction(action);

      const marked = await markTelegramUpdateProcessed(executor, update.updateId, clock.now());
      if (!marked) {
        logger.warn('telegram.update.mark_skipped', { updateId: update.updateId });
      }
      logger.info('telegram.update.processed', {
        updateId: update.updateId,
        action: action.type,
        noopReason: action.type === 'noop' ? action.reason : undefined,
        authorized: actor.kind === 'authorized',
        role: actor.kind === 'authorized' ? actor.role : undefined,
      });
      return 'processed';
    } catch (error) {
      const failureClass = classifyProcessingFailure(error);
      logger.warn('telegram.update.failed', {
        updateId: update.updateId,
        errorCode: toAppError(error).code,
        retryable: failureClass === 'retryable',
      });
      try {
        await markTelegramUpdateFailed(executor, update.updateId, clock.now(), failureClass);
      } catch (markError) {
        // The row stays `claimed` WITH ITS LEASE (observable); after lease
        // expiry a later delivery atomically reclaims the abandoned claim
        // (reclaimed_stale — ADR-0030), so the update is still recoverable.
        // Never let a marking failure mask the original error.
        logger.warn('telegram.update.mark_failed', {
          updateId: update.updateId,
          errorCode: toAppError(markError).code,
        });
      }
      if (failureClass === 'retryable') {
        // Propagate 503 semantics: the webhook MUST NOT answer 200, so
        // Telegram redelivers and the failed row is reclaimed then.
        throw new AppError('service_unavailable', { cause: error });
      }
      // Permanent (ADR-0031): acknowledge to avoid an infinite retry loop.
      // The row is marked failed with failure_class='permanent' (above) —
      // TERMINAL: reclaim is impossible and later deliveries observe
      // permanently_failed without executing.
      return 'failed';
    }
  }

  return { processUpdate };
}
