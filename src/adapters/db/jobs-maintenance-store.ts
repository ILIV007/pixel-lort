/**
 * Maintenance-state settings store (Phase 3 — ADR-0036 §7; typed D1 boundary
 * per ADR-0022).
 *
 * ALL SQL for the `jobs.maintenance_heartbeat` handler's durable effect
 * lives HERE — the application handler stays SQL-free (the repository SQL
 * boundary; v1.3.1 final review correction). No new framework: one small
 * typed function over the existing `settings` table.
 *
 * Effect: an IDEMPOTENT, D1-ONLY upsert of the dedicated
 * `jobs_maintenance:heartbeat` settings key (an overwrite — replaying the
 * same job can never accumulate state). All writes stay inside the dedicated
 * `jobs_maintenance:` namespace; unrelated settings rows are untouched.
 * Observability: this module never logs SQL text, parameters, or rows.
 */
import type { DbExecutor } from './db-executor';

/** Dedicated settings namespace for job maintenance state (ADR-0036 §7). */
export const JOBS_MAINTENANCE_SETTINGS_KEY = 'jobs_maintenance:heartbeat';

/**
 * Settings ROW format version (matches the settings column convention used
 * by the existing stores — a row-format marker, not the DB schema version).
 */
const SETTINGS_ROW_SCHEMA_VERSION = 1;

/** The durable heartbeat marker written by the maintenance handler. */
export interface MaintenanceHeartbeatRecord {
  /** Last successful run timestamp (epoch ms). */
  readonly atMs: number;
  /** Job id whose execution produced this marker (reference only). */
  readonly jobId: string;
}

/**
 * Idempotently upsert the maintenance heartbeat marker: insert the
 * dedicated key, or overwrite ONLY that key's value/timestamp on conflict.
 */
export async function upsertMaintenanceHeartbeat(
  executor: DbExecutor,
  record: MaintenanceHeartbeatRecord,
): Promise<void> {
  const valueJson = JSON.stringify({ at: record.atMs, jobId: record.jobId });
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES (?, ?, ${SETTINGS_ROW_SCHEMA_VERSION}, NULL, ?)
          ON CONFLICT(key) DO UPDATE
            SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    params: [JOBS_MAINTENANCE_SETTINGS_KEY, valueJson, record.atMs],
  });
}
