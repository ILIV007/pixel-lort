/**
 * Telegram ingress pipeline (Phase 2A, corrected by ADR-0027) — the durable
 * update lifecycle with RETRYABLE failure semantics.
 *
 * Orchestrates, for one verified and parsed Update:
 *   1. durable claim by update_id — four claim outcomes (ADR-0027):
 *        claimed (new) | reclaimed (failed -> claimed, exactly one winner)
 *        | already_processed (terminal, ack) | in_flight (owned by another
 *        delivery, ack). Duplicates are acknowledged WITHOUT reprocessing;
 *        a FAILED row is atomically reclaimable so Telegram's redelivery
 *        can retry it — a temporary failure can never permanently lose an
 *        update.
 *   2. routing of the claimed update (command/authorization contracts are
 *      wired by their owning slices) producing TYPED actions (send_message /
 *      denied / answer_callback / noop). An authorization DENIAL is a
 *      successfully handled action, never a processing failure.
 *   3. a stable terminal transition: processed, or failed when processing
 *      threw. A transient internal failure therefore never ends up marked
 *      processed.
 *   4. FAILURE CLASSIFICATION (the correction's core):
 *        - RETRYABLE failures (Telegram timeout/network/429/5xx, database
 *          and service-unavailability, unknown internal errors) mark the
 *          row `failed` and PROPAGATE a safe AppError with HTTP 503
 *          semantics — the webhook does NOT answer 200, so Telegram
 *          redelivers and the failed row is reclaimed (exactly one
 *          concurrent reclaim wins).
 *        - PERMANENT failures (Telegram 4xx client errors, configuration
 *          errors, deterministic internal rejections) mark the row `failed`
 *          and are ACKNOWLEDGED with 200 — no infinite retry loop. Logs
 *          carry stable event names and error codes only; user text,
 *          Telegram response bodies, tokens, and secrets are never logged.
 *   5. MISSING OUTBOUND CLIENT: a noop action completes safely without a
 *      Bot API client (offline mode). An OUTBOUND action (send_message /
 *      denied / answer_callback) without a client is a retryable
 *      `service_unavailable` — never silently skipped-and-acked, so the
 *      absence of BOT_TOKEN can never falsely produce successful
 *      processing.
 *
 * The claim happens FIRST and is durable in D1 — there is no in-memory-only
 * deduplication and KV is never the authority (ADR-0025). Concurrent
 * duplicate deliveries produce exactly one winner; losers see the existing
 * row's status.
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
export type ProcessingFailureClass = 'retryable' | 'permanent';

/**
 * AppError codes that describe DETERMINISTIC conditions: retrying the same
 * delivery cannot succeed, so the update is marked failed and acknowledged
 * (200) to avoid an infinite redelivery loop.
 *
 * Everything else — database and service-availability codes, and any
 * UNKNOWN error shape — is classified RETRYABLE by default (fail-safe
 * toward redelivery): a transient outage must never permanently lose an
 * update. The cost of a wrong retryable guess is bounded (durable claims
 * prevent double processing and Telegram's redelivery window is finite);
 * the cost of a wrong permanent guess is permanent update loss.
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
   * failed retryably, so the caller never acknowledges a lost update.
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

    if (claim.kind === 'already_processed' || claim.kind === 'in_flight') {
      logger.info('telegram.update.duplicate', {
        updateId: update.updateId,
        existingStatus: claim.kind === 'already_processed' ? 'processed' : 'claimed',
      });
      return 'duplicate';
    }

    logger.info('telegram.update.claimed', {
      updateId: update.updateId,
      reclaimed: claim.kind === 'reclaimed',
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
        await markTelegramUpdateFailed(executor, update.updateId, clock.now());
      } catch (markError) {
        // The row stays in `claimed`, which remains observable and
        // recoverable; never let a marking failure mask the original error.
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
      // Permanent: acknowledge to avoid an infinite retry loop. The row is
      // marked failed (above) — observable, never re-executed.
      return 'failed';
    }
  }

  return { processUpdate };
}
