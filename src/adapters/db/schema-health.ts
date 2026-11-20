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

/**
 * R1.20-R1 — the schema version of the LINEAR path's final candidate state:
 * migration candidate 0005 (admin post pipeline) applied ON TOP of 0004.
 * Version 5 therefore MEANS "ownership present AND admin post present".
 * Capability marker only — never a health expectation.
 */
export const ADMIN_POST_SCHEMA_VERSION = 5;

/**
 * R1.22 Phase A — the schema version of the LINEAR path's final candidate
 * state: migration candidate 0006 (editorial→post provenance) applied ON
 * TOP of 0005. Version 6 therefore MEANS "ownership present AND admin post
 * present AND the per-version editorial provenance present". Capability
 * marker only — never a health expectation.
 */
export const EDITORIAL_POST_SCHEMA_VERSION = 6;

/**
 * Slice 4 — the schema version of the LINEAR path's final candidate
 * state: migration candidate 0007 (inbound AI-admin pipeline) applied ON
 * TOP of 0006. Version 7 therefore MEANS "ownership present AND admin post
 * present AND the per-version editorial provenance present AND the inbound
 * published_posts / inbound_approvals tables present". Capability marker
 * only — never a health expectation.
 */
export const INBOUND_PIPELINE_SCHEMA_VERSION = 7;

/**
 * Slice 5 — the schema version of the LINEAR path's final candidate
 * state: migration candidate 0008 (live watchlists) applied ON TOP of
 * 0007. Version 8 therefore MEANS "ownership present AND admin post
 * present AND the per-version editorial provenance present AND the inbound
 * pipeline present AND the live-watchlist tables present". Capability
 * marker only — never a health expectation.
 */
export const LIVE_WATCHLISTS_SCHEMA_VERSION = 8;

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
  /** A well-formed integer that is NOT an exactly-known version (≠3, ≠4, ≠5, ≠6, ≠7, ≠8). */
  | 'schema_capability_version_unsupported'
  /**
   * The recorded migration_id does not identify a known shape for the
   * parsed version — a bare version number is never sufficient evidence for
   * a table-shape capability.
   */
  | 'schema_capability_migration_id_unknown';

/** The migration_id values that identify a KNOWN shape. */
export const SCHEMA_V4_OWNERSHIP_MIGRATION_ID = '0004_source_poll_ownership';
/**
 * Identifies the version-4 RETIRED shape (the pre-R1.20-R1 non-linear
 * candidate where 0005 wrote version 4 over the 0004-less chain) AND the
 * version-5 linear shape — the version number itself distinguishes them.
 */
export const SCHEMA_ADMIN_POST_MIGRATION_ID = '0005_admin_post_pipeline';
/**
 * R1.22 Phase A — identifies the version-6 linear shape (the editorial→post
 * provenance rebuild of admin_post_versions on top of the admin post
 * pipeline).
 */
export const SCHEMA_EDITORIAL_POST_MIGRATION_ID = '0006_admin_post_editorial_source';
/**
 * Slice 4 — identifies the version-7 linear shape (the inbound AI-admin
 * pipeline: published_posts + inbound_approvals on top of the editorial
 * provenance).
 */
export const SCHEMA_INBOUND_PIPELINE_MIGRATION_ID = '0007_inbound_pipeline';
/**
 * Slice 5 — identifies the version-8 linear shape (the live-watchlist
 * tables: watchlist_entries, chart_snapshots, chart_snapshot_rows,
 * watchlist_signals, watchlist_aliases, watchlist_exclusions on top of
 * the inbound pipeline).
 */
export const SCHEMA_LIVE_WATCHLISTS_MIGRATION_ID = '0008_live_watchlists';
/**
 * Slice 6 — identifies the version-9 linear shape (the post-management +
 * near-dup tables: channel_pins, story_merges, quality_rejections,
 * channel_post_deletes on top of the live watchlists).
 */
export const POST_MANAGEMENT_SCHEMA_VERSION = 9;
export const SCHEMA_POST_MANAGEMENT_MIGRATION_ID = '0009_post_management_near_dup';

