import { describe, expect, it } from 'vitest';
import {
  createSteamNewsConnector,
  SteamRuntimeConfigSchema,
} from '../../src/connectors/steam-news';
import {
  buildSteamCursor,
  nextSteamCursorStart,
  normalizeSteamCursor,
  steamWatchlistFingerprint,
  STEAM_CURSOR_MAX_CHARS,
  STEAM_CURSOR_VERSION,
} from '../../src/connectors/steam-cursor';
import { createFetchMock, type QueuedResponse, connectorEffects } from '../helpers/fetch-mock';

/**
 * Round 1.7 (R04) — Steam bounded PERSISTENT CYCLIC ROTATION: connector
 * CONTRACT tests over a scripted SafeFetchExecutor fake
 * (tests/helpers/fetch-mock.ts — NOT raw HTTP; raw-transport coverage
 * through the REAL createSafeFetch port lives in
 * tests/integration/round17-r04-steam-rotation.test.ts). Deterministic
 * fixtures only; no real provider requests (AGENTS.md §4).
 *
 * Covered here: the prompt's N3/B2 windows (570,440 then 730,570),
 * wraparound across several polls, N>B / N=B / N<B / B1 / maximum
 * supported lengths, empty watchlist (no network), empty successful
 * responses (still rotate), duplicate configured entries (no starvation),
 * the invalid-cursor matrix, watchlist grow/shrink/reorder and batch-size
 * changes, and the pure cursor helper's normalization policy.
 */

const SOURCE_ID = 'steam_news_watchlist';

const emptyOk = (
  appid: number,
): { status: number; headers: Record<string, string>; bodyText: string } => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyText: JSON.stringify({ appnews: { appid, newsitems: [] } }),
});

/** Run one poll and return the requested app IDs plus the connector output. */
async function poll(
  config: Record<string, unknown>,
  cursor: string | null,
  responses: readonly QueuedResponse[] = [],
): Promise<{ appids: string[]; cursor: string | null; status: string }> {
  const mock = createFetchMock([...responses]);
  const connector = createSteamNewsConnector();
  const result = await connector.fetch({
    sourceId: SOURCE_ID,
    config,
    state: { etag: null, lastModified: null, cursor },
    effects: connectorEffects(mock.fetchFn, {}),
  });
  return {
    appids: mock.calls.map((c) => new URL(c.url).searchParams.get('appid') ?? ''),
    cursor: result.cursor,
    status: result.status,
  };
}

/** Drive the connector through `polls` successful rotations from a cursor. */
async function rotate(
  config: Record<string, unknown>,
  startCursor: string | null,
  polls: number,
): Promise<string[][]> {
  const visited: string[][] = [];
  let cursor = startCursor;
  for (let i = 0; i < polls; i += 1) {
    const apps = (config['apps'] as number[]).length;
    const batch = config['appsPerBatch'] as number;
    const result = await poll(
      config,
      cursor,
      Array.from({ length: Math.min(batch, apps) }, (_, k) => {
        return emptyOk(k); // appid in the body is irrelevant to the connector
      }),
    );
    visited.push(result.appids);
    if (result.cursor === null) {
      throw new Error('rotation cursor must never be null on a successful poll');
    }
    cursor = result.cursor;
  }
  return visited;
}

const B2_CONFIG = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440, 730] };

/** n scripted successful empty-newsitem responses. */
const oks = (n: number): QueuedResponse[] => Array.from({ length: n }, () => emptyOk(0));

