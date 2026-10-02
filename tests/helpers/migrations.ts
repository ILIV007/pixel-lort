import migration0001 from '../../migrations/0001_initial_schema.sql?raw';
import migration0002Synthetic from '../fixtures/migration-0002-synthetic.sql?raw';

/**
 * TEST INFRASTRUCTURE — migration application helper for the workerd test
 * environment (Phase 1A).
 *
 * This module is NOT part of the shipped worker. It exists only to
 * materialize the schema inside the vitest/workerd D1 test environment.
 * REMOTE/production migration bookkeeping remains the exclusive
 * responsibility of `wrangler d1 migrations` commands and their
 * `d1_migrations` table, which this helper intentionally never touches
 * (ADR-0019).
 *
 * Design (future-safe, incremental):
 * - Every migration descriptor carries its TARGET schema version.
 * - The currently applied APPLICATION schema version is read safely from
 *   `schema_metadata` (0 when the table/row does not exist yet).
 * - Only migrations with a version GREATER than the observed version are
 *   applied, in strict ascending order — so appending a future `0002_*`
 *   migration to `MIGRATIONS` upgrades a version-1 database instead of being
 *   silently skipped (which could hide migration defects).
 * - Re-running the helper at the latest version is a no-op.
 * - Plans are validated BEFORE any database access; an invalid plan can
 *   never alter the database (see `validateMigrationPlan`).
 * - Each migration is applied as ONE atomic `db.batch()` (D1 batches are
 *   implicit transactions): a failed migration rolls back completely and
 *   leaves the database at its previous version.
 *
 * Mechanism note: D1's `exec()` cannot reliably execute multi-line
 * statements, so each migration file is split into individual statements and
 * applied as one atomic `db.batch()` — mirroring how
 * `wrangler d1 migrations apply` runs a migration file as a single unit. The
 * blueprint-derived SQL contains no semicolons inside string literals and no
 * triggers, so a strict split on `;` is safe here (the schema tests pin the
 * resulting table/index sets, so any mis-split fails loudly).
 */

export interface MigrationDescriptor {
  /** Migration identifier, matching the file name convention `NNNN_name`. */
  readonly id: string;
  /** Target application schema version AFTER this migration is applied. */
  readonly version: number;
  /** Raw migration SQL, imported at build time via Vite `?raw`. */
  readonly sql: string;
}

/**
 * Ordered migration list — APPEND-ONLY and strictly ascending by version
 * (AGENTS.md §6: applied migrations are never edited or reordered; new
 * schema changes append `0002_*.sql` and newer).
 *
 * TEST-ONLY synthetic descriptors (see
 * `tests/fixtures/migration-0002-synthetic.sql`) are injected via the `plan`
 * parameter of `applyMigrations` — they are NEVER added to this list.
 */
export const MIGRATIONS: readonly MigrationDescriptor[] = [
  { id: '0001_initial_schema', version: 1, sql: migration0001 },
];

/** Synthetic version-2 descriptor — TEST INFRASTRUCTURE ONLY. */
export const SYNTHETIC_MIGRATION_0002: MigrationDescriptor = {
  id: 'test_0002_synthetic',
  version: 2,
  sql: migration0002Synthetic,
};

/** Stable reason codes for invalid migration plans. */
export type MigrationPlanIssueCode =
  'empty_plan' | 'invalid_version' | 'duplicate_version' | 'non_ascending_versions' | 'version_gap';

/**
 * Thrown BEFORE any database access when a migration plan is structurally
 * invalid. Carries a stable machine-readable `code`; messages contain only
 * indexes, identifiers, and version numbers — never SQL content.
 */
export class MigrationPlanError extends Error {
  readonly code: MigrationPlanIssueCode;

  constructor(code: MigrationPlanIssueCode, message: string) {
    super(message);
    this.name = 'MigrationPlanError';
    this.code = code;
  }
}

/**
 * Validate a migration plan WITHOUT touching the database.
 *
 * Rules:
 * - the plan must not be empty;
 * - every descriptor must target a positive integer version
 *   (`invalid_version`);
 * - versions must be unique (`duplicate_version`);
 * - versions must be strictly ascending in list order
 *   (`non_ascending_versions`);
 * - strict continuity is expected: versions must be exactly `1..N`
 *   (`version_gap`) — an append-only migration history cannot have holes.
 */
