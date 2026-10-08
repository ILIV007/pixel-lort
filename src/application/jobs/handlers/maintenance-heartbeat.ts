/**
 * `jobs.maintenance_heartbeat` — the ONE registered Phase 3 handler
 * (ADR-0036 §7).
 *
 * Purpose: prove the durable engine end-to-end (create → dispatch →
 * consume → fenced terminal persistence) WITHOUT calling Telegram, an AI
 * provider, or any external service. Its effect is IDEMPOTENT and D1-ONLY:
 * an upsert of the dedicated `jobs_maintenance:heartbeat` settings key with
 * the last successful run timestamp (an overwrite — replaying the same job
 * can never accumulate state). The `note` field, when present, is bounded
 * (≤ 200 chars by the payload schema), stored only in that settings row,
 * and never logged or delivered anywhere.
 *
 * The handler itself is SQL-FREE: the durable effect is delegated to the
 * typed DB adapter `upsertMaintenanceHeartbeat`
 * (`src/adapters/db/jobs-maintenance-store.ts` — the ADR-0022 repository
 * SQL boundary; v1.3.1 final review correction, behavior unchanged).
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../../domain/jobs/handler';
import type { MaintenanceHeartbeatPayload } from '../../../domain/jobs/payloads';
import { MaintenanceHeartbeatPayloadSchema } from '../../../domain/jobs/payloads';
import type { DbExecutor } from '../../../adapters/db/db-executor';
import { upsertMaintenanceHeartbeat } from '../../../adapters/db/jobs-maintenance-store';

/** Handler dependencies: the typed D1 boundary and an injected clock. */
export interface MaintenanceHeartbeatHandlerOptions {
  readonly executor: DbExecutor;
  readonly nowMs: () => number;
}

export function createMaintenanceHeartbeatHandler(
  options: MaintenanceHeartbeatHandlerOptions,
): JobHandler<MaintenanceHeartbeatPayload> {
  return {
    type: 'jobs.maintenance_heartbeat',
    async execute(
      context: JobExecutionContext<MaintenanceHeartbeatPayload>,
    ): Promise<HandlerOutcome> {
      // Defense-in-depth: the engine already validated the payload; the
      // schema check here keeps the handler safe if reused directly.
      const parsed = MaintenanceHeartbeatPayloadSchema.safeParse(context.payload);
      if (!parsed.success) {
        return { kind: 'permanent', reasonCode: 'job_payload_invalid' };
      }
      const nowMs = options.nowMs();
      await upsertMaintenanceHeartbeat(options.executor, { atMs: nowMs, jobId: context.jobId });
      return { kind: 'success' };
    },
  };
}
