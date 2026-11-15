import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { recordBlockedSourceSkip } from '../../src/adapters/db/source-ingest-store';

/**
 * Registry seeding on REAL workerd D1 (Phase 4 — ADR-0038 §2): the full
 * 14-source catalog seeds idempotently, enabled = 0 everywhere, repeated
 * imports NEVER re-enable owner-disabled sources or clobber owner state,
 * and blocked-source skip writes are guarded.
 */

const NOW = 1_770_000_000_000;

const executor: DbExecutor = createDbExecutor(env.DB);

beforeEach(async () => {
  await applyMigrations(env.DB);
  // Fresh source tables for every test (bounded deletes, test-only).
  await executor.run({ sql: 'DELETE FROM source_state' });
  await executor.run({ sql: 'DELETE FROM sources' });
  await executor.run({ sql: "DELETE FROM budgets WHERE scope = 'ingestion'" });
});

describe('seedSourcesFromRegistry', () => {
  it('seeds the full catalog with enabled = 0 and state rows', async () => {
    const registry = parseEmbeddedRegistry();
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;

    const summary = await seedSourcesFromRegistry(executor, registry.registry, NOW);
    expect(summary.total).toBe(14);
    expect(summary.written).toBe(14);

    const sources = await executor.query<{
      id: string;
      connector: string;
      enabled: number;
      interval_seconds: number;
      config_json: string;
    }>({
      sql: 'SELECT id, connector, enabled, interval_seconds, config_json FROM sources ORDER BY id',
    });
    expect(sources.rows).toHaveLength(14);
    for (const row of sources.rows) {
      expect(row.enabled).toBe(0); // nothing activates implicitly
    }
    const ids = sources.rows.map((row) => row.id);
    expect(ids).toContain('playstation_blog');
    expect(ids).toContain('xbox_wire');
    expect(ids).toContain('bluesky_watchlist');
    expect(ids).toContain('igdb_metadata');

    const states = await executor.query<{ source_id: string; next_poll_at: number }>({
      sql: 'SELECT source_id, next_poll_at FROM source_state',
    });
    expect(states.rows).toHaveLength(14);
    for (const row of states.rows) {
      expect(row.next_poll_at).toBe(0);
    }
  });

  it('is idempotent and never re-enables an owner-disabled source', async () => {
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) throw new Error('registry invalid');
    await seedSourcesFromRegistry(executor, registry.registry, NOW);

    // Owner enables two sources (the reviewed activation procedure).
    await executor.run({
      sql: "UPDATE sources SET enabled = 1 WHERE id IN ('playstation_blog', 'xbox_wire')",
    });
    // Owner tunes a priority (owner-managed column).
    await executor.run({
      sql: 'UPDATE sources SET priority = 10 WHERE id = ?',
      params: ['playstation_blog'],
    });
    // Owner pollutes the state (next_poll_at advanced).
    await executor.run({
      sql: 'UPDATE source_state SET next_poll_at = 999 WHERE source_id = ?',
      params: ['playstation_blog'],
    });

    const second = await seedSourcesFromRegistry(executor, registry.registry, NOW + 1000);
    expect(second.total).toBe(14);

    const playstation = await executor.first<{
      enabled: number;
      priority: number;
      interval_seconds: number;
    }>({
      sql: 'SELECT enabled, priority, interval_seconds FROM sources WHERE id = ?',
      params: ['playstation_blog'],
    });
    expect(playstation?.enabled).toBe(1); // NEVER silently re-disabled OR re-enabled
    expect(playstation?.priority).toBe(10); // owner-managed priority untouched
    expect(playstation?.interval_seconds).toBe(300); // descriptor refreshed

    const state = await executor.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(state?.next_poll_at).toBe(999); // owner runtime state untouched
  });

  it('stores connector-specific registry config verbatim', async () => {
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) throw new Error('registry invalid');
    await seedSourcesFromRegistry(executor, registry.registry, NOW);

    const steam = await executor.first<{ config_json: string }>({
      sql: 'SELECT config_json FROM sources WHERE id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(JSON.parse(steam?.config_json ?? '{}')).toMatchObject({
      appsPerBatch: 10,
      maxItemsPerApp: 3,
    });

    const crack = await executor.first<{ config_json: string; approval_policy: string }>({
      sql: 'SELECT config_json, approval_policy FROM sources WHERE id = ?',
      params: ['reddit_crack_signals'],
    });
    expect(JSON.parse(crack?.config_json ?? '{}')).toMatchObject({ subreddits: ['CrackWatch'] });
    expect(crack?.approval_policy).toBe('signal_only');
  });
});

describe('recordBlockedSourceSkip', () => {
  it('advances the schedule with a stable reason when it owns the window', async () => {
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) throw new Error('registry invalid');
    await seedSourcesFromRegistry(executor, registry.registry, NOW);
    // Source due at T=100.
    await executor.run({
      sql: 'UPDATE source_state SET next_poll_at = 100 WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });

    const won = await recordBlockedSourceSkip(executor, {
      sourceId: 'github_release_watchlist',
      scheduledForMs: 100,
      reason: 'watchlist_empty',
      intervalSeconds: 900,
      nowMs: NOW,
    });
    expect(won).toBe(true);

    const state = await executor.first<{ next_poll_at: number; last_error: string | null }>({
      sql: 'SELECT next_poll_at, last_error FROM source_state WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });
    expect(state?.next_poll_at).toBe(NOW + 900_000);
    expect(state?.last_error).toBe('watchlist_empty');
  });

  it('does not overwrite when another actor moved the window (fenced)', async () => {
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) throw new Error('registry invalid');
    await seedSourcesFromRegistry(executor, registry.registry, NOW);
    await executor.run({
      sql: 'UPDATE source_state SET next_poll_at = 200 WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });

    const won = await recordBlockedSourceSkip(executor, {
      sourceId: 'github_release_watchlist',
      scheduledForMs: 100, // stale window
      reason: 'watchlist_empty',
      intervalSeconds: 900,
      nowMs: NOW,
    });
    expect(won).toBe(false);
    const state = await executor.first<{ next_poll_at: number; last_error: string | null }>({
      sql: 'SELECT next_poll_at, last_error FROM source_state WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });
    expect(state?.next_poll_at).toBe(200);
    expect(state?.last_error).toBeNull();
  });
});
