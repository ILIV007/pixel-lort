/**
 * Migration / schema health query (Phase 1A).
 *
 * Reads the APPLICATION schema metadata table (schema_metadata — ADR-0019)
 * and compares the recorded schema version against the expected value. This
 * is intentionally independent of Wrangler's migration bookkeeping
 * (`d1_migrations`): wrangler tracks which FILES were applied; this check
 * verifies what the RUNNING application expects from the schema.
 *
 * Observability: results carry stable reason codes and an integer version
 * only — never raw metadata values beyond the parsed integer, never full rows.
 */
import type { DbExecutor } from './db-executor';
import { toDbAppError } from './d1-errors';

export type SchemaHealthReason =
  'schema_missing_metadata' | 'schema_version_mismatch' | 'schema_query_failed';

export interface SchemaHealthResult {
  readonly ok: boolean;
  /** Stable reason code; present exactly when `ok` is false. */
  readonly reason?: SchemaHealthReason;
  /** Parsed observed version when readable; omitted otherwise. */
  readonly observedSchemaVersion?: number;
}

const SCHEMA_METADATA_TABLE = 'schema_metadata';
const VERSION_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

export const SCHEMA_METADATA = {
  table: SCHEMA_METADATA_TABLE,
  versionKey: 'schema_version',
  migrationIdKey: 'migration_id',
  appliedAtKey: 'applied_at',
} as const;

export async function checkSchemaHealth(
  executor: DbExecutor,
  expectedSchemaVersion: number,
): Promise<SchemaHealthResult> {
  let rows: readonly { key: string; value: string }[];
  try {
    const result = await executor.query<{ key: string; value: string }>({
      sql: `SELECT key, value FROM ${SCHEMA_METADATA_TABLE}`,
    });
    rows = result.rows;
  } catch (error) {
    if (toDbAppError(error).code === 'db_schema_invalid') {
      // Missing table — migrations were never applied to this database.
      return { ok: false, reason: 'schema_missing_metadata' };
    }
    return { ok: false, reason: 'schema_query_failed' };
  }

  const metadata = new Map(rows.map((row) => [row['key'], row['value']]));
  const versionRaw = metadata.get(SCHEMA_METADATA.versionKey);
  if (versionRaw === undefined || !VERSION_POSITIVE_INTEGER_PATTERN.test(versionRaw)) {
    return { ok: false, reason: 'schema_missing_metadata' };
  }

  const observed = Number.parseInt(versionRaw, 10);
  if (observed !== expectedSchemaVersion) {
    return {
      ok: false,
      reason: 'schema_version_mismatch',
      observedSchemaVersion: observed,
    };
  }

  const migrationId = metadata.get(SCHEMA_METADATA.migrationIdKey);
  const appliedAt = metadata.get(SCHEMA_METADATA.appliedAtKey);
  if (migrationId === undefined || migrationId === '' || appliedAt === undefined) {
    return { ok: false, reason: 'schema_missing_metadata' };
  }

  return { ok: true };
}
