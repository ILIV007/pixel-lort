import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0007 — the inbound AI-admin pipeline (slice 4; schema version
 * 7). This file has its OWN isolated storage (vitest-pool-workers isolates
 * per test FILE), so it proves the full upgrade path of a POPULATED
 * schema-v6 database:
 *
 *  1. apply ONLY migrations 0001..0006 -> a genuine schema-v6 database;
 *  2. apply the real append-only plan -> ONLY 0007 is pending;
 *  3. schema version becomes 7 with the 0007 migration id;
 *  4. `published_posts` admits one row per source message (UNIQUE index)
 *     and rejects a second row for the same source message;
 *  5. `inbound_approvals` admits one PENDING approval per source message
 *     (partial UNIQUE index) and admits a second pending row once the
 *     first is decided;
 *  6. the CHECKs reject invalid kind / state / presentation / fingerprint
 *     at the DATABASE level;
 *  7. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives 0007
 * exclusively through `wrangler d1 migrations apply` with explicit owner
 * approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V6_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 6,
);

// Slice 5: the chain continues past 0007 (0008_live_watchlists), so the
// "only 0007 pending" proof below uses the V7-capped plan, not the full
// default plan.
const V7_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 7,
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

// Slice 5: the first test below advances the shared per-file database to
// version 8 (the full plan continues past 0007 with exactly 0008). Later
// tests' beforeEach therefore sees finalVersion 8, not 7 — the flag keeps
// the version assertion honest about which state the file is in.
let fullPlanApplied = false;

beforeEach(async () => {
  // Build the version-6 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V6 plan is a no-op.
  await applyMigrations(db, V6_ONLY);
  // Upgrade to the V7-capped plan — on the first run ONLY 0007 is
  // pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 7 (the full default plan continues to 8;
  // see the first test below) — unless the first test already advanced
  // the shared database to 8, in which case the capped plan is a no-op
  // at version 8.
  const upgrade = await applyMigrations(db, V7_ONLY);
  expect(upgrade.finalVersion).toBe(fullPlanApplied ? 8 : 7);
});

