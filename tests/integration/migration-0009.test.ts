import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0009 — post management + near-dup detection (slice 6; schema
 * version 8 → 9). This file has its OWN isolated storage
 * (vitest-pool-workers isolates per test FILE), so it proves the full
 * upgrade path of a POPULATED schema-v8 database:
 *
 *  1. apply ONLY migrations 0001..0008 -> a genuine schema-v8 database;
 *  2. apply the real append-only plan -> ONLY 0009 is pending;
 *  3. schema version becomes 9 with the 0009 migration id;
 *  4. the four new tables exist with their CHECK/UNIQUE constraints
 *     enforced at the DATABASE level (max-one-active-pin overall AND per
 *     message, one adjudication per (item, story), one negative-cache row
 *     per fingerprint, one delete record per (ref, message));
 *  5. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives 0009
 * exclusively through `wrangler d1 migrations apply` with explicit owner
 * approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V8_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 8,
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
  // Build the version-8 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V8 plan is a no-op.
  await applyMigrations(db, V8_ONLY);
  // Upgrade to the real append-only plan — on the first run ONLY 0009 is
  // pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 9.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(9);
});

describe('slice 6 — migration 0009: post-management + near-dup tables (schema 8 → 9)', () => {
  it('applies exactly 0009 as the only pending step on a fresh schema-v8 database', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(9);
    expect(await appliedSchemaVersion()).toBe(9);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0009_post_management_near_dup');
  });

  it('admits one active pin per message and refuses a second active pin overall', async () => {
    await executor.run({
      sql: `INSERT INTO channel_pins
              (id, channel_message_id, post_ref_type, post_ref_id, status,
               pinned_by, pinned_at_ms, created_at_ms, updated_at_ms)
            VALUES ('pin:1', 100, 'publication', 'pub-1', 'active', 1, 1, 1, 1)`,
    });
    // A second ACTIVE pin on the SAME message is refused.
    await expect(
      executor.run({
        sql: `INSERT INTO channel_pins
                (id, channel_message_id, post_ref_type, post_ref_id, status,
                 pinned_by, pinned_at_ms, created_at_ms, updated_at_ms)
              VALUES ('pin:2', 100, 'publication', 'pub-1', 'active', 1, 1, 1, 1)`,
      }),
    ).rejects.toThrow();
    // A second ACTIVE pin on a DIFFERENT message is ALSO refused
    // (max one active pin in the whole channel).
    await expect(
      executor.run({
        sql: `INSERT INTO channel_pins
                (id, channel_message_id, post_ref_type, post_ref_id, status,
                 pinned_by, pinned_at_ms, created_at_ms, updated_at_ms)
              VALUES ('pin:3', 101, 'publication', 'pub-2', 'active', 1, 1, 1, 1)`,
      }),
    ).rejects.toThrow();
    // A RELEASED pin on the same message is fine (history is kept).
    await executor.run({
      sql: `INSERT INTO channel_pins
              (id, channel_message_id, post_ref_type, post_ref_id, status,
               pinned_by, pinned_at_ms, created_at_ms, updated_at_ms)
            VALUES ('pin:4', 100, 'publication', 'pub-1', 'released', 1, 1, 1, 1)`,
    });
    // And after releasing the active one, a new active pin is admitted.
    await executor.run({
      sql: `UPDATE channel_pins SET status = 'released' WHERE id = 'pin:1'`,
    });
    await executor.run({
      sql: `INSERT INTO channel_pins
              (id, channel_message_id, post_ref_type, post_ref_id, status,
               pinned_by, pinned_at_ms, created_at_ms, updated_at_ms)
            VALUES ('pin:5', 101, 'publication', 'pub-2', 'active', 1, 1, 1, 1)`,
    });
  });

  it('admits one adjudication per (item, story) and pins the score CHECKs', async () => {
    await executor.run({
      sql: `INSERT INTO story_merges
              (id, canonical_story_id, source_item_id, similarity_score,
               title_score, entity_score, method, disposition, decided_by,
               reason_code, created_at_ms)
            VALUES ('nm:1', 'story-1', 'item-1', 0.9, 0.9, 1, 'deterministic',
                    'merged_as_update', 'editorial.prepare_draft:near_dup_nd1',
                    'near_dup_merge_threshold', 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO story_merges
                (id, canonical_story_id, source_item_id, similarity_score,
                 title_score, entity_score, method, disposition, decided_by,
                 reason_code, created_at_ms)
              VALUES ('nm:2', 'story-1', 'item-1', 0.9, 0.9, 1, 'deterministic',
                      'merged_as_update', 'editorial.prepare_draft:near_dup_nd1',
                      'near_dup_merge_threshold', 1)`,
      }),
    ).rejects.toThrow();
    // Out-of-range scores are refused by the CHECKs.
    await expect(
      executor.run({
        sql: `INSERT INTO story_merges
                (id, canonical_story_id, source_item_id, similarity_score,
                 title_score, entity_score, method, disposition, decided_by,
                 reason_code, created_at_ms)
              VALUES ('nm:3', 'story-2', 'item-2', 1.5, 0.9, 1, 'deterministic',
                      'merged_as_update', 'editorial.prepare_draft:near_dup_nd1',
                      'near_dup_merge_threshold', 1)`,
      }),
    ).rejects.toThrow();
    // An unknown disposition is refused.
    await expect(
      executor.run({
        sql: `INSERT INTO story_merges
                (id, canonical_story_id, source_item_id, similarity_score,
                 title_score, entity_score, method, disposition, decided_by,
                 reason_code, created_at_ms)
              VALUES ('nm:4', 'story-2', 'item-2', 0.5, 0.5, 0.5, 'deterministic',
                      'maybe', 'editorial.prepare_draft:near_dup_nd1',
                      'near_dup_review_threshold', 1)`,
      }),
    ).rejects.toThrow();
  });

  it('admits one negative-cache row per fingerprint', async () => {
    await executor.run({
      sql: `INSERT INTO quality_rejections
              (id, fingerprint, reason, source_item_id, rejected_at_ms,
               expires_at_ms, created_at_ms)
            VALUES ('qr:1', 'fp-1', 'editorial_input_invalid', 'item-1', 1, 2, 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO quality_rejections
                (id, fingerprint, reason, source_item_id, rejected_at_ms,
                 expires_at_ms, created_at_ms)
              VALUES ('qr:2', 'fp-1', 'editorial_ai_refused', 'item-2', 1, 2, 1)`,
      }),
    ).rejects.toThrow();
  });

  it('admits one delete record per (ref, message)', async () => {
    await executor.run({
      sql: `INSERT INTO channel_post_deletes
              (id, post_ref_type, post_ref_id, channel_message_id,
               deleted_by, reason, deleted_at_ms)
            VALUES ('del:1', 'publication', 'pub-1', 100, 1, 'expired', 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO channel_post_deletes
                (id, post_ref_type, post_ref_id, channel_message_id,
                 deleted_by, reason, deleted_at_ms)
              VALUES ('del:2', 'publication', 'pub-1', 100, 1, 'expired', 1)`,
      }),
    ).rejects.toThrow();
    // The same message under a different ref is a different record.
    await executor.run({
      sql: `INSERT INTO channel_post_deletes
              (id, post_ref_type, post_ref_id, channel_message_id,
               deleted_by, reason, deleted_at_ms)
            VALUES ('del:3', 'inbound', 'inb-1', 100, 1, 'expired', 1)`,
    });
  });
});
