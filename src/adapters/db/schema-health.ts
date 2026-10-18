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

/**
 * Round 1.9 — the schema version that carries the source-poll ownership
 * capability (migration candidate 0004: `source_state.poll_owner_job_id` +
 * the partial unique outstanding-poll index). The APPLIED runtime schema
 * stays 3 until the migration is separately authorized and executed by the
 * owner; this constant is a capability marker, never a health expectation.
 */
export const OWNERSHIP_SCHEMA_VERSION = 4;

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

/**
 * Round 1.9.1 — R19-01 typed schema-capability resolution (replaces the
 * Round 1.9 `readAppliedSchemaVersion` / `OwnershipCapability` boolean
 * contract, which collapsed every unreadable/invalid/unsupported state into
 * "ownership OFF" and thereby re-activated the legacy ingestion path —
 * Posidon counterexamples CE1–CE4).
 *
 * Reads the APPLIED application schema version from `schema_metadata` (ONE
 * bounded, indexed metadata read) and resolves EXACTLY ONE of three
 * distinct capability states:
 *   - `known_v3_legacy`   → readable exact integer 3: the documented,
 *     accepted legacy ingestion mode (marker-CAS pacing; the R09 defect is
 *     honestly visible there by design);
 *   - `known_v4_ownership` → readable exact integer 4: the ownership
 *     capability (durable owner + outstanding-poll exclusivity +
 *     ownership-fenced commits); ALL owner/generation fences apply;
 *   - `unresolved` → the metadata is unavailable or not a known version:
 *     a failed/missing/corrupt/unsafe-integer read, or a parsed integer
 *     other than exactly 3 or 4 (no invented valid versions). Callers MUST
 *     fail closed: the scheduler stops before seed/job/source-state
 *     effects; the poll handler stops before budget/network/item/
 *     source-state effects. Unresolved is NEVER legacy, NEVER ownership,
 *     and never silently completes or poisons work.
 *
 * This is a capability DETECTION, not a health decision: `checkSchemaHealth`
 * stays the exact-equality readiness gate against the OPERATOR-CONFIGURED
 * expected version and is byte-identical. A database whose applied version
 * differs from the bundle's configured expectation is unhealthy regardless
 * of what the capability resolves (never accept arbitrary versions).
 */

/**
 * Stable reason codes for the `unresolved` capability state. Carried on
 * scheduler/handler outcomes and warnings for observability — codes only,
 * never raw metadata values (beyond the parsed integer for the unsupported
 * case, mirroring the health result's observability rules).
 */
export type SchemaCapabilityUnresolvedReason =
  /** The metadata SELECT itself failed (transient or persistent outage). */
  | 'schema_capability_metadata_read_failed'
  /** No `schema_version` row (or an empty value) — metadata never written. */
  | 'schema_capability_metadata_missing'
  /** A value that is not a positive safe integer (corrupt/oversized). */
  | 'schema_capability_metadata_invalid'
  /** A well-formed integer that is NOT an exactly-known version (≠3, ≠4). */
  | 'schema_capability_version_unsupported';

/** The three distinct, typed capability states (R19-01 — no boolean merge). */
export type SchemaCapability =
  | {
      readonly kind: 'known_v3_legacy';
      readonly appliedSchemaVersion: 3;
    }
  | {
      readonly kind: 'known_v4_ownership';
      readonly appliedSchemaVersion: 4;
    }
  | {
      readonly kind: 'unresolved';
      readonly reason: SchemaCapabilityUnresolvedReason;
    };

export async function resolveSchemaCapability(executor: DbExecutor): Promise<SchemaCapability> {
  let row: { value: string } | null;
  try {
    row = await executor.first<{ value: string }>({
      sql: `SELECT value FROM ${SCHEMA_METADATA_TABLE} WHERE key = ?`,
      params: [SCHEMA_METADATA.versionKey],
    });
  } catch {
    return { kind: 'unresolved', reason: 'schema_capability_metadata_read_failed' };
  }
  if (row === null || row.value === '') {
    return { kind: 'unresolved', reason: 'schema_capability_metadata_missing' };
  }
  if (!VERSION_POSITIVE_INTEGER_PATTERN.test(row.value)) {
    return { kind: 'unresolved', reason: 'schema_capability_metadata_invalid' };
  }
  const parsed = Number.parseInt(row.value, 10);
  if (!Number.isSafeInteger(parsed)) {
    // A pattern-matching value that still exceeds MAX_SAFE_INTEGER — an
    // unsafe/oversized integer is INVALID metadata, never a version.
    return { kind: 'unresolved', reason: 'schema_capability_metadata_invalid' };
  }
  if (parsed === 3) {
    return { kind: 'known_v3_legacy', appliedSchemaVersion: 3 };
  }
  if (parsed === 4) {
    return { kind: 'known_v4_ownership', appliedSchemaVersion: 4 };
  }
  return { kind: 'unresolved', reason: 'schema_capability_version_unsupported' };
}
