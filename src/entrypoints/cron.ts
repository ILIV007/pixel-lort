/**
 * Scheduled (cron) entrypoint — bounded durable-work dispatch (Phase 3,
 * ADR-0036; blueprint §2: cron ONLY dispatches due work to the queue).
 *
 * Per pass (all bounded, indexed, deterministic):
 *  1. [Phase 4, gate-gated ADR-0038 §3] schedule due sources: ONE bounded
 *     indexed due-source scan creating durable poll jobs — NEVER fetching
 *     a feed inline (no connector code runs in cron);
 *  2. reclaim expired job leases (abandoned-claim recovery);
 *  3. dispatch due `pending`/`retry_wait` rows plus stranded `queued` rows
 *     past the grace window — sending durable job REFERENCES only;
 *  4. reconcile dead-letter rows whose safe DLQ reference was never
 *     confirmed delivered.
 *
 * Cron NEVER fetches feeds, calls AI, publishes, or executes handlers
 * inline. With `JOBS_ENABLED` off (or a misconfigured engine) the pass is a
 * structured no-op — the Phase 2 Telegram-only deployment behavior is
 * preserved exactly. With `SOURCE_INGESTION_ENABLED` off (default), the
 * scheduling step is skipped entirely — byte-identical Phase 3 behavior.
 *
 * Slice 9 — the autonomous chain runs HERE, after dispatch, in order:
 *  5. [editorial gate] drain fresh source items into `editorial.prepare_draft`
 *     jobs (Link 2 — the production trigger ingestion never had);
 *  6. [mode-gated] bridge ready drafts into the `publications` outbox
 *     through the ag1 auto-gate (Link 4 — `paused`/`approval` skip with
 *     zero writes, and a missing mode row is treated as `paused`);
 *  7. scan due publications with the REAL Bot API transport and the send
 *     gate resolved from the SAME D1 mode (Link 5 — the scheduler only
 *     sends while the mode is `auto`/`safe-auto`; otherwise the scan is
 *     decision-only observation + ledger reconciliation).
 */
import { createLogger } from '../observability/logger';
import type { WorkerEnv } from '../shared/types/env';
import { resolveJobsEngine } from '../application/jobs/engine-env';
import { scheduleDueSources } from '../application/ingestion/scheduler';
import { enqueueFreshSourceItems } from '../application/editorial/enqueue-fresh-items';
import { bridgeReadyDrafts } from '../application/publishing/auto-publish-bridge';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
} from '../application/publishing/scheduler';
import { readExplicitPublishMode } from '../adapters/db/publishing-settings-store';
import { parseTelegramPhase2Config } from '../shared/config/phase2';
import { createBotApiClient } from '../adapters/telegram/bot-api-client';
import { createConnectorRegistry } from '../connectors/registry';
import { createDbExecutor } from '../adapters/db/db-executor';
import { systemClock } from '../shared/time/clock';
import type { RichTextEnvelope } from '../domain/telegram/rich-text-envelope';
import type { PublishMode } from '../domain/publishing/publishing-settings';