describe('steam rotation — cyclic windows (R04)', () => {
  it('N3/B2: first window 570,440 then 730,570 (prompt example)', async () => {
    const first = await poll(B2_CONFIG, null, [emptyOk(570), emptyOk(440)]);
    expect(first.appids).toEqual(['570', '440']);
    expect(first.cursor).not.toBeNull();
    expect(first.status).toBe('changed');

    const second = await poll(B2_CONFIG, first.cursor, [emptyOk(730), emptyOk(570)]);
    expect(second.appids).toEqual(['730', '570']);
  });

  it('N3/B2: wraparound over several polls covers every configured position cyclically', async () => {
    const windows = await rotate(B2_CONFIG, null, 5);
    // (0,1) → (2,0) → (1,2) → (0,1) → (2,0): every position, forever.
    expect(windows).toEqual([
      ['570', '440'],
      ['730', '570'],
      ['440', '730'],
      ['570', '440'],
      ['730', '570'],
    ]);
  });

  it('N=B: the whole watchlist is one window and the cursor returns to the head', async () => {
    const windows = await rotate({ appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440] }, null, 3);
    expect(windows).toEqual([
      ['570', '440'],
      ['570', '440'],
      ['570', '440'],
    ]);
  });

  it('N<B: a batch larger than the watchlist never exceeds the configured entries', async () => {
    const windows = await rotate(
      { appsPerBatch: 25, maxItemsPerApp: 3, apps: [570, 440] },
      null,
      2,
    );
    expect(windows).toEqual([
      ['570', '440'],
      ['570', '440'],
    ]);
  });

  it('B1: strict one-app-per-poll rotation', async () => {
    const windows = await rotate(
      { appsPerBatch: 1, maxItemsPerApp: 3, apps: [570, 440, 730] },
      null,
      4,
    );
    expect(windows).toEqual([['570'], ['440'], ['730'], ['570']]);
  });

  it('maximum supported lengths: 50 apps × batch 25 in two full-coverage polls', async () => {
    const apps = Array.from({ length: 50 }, (_, i) => i + 1);
    const config = { appsPerBatch: 25, maxItemsPerApp: 1, apps };
    const windows = await rotate(config, null, 2);
    expect(windows[0]).toEqual(apps.slice(0, 25).map(String));
    expect(windows[1]).toEqual(apps.slice(25, 50).map(String));
    // One more poll wraps to the head again (three full windows cyclically).
    const windows3 = await rotate(config, null, 3);
    expect(windows3[2]).toEqual(apps.slice(0, 25).map(String));
  });

  it('empty watchlist: fail-closed with no network and a preserved cursor', async () => {
    const mock = createFetchMock([{ status: 200, bodyText: '{"appnews":{}}' }]);
    const connector = createSteamNewsConnector();
    const config = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [] };
    expect(connector.preflight(config, () => undefined)).toMatchObject({ ok: false });
    expect(connector.plannedRequestCount(config)).toBe(0);
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config,
      state: { etag: null, lastModified: null, cursor: '{"legacy":"cursor"}' },
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('watchlist_empty');
    expect(result.cursor).toBe('{"legacy":"cursor"}'); // conservative pass-through
    expect(mock.calls).toHaveLength(0); // no network, ever
  });

  it('empty successful responses still rotate (progress = windows visited)', async () => {
    const first = await poll(B2_CONFIG, null, [
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"appnews":{}}' },
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: '{"appnews":{"newsitems":[]}}',
      },
    ]);
    expect(first.status).toBe('changed');
    expect(first.cursor).not.toBeNull();
    const second = await poll(B2_CONFIG, first.cursor, oks(2));
    expect(second.appids).toEqual(['730', '570']);
  });

  it('duplicate configured entries are honored without starving other configured IDs', async () => {
    const config = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440, 570, 730] };
    const windows = await rotate(config, null, 4);
    // Every configured POSITION is visited; 440 and 730 are not starved by
    // the duplicated 570, and the owner list is never rewritten.
    expect(windows).toEqual([
      ['570', '440'],
      ['570', '730'],
      ['570', '440'],
      ['570', '730'],
    ]);
    const distinct = new Set(windows.flat());
    expect(distinct).toEqual(new Set(['570', '440', '730']));
  });
});

