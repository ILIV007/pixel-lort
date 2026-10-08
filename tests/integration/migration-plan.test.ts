import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  MIGRATIONS,
  SYNTHETIC_MIGRATION_0002,
  MigrationPlanError,
  applyMigrations,
  validateMigrationPlan,
  type MigrationDescriptor,
} from '../helpers/migrations';

/**
 * Append-only migration-plan contract tests (Phase 1A correction — review
 * item 2; extended for the REAL migration 0002 in the Phase 2A second
 * correction round, schema v2).
 *
 * The test migration helper applies only PENDING migrations in strict
 * ascending order: a database already at version 1 must UPGRADE by applying
 * only the pending version-2 migration, never re-apply version 1, and a
 * re-run at the latest version must be a no-op. The synthetic TEST-ONLY
 * version-2 descriptor (`tests/fixtures/migration-0002-synthetic.sql`)
 * proves the helper's plan mechanics independently of the real migration;
 * the REAL v1 -> v2 upgrade of a POPULATED database is proven in
 * `tests/integration/migration-0002.test.ts`, and the real plan's end state
 * on a fresh database is pinned by `tests/integration/d1-schema.test.ts`.
 *
 * Proofs in this file:
 *  1. version 1 applies to an empty DB (partial plan);
 *  2. the pending version 2 applies to a version-1 DB (synthetic descriptor);
 *  3. version 1 is not reapplied;
 *  4. re-running at the latest version is a no-op (real AND synthetic plans);
 *  5. metadata advances to version 2.
 *
 * Failure atomicity (proof 6) and invalid-plan (proof 7) proofs live in
 * `tests/integration/migration-plan-failures.test.ts` — a separate FILE,
 * because vitest-pool-workers isolates storage per test FILE and this file
 * intentionally advances its shared database from version 1 to version 2.
 */

const db: D1Database = env.DB;

/** The real approved migrations (0001 = schema v1; 0002 = lifecycle, schema v2). */
const V1 = MIGRATIONS[0]!;
const REAL_V2 = MIGRATIONS[1]!;

/** A plan with the synthetic TEST-ONLY version-2 migration appended. */
const PLAN_V1_SYNTHETIC_V2: readonly MigrationDescriptor[] = [V1, SYNTHETIC_MIGRATION_0002];

/** A plan containing ONLY migration 0001 (for building version-1 databases). */
const PLAN_V1_ONLY: readonly MigrationDescriptor[] = [V1];

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

describe('migration plan validation (pure — no database access)', () => {
  it('accepts the real append-only MIGRATIONS list (guards the shipped default)', () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual([
      '0001_initial_schema',
      '0002_telegram_update_lifecycle',
    ]);
    expect(REAL_V2.version).toBe(2);
    expect(() => validateMigrationPlan(MIGRATIONS)).not.toThrow();
    expect(() => validateMigrationPlan(PLAN_V1_SYNTHETIC_V2)).not.toThrow();
  });

  it('rejects an empty plan', () => {
    expect(() => validateMigrationPlan([])).toThrowError(MigrationPlanError);
    try {
      validateMigrationPlan([]);
      expect.unreachable('empty plan must throw');
    } catch (error) {
      expect((error as MigrationPlanError).code).toBe('empty_plan');
    }
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-positive or non-integer target version %p',
    (version) => {
      const plan: readonly MigrationDescriptor[] = [{ id: 'bad', version, sql: 'SELECT 1' }];
      expect(() => validateMigrationPlan(plan)).toThrowError(MigrationPlanError);
      try {
        validateMigrationPlan(plan);
        expect.unreachable('invalid version must throw');
      } catch (error) {
        expect((error as MigrationPlanError).code).toBe('invalid_version');
      }
    },
  );

  it('rejects duplicate target versions', () => {
    const plan: readonly MigrationDescriptor[] = [
      { id: 'a', version: 1, sql: 'SELECT 1' },
      { id: 'b', version: 1, sql: 'SELECT 2' },
    ];
    try {
      validateMigrationPlan(plan);
      expect.unreachable('duplicate version must throw');
    } catch (error) {
      expect((error as MigrationPlanError).code).toBe('duplicate_version');
    }
  });

  it('rejects non-ascending versions', () => {
    const plan: readonly MigrationDescriptor[] = [
      { id: 'a', version: 2, sql: 'SELECT 1' },
      { id: 'b', version: 1, sql: 'SELECT 2' },
    ];
    try {
      validateMigrationPlan(plan);
      expect.unreachable('non-ascending plan must throw');
    } catch (error) {
      expect((error as MigrationPlanError).code).toBe('non_ascending_versions');
    }
  });

  it('rejects unexpected gaps when strict continuity is expected', () => {
    const plan: readonly MigrationDescriptor[] = [
      { id: 'a', version: 1, sql: 'SELECT 1' },
      { id: 'b', version: 3, sql: 'SELECT 2' },
    ];
    try {
      validateMigrationPlan(plan);
      expect.unreachable('gapped plan must throw');
    } catch (error) {
      expect((error as MigrationPlanError).code).toBe('version_gap');
    }
  });
});