/** The distinct, typed capability states (R19-01 — no boolean merge). */
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
      /**
       * The RETIRED non-linear shape (pre-R1.20-R1): version 4 recorded with
       * the 0005 migration id — the admin-post tables exist but the R09
       * ownership column does NOT. The ingestion tables are byte-identical
       * to the accepted schema 3, so every ingestion path treats this state
       * EXACTLY like the legacy mode. Only disposable databases created by
       * the retired candidate can ever report it; the linear chain can no
       * longer produce it.
       */
      readonly kind: 'known_v4_admin_post';
      readonly appliedSchemaVersion: 4;
    }
  | {
      /**
       * R1.20-R1: the LINEAR final candidate state — 0005 applied on top of
       * 0004. BOTH capabilities are present: the ownership column + the
       * outstanding-poll index (from 0004) AND the admin post tables (from
       * 0005). Every ingestion path treats this state exactly like the
       * ownership mode; the admin post pipeline is available.
       */
      readonly kind: 'known_v5_admin_post';
      readonly appliedSchemaVersion: 5;
    }
  | {
      /**
       * R1.22 Phase A: the LINEAR final candidate state — 0006 applied on
       * top of 0005. ALL capabilities are present: ownership (0004), the
       * admin post pipeline (0005) AND the per-version editorial provenance
       * with the nullable source_update_id (0006). Every ingestion path
       * treats this state exactly like the ownership mode; the admin post
       * pipeline AND the editorial bridge are available.
       */
      readonly kind: 'known_v6_editorial_post';
      readonly appliedSchemaVersion: 6;
    }
  | {
      /**
       * Slice 4: the LINEAR final candidate state — 0007 applied on top
       * of 0006. ALL capabilities are present: ownership (0004), the
       * admin post pipeline (0005), the per-version editorial provenance
       * with the nullable source_update_id (0006) AND the inbound
       * published_posts / inbound_approvals tables (0007). Every ingestion
       * path treats this state exactly like the ownership mode; the admin
       * post pipeline, the editorial bridge AND the inbound pipeline are
       * available.
       */
      readonly kind: 'known_v7_inbound';
      readonly appliedSchemaVersion: 7;
    }
  | {
      /**
       * Slice 5: the LINEAR final candidate state — 0008 applied on top
       * of 0007. ALL capabilities are present, plus the live-watchlist
       * tables (0008). Every ingestion path treats this state exactly
       * like the ownership mode.
       */
      readonly kind: 'known_v8_live_watchlists';
      readonly appliedSchemaVersion: 8;
    }
  | {
      /**
       * Slice 6: the LINEAR final candidate state — 0009 applied on top
       * of 0008. ALL capabilities are present, plus the post-management
       * + near-dup tables (0009). Every ingestion path treats this state
       * exactly like the ownership mode.
       */
      readonly kind: 'known_v9_post_management';
      readonly appliedSchemaVersion: 9;
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
  if (
    parsed === 4 ||
    parsed === 5 ||
    parsed === 6 ||
    parsed === 7 ||
    parsed === 8 ||
    parsed === 9
  ) {
    // The migration_id distinguishes the shapes a version number alone can
    // never prove: at version 4 the ownership column exists ONLY under the
    // 0004 id; at version 5 the linear chain requires the 0005 id (and
    // implies 0004's changes); at version 6 the linear chain requires the
    // 0006 id (and implies 0004+0005's changes); at version 7 the linear
    // chain requires the 0007 id (and implies 0004+0005+0006's changes);
    // at version 8 the linear chain requires the 0008 id (and implies
    // 0004..0007's changes); at version 9 the linear chain requires the
    // 0009 id (and implies 0004..0008's changes).
    // Anything else is UNRESOLVED — no invented valid shapes.
    let idRow: { value: string } | null;
    try {
      idRow = await executor.first<{ value: string }>({
        sql: `SELECT value FROM ${SCHEMA_METADATA_TABLE} WHERE key = ?`,
        params: [SCHEMA_METADATA.migrationIdKey],
      });
    } catch {
      return { kind: 'unresolved', reason: 'schema_capability_metadata_read_failed' };
    }
    if (idRow === null || idRow.value === '') {
      return { kind: 'unresolved', reason: 'schema_capability_metadata_missing' };
    }
    if (parsed === 4) {
      if (idRow.value === SCHEMA_V4_OWNERSHIP_MIGRATION_ID) {
        return { kind: 'known_v4_ownership', appliedSchemaVersion: 4 };
      }
      if (idRow.value === SCHEMA_ADMIN_POST_MIGRATION_ID) {
        return { kind: 'known_v4_admin_post', appliedSchemaVersion: 4 };
      }
      return { kind: 'unresolved', reason: 'schema_capability_migration_id_unknown' };
    }
    if (parsed === 5) {
      if (idRow.value === SCHEMA_ADMIN_POST_MIGRATION_ID) {
        return { kind: 'known_v5_admin_post', appliedSchemaVersion: 5 };
      }
      return { kind: 'unresolved', reason: 'schema_capability_migration_id_unknown' };
    }
    if (parsed === 6) {
      if (idRow.value === SCHEMA_EDITORIAL_POST_MIGRATION_ID) {
        return { kind: 'known_v6_editorial_post', appliedSchemaVersion: 6 };
      }
      return { kind: 'unresolved', reason: 'schema_capability_migration_id_unknown' };
    }
    if (idRow.value === SCHEMA_INBOUND_PIPELINE_MIGRATION_ID) {
      return { kind: 'known_v7_inbound', appliedSchemaVersion: 7 };
    }
    if (parsed === 8 && idRow.value === SCHEMA_LIVE_WATCHLISTS_MIGRATION_ID) {
      return { kind: 'known_v8_live_watchlists', appliedSchemaVersion: 8 };
    }
    if (parsed === 9 && idRow.value === SCHEMA_POST_MANAGEMENT_MIGRATION_ID) {
      return { kind: 'known_v9_post_management', appliedSchemaVersion: 9 };
    }
    return { kind: 'unresolved', reason: 'schema_capability_migration_id_unknown' };
  }
  return { kind: 'unresolved', reason: 'schema_capability_version_unsupported' };
}
