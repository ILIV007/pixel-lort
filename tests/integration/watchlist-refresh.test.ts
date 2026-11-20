import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import {
  findWatchlistEntry,
  insertWatchlistExclusion,
  listWatchlistEntries,
  upsertWatchlistEntry,
} from '../../src/adapters/db/watchlist-store';
import {
  refreshFreeOffers,
  refreshWatchlistFromChartSnapshot,
} from '../../src/application/watchlist/refresh-service';

/**
 * Slice 5 — live-watchlist refresh on REAL D1 (live-watchlists-design
 * §3–§4): weekly snapshots + movers, auto-add with the weekly cap,
 * staged auto-prune (manual entries never prune), free-offer expiry,
 * exclusions, and aliasing. Nothing here posts — refreshes only produce
 * candidates in D1.
 */

const db: D1Database = env.DB;
const executor = createDbExecutor(db);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await applyMigrations(db);
});

describe('watchlist refresh — weekly chart snapshots and movers', () => {
  it('saves the first snapshot and auto-adds only the qualifying new entries', async () => {
    const summary = await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-11-15',
      nowMs: Date.UTC(2026, 10, 15, 7, 0, 0),
      rows: [
        { key: '730', rank: 1, playersNow: 1_200_000, peakToday: 1_350_000 },
        { key: '570', rank: 2, playersNow: 600_000, peakToday: 700_000 },
        { key: '440', rank: 50, playersNow: 80_000, peakToday: 90_000 },
        { key: '999', rank: 90, playersNow: 60_000, peakToday: 65_000 },
        { key: '123', rank: 60, playersNow: 40_000, peakToday: 45_000 },
      ],
    });
    expect(summary.snapshotCreated).toBe(true);
    expect(summary.rowsSaved).toBe(5);
    // All five rows are new entries, but only ranks ≤ 50 auto-add.
    expect(summary.movers).toHaveLength(5);
    expect(summary.entriesAdded).toBe(3);
    expect(summary.exits).toBe(0);
    expect(await findWatchlistEntry(executor, 'game', '730')).not.toBeNull();
    expect(await findWatchlistEntry(executor, 'game', '440')).not.toBeNull();
    expect(await findWatchlistEntry(executor, 'game', '999')).toBeNull();
    expect(await findWatchlistEntry(executor, 'game', '123')).toBeNull();
  });

  it('diffs week over week: climbers and new entries move, exits never post', async () => {
    await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-11-01',
      nowMs: Date.UTC(2026, 10, 1, 7, 0, 0),
      rows: [
        { key: '731', rank: 1, playersNow: 1_200_000, peakToday: 1_350_000 },
        { key: '571', rank: 2, playersNow: 600_000, peakToday: 700_000 },
        { key: '441', rank: 50, playersNow: 80_000, peakToday: 90_000 },
        { key: '998', rank: 90, playersNow: 60_000, peakToday: 65_000 },
      ],
    });
    const summary = await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-11-08',
      nowMs: Date.UTC(2026, 10, 8, 7, 0, 0),
      rows: [
        { key: '731', rank: 1, playersNow: 1_210_000, peakToday: 1_360_000 },
        { key: '571', rank: 2, playersNow: 610_000, peakToday: 710_000 },
        { key: '441', rank: 25, playersNow: 200_000, peakToday: 220_000 },
        { key: '124', rank: 30, playersNow: 90_000, peakToday: 100_000 },
        { key: '556', rank: 45, playersNow: 85_000, peakToday: 95_000 },
      ],
    });
    expect(summary.snapshotCreated).toBe(true);
    expect(summary.movers.map((mover) => mover.key).sort()).toEqual(['124', '441', '556']);
    expect(summary.movers.find((mover) => mover.key === '441')).toMatchObject({
      kind: 'climber',
      rankJump: 25,
    });
    expect(summary.exits).toBe(1);
    expect(summary.entriesAdded).toBe(2);
    expect(summary.entriesUpdated).toBe(5);
    expect(await findWatchlistEntry(executor, 'game', '124')).not.toBeNull();
    expect(await findWatchlistEntry(executor, 'game', '556')).not.toBeNull();
  });

  it('never snapshots the same date twice', async () => {
    const rows = [{ key: '732', rank: 1, playersNow: 1_200_000, peakToday: 1_350_000 }];
    const first = await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-11-29',
      nowMs: Date.UTC(2026, 10, 29, 7, 0, 0),
      rows,
    });
    expect(first.snapshotCreated).toBe(true);
    const second = await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-11-29',
      nowMs: Date.UTC(2026, 10, 29, 8, 0, 0),
      rows,
    });
    expect(second.snapshotCreated).toBe(false);
    expect(second.rowsSaved).toBe(0);
    expect(second.movers).toEqual([]);
  });
});