describe('applyMigrations — incremental, future-safe semantics', () => {
  it('applies version 1 to an empty database via the partial plan (proof 1)', async () => {
    const result = await applyMigrations(db, PLAN_V1_ONLY);

    expect(result.observedVersion).toBe(0);
    expect(result.applied.map((migration) => migration.id)).toEqual(['0001_initial_schema']);
    expect(result.finalVersion).toBe(1);
    expect(await appliedSchemaVersion()).toBe(1);
    expect(await appliedMigrationId()).toBe('0001_initial_schema');
  });

  it('upgrades the version-1 database by applying ONLY the pending version 2 (proofs 2, 3, 5)', async () => {
    // Sentinel row: if version 1 were re-executed, this state would be
    // disturbed (and its CREATE TABLE statements would fail loudly).
    await db
      .prepare(
        `INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, approval_policy, created_at, updated_at)
         VALUES ('src-plan-sentinel', 'Plan Sentinel', 'rss', 'radar', 50, 300, 'auto', 1, 1)`,
      )
      .run();

    const result = await applyMigrations(db, PLAN_V1_SYNTHETIC_V2);

    // Proof 3: only the PENDING migration was applied — version 1 skipped.
    expect(result.observedVersion).toBe(1);
    expect(result.applied.map((migration) => migration.id)).toEqual(['test_0002_synthetic']);
    expect(result.finalVersion).toBe(2);

    // Proof 2: the synthetic version-2 migration took effect.
    const probe = await db
      .prepare(`SELECT note FROM migration_v2_probe WHERE id = 'probe'`)
      .first<{ note: string }>();
    expect(probe?.note).toBe('applied by synthetic version 2');

    // Proof 5: application metadata advanced to version 2.
    expect(await appliedSchemaVersion()).toBe(2);
    expect(await appliedMigrationId()).toBe('test_0002_synthetic');

    // Sentinel survived untouched — version 1's schema was not re-run.
    const sentinel = await db
      .prepare(`SELECT id FROM sources WHERE id = 'src-plan-sentinel'`)
      .first<{ id: string }>();
    expect(sentinel?.id).toBe('src-plan-sentinel');
  });

  it('re-running at the latest version is a no-op — nothing is reapplied (proof 4)', async () => {
    await applyMigrations(db, PLAN_V1_SYNTHETIC_V2); // database at version 2

    const again = await applyMigrations(db, PLAN_V1_SYNTHETIC_V2);
    const andAgain = await applyMigrations(db, MIGRATIONS);

    expect(again.observedVersion).toBe(2);
    expect(again.applied).toEqual([]);
    expect(again.finalVersion).toBe(2);
    expect(andAgain.observedVersion).toBe(2);
    expect(andAgain.applied).toEqual([]);
    expect(andAgain.finalVersion).toBe(2);

    // No duplicate probe rows: the version-2 statements did not run again.
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM migration_v2_probe`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
    expect(await appliedSchemaVersion()).toBe(2);
  });
});