describe('steam rotation — cursor policy', () => {
  it('cursor is bounded, versioned opaque JSON with exactly four keys', async () => {
    const cursor = await poll(B2_CONFIG, null, oks(2)).then((r) => r.cursor);
    expect(cursor).not.toBeNull();
    expect(cursor!.length).toBeLessThan(STEAM_CURSOR_MAX_CHARS);
    const parsed = JSON.parse(cursor!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['fp', 'n', 'start', 'v']);
    expect(parsed['v']).toBe(STEAM_CURSOR_VERSION);
    expect(parsed['n']).toBe(3);
    expect(parsed['start']).toBe(2);
    expect(parsed['fp']).toMatch(/^[0-9a-f]{8}$/);
  });

  it('invalid cursor matrix: every malformed/foreign cursor deterministically restarts at index 0', async () => {
    const fp = steamWatchlistFingerprint(B2_CONFIG.apps);
    const cases: readonly string[] = [
      'not-json-at-all',
      '{"v":1,"fp":"' + fp + '","n":3,"start":2', // truncated JSON
      '[]',
      '42',
      '"string"',
      'null',
      JSON.stringify({ v: 2, fp, n: 3, start: 2 }), // unsupported version
      JSON.stringify({ v: 1, fp, n: 3, start: 2, extra: true }), // unknown key
      JSON.stringify({ v: 1, n: 3, start: 2 }), // missing fp
      JSON.stringify({ v: 1, fp: 'nothex', n: 3, start: 2 }), // malformed fingerprint
      JSON.stringify({ v: 1, fp, n: 3, start: -1 }), // negative start
      JSON.stringify({ v: 1, fp, n: 3, start: 3 }), // start out of range
      JSON.stringify({ v: 1, fp, n: 3, start: 999999 }), // far out of range
      JSON.stringify({ v: 1, fp, n: 4, start: 2 }), // watchlist grew
      JSON.stringify({ v: 1, fp, n: 2, start: 2 }), // watchlist shrank
      JSON.stringify({ v: 1, fp: 'deadbeef', n: 3, start: 2 }), // fingerprint mismatch
      JSON.stringify({ start: 2 }), // missing fields
      'x'.repeat(STEAM_CURSOR_MAX_CHARS + 1), // oversized — reset without parsing
    ];
    for (const raw of cases) {
      const result = await poll(B2_CONFIG, raw, [emptyOk(570), emptyOk(440)]);
      expect(result.appids, `cursor ${raw.slice(0, 40)} must reset to the head`).toEqual([
        '570',
        '440',
      ]);
      // Requests still derive ONLY from the configured watchlist.
      for (const appid of result.appids) {
        expect(B2_CONFIG.apps.map(String)).toContain(appid);
      }
      expect(normalizeSteamCursor(raw, B2_CONFIG.apps)).toEqual({ start: 0, reset: true });
    }
  });

  it('a structurally valid cursor never invents an app ID outside the watchlist', async () => {
    // Forged cursor with the actual current fingerprint and a valid start:
    // at worst it selects a different window of the SAME watchlist.
    // This is not a measured hash-collision experiment.
    const fp = steamWatchlistFingerprint(B2_CONFIG.apps);
    const forged = JSON.stringify({ v: 1, fp, n: 3, start: 1 });
    const result = await poll(B2_CONFIG, forged, [emptyOk(440), emptyOk(730)]);
    expect(result.appids).toEqual(['440', '730']);
    for (const appid of result.appids) {
      expect(B2_CONFIG.apps.map(String)).toContain(appid);
    }
  });

  it('watchlist grow / shrink / reorder reset rotation deterministically to the head', async () => {
    const original = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440, 730] };
    const first = await poll(original, null, oks(2));
    expect(first.cursor).not.toBeNull();

    // Grow: [570,440,730,160] — fingerprint mismatch → head.
    const grown = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440, 730, 160] };
    expect(normalizeSteamCursor(first.cursor, grown.apps)).toEqual({ start: 0, reset: true });
    expect((await poll(grown, first.cursor, oks(2))).appids).toEqual(['570', '440']);

    // Shrink: [570,440] — mismatch → head.
    const shrunk = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440] };
    expect(normalizeSteamCursor(first.cursor, shrunk.apps)).toEqual({ start: 0, reset: true });
    expect((await poll(shrunk, first.cursor, oks(2))).appids).toEqual(['570', '440']);

    // Reorder (same length): [730,440,570] — fingerprint mismatch → head.
    const reordered = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [730, 440, 570] };
    expect(normalizeSteamCursor(first.cursor, reordered.apps)).toEqual({ start: 0, reset: true });
    expect((await poll(reordered, first.cursor, oks(2))).appids).toEqual(['730', '440']);
  });

  it('batch-size changes keep a valid cursor: the window size follows the CURRENT config', async () => {
    const b2 = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440, 730] };
    const first = await poll(b2, null, oks(2));
    expect(first.cursor).not.toBeNull();
    // Same watchlist, larger batch: window of 3 from the SAME start (2) —
    // wrap included, all entries visited.
    const b3 = { appsPerBatch: 3, maxItemsPerApp: 3, apps: [570, 440, 730] };
    const result = await poll(b3, first.cursor, oks(3));
    expect(result.appids).toEqual(['730', '570', '440']);
    // next start: (2 + 3) % 3 = 2 — back to the same cyclic phase.
    expect(JSON.parse(result.cursor!)['start']).toBe(2);
  });

  it('pure helper: fingerprint is order- and duplicate-sensitive and stable', () => {
    expect(steamWatchlistFingerprint([570, 440])).toBe(steamWatchlistFingerprint([570, 440]));
    expect(steamWatchlistFingerprint([570, 440])).not.toBe(steamWatchlistFingerprint([440, 570]));
    expect(steamWatchlistFingerprint([570, 570])).not.toBe(steamWatchlistFingerprint([570]));
    expect(steamWatchlistFingerprint([570, 440, 730])).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pure helper: nextSteamCursorStart implements (start + selectedCount) mod length', () => {
    expect(nextSteamCursorStart(0, 2, 3)).toBe(2);
    expect(nextSteamCursorStart(2, 2, 3)).toBe(1);
    expect(nextSteamCursorStart(1, 2, 3)).toBe(0);
    expect(nextSteamCursorStart(0, 25, 50)).toBe(25);
    expect(nextSteamCursorStart(25, 25, 50)).toBe(0);
    expect(nextSteamCursorStart(0, 3, 3)).toBe(0);
  });

  it('build/normalize round-trip and null/empty normalization', () => {
    const apps = [570, 440, 730];
    expect(normalizeSteamCursor(null, apps)).toEqual({ start: 0, reset: false });
    expect(normalizeSteamCursor('', apps)).toEqual({ start: 0, reset: false });
    const cursor = buildSteamCursor(apps, 2);
    expect(normalizeSteamCursor(cursor, apps)).toEqual({ start: 2, reset: false });
    // Empty watchlist never normalizes to anything but the head.
    expect(normalizeSteamCursor(cursor, [])).toEqual({ start: 0, reset: false });
  });

  it('plannedRequestCount stays truthful and bounded: min(watchlist, batch)', () => {
    const connector = createSteamNewsConnector();
    expect(connector.plannedRequestCount(B2_CONFIG)).toBe(2);
    expect(
      connector.plannedRequestCount({ appsPerBatch: 25, maxItemsPerApp: 1, apps: [1, 2] }),
    ).toBe(2);
    expect(
      connector.plannedRequestCount({ appsPerBatch: 1, maxItemsPerApp: 1, apps: [1, 2, 3] }),
    ).toBe(1);
    expect(SteamRuntimeConfigSchema.safeParse({ ...B2_CONFIG, appsPerBatch: 26 }).success).toBe(
      false,
    );
  });
});
