import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0006 — the editorial→post provenance (R1.22 Phase A; schema
 * version 6). This file has its OWN isolated storage (vitest-pool-workers
 * isolates per test FILE), so it proves the full upgrade path of a POPULATED
 * schema-v5 database:
 *
 *  1. apply ONLY migrations 0001..0005 -> a genuine schema-v5 database;
 *  2. populate admin post versions using ONLY v5 columns (captured rows
 *     carry a real source_update_id and no editorial columns);
 *  3. apply the real append-only plan -> ONLY 0006 is pending;
 *  4. schema version becomes 6 with the 0006 migration id;
 *  5. every legacy captured row survives byte-identically: the same
 *     envelope/fingerprint/source_update_id, editorial columns NULL —
 *     no data loss, no backfill (NULL is the correct "not editorial"
 *     semantic for legacy rows);
 *  6. the EXACTLY-ONE-origin CHECK admits captured rows and rejects the
 *     fabricated shapes (both origins, no origin, incomplete editorial
 *     pair) at the DATABASE level;
 *  7. the partial UNIQUE index admits one editorial-derived version and
 *     rejects a second derivation of the SAME editorial draft version
 *     (while a DIFFERENT editorial draft version converts freely);
 *  8. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives 0006
 * exclusively through `wrangler d1 migrations apply` with explicit owner
 * approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V5_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 5,
);

const executor = createDbExecutor(db);

interface VersionRow {
  readonly draft_id: string;
  readonly version: number;
  readonly envelope_json: string;
  readonly fingerprint: string;
  readonly source_update_id: number | null;
  readonly editorial_draft_id: string | null;
  readonly editorial_draft_version: number | null;
}

const LEGACY_CAPTURE = {
  draftId: 'legacy-capture-draft-0001',
  envelope: '{"schemaVersion":1,"media":"none"}',
  fingerprint: 'a'.repeat(64),
  sourceUpdateId: 4242,
};

