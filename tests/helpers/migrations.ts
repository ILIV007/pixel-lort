import migration0001 from '../../migrations/0001_initial_schema.sql?raw';

/**
 * Migration application helper for the workerd test environment (Phase 1A).
 *
 * D1's `exec()` cannot reliably execute multi-line statements, so each
 * migration file is split into individual statements and applied as one
 * ATOMIC `db.batch()` — mirroring how `wrangler d1 migrations apply` runs a
 * migration file as a single unit.
 *
 * The blueprint-derived SQL contains no semicolons inside string literals
 * and no triggers, so a strict split on `;` is safe here (the schema tests
 * pin the resulting table/index sets, so any mis-split fails loudly).
 *
 * Wrangler's own migration bookkeeping (`d1_migrations`) is intentionally
 * NOT touched: it belongs to wrangler migration commands, while this helper
 * exists only to materialize the schema for tests (ADR-0019).
 */

export interface AppliedMigration {
  /** Migration identifier, matching the file name convention `NNNN_name`. */
  readonly id: string;
  /** Raw migration SQL, imported at build time via Vite `?raw`. */
  readonly sql: string;
}

/** Ordered migration list — append-only, mirrors migrations/ directory. */
export const MIGRATIONS: readonly AppliedMigration[] = [
  { id: '0001_initial_schema', sql: migration0001 },
];

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
 * Apply all migrations in order to the given D1 database.
 * Idempotent within a storage scope: skips when the application metadata
 * row is already present (storage isolation semantics differ between
 * vitest-pool-workers configurations).
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  const existing = await db
    .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
    .first<{ value: string }>()
    .catch(() => null);
  if (existing !== null) {
    return;
  }
  for (const migration of MIGRATIONS) {
    const statements = splitSqlStatements(migration.sql).map((statement) => db.prepare(statement));
    await db.batch(statements);
  }
}
