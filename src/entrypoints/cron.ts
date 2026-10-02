/**
 * Scheduled (cron) entrypoint — typed no-op foundation for Phase 0.
 *
 * Blueprint §2: cron only dispatches due work to the queue; it never fetches
 * feeds, calls AI, or publishes inline. That dispatch logic arrives with the
 * job/queue framework phase. Phase 0 intentionally performs no work and only
 * emits a structured log so operators can verify schedules are firing.
 *
 * Logging rules: never log the environment object or any secret-bearing value.
 */
import { createLogger } from '../observability/logger';
import type { WorkerEnv } from '../shared/types/env';

export async function handleScheduled(
  controller: ScheduledController,
  _env: WorkerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const logger = createLogger({ base: { evt: 'cron' } });
  logger.info('cron.triggered', {
    cron: controller.cron,
    scheduledTime: new Date(controller.scheduledTime).toISOString(),
  });
  // Phase 0: intentional no-op. Due-work dispatch is implemented in a later phase.
}