export function validateMigrationPlan(plan: readonly MigrationDescriptor[]): void {
  if (plan.length === 0) {
    throw new MigrationPlanError(
      'empty_plan',
      'migration plan must contain at least one migration',
    );
  }
  for (const [index, migration] of plan.entries()) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new MigrationPlanError(
        'invalid_version',
        `migration at index ${index} (${migration.id}) must target a positive integer schema version`,
      );
    }
  }
  for (const [index, migration] of plan.entries()) {
    const previous = index > 0 ? plan[index - 1] : undefined;
    if (previous !== undefined && previous.version === migration.version) {
      throw new MigrationPlanError(
        'duplicate_version',
        `migration plan contains duplicate target version ${migration.version}`,
      );
    }
  }
  for (const [index, migration] of plan.entries()) {
    const previous = index > 0 ? plan[index - 1] : undefined;
    if (previous !== undefined && previous.version > migration.version) {
      throw new MigrationPlanError(
        'non_ascending_versions',
        `migration plan is not strictly ascending at index ${index} (${migration.id})`,
      );
    }
  }
  for (const [index, migration] of plan.entries()) {
    if (migration.version !== index + 1) {
      throw new MigrationPlanError(
        'version_gap',
        `strict continuity expected: migration at index ${index} must target version ${index + 1} (got ${migration.version})`,
      );
    }
  }
}

export interface MigrationApplyResult {
  /** Application schema version observed BEFORE applying (0 = fresh DB). */
  readonly observedVersion: number;
  /** Migrations actually applied, in application order (empty = no-op). */
  readonly applied: readonly MigrationDescriptor[];
  /** Application schema version after the call returns. */
  readonly finalVersion: number;
}

/**
 * Read the currently applied APPLICATION schema version safely.
 *
 * - `schema_metadata` table or row missing (fresh database) -> 0.
 * - Corrupt/unparsable version value -> MigrationPlanError (fail loud; never
 *   guess a version and never re-apply migrations over unknown state).
 * - Unexpected driver failures propagate (fail loud).
 */
async function readAppliedSchemaVersion(db: D1Database): Promise<number> {
  let row: { value: string } | null;
  try {
    row = await db
      .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
      .first<{ value: string }>();
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return 0;
    }
    throw error;
  }
  if (row === null) {
    return 0;
  }
  const parsed = Number.parseInt(row.value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MigrationPlanError(
      'invalid_version',
      'applied schema_metadata.schema_version is corrupt (expected a positive integer)',
    );
  }
  return parsed;
}

/** Strip `--` comment lines and split into non-empty statements. */
export function splitSqlStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Apply PENDING migrations (target version > observed version) in strict
 * ascending order to the given D1 database.
 *
 * - Defaults to the real append-only `MIGRATIONS` list; tests may inject a
 *   synthetic plan (e.g. including the version-2 synthetic descriptor).
 * - The plan is validated FIRST — an invalid plan throws before the database
 *   is touched at all.
 * - At the latest version this is a no-op (empty `applied` list).
 * - Each migration runs as ONE atomic batch; a failed migration rolls back
 *   completely and the error propagates, leaving the database at the previous
 *   version.
 */
export async function applyMigrations(
  db: D1Database,
  plan: readonly MigrationDescriptor[] = MIGRATIONS,
): Promise<MigrationApplyResult> {
  validateMigrationPlan(plan);

  const observedVersion = await readAppliedSchemaVersion(db);
  const pending = plan.filter((migration) => migration.version > observedVersion);

  for (const migration of pending) {
    const statements = splitSqlStatements(migration.sql).map((statement) => db.prepare(statement));
    // One atomic transaction per migration — D1 batches roll back completely
    // on failure, so the database stays at its previous version.
    await db.batch(statements);
  }

  return {
    observedVersion,
    applied: pending,
    finalVersion: pending.length > 0 ? pending[pending.length - 1]!.version : observedVersion,
  };
}
