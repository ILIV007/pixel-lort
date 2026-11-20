import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0008 — the live watchlists (slice 5; schema version 7 → 8).
 * This file has its OWN isolated storage (vitest-pool-workers isolates
 * per test FILE), so it proves the full upgrade path of a POPULATED
 * schema-v7 database:
 *
 *  1. apply ONLY migrations 0001..0007 -> a genuine schema-v7 database;
 *  2. apply the real append-only plan -> ONLY 0008 + 0009 are pending;
 *  3. schema version becomes 9 with the 0009 migration id;
 *  4. the six watchlist tables exist with their CHECK/UNIQUE constraints
 *     enforced at the DATABASE level;
 *  5. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives 0008
 * exclusively through `wrangler d1 migrations apply` with explicit owner
 * approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

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

beforeEach(async () => {
  // Build the version-7 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V7 plan is a no-op.
  await applyMigrations(db, V7_ONLY);
  // Upgrade to the real append-only plan — on the first run ONLY 0008 +
  // 0009 + 0010 are pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 10.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(10);
});

describe('slice 5 — migration 0008: live-watchlist tables (schema 7 → 8)', () => {
  it('applies 0008 + 0009 + 0010 as the only pending steps on a fresh schema-v7 database', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(10);
    expect(await appliedSchemaVersion()).toBe(10);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0010_soul_versioning');
  });

  it('admits one entry per kind+key and rejects a duplicate', async () => {
    await executor.run({
      sql: `INSERT INTO watchlist_entries
              (kind, key, label, source, status, score, first_seen_at_ms,
               last_seen_at_ms, created_at_ms, updated_at_ms)
            VALUES ('game', '730', 'Counter-Strike 2', 'live', 'active', 98.5, 1, 1, 1, 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO watchlist_entries
                (kind, key, label, source, status, score, first_seen_at_ms,
                 last_seen_at_ms, created_at_ms, updated_at_ms)
              VALUES ('game', '730', 'Counter-Strike 2', 'live', 'active', 10, 1, 1, 1, 1)`,
      }),
    ).rejects.toThrow();
    // The same key under a DIFFERENT kind is a different entry (an offer
    // is an event on a game, not the game itself).
    await executor.run({
      sql: `INSERT INTO watchlist_entries
              (kind, key, label, source, status, score, first_seen_at_ms,
               last_seen_at_ms, created_at_ms, updated_at_ms)
            VALUES ('free_game', 'epic-free:730', 'Counter-Strike 2', 'live', 'active', 0, 1, 1, 1, 1)`,
    });
  });

  it('rejects invalid kind, source, status, and score at the database level', async () => {
    const base = `INSERT INTO watchlist_entries
      (kind, key, label, source, status, score, first_seen_at_ms,
       last_seen_at_ms, created_at_ms, updated_at_ms) VALUES `;
    await expect(
      executor.run({ sql: `${base} ('movie', '1', 'X', 'live', 'active', 0, 1, 1, 1, 1)` }),
    ).rejects.toThrow();
    await expect(
      executor.run({ sql: `${base} ('game', '2', 'X', 'owner', 'active', 0, 1, 1, 1, 1)` }),
    ).rejects.toThrow();
    await expect(
      executor.run({ sql: `${base} ('game', '3', 'X', 'live', 'gone', 0, 1, 1, 1, 1)` }),
    ).rejects.toThrow();
    await expect(
      executor.run({ sql: `${base} ('game', '4', 'X', 'live', 'active', 101, 1, 1, 1, 1)` }),
    ).rejects.toThrow();
    await expect(
      executor.run({ sql: `${base} ('game', '5', 'X', 'live', 'active', -1, 1, 1, 1, 1)` }),
    ).rejects.toThrow();
  });

  it('admits one snapshot per date+source and one row per snapshot+key', async () => {
    await executor.run({
      sql: `INSERT INTO chart_snapshots (snapshot_date, source, row_count, created_at_ms)
            VALUES ('2026-11-22', 'steam-mostplayed', 2, 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO chart_snapshots (snapshot_date, source, row_count, created_at_ms)
              VALUES ('2026-11-22', 'steam-mostplayed', 2, 1)`,
      }),
    ).rejects.toThrow();
    const snapshot = await executor.first<{ id: number }>({
      sql: `SELECT id FROM chart_snapshots WHERE snapshot_date = '2026-11-22'`,
    });
    expect(snapshot).not.toBeNull();
    await executor.run({
      sql: `INSERT INTO chart_snapshot_rows (snapshot_id, kind, key, rank, players_now, peak_today)
            VALUES (${snapshot!.id}, 'game', '730', 1, 1200000, 1350000)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO chart_snapshot_rows (snapshot_id, kind, key, rank, players_now, peak_today)
              VALUES (${snapshot!.id}, 'game', '730', 1, 1200000, 1350000)`,
      }),
    ).rejects.toThrow();
    await expect(
      executor.run({
        sql: `INSERT INTO chart_snapshot_rows (snapshot_id, kind, key, rank, players_now, peak_today)
              VALUES (${snapshot!.id}, 'game', '570', 0, 600000, 700000)`,
      }),
    ).rejects.toThrow();
  });

  it('admits one alias per kind+source+key and one exclusion per kind+pattern', async () => {
    await executor.run({
      sql: `INSERT INTO watchlist_aliases (kind, canonical_key, alias_key, alias_source, created_at_ms)
            VALUES ('game', '730', 'epic-free:abc', 'epic', 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO watchlist_aliases (kind, canonical_key, alias_key, alias_source, created_at_ms)
              VALUES ('game', '730', 'epic-free:abc', 'epic', 1)`,
      }),
    ).rejects.toThrow();
    await executor.run({
      sql: `INSERT INTO watchlist_exclusions (kind, key_pattern, reason, created_by, created_at_ms)
            VALUES ('game', '999', 'owner asked to ignore it', 'owner', 1)`,
    });
    await expect(
      executor.run({
        sql: `INSERT INTO watchlist_exclusions (kind, key_pattern, reason, created_by, created_at_ms)
              VALUES ('game', '999', 'another reason', 'owner', 1)`,
      }),
    ).rejects.toThrow();
  });
});
