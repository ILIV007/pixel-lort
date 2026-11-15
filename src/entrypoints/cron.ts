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
 */
import { createLogger } from '../observability/logger';
import type { WorkerEnv } from '../shared/types/env';
import { resolveJobsEngine } from '../application/jobs/engine-env';
import { scheduleDueSources } from '../application/ingestion/scheduler';
import { createConnectorRegistry } from '../connectors/registry';
import { createDbExecutor } from '../adapters/db/db-executor';

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
}