describe('slice 4 — migration 0007: inbound pipeline tables (schema 6 → 7)', () => {
  it('applies exactly 0007 as the only pending step on a fresh schema-v6 database', async () => {
    const rerun = await applyMigrations(db, V7_ONLY);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(7);
    expect(await appliedSchemaVersion()).toBe(7);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0007_inbound_pipeline');
    // The full default plan continues the linear chain past 0007: exactly
    // 0008 is pending and the database lands at version 8.
    const full = await applyMigrations(db);
    expect(full.applied.map((migration) => migration.id)).toEqual(['0008_live_watchlists']);
    expect(full.finalVersion).toBe(8);
    expect(await appliedSchemaVersion()).toBe(8);
    // The shared per-file database is now at version 8; later tests'
    // beforeEach must expect 8, not 7.
    fullPlanApplied = true;
  });

  it('admits one published post per source message and rejects a second row for the same source', async () => {
    await executor.run({
      sql: `INSERT INTO published_posts
              (id, source_chat_id, source_message_id, channel_message_ids,
               kind, media_file_id, category, presentation,
               created_by_user_id, created_at_ms, updated_at_ms)
            VALUES ('pp-1', 111, 42, '[1001]', 'text', NULL, 'trailer', 'classic', 1, 1, 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO published_posts
                (id, source_chat_id, source_message_id, channel_message_ids,
                 kind, media_file_id, category, presentation,
                 created_by_user_id, created_at_ms, updated_at_ms)
              VALUES ('pp-2', 111, 42, '[1002]', 'text', NULL, 'trailer', 'classic', 1, 1, 1)`,
      }),
    ).rejects.toThrow();
    // A different source message in the same chat is fine.
    await executor.run({
      sql: `INSERT INTO published_posts
              (id, source_chat_id, source_message_id, channel_message_ids,
               kind, media_file_id, category, presentation,
               created_by_user_id, created_at_ms, updated_at_ms)
            VALUES ('pp-3', 111, 43, '[1003]', 'photo', 'file-1', 'patch', 'rich', 1, 1, 1)`,
    });
  });

  it('admits one pending approval per source message, and a new pending row once the first is decided', async () => {
    const fingerprint = 'c'.repeat(64);
    await executor.run({
      sql: `INSERT INTO inbound_approvals
              (id, source_chat_id, source_message_id, source_update_id,
               created_by_user_id, content_json, fingerprint, category,
               presentation, state, expires_at_ms, created_at_ms, updated_at_ms)
            VALUES ('ia-1', 222, 7, 9001, 1, '{}', '${fingerprint}', 'leak', 'classic', 'pending', 9999999999999, 1, 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO inbound_approvals
                (id, source_chat_id, source_message_id, source_update_id,
                 created_by_user_id, content_json, fingerprint, category,
                 presentation, state, expires_at_ms, created_at_ms, updated_at_ms)
              VALUES ('ia-2', 222, 7, 9002, 1, '{}', '${fingerprint}', 'leak', 'classic', 'pending', 9999999999999, 1, 1)`,
      }),
    ).rejects.toThrow();
    // Decide the first row, then a second pending row is admitted.
    await executor.run({
      sql: `UPDATE inbound_approvals SET state = 'rejected', updated_at_ms = 2 WHERE id = 'ia-1'`,
    });
    await executor.run({
      sql: `INSERT INTO inbound_approvals
              (id, source_chat_id, source_message_id, source_update_id,
               created_by_user_id, content_json, fingerprint, category,
               presentation, state, expires_at_ms, created_at_ms, updated_at_ms)
            VALUES ('ia-3', 222, 7, 9003, 1, '{}', '${fingerprint}', 'leak', 'classic', 'pending', 9999999999999, 1, 1)`,
    });
  });

  it('rejects invalid kind, state, presentation and fingerprint at the database level', async () => {
    const fingerprint = 'd'.repeat(64);
    // Invalid published_posts kind.
    await expect(
      executor.run({
        sql: `INSERT INTO published_posts
                (id, source_chat_id, source_message_id, channel_message_ids,
                 kind, media_file_id, category, presentation,
                 created_by_user_id, created_at_ms, updated_at_ms)
              VALUES ('pp-bad-kind', 333, 1, '[1]', 'album', NULL, 'news', 'classic', 1, 1, 1)`,
      }),
    ).rejects.toThrow();
    // Invalid published_posts presentation.
    await expect(
      executor.run({
        sql: `INSERT INTO published_posts
                (id, source_chat_id, source_message_id, channel_message_ids,
                 kind, media_file_id, category, presentation,
                 created_by_user_id, created_at_ms, updated_at_ms)
              VALUES ('pp-bad-pres', 333, 2, '[1]', 'text', NULL, 'news', 'fancy', 1, 1, 1)`,
      }),
    ).rejects.toThrow();
    // Invalid approval state.
    await expect(
      executor.run({
        sql: `INSERT INTO inbound_approvals
                (id, source_chat_id, source_message_id, source_update_id,
                 created_by_user_id, content_json, fingerprint, category,
                 presentation, state, expires_at_ms, created_at_ms, updated_at_ms)
              VALUES ('ia-bad-state', 333, 3, 1, 1, '{}', '${fingerprint}', 'news', 'classic', 'waiting', 9999999999999, 1, 1)`,
      }),
    ).rejects.toThrow();
    // Short fingerprint (not 64 chars).
    await expect(
      executor.run({
        sql: `INSERT INTO inbound_approvals
                (id, source_chat_id, source_message_id, source_update_id,
                 created_by_user_id, content_json, fingerprint, category,
                 presentation, state, expires_at_ms, created_at_ms, updated_at_ms)
              VALUES ('ia-bad-fp', 333, 4, 1, 1, '{}', 'abc', 'news', 'classic', 'pending', 9999999999999, 1, 1)`,
      }),
    ).rejects.toThrow();
  });
});
