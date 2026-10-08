/**
 * Scheduled (cron) entrypoint — bounded durable-work dispatch (Phase 3,
 * ADR-0036; blueprint §2: cron ONLY dispatches due work to the queue).
 *
 * Per pass (all bounded, indexed, deterministic):
 *  1. reclaim expired job leases (abandoned-claim recovery);
 *  2. dispatch due `pending`/`retry_wait` rows plus stranded `queued` rows
 *     past the grace window — sending durable job REFERENCES only;
 *  3. reconcile dead-letter rows whose safe DLQ reference was never
 *     confirmed delivered.
 *
 * Cron NEVER fetches feeds, calls AI, publishes, or executes handlers
 * inline. With `JOBS_ENABLED` off (or a misconfigured engine) the pass is a
 * structured no-op — the Phase 2 Telegram-only deployment behavior is
 * preserved exactly.
 */
import { createLogger } from '../observability/logger';
import type { WorkerEnv } from '../shared/types/env';
import { resolveJobsEngine } from '../application/jobs/engine-env';

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

  try {
    const summary = await resolution.engine.dispatchDueJobs();
    logger.info('cron.jobs_dispatched', {
      dueScanned: summary.dueScanned,
      strandedScanned: summary.strandedScanned,
      dispatched: summary.dispatched,
      sendFailures: summary.sendFailures,
      poisonedUnregistered: summary.poisonedUnregistered,
      reclaimedLeases: summary.reclaimedLeases,
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