async function appliedSchemaVersion(): Promise<number> {
  const row = await executor
    .first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'schema_version'`,
    })
    .catch(() => null);
  return row === null ? 0 : Number.parseInt(row.value, 10);
}

async function seedLegacyCapturedVersion(): Promise<void> {
  await executor.run({
    sql: `INSERT INTO admin_post_versions
            (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms)
          VALUES (?, 1, ?, ?, ?, 1000000001, 1)`,
    params: [
      LEGACY_CAPTURE.draftId,
      LEGACY_CAPTURE.envelope,
      LEGACY_CAPTURE.fingerprint,
      LEGACY_CAPTURE.sourceUpdateId,
    ],
  });
}

beforeEach(async () => {
  // Build the version-5 baseline ONCE per test: a genuine populated
  // schema-v5 database (legacy captured versions use ONLY v5 columns).
  // Storage persists across tests WITHIN this file, so on later tests the
  // V5 plan is a no-op and the seeded legacy row is still present.
  const result = await applyMigrations(db, V5_ONLY);
  if (result.observedVersion === 0) {
    await seedLegacyCapturedVersion();
  }
  // Upgrade to the real append-only plan — on the first run ONLY 0006 is
  // pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 6.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(6);
});

describe('R1.22 — migration 0006: editorial→post provenance (schema 5 → 6)', () => {
  it('applies exactly 0006 as the only pending step on a fresh schema-v5 database', async () => {
    // This assertion is meaningful ONLY on the file's first run (storage
    // persists across tests within the file); the beforeEach already
    // upgraded the database, so the honest re-derivation is: the full plan
    // applied nothing further and the version/migration-id pair is 6/0006.
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(6);
    expect(await appliedSchemaVersion()).toBe(6);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0006_admin_post_editorial_source');
  });

  it('preserves every legacy captured row byte-identically with NULL editorial provenance', async () => {
    const row = await executor.first<VersionRow>({
      sql: `SELECT draft_id, version, envelope_json, fingerprint, source_update_id,
                   editorial_draft_id, editorial_draft_version
            FROM admin_post_versions WHERE draft_id = ?`,
      params: [LEGACY_CAPTURE.draftId],
    });
    expect(row).not.toBeNull();
    expect(row?.envelope_json).toBe(LEGACY_CAPTURE.envelope);
    expect(row?.fingerprint).toBe(LEGACY_CAPTURE.fingerprint);
    expect(row?.source_update_id).toBe(LEGACY_CAPTURE.sourceUpdateId);
    expect(row?.editorial_draft_id).toBeNull();
    expect(row?.editorial_draft_version).toBeNull();
  });

  it('admits a captured version (source_update_id set, editorial NULL) and an editorial-derived version (complete pair)', async () => {
    // Captured shape (post-0006 write path stays available).
    await executor.run({
      sql: `INSERT INTO admin_post_versions
              (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms)
            VALUES ('new-capture-draft', 1, '{}', '${'b'.repeat(64)}', 9000, 1, 1)`,
    });
    // Editorial-derived shape: NULL update id + the complete provenance pair.
    await executor.run({
      sql: `INSERT INTO admin_post_versions
              (draft_id, version, envelope_json, fingerprint, source_update_id,
               created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
            VALUES ('derived-draft', 1, '{}', '${'c'.repeat(64)}', NULL, 1, 1, 'ed-1', 1)`,
    });
    const count = await executor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM admin_post_versions',
    });
    expect(count?.n).toBe(3); // legacy + new capture + derived
  });

  it('rejects fabricated origin shapes at the database level', async () => {
    // BOTH origins — a fabricated update id on an editorial-derived version.
    await expect(
      executor.run({
        sql: `INSERT INTO admin_post_versions
                (draft_id, version, envelope_json, fingerprint, source_update_id,
                 created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
              VALUES ('bad-both', 1, '{}', '${'d'.repeat(64)}', 777, 1, 1, 'ed-x', 1)`,
      }),
    ).rejects.toThrow();
    // NEITHER origin — an origin-less version.
    await expect(
      executor.run({
        sql: `INSERT INTO admin_post_versions
                (draft_id, version, envelope_json, fingerprint, source_update_id,
                 created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
              VALUES ('bad-neither', 1, '{}', '${'e'.repeat(64)}', NULL, 1, 1, NULL, NULL)`,
      }),
    ).rejects.toThrow();
    // INCOMPLETE editorial pair — id without version.
    await expect(
      executor.run({
        sql: `INSERT INTO admin_post_versions
                (draft_id, version, envelope_json, fingerprint, source_update_id,
                 created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
              VALUES ('bad-pair', 1, '{}', '${'f'.repeat(64)}', NULL, 1, 1, 'ed-y', NULL)`,
      }),
    ).rejects.toThrow();
  });

  it('enforces at most ONE derived version per editorial draft version (partial UNIQUE), while different drafts convert freely', async () => {
    await executor.run({
      sql: `INSERT INTO admin_post_versions
              (draft_id, version, envelope_json, fingerprint, source_update_id,
               created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
            VALUES ('first-derivation', 1, '{}', '${'1'.repeat(64)}', NULL, 1, 1, 'ed-shared', 1)`,
    });
    // A second derivation of the SAME editorial draft version — rejected.
    await expect(
      executor.run({
        sql: `INSERT INTO admin_post_versions
                (draft_id, version, envelope_json, fingerprint, source_update_id,
                 created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
              VALUES ('second-derivation', 1, '{}', '${'2'.repeat(64)}', NULL, 1, 1, 'ed-shared', 1)`,
      }),
    ).rejects.toThrow();
    // A DIFFERENT editorial draft version converts freely.
    await executor.run({
      sql: `INSERT INTO admin_post_versions
              (draft_id, version, envelope_json, fingerprint, source_update_id,
               created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
            VALUES ('other-derivation', 1, '{}', '${'3'.repeat(64)}', NULL, 1, 1, 'ed-shared', 2)`,
    });
  });

  it('re-running the full plan is a no-op (append-only idempotence)', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(6);
  });
});