export async function handleScheduled(
  controller: ScheduledController,
  env: WorkerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const logger = createLogger({ base: { evt: 'cron' } });
  logger.info('cron.triggered', {
    cron: controller.cron,
    scheduledTime: new Date(controller.scheduledTime).toISOString(),
  });

  const resolution = resolveJobsEngine(env, logger);
  if (resolution.kind === 'disabled') {
    logger.debug('cron.jobs_disabled');
    return;
  }
  if (resolution.kind === 'config_invalid') {
    logger.warn('cron.jobs_config_invalid');
    return;
  }

  // Phase 4 (gate-gated): bounded due-source scheduling — durable job
  // creation ONLY, never an inline fetch (ADR-0038 §3).
  if (resolution.ingestionEnabled) {
    try {
      const outcome = await scheduleDueSources({
        executor: createDbExecutor(env.DB!, { logger }),
        engine: resolution.engine,
        connectors: createConnectorRegistry(),
        secrets: (name: string) => (env as Record<string, unknown>)[name] as string | undefined,
        nowMs: Date.now(),
        logger,
      });
      if (outcome.kind === 'registry_invalid') {
        logger.warn('cron.ingestion_registry_invalid');
      } else if (outcome.kind === 'capability_unresolved') {
        // R19-01: the pass stopped before every seed/job/state effect — a
        // stable, recoverable condition that self-heals on a later pass
        // once the schema metadata is readable and a known version again.
        logger.warn('cron.ingestion_capability_unresolved', {
          reason: outcome.reason,
        });
      } else if (outcome.kind === 'scheduled') {
        logger.info('cron.ingestion_scheduled', {
          jobsCreated: outcome.jobsCreated,
          blockedSkipped: outcome.blockedSkipped,
          seeded: outcome.seeded,
        });
      }
    } catch {
      logger.warn('cron.ingestion_schedule_failed', { errorCode: 'internal_error' });
    }
  }

  try {
    const summary = await resolution.engine.dispatchDueJobs();
    logger.info('cron.jobs_dispatched', {
      dueScanned: summary.dueScanned,
      strandedScanned: summary.strandedScanned,
      dispatched: summary.dispatched,
      sendFailures: summary.sendFailures,
      poisonedUnregistered: summary.poisonedUnregistered,
      misconfiguredPoisoned: summary.misconfiguredPoisoned,
      policyPaused: summary.policyPaused,
      pausedExpiredObserved: summary.pausedExpiredObserved,
      reclaimedLeases: summary.reclaimedLeases,
      reclaimedExhausted: summary.reclaimedExhausted,
    });
    if (summary.sendFailures > 0) {
      logger.warn('cron.jobs_dispatch_degraded', { sendFailures: summary.sendFailures });
    }
  } catch {
    logger.warn('cron.jobs_dispatch_failed', { errorCode: 'internal_error' });
  }

  try {
    const dlq = await resolution.engine.reconcileDeadLetters();
    if (dlq.scanned > 0 || dlq.sendFailures > 0) {
      logger.info('cron.jobs_dlq_reconciled', {
        scanned: dlq.scanned,
        delivered: dlq.delivered,
        sendFailures: dlq.sendFailures,
      });
    }
  } catch {
    logger.warn('cron.jobs_dlq_reconcile_failed', { errorCode: 'internal_error' });
  }

  // Slice 9 — the autonomous chain (Links 2/4/5). Each step is
  // independently fail-closed and independently logged: a failure in one
  // step never aborts the others, and no step ever runs inline work the
  // queue/scheduler owns (no feed fetch, no AI call, no handler
  // execution here — only durable enqueue/bridge/scan composition).
  const executor = createDbExecutor(env.DB!, { logger });

  // Link 2 — drain fresh items into editorial (EDITORIAL_ENABLED only).
  if (resolution.editorialEnabled) {
    try {
      const drained = await enqueueFreshSourceItems({
        executor,
        engine: resolution.engine,
        logger,
      });
      logger.info('cron.editorial_drained', {
        scanned: drained.scanned,
        enqueued: drained.enqueued,
        alreadyQueued: drained.alreadyQueued,
        rejected: drained.rejected,
        conflicts: drained.conflicts,
      });
    } catch {
      logger.warn('cron.editorial_drain_failed', { errorCode: 'internal_error' });
    }
  }

  // The mode is read ONCE for the bridge + the send gate, and a missing
  // or corrupt mode row is `paused` (never the panel default `auto` —
  // see readExplicitPublishMode).
  let mode: PublishMode = 'paused';
  try {
    mode = (await readExplicitPublishMode(executor)) ?? 'paused';
  } catch {
    logger.warn('cron.publish_mode_unreadable', { errorCode: 'internal_error' });
    mode = 'paused';
  }

  // Link 4 — bridge ready drafts into the outbox (mode-gated inside).
  // The destination is the operator-configured TARGET_CHANNEL, never a
  // hardcoded fallback: without it the bridge AND the scan below both
  // skip (an enqueued publication to an unknown destination must never
  // exist).
  const destination = phase2TargetChannel(env);
  if (destination === undefined) {
    logger.warn('cron.auto_publish_skipped', { reason: 'target_channel_missing' });
  } else {
    try {
      const bridged = await bridgeReadyDrafts({
        executor,
        destination,
        mode,
        nowMs: Date.now(),
        logger,
      });
      if (bridged.kind === 'bridged') {
        logger.info('cron.auto_publish_bridged', {
          scanned: bridged.scanned,
          approved: bridged.approved,
          enqueued: bridged.enqueued,
          duplicates: bridged.duplicates,
          requiresReview: bridged.requiresReview,
          refused: bridged.refused,
          rejected: bridged.rejected,
        });
      } else {
        logger.debug('cron.auto_publish_skipped', { reason: bridged.reason });
      }
    } catch {
      logger.warn('cron.auto_publish_bridge_failed', { errorCode: 'internal_error' });
    }
  }

  // Link 5 — scan due publications (the scheduler's own send gate is
  // resolved from the SAME mode; the transport is the REAL Bot API
  // client — the same instance shape the webhook wires — and NO send
  // happens while the mode is not auto/safe-auto).
  try {
    const botToken = phase2BotToken(env);
    if (destination === undefined) {
      logger.warn('cron.publication_scan_skipped', { reason: 'target_channel_missing' });
    } else {
      const botApi = botToken !== undefined ? createBotApiClient({ botToken, logger }) : undefined;
      const scheduler = createPublicationScheduler({
        executor,
        destination,
        transport:
          botApi === undefined
            ? undefined
            : {
                sendMessageRich: (input) =>
                  botApi.sendMessageRich({
                    chatId: input.chatId,
                    // The scheduler's render envelope IS the rich-text
                    // envelope the client validates; the cast only
                    // bridges the scheduler's structural content shape.
                    content: input.content as RichTextEnvelope,
                  }),
              },
        sendGate: { enabled: mode === 'auto' || mode === 'safe-auto' },
        contextProvider: createStoriesPolicyContextProvider(executor),
        clock: systemClock,
        logger,
      });
      const report = await scheduler.scanDuePublications();
      logger.info('cron.publications_scanned', {
        gateEnabled: report.gateEnabled,
        decisionOnly: report.decisionOnly,
        misconfigured: report.misconfigured,
        dueCount: report.dueCount,
        processed: report.processed,
        reclaimed: report.reclaimed,
        uncertainParked: report.uncertainParked,
        uncertaintyHealed: report.uncertaintyHealed,
      });
    }
  } catch {
    logger.warn('cron.publication_scan_failed', { errorCode: 'internal_error' });
  }
}

/**
 * Slice 9 — the phase-2 channel/token reads for the publication scan.
 * BOT_TOKEN stays OPTIONAL (validated whenever present, never required
 * here): without it the scheduler is built transport-less and its
 * gate-ON path reports the LOUD `transport_absent` misconfiguration
 * with zero writes instead of sending anywhere.
 */
function phase2TargetChannel(env: WorkerEnv): string | undefined {
  const phase2 = parseTelegramPhase2Config(env as Readonly<Record<string, unknown>>);
  return phase2.config?.targetChannel;
}

function phase2BotToken(env: WorkerEnv): string | undefined {
  const phase2 = parseTelegramPhase2Config(env as Readonly<Record<string, unknown>>);
  return phase2.config?.botToken;
}
