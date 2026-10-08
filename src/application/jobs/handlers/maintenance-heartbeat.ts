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
 * All writes stay inside the dedicated `jobs_maintenance:` namespace of the
 * blueprint `settings` table; unrelated rows are untouched.
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../../domain/jobs/handler';
import type { MaintenanceHeartbeatPayload } from '../../../domain/jobs/payloads';
import { MaintenanceHeartbeatPayloadSchema } from '../../../domain/jobs/payloads';
import type { DbExecutor } from '../../../adapters/db/db-executor';

/** Dedicated settings namespace for job maintenance state (ADR-0036 §7). */
export const JOBS_MAINTENANCE_SETTINGS_KEY = 'jobs_maintenance:heartbeat';

/**
 * Settings ROW format version (matches the settings column convention used
 * by the existing stores — a row-format marker, not the DB schema version).
 */
const SETTINGS_ROW_SCHEMA_VERSION = 1;

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
      const valueJson = JSON.stringify({ at: nowMs, jobId: context.jobId });
      await options.executor.run({
        sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
              VALUES (?, ?, ${SETTINGS_ROW_SCHEMA_VERSION}, NULL, ?)
              ON CONFLICT(key) DO UPDATE
                SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        params: [JOBS_MAINTENANCE_SETTINGS_KEY, valueJson, nowMs],
      });
      return { kind: 'success' };
    },
  };
}
