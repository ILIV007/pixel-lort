import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  MIGRATIONS,
  MigrationPlanError,
  applyMigrations,
  type MigrationDescriptor,
} from '../helpers/migrations';

/**
 * Migration failure-atomicity and invalid-plan contract tests (Phase 1A
 * correction — review item 2, proofs 6 and 7).
 *
 * These tests need a FRESH database (no migrations applied), so they live in
 * their own file: vitest-pool-workers isolates storage per test FILE, and
 * `migration-plan.test.ts` intentionally advances its shared database to
 * version 2. Within THIS file the database starts empty; the tests below are
 * ordered so that no test applies a valid migration before the invalid-plan
 * proofs run.
 *
 * Proofs:
 *  6. a failed pending migration rolls back ATOMICALLY (no partial state)
 *     and the database stays at its previous version, which can still be
 *     upgraded afterwards (recovery path);
 *  7. invalid plans (gaps, duplicates, non-ascending, invalid versions) fail
 *     BEFORE altering the database.
 */

const db: D1Database = env.DB;

/** The real approved migrations (0001 = schema v1; 0002 = lifecycle, schema v2). */
const V1 = MIGRATIONS[0]!;

/** A deliberately broken pending migration: statement 3 fails. */
const BROKEN_V2: MigrationDescriptor = {
  id: 'test_0002_broken',
  version: 2,
  sql: [
    'CREATE TABLE migration_v2_broken (id TEXT PRIMARY KEY)',
    "INSERT INTO migration_v2_broken (id) VALUES ('partial-state-marker')",
    'INSERT INTO this_table_was_never_created (id) VALUES (1)',
  ].join(';\n'),
};

async function appliedSchemaVersion(): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
    .first<{ value: string }>()
    .catch(() => null);
  return row === null ? 0 : Number.parseInt(row.value, 10);
}

async function appliedMigrationId(): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM schema_metadata WHERE key = 'migration_id'`)
    .first<{ value: string }>()
    .catch(() => null);
  return row?.value ?? null;
}

async function userTableNames(): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '_cf\\_%' ESCAPE '\\'
         AND name NOT LIKE 'd1\\_migrations' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  return result.results.map((row) => row['name']!);
}

describe('applyMigrations — invalid plans never alter the database (proof 7)', () => {
  it('fails for a gapped plan BEFORE any database access (fresh database stays empty)', async () => {
    // First database access in this file: storage isolation guarantees an
    // empty database here, so "still empty" is a strict no-alteration proof.
    const gapPlan: readonly MigrationDescriptor[] = [
      V1,
      { id: 'test_0003_gap', version: 3, sql: 'SELECT 1' },
    ];

    await expect(applyMigrations(db, gapPlan)).rejects.toThrowError(MigrationPlanError);

    expect(await userTableNames()).toEqual([]);
    expect(await appliedSchemaVersion()).toBe(0);
  });

  it('fails for duplicate, non-ascending, and invalid-version plans BEFORE any database access', async () => {
    const tablesBefore = await userTableNames();
    const versionBefore = await appliedSchemaVersion();

    const duplicate: readonly MigrationDescriptor[] = [V1, { ...V1 }];
    const nonAscending: readonly MigrationDescriptor[] = [
      { id: 'test_0002', version: 2, sql: 'SELECT 1' },
      V1,
    ];
    const invalidVersion: readonly MigrationDescriptor[] = [
      V1,
      { id: 'bad', version: 0, sql: 'SELECT 1' },
    ];

    await expect(applyMigrations(db, duplicate)).rejects.toMatchObject({
      code: 'duplicate_version',
    });
    await expect(applyMigrations(db, nonAscending)).rejects.toMatchObject({
      code: 'non_ascending_versions',
    });
    await expect(applyMigrations(db, invalidVersion)).rejects.toMatchObject({
      code: 'invalid_version',
    });

    // Database state is bit-for-bit identical to before the rejected calls.
    expect(await userTableNames()).toEqual(tablesBefore);
    expect(await appliedSchemaVersion()).toBe(versionBefore);
  });
});

describe('applyMigrations — failure atomicity (proof 6)', () => {
  it('rolls back a failed pending migration completely, keeping the previous version', async () => {
    // Build a genuine version-1 database (partial plan — nothing applied
    // before this in this file).
    await applyMigrations(db, [V1]);

    await expect(applyMigrations(db, [V1, BROKEN_V2])).rejects.toThrowError();

    // The failed migration left NO partial state: its first two statements
    // (CREATE TABLE + INSERT) were rolled back together with the batch.
    await expect(db.prepare(`SELECT * FROM migration_v2_broken`).all()).rejects.toThrowError(
      /no such table/i,
    );
    expect(await appliedSchemaVersion()).toBe(1);
    expect(await appliedMigrationId()).toBe('0001_initial_schema');

    // Version-1 objects are intact and the database can still be upgraded by
    // a valid pending migration afterwards (recovery path) — here via the
    // REAL migration 0002, landing at the shipped schema version 2.
    const recovery = await applyMigrations(db);
    expect(recovery.observedVersion).toBe(1);
    expect(recovery.applied.map((migration) => migration.id)).toEqual([
      '0002_telegram_update_lifecycle',
    ]);
    expect(await appliedSchemaVersion()).toBe(2);
    expect(await appliedMigrationId()).toBe('0002_telegram_update_lifecycle');
  });
});
