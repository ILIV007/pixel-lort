/**
 * Telegram ingress pipeline (Phase 2A) — the durable update lifecycle.
 *
 * Orchestrates, for one verified and parsed Update:
 *   1. durable claim by update_id (duplicates are acknowledged WITHOUT
 *      reprocessing — Telegram may deliver the same update repeatedly);
 *   2. routing of the claimed update (command/authorization contracts are
 *      wired by their owning slices; until then claimed updates are
 *      classified and marked processed);
 *   3. a stable terminal transition: processed, or failed when processing
 *      threw. A transient internal failure therefore never ends up marked
 *      processed.
 *
 * The claim happens FIRST and is durable in D1 — there is no in-memory-only
 * deduplication and KV is never the authority (ADR-0025). Concurrent
 * duplicate deliveries produce exactly one winner; losers see the existing
 * row's status.
 *
 * Processing: unsupported updates are acknowledged; commands are routed by
 * the command router against a fail-closed actor resolution and produce
 * TYPED actions (send_message / denied / noop). Outbound actions execute
 * through the injected Bot API client when one is configured (BOT_TOKEN
 * present); without a client — offline mode, e.g. the Phase 2A preview —
 * they are logged as skipped and the lifecycle still completes. Every
 * outbound text passes the Telegram-safe HTML validator as a final gate.
 * Nothing is executed for noop actions.
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
import type { ParsedUpdate } from '../adapters/telegram/update-parser';
import type { ActorResolution, AuthorizationService } from '../admin/authorization';
import type { CommandRouter, TelegramAction } from '../admin/command-router';
import { isSafeTelegramHtml, type TelegramSafeHtml } from '../admin/telegram-html';
import type { TelegramBotApiClient } from '../adapters/telegram/bot-api-client';
import { AppError, toAppError } from '../shared/errors/app-error';
import type { Clock } from '../shared/time/clock';
import type { Logger } from '../observability/logger';

export type TelegramUpdateOutcome = 'processed' | 'duplicate' | 'failed';

export interface TelegramIngressDeps {
  readonly executor: DbExecutor;
  readonly authorization: AuthorizationService;
  readonly commandRouter: CommandRouter;
  /** Optional: absent (no BOT_TOKEN) means offline mode — no live calls. */
  readonly botApi?: TelegramBotApiClient;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface TelegramIngress {
  /** Run the durable lifecycle for one parsed update. */
  processUpdate(update: ParsedUpdate): Promise<TelegramUpdateOutcome>;
}

export function createTelegramIngress(deps: TelegramIngressDeps): TelegramIngress {
  const { executor, authorization, commandRouter, botApi, clock, logger } = deps;

  async function sendSafely(chatId: number, text: TelegramSafeHtml): Promise<void> {
    if (botApi === undefined) {
      logger.info('telegram.action.skipped_offline', { action: 'send_message' });
      return;
    }
    // Defense-in-depth: only builder-composed text may reach the Bot API.
    if (!isSafeTelegramHtml(text)) {
      logger.error('telegram.action.html_rejected', { action: 'send_message' });
      throw new AppError('internal_error');
    }
    await botApi.sendMessage({ chatId, text });
  }

  /** Execute a routed action against the injected Bot API client. */
  async function executeAction(action: TelegramAction): Promise<void> {
    switch (action.type) {
      case 'noop':
        return;
      case 'send_message':
        await sendSafely(action.chatId, action.text);
        return;
      case 'denied':
        await sendSafely(action.chatId, action.text);
        return;
      case 'answer_callback':
        if (botApi === undefined) {
          logger.info('telegram.action.skipped_offline', { action: 'answer_callback' });
          return;
        }
        await botApi.answerCallbackQuery({ callbackQueryId: action.callbackQueryId });
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

    if (claim.kind === 'duplicate') {
      logger.info('telegram.update.duplicate', {
        updateId: update.updateId,
        existingStatus: claim.existingStatus,
      });
      return 'duplicate';
    }

    logger.info('telegram.update.claimed', { updateId: update.updateId });

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
      logger.warn('telegram.update.failed', {
        updateId: update.updateId,
        errorCode: toAppError(error).code,
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
      return 'failed';
    }
  }

  return { processUpdate };
}
