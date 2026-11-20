import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0011 — autonomous soul stamp (slice 9; schema version 10 → 11).
 * This file has its OWN isolated storage (vitest-pool-workers isolates per
 * test FILE), so it proves the full upgrade path of a POPULATED schema-v10
 * database:
 *
 *  1. apply ONLY migrations 0001..0010 -> a genuine schema-v10 database;
 *  2. apply the real append-only plan -> ONLY 0011 is pending;
 *  3. schema version becomes 11 with the 0011 migration id;
 *  4. the `publications.soul_version` CHECK is enforced at the DATABASE
 *     level (NULL for legacy rows, positive integers for stamped rows,
 *     0/negative refused);
 *  5. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives 0011
 * exclusively through `wrangler d1 migrations apply` with explicit owner
 * approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V10_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 10,
);

const executor = createDbExecutor(db);

async function appliedSchemaVersion(): Promise<number> {
  const row = await executor
    .first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'schema_version'`,
    })
    .catch(() => null);
  return row === null ? 0 : Number.parseInt(row.value, 10);
}

beforeEach(async () => {
  // Build the version-10 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V10 plan is a no-op.
  await applyMigrations(db, V10_ONLY);
  // Upgrade to the real append-only plan — on the first run ONLY 0011 is
  // pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 11.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(11);
});

describe('slice 9 — migration 0011: autonomous soul stamp (schema 10 → 11)', () => {
  it('applies exactly 0011 as the only pending step on a fresh schema-v10 database', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(11);
    expect(await appliedSchemaVersion()).toBe(11);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0011_autonomous_soul_stamp');
  });

  it('accepts NULL and positive soul_version on publications, refuses 0/negative', async () => {
    // A publications row references a story + a draft: seed the minimal
    // parents first (the CHECK under test is on soul_version, not the FKs).
    await executor.run({
      sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type,
              priority, confidence, working_headline,
              first_seen_at, last_evidence_at, version, created_at, updated_at)
            VALUES ('story-0011', 'story-0011', 'discovered', 'official', 'industry',
              50, 0, 'headline', 1, 1, 1, 1, 1)`,
    });
    await executor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title,
              document_json, rendered_html, facts_json, warnings_json, ai_run_id,
              version, created_by, created_at, updated_at)
            VALUES ('draft-0011', 'story-0011', 'ready', 'fa', 'short', 'title',
              '{}', NULL, '[]', '[]', NULL, 1, 'test', 1, 1)`,
    });
    const insertPublication = (id: string, soulVersion: number | null) =>
      executor.run({
        sql: `INSERT INTO publications (id, story_id, draft_id, status, priority,
                approval_mode, scheduled_at, run_after, claimed_at, lease_until,
                published_at, attempts, max_attempts, idempotency_key, last_error,
                created_at, updated_at, soul_version)
              VALUES (?, 'story-0011', 'draft-0011', 'pending', 80, 'auto',
                NULL, 1, NULL, NULL, NULL, 0, 3, ?, NULL, 1, 1, ?)`,
        params: [id, `key-${id}`, soulVersion],
      });
    // Legacy row: NULL soul_version.
    await insertPublication('pub-0011-legacy', null);
    // Stamped row: soul_version 1.
    await insertPublication('pub-0011-stamped', 1);
    // soul_version 0 is refused by the CHECK.
    await expect(insertPublication('pub-0011-zero', 0)).rejects.toThrow();
    // soul_version -1 is refused by the CHECK.
    await expect(insertPublication('pub-0011-negative', -1)).rejects.toThrow();
    const rows = await executor.query<{ id: string; soul_version: number | null }>({
      sql: `SELECT id, soul_version FROM publications ORDER BY id`,
    });
    expect(rows.rows).toEqual([
      { id: 'pub-0011-legacy', soul_version: null },
      { id: 'pub-0011-stamped', soul_version: 1 },
    ]);
  });
});