describe('watchlist refresh — free offers', () => {
  it('upserts live offers, aliases to the canonical game, and expires the old one', async () => {
    await upsertWatchlistEntry(executor, {
      kind: 'game',
      key: '9001',
      label: 'Hollow Knight',
      source: 'manual',
      status: 'active',
      nowMs: Date.UTC(2026, 10, 20, 7, 0, 0),
    });
    const summary = await refreshFreeOffers(executor, {
      nowMs: Date.UTC(2026, 10, 22, 7, 0, 0),
      offers: [
        {
          sourceId: 'epic-free:a1',
          offerId: 'a1',
          title: 'Hollow Knight',
          pageSlug: 'hollow-knight',
          storeUrl: 'https://store.epicgames.com/en-US/p/hollow-knight',
          originalPrice: 1499,
          currencyCode: 'USD',
          startDate: '2026-11-20T16:00:00.000Z',
          endDate: '2026-11-27T16:00:00.000Z',
        },
        {
          sourceId: 'epic-free:b2',
          offerId: 'b2',
          title: 'Old Offer',
          pageSlug: 'old-offer',
          storeUrl: 'https://store.epicgames.com/en-US/p/old-offer',
          originalPrice: 999,
          currencyCode: 'USD',
          startDate: '2026-11-13T16:00:00.000Z',
          endDate: '2026-11-15T16:00:00.000Z',
        },
      ],
    });
    expect(summary).toMatchObject({
      offersSeen: 2,
      entriesUpserted: 2,
      entriesExpired: 1,
      aliasesCreated: 1,
    });
    const live = await findWatchlistEntry(executor, 'free_game', 'epic-free:a1');
    expect(live?.status).toBe('active');
    expect(live?.expires_at_ms).toBe(Date.parse('2026-11-27T16:00:00.000Z'));
    const old = await findWatchlistEntry(executor, 'free_game', 'epic-free:b2');
    expect(old?.status).toBe('expired');
    // Re-refreshing is idempotent: the expired offer stays expired.
    const again = await refreshFreeOffers(executor, {
      nowMs: Date.UTC(2026, 10, 22, 8, 0, 0),
      offers: [
        {
          sourceId: 'epic-free:a1',
          offerId: 'a1',
          title: 'Hollow Knight',
          pageSlug: 'hollow-knight',
          storeUrl: 'https://store.epicgames.com/en-US/p/hollow-knight',
          originalPrice: 1499,
          currencyCode: 'USD',
          startDate: '2026-11-20T16:00:00.000Z',
          endDate: '2026-11-27T16:00:00.000Z',
        },
      ],
    });
    expect(again.entriesExpired).toBe(0);
    expect((await findWatchlistEntry(executor, 'free_game', 'epic-free:b2'))?.status).toBe(
      'expired',
    );
  });
});

describe('watchlist refresh — exclusions and pruning', () => {
  it('an exclusion beats auto-add (no entry, no signal)', async () => {
    await insertWatchlistExclusion(executor, {
      kind: 'game',
      keyPattern: '4242',
      reason: 'owner asked to ignore it',
      createdBy: 'owner',
      nowMs: Date.UTC(2026, 11, 13, 7, 0, 0),
    });
    const summary = await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-12-13',
      nowMs: Date.UTC(2026, 11, 13, 7, 0, 0),
      rows: [
        { key: '4242', rank: 5, playersNow: 500_000, peakToday: 600_000 },
        { key: '4243', rank: 6, playersNow: 480_000, peakToday: 550_000 },
      ],
    });
    expect(summary.movers.map((mover) => mover.key)).toEqual(['4243']);
    expect(await findWatchlistEntry(executor, 'game', '4242')).toBeNull();
    expect(await findWatchlistEntry(executor, 'game', '4243')).not.toBeNull();
  });

  it('stale live entries cool down; stale manual entries never auto-prune', async () => {
    const nowMs = Date.UTC(2026, 11, 6, 7, 0, 0);
    const staleMs = nowMs - 20 * DAY_MS;
    await executor.run({
      sql: `INSERT INTO watchlist_entries
              (kind, key, label, source, status, score, first_seen_at_ms,
               last_seen_at_ms, last_signal_at_ms, created_at_ms, updated_at_ms)
            VALUES ('game', '888', 'Stale Live Game', 'live', 'active', 40, ${staleMs}, ${staleMs}, ${staleMs}, ${staleMs}, ${staleMs})`,
    });
    await executor.run({
      sql: `INSERT INTO watchlist_entries
              (kind, key, label, source, status, score, first_seen_at_ms,
               last_seen_at_ms, last_signal_at_ms, created_at_ms, updated_at_ms)
            VALUES ('game', '777', 'Stale Manual Game', 'manual', 'active', 50, ${staleMs}, ${staleMs}, ${staleMs}, ${staleMs}, ${staleMs})`,
    });
    const summary = await refreshWatchlistFromChartSnapshot(executor, {
      snapshotDate: '2026-12-06',
      nowMs,
      rows: [{ key: '730', rank: 1, playersNow: 1_200_000, peakToday: 1_350_000 }],
    });
    expect(summary.entriesPruned).toBeGreaterThanOrEqual(1);
    expect((await findWatchlistEntry(executor, 'game', '888'))?.status).toBe('cooling');
    expect((await findWatchlistEntry(executor, 'game', '777'))?.status).toBe('active');
    // The active list still shows the manual entry as active.
    const active = await listWatchlistEntries(executor, { kind: 'game', status: 'active' });
    expect(active.some((entry) => entry.key === '777')).toBe(true);
  });
});
