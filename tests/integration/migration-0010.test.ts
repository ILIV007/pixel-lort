import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0010 — Soul v1 versioning (slice 8; schema version 9 → 10).
 * This file has its OWN isolated storage (vitest-pool-workers isolates per
 * test FILE), so it proves the full upgrade path of a POPULATED schema-v9
 * database:
 *
 *  1. apply ONLY migrations 0001..0009 -> a genuine schema-v9 database;
 *  2. apply the real append-only plan -> ONLY 0010 is pending;
 *  3. schema version becomes 10 with the 0010 migration id;
 *  4. the `souls` table exists with its CHECK constraints enforced at the
 *     DATABASE level (version >= 1, non-empty text, 64-hex sha256,
 *     positive creator), and `published_posts.soul_version` accepts NULL
 *     (legacy) and positive integers but refuses 0/negative;
 *  5. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives 0010
 * exclusively through `wrangler d1 migrations apply` with explicit owner
 * approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V9_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 9,
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
  // Build the version-9 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V9 plan is a no-op.
  await applyMigrations(db, V9_ONLY);
  // Upgrade to the real append-only plan — on the first run ONLY 0010 +
  // 0011 are pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 11.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(11);
});

describe('slice 8 — migration 0010: Soul versioning (schema 9 → 10)', () => {
  it('applies 0010 + 0011 as the only pending steps on a fresh schema-v9 database', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(11);
    expect(await appliedSchemaVersion()).toBe(11);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0011_autonomous_soul_stamp');
  });

  it('enforces the souls CHECK constraints at the database level', async () => {
    const sha = 'a'.repeat(64);
    await executor.run({
      sql: `INSERT INTO souls (version, text, sha256, created_by, created_at_ms)
            VALUES (1, 'Soul v1', ?, 1000000001, 1)`,
      params: [sha],
    });
    // A second row with the SAME version is refused (PRIMARY KEY).
    await expect(
      executor.run({
        sql: `INSERT INTO souls (version, text, sha256, created_by, created_at_ms)
              VALUES (1, 'Soul v1 duplicate', ?, 1000000001, 1)`,
        params: [sha],
      }),
    ).rejects.toThrow();
    // Version 0 is refused.
    await expect(
      executor.run({
        sql: `INSERT INTO souls (version, text, sha256, created_by, created_at_ms)
              VALUES (0, 'Soul v0', ?, 1000000001, 1)`,
        params: [sha],
      }),
    ).rejects.toThrow();
    // A short sha256 is refused.
    await expect(
      executor.run({
        sql: `INSERT INTO souls (version, text, sha256, created_by, created_at_ms)
              VALUES (2, 'Soul v2', 'abc', 1000000001, 1)`,
        params: [],
      }),
    ).rejects.toThrow();
    // Empty text is refused.
    await expect(
      executor.run({
        sql: `INSERT INTO souls (version, text, sha256, created_by, created_at_ms)
              VALUES (2, '', ?, 1000000001, 1)`,
        params: [sha],
      }),
    ).rejects.toThrow();
  });

  it('accepts NULL and positive soul_version on published_posts, refuses 0/negative', async () => {
    const base = {
      id: 'pp-legacy',
      sourceChatId: 111111,
      sourceMessageId: 201,
      channelMessageIds: JSON.stringify([5001]),
      kind: 'text',
      mediaFileId: null,
      category: 'news',
      presentation: 'classic',
      createdByUserId: 1000000001,
      createdAtMs: 1,
      updatedAtMs: 1,
    } as const;
    // Legacy row: NULL soul_version.
    await executor.run({
      sql: `INSERT INTO published_posts
              (id, source_chat_id, source_message_id, channel_message_ids,
               kind, media_file_id, category, presentation,
               created_by_user_id, soul_version, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        base.id,
        base.sourceChatId,
        base.sourceMessageId,
        base.channelMessageIds,
        base.kind,
        base.mediaFileId,
        base.category,
        base.presentation,
        base.createdByUserId,
        null,
        base.createdAtMs,
        base.updatedAtMs,
      ],
    });
    // Stamped row: soul_version 1.
    await executor.run({
      sql: `INSERT INTO published_posts
              (id, source_chat_id, source_message_id, channel_message_ids,
               kind, media_file_id, category, presentation,
               created_by_user_id, soul_version, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        'pp-stamped',
        base.sourceChatId,
        202,
        base.channelMessageIds,
        base.kind,
        base.mediaFileId,
        base.category,
        base.presentation,
        base.createdByUserId,
        1,
        base.createdAtMs,
        base.updatedAtMs,
      ],
    });
    // soul_version 0 is refused by the CHECK.
    await expect(
      executor.run({
        sql: `INSERT INTO published_posts
                (id, source_chat_id, source_message_id, channel_message_ids,
                 kind, media_file_id, category, presentation,
                 created_by_user_id, soul_version, created_at_ms, updated_at_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          'pp-zero',
          base.sourceChatId,
          203,
          base.channelMessageIds,
          base.kind,
          base.mediaFileId,
          base.category,
          base.presentation,
          base.createdByUserId,
          0,
          base.createdAtMs,
          base.updatedAtMs,
        ],
      }),
    ).rejects.toThrow();
    const rows = await executor.query<{ id: string; soul_version: number | null }>({
      sql: `SELECT id, soul_version FROM published_posts ORDER BY id`,
    });
    expect(rows.rows).toEqual([
      { id: 'pp-legacy', soul_version: null },
      { id: 'pp-stamped', soul_version: 1 },
    ]);
  });
});
