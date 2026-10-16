/**
 * Round 1.8 — R10 per-hop ingestion budget authority (permanent tests).
 *
 * Two explicitly labeled families (the labels distinguish them, per the
 * Round 1.8 acceptance requirements):
 *
 * 1. "SafeFetchExecutor fake contract coverage" — connector-level tests
 *    over the scripted SafeFetchExecutor fake (tests/helpers/fetch-mock):
 *    they pin the TYPED propagation contract
 *    (`budgetDenied` / `budgetDenialKind`) and the no-further-network
 *    abort semantics, WITHOUT any real charging.
 *
 * 2. "raw-port" — REAL workerd D1 + REAL `createIngestionSafeFetch` (and
 *    the REAL poll handler built from the raw transport) over scripted RAW
 *    `typeof fetch` scripts: they pin per-hop charging (exactly one atomic
 *    unit before EVERY raw attempt), concurrent last-unit admission,
 *    Tehran-day rollover per hop, budget change between hops, the typed
 *    infrastructure path on D1 failure, and the charged-but-not-attempted
 *    crash window.
 *
 * R09 (cross-worker source ownership) is deliberately NOT touched and
 * stays RED in the accepted characterization. No schema change, no
 * migration, no deployment — local product tests only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  authorizeIngestionUnit,
  readIngestionBudget,
} from '../../src/adapters/db/ingestion-budget-store';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { createRssConnector } from '../../src/connectors/rss';
import { createSteamNewsConnector } from '../../src/connectors/steam-news';
import { createYoutubePlaylistsConnector } from '../../src/connectors/youtube-playlists';
import { createRedditOauthConnector } from '../../src/connectors/reddit-oauth';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { createIngestionSafeFetch, createSafeFetch } from '../../src/shared/http/safe-http';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';
import { tehranBudgetDay } from '../../src/shared/time/tehran-day';
import { INGESTION_LIMITS } from '../../src/domain/source/source-registry';

const NOW = 1_770_000_000_000; // 2026-02-02 — Tehran 2026-02-02 14:10
const db: DbExecutor = createDbExecutor(env.DB);

const registry = () => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('registry invalid');
  return r.registry;
};

const state = { etag: null, lastModified: null, cursor: null };

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
  await seedSourcesFromRegistry(db, registry(), NOW);
});

/** Build the REAL per-execution ingestion transport exactly as the handler does. */
function realIngestionTransport(
  sourceId: string,
  fetchFn: typeof fetch,
  nowMs: () => number,
): ReturnType<typeof createIngestionSafeFetch> {
  return createIngestionSafeFetch({
    fetchFn,
    authorizeUnit: async () => {
      const grant = await authorizeIngestionUnit(db, { sourceId, nowMs: nowMs() });
      if (grant.kind === 'authorized') return { kind: 'granted' };
      return grant.kind === 'denied' ? { kind: 'budget_denied' } : { kind: 'source_missing' };
    },
  });
}

const okXml = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });

const okJson = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

const RSS_BODY = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><guid>ps-news-1</guid><link>https://blog.playstation.com/article/new-game</link>
<title>New Game Announced</title><description>A big announcement</description>
<pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate></item></channel></rss>`;

const redir = (location: string) => new Response(null, { status: 302, headers: { location } });

async function setBudget(sourceId: string, cap: number): Promise<void> {
  await db.run({
    sql: 'UPDATE sources SET daily_request_budget = ? WHERE id = ?',
    params: [cap, sourceId],
  });
}

async function enable(sourceId: string): Promise<void> {
  await db.run({ sql: 'UPDATE sources SET enabled = 1 WHERE id = ?', params: [sourceId] });
}

const validFeed = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'application/xml' },
  bodyText: body,
});

describe('R10 raw-port: authorizeIngestionUnit on REAL workerd D1', () => {
  it('charges exactly one unit per authorization on a fresh day row', async () => {
    await setBudget('playstation_blog', 5);
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('authorized');
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('authorized');
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(2);
  });

  it('a quota of 0 denies every unit and charges nothing', async () => {
    await setBudget('playstation_blog', 0);
    const grant = await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW });
    expect(grant.kind).toBe('denied');
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(0);
  });

  it('reports a missing source distinctly from exhaustion', async () => {
    const grant = await authorizeIngestionUnit(db, { sourceId: 'no_such_source', nowMs: NOW });
    expect(grant.kind).toBe('source_missing');
  });

  it('concurrent authorizations against the last unit on an EXISTING day admit exactly the cap', async () => {
    await setBudget('playstation_blog', 3);
    // Warm the day row first (existing-day race on the last unit).
    await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW });
    await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW }),
      ),
    );
    const authorized = results.filter((r) => r.kind === 'authorized').length;
    expect(authorized).toBe(1); // cap 3 − 2 already charged = exactly ONE left
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(3);
  });

  it('concurrent authorizations on a NEW day admit exactly the cap (race-safe init)', async () => {
    await setBudget('playstation_blog', 2);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW }),
      ),
    );
    const authorized = results.filter((r) => r.kind === 'authorized').length;
    expect(authorized).toBe(2); // exactly the cap — never cap+1
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(2);
  });

  it('independent sources remain isolated under the same pressure', async () => {
    await setBudget('playstation_blog', 1);
    await setBudget('xbox_wire', 1);
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('authorized');
    expect((await authorizeIngestionUnit(db, { sourceId: 'xbox_wire', nowMs: NOW })).kind).toBe(
      'authorized',
    );
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('denied');
    expect((await authorizeIngestionUnit(db, { sourceId: 'xbox_wire', nowMs: NOW })).kind).toBe(
      'denied',
    );
  });
});

describe('R10 raw-port: REAL createIngestionSafeFetch + scripted RAW fetch (RSS connector)', () => {
  it('cap 1 with a 302→200 sequence: exactly ONE raw call and ONE charged unit', async () => {
    await setBudget('playstation_blog', 1);
    await enable('playstation_blog');
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls === 1 ? redir('https://blog.playstation.com/feed/final') : okXml(RSS_BODY);
    }) as typeof fetch;
    const connector = createRssConnector();
    const output = await connector.fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: realIngestionTransport('playstation_blog', fetchFn, () => NOW),
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(1); // the redirect hop was DENIED — zero raw requests
    expect(output.budgetDenied).toBe(true);
    expect(output.budgetDenialKind).toBe('budget_exhausted');
    expect(output.failureReason).toBe('budget_exhausted');
    expect(output.requestCount).toBe(1); // observed attempts preserved
    expect(output.items).toHaveLength(0);
    expect(output.cursor).toBe(state.cursor); // PRIOR cursor, never advanced
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('successful no-redirect poll at cap 1: one raw call, one unit, items commit-shaped output', async () => {
    await setBudget('playstation_blog', 1);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return okXml(RSS_BODY);
    }) as typeof fetch;
    const output = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: realIngestionTransport('playstation_blog', fetchFn, () => NOW),
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(1);
    expect(output.status).toBe('changed');
    expect(output.budgetDenied).toBeUndefined();
    expect(output.requestCount).toBe(1);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('cap 0: ZERO raw requests, typed denial, zero charges', async () => {
    await setBudget('playstation_blog', 0);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return okXml(RSS_BODY);
    }) as typeof fetch;
    const output = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: realIngestionTransport('playstation_blog', fetchFn, () => NOW),
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(0);
    expect(output.budgetDenied).toBe(true);
    expect(output.requestCount).toBe(0);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(0);
  });

  it('exhausted source: ZERO raw requests after the last unit is gone', async () => {
    await setBudget('playstation_blog', 1);
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('authorized');
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return okXml(RSS_BODY);
    }) as typeof fetch;
    const output = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: realIngestionTransport('playstation_blog', fetchFn, () => NOW),
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(0);
    expect(output.budgetDenied).toBe(true);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('missing source: ZERO raw requests and the distinct source_missing denial', async () => {
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return okXml(RSS_BODY);
    }) as typeof fetch;
    const output = await createRssConnector().fetch({
      sourceId: 'vanished_source',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: realIngestionTransport('vanished_source', fetchFn, () => NOW),
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(0);
    expect(output.budgetDenied).toBe(true);
    expect(output.budgetDenialKind).toBe('source_missing');
  });

  it('redirect to a disallowed host: the guard rejects BEFORE the unit — no extra network, no extra unit', async () => {
    await setBudget('playstation_blog', 5);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return redir('https://evil.example.com/feed');
    }) as typeof fetch;
    const result = await realIngestionTransport(
      'playstation_blog',
      fetchFn,
      () => NOW,
    )({
      url: 'https://blog.playstation.com/feed/',
      headers: { accept: 'application/rss+xml' },
      byteCap: INGESTION_LIMITS.maxFeedBytes,
      timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
      maxRedirects: INGESTION_LIMITS.maxRedirects,
      allowedHosts: ['blog.playstation.com'],
    });
    expect(rawCalls).toBe(1); // hop 0 only; hop 1 never authorized, never sent
    expect(result).toMatchObject({ ok: false, reason: 'host_not_allowed', requestCount: 1 });
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('multi-hop sequence 302→302→200 at cap 3: three raw calls, three charged units', async () => {
    await setBudget('playstation_blog', 3);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls <= 2
        ? redir(`https://blog.playstation.com/feed/hop${rawCalls}`)
        : okXml(RSS_BODY);
    }) as typeof fetch;
    const output = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: realIngestionTransport('playstation_blog', fetchFn, () => NOW),
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(3);
    expect(output.status).toBe('changed');
    expect(output.requestCount).toBe(3);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(3);
  });

  it('maximum redirects: every attempted hop charged, then redirect_limit (no hidden charge)', async () => {
    await setBudget('playstation_blog', 10);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return redir(`https://blog.playstation.com/feed/loop${rawCalls}`);
    }) as typeof fetch;
    const result = await realIngestionTransport(
      'playstation_blog',
      fetchFn,
      () => NOW,
    )({
      url: 'https://blog.playstation.com/feed/',
      headers: {},
      byteCap: INGESTION_LIMITS.maxFeedBytes,
      timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
      maxRedirects: INGESTION_LIMITS.maxRedirects, // 2 → hops 0,1,2 attempted
      allowedHosts: ['blog.playstation.com'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'redirect_limit', requestCount: 3 });
    expect(rawCalls).toBe(3);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(3);
  });

  it('a THROWN raw attempt still consumes its unit (network_error, one charge)', async () => {
    await setBudget('playstation_blog', 2);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      throw new TypeError('simulated connection reset');
    }) as typeof fetch;
    const result = await realIngestionTransport(
      'playstation_blog',
      fetchFn,
      () => NOW,
    )({
      url: 'https://blog.playstation.com/feed/',
      headers: {},
      byteCap: INGESTION_LIMITS.maxFeedBytes,
      timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
      maxRedirects: INGESTION_LIMITS.maxRedirects,
      allowedHosts: ['blog.playstation.com'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'network_error', requestCount: 1 });
    expect(rawCalls).toBe(1);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('timeout and body failures consume their units (no refunds)', async () => {
    await setBudget('playstation_blog', 5);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const timeoutTransport = realIngestionTransport(
      'playstation_blog',
      (async () => {
        throw abortError;
      }) as typeof fetch,
      () => NOW,
    );
    const timeoutResult = await timeoutTransport({
      url: 'https://blog.playstation.com/feed/',
      headers: {},
      byteCap: INGESTION_LIMITS.maxFeedBytes,
      timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
      maxRedirects: INGESTION_LIMITS.maxRedirects,
      allowedHosts: ['blog.playstation.com'],
    });
    expect(timeoutResult).toMatchObject({ ok: false, reason: 'timeout', requestCount: 1 });

    const oversized = new Response('x'.repeat(64), {
      status: 200,
      headers: { 'content-type': 'application/xml', 'content-length': '999999' },
    });
    const bodyTransport = realIngestionTransport(
      'playstation_blog',
      (async () => oversized) as typeof fetch,
      () => NOW,
    );
    const bodyResult = await bodyTransport({
      url: 'https://blog.playstation.com/feed/',
      headers: {},
      byteCap: 16,
      timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
      maxRedirects: INGESTION_LIMITS.maxRedirects,
      allowedHosts: ['blog.playstation.com'],
    });
    expect(bodyResult).toMatchObject({ ok: false, reason: 'body_too_large', requestCount: 1 });
    // Both failed attempts consumed exactly one unit each — no refunds.
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(2);
  });

  it('per-hop Tehran day rollover: a redirect straddling midnight charges each hop to ITS day', async () => {
    await setBudget('playstation_blog', 1);
    const beforeMidnight = Date.UTC(2025, 9, 6, 20, 29, 0); // Tehran 2025-10-06 23:59
    const afterMidnight = Date.UTC(2025, 9, 6, 20, 31, 0); // Tehran 2025-10-07 00:01
    expect(tehranBudgetDay(beforeMidnight)).toBe('2025-10-06');
    expect(tehranBudgetDay(afterMidnight)).toBe('2025-10-07');
    let authorizations = 0;
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls === 1 ? redir('https://blog.playstation.com/feed/next-day') : okXml(RSS_BODY);
    }) as typeof fetch;
    // The handler resolves nowMs at EACH authorization — reproduced here by
    // the same closure shape over a clock that rolls over midnight between
    // the first and second authorization.
    const transport = createIngestionSafeFetch({
      fetchFn,
      authorizeUnit: async () => {
        const nowMs = authorizations === 0 ? beforeMidnight : afterMidnight;
        authorizations += 1;
        const grant = await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs });
        return grant.kind === 'authorized' ? { kind: 'granted' } : { kind: 'budget_denied' };
      },
    });
    const output = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: transport,
        nowMs: () => afterMidnight,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(2); // hop0 charged to day1 (cap 1 fresh), hop1 to day2 (fresh day)
    expect(output.status).toBe('changed');
    expect(
      await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: beforeMidnight }),
    ).toBe(1);
    expect(
      await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: afterMidnight }),
    ).toBe(1);
  });

  it('budget change between hops is respected (cap lowered after hop 0 → denial)', async () => {
    await setBudget('playstation_blog', 2);
    let authorizations = 0;
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls === 1 ? redir('https://blog.playstation.com/feed/final') : okXml(RSS_BODY);
    }) as typeof fetch;
    const transport = createIngestionSafeFetch({
      fetchFn,
      authorizeUnit: async () => {
        const grant = await authorizeIngestionUnit(db, {
          sourceId: 'playstation_blog',
          nowMs: NOW,
        });
        if (grant.kind === 'authorized') {
          authorizations += 1;
          if (authorizations === 1) {
            // The operator lowers the cap BETWEEN hops.
            await setBudget('playstation_blog', 1);
          }
          return { kind: 'granted' };
        }
        return { kind: 'budget_denied' };
      },
    });
    const output = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state,
      effects: {
        safeFetch: transport,
        nowMs: () => NOW,
        random: () => 0.5,
        secrets: () => undefined,
      },
    });
    expect(rawCalls).toBe(1);
    expect(output.budgetDenied).toBe(true);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });
});

describe('R10 SafeFetchExecutor fake contract coverage (connector propagation)', () => {
  it('RSS multi-feed: a denial on the SECOND feed aborts with no third call and the PRIOR cursor', async () => {
    const mock = createFetchMock([
      validFeed(RSS_BODY),
      { failReason: 'budget_denied' },
      validFeed(RSS_BODY), // must NEVER be consumed
    ]);
    const output = await createRssConnector().fetch({
      sourceId: 'itch_discovery',
      config: {
        endpointTemplates: [
          'https://itch.io/games/newest.xml',
          'https://itch.io/games/newest/price-free.xml',
        ],
      },
      state,
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(mock.calls).toHaveLength(2); // no extra network after denial
    expect(output.budgetDenied).toBe(true);
    expect(output.budgetDenialKind).toBe('budget_exhausted');
    expect(output.status).toBe('failed');
    expect(output.failureReason).toBe('budget_exhausted');
    expect(output.items).toHaveLength(0);
    expect(output.cursor).toBe(state.cursor); // PRIOR cursor — no partial progress
    expect(output.requestCount).toBe(2); // cumulative observed attempts
  });

  it('Steam: a denial preserves the SAME rotation window cursor (never rotates ahead)', async () => {
    const config = { apps: [570, 440, 730], appsPerBatch: 2, maxItemsPerApp: 3 };
    const mock = createFetchMock([
      { status: 200, bodyText: '{"appnews":{"newsitems":[]}}' },
      { failReason: 'budget_denied' },
    ]);
    const output = await createSteamNewsConnector().fetch({
      sourceId: 'steam_news_watchlist',
      config,
      state,
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(mock.calls).toHaveLength(2);
    expect(output.budgetDenied).toBe(true);
    expect(output.failureReason).toBe('budget_exhausted');
    expect(output.items).toHaveLength(0);
    // The PRIOR cursor is preserved EXACTLY (null prior stays null — R04
    // invariant: nothing invented, nothing wiped). The SAME window is
    // retried later because the normalized placement of a null cursor is
    // deterministic (start 0).
    expect(output.cursor).toBe(state.cursor);
  });

  it('Steam: source_missing propagates with its own denial kind', async () => {
    const config = { apps: [570], appsPerBatch: 1, maxItemsPerApp: 3 };
    const mock = createFetchMock([{ failReason: 'budget_source_missing' }]);
    const output = await createSteamNewsConnector().fetch({
      sourceId: 'steam_news_watchlist',
      config,
      state,
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(output.budgetDenied).toBe(true);
    expect(output.budgetDenialKind).toBe('source_missing');
    expect(output.failureReason).toBe('budget_exhausted');
  });

  it('YouTube: a denial on the details call is authority, not silent enrichment degradation', async () => {
    const config = {
      useSearchEndpoint: false,
      downloadVideo: false,
      playlists: ['PLreview123456'],
    };
    const mock = createFetchMock([
      {
        status: 200,
        bodyText:
          '{"items":[{"contentDetails":{"videoId":"dQw4w9WgXcQ"},"snippet":{"title":"t"}}]}',
      },
      { failReason: 'budget_denied' },
    ]);
    const output = await createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_official_watchlist',
      config,
      state,
      effects: connectorEffects(mock.fetchFn, { YOUTUBE_API_KEY: 'fixture-not-a-real-key' }),
    });
    expect(mock.calls).toHaveLength(2);
    expect(output.budgetDenied).toBe(true);
    expect(output.items).toHaveLength(0); // no items from a denied window
    expect(output.requestCount).toBe(2);
  });

  it('YouTube: a denial on the FIRST playlist page aborts before any details call', async () => {
    const config = {
      useSearchEndpoint: false,
      downloadVideo: false,
      playlists: ['PLreview123456'],
    };
    const mock = createFetchMock([{ failReason: 'budget_denied' }]);
    const output = await createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_official_watchlist',
      config,
      state,
      effects: connectorEffects(mock.fetchFn, { YOUTUBE_API_KEY: 'fixture-not-a-real-key' }),
    });
    expect(mock.calls).toHaveLength(1);
    expect(output.budgetDenied).toBe(true);
  });

  it('GitHub multi-repo: a denial on the second repo keeps the PRIOR etag cursor and no items', async () => {
    const config = { repositories: ['owner/first', 'owner/second'], includePrereleases: false };
    const priorCursor = '{"owner/first":"etag-v1"}';
    const mock = createFetchMock([
      { status: 200, bodyText: '[{"id":1,"tag_name":"v1"}]' },
      { failReason: 'budget_denied' },
    ]);
    const output = await createGithubReleasesConnector().fetch({
      sourceId: 'github_release_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: priorCursor },
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(mock.calls).toHaveLength(2);
    expect(output.budgetDenied).toBe(true);
    expect(output.cursor).toBe(priorCursor); // PRIOR cursor — no partial etag progress
    expect(output.items).toHaveLength(0);
    expect(output.requestCount).toBe(2);
  });

  it('Reddit: a denial on the token request emits ZERO listing calls', async () => {
    const config = { subreddits: ['CrackWatch'], limit: 25 };
    const mock = createFetchMock([{ failReason: 'budget_denied' }]);
    const output = await createRedditOauthConnector().fetch({
      sourceId: 'reddit_crack_signals',
      config,
      state,
      effects: connectorEffects(mock.fetchFn, {
        REDDIT_CLIENT_ID: 'fixture-id',
        REDDIT_CLIENT_SECRET: 'fixture-secret',
      }),
    });
    expect(mock.calls).toHaveLength(1); // token only — the API path never ran
    expect(output.budgetDenied).toBe(true);
    expect(output.requestCount).toBe(1);
  });

  it('Reddit: a denial on the first listing after a successful token keeps the prior cursor', async () => {
    const config = { subreddits: ['CrackWatch', 'GamingLeaksAndRumours'], limit: 25 };
    const priorCursor = '{"CrackWatch":"t3_after_old"}';
    const mock = createFetchMock([
      { status: 200, bodyText: '{"access_token":"fixture-token","token_type":"bearer"}' },
      { failReason: 'budget_denied' },
      { status: 200, bodyText: '{}' }, // never consumed
    ]);
    const output = await createRedditOauthConnector().fetch({
      sourceId: 'reddit_crack_signals',
      config,
      state: { etag: null, lastModified: null, cursor: priorCursor },
      effects: connectorEffects(mock.fetchFn, {
        REDDIT_CLIENT_ID: 'fixture-id',
        REDDIT_CLIENT_SECRET: 'fixture-secret',
      }),
    });
    expect(mock.calls).toHaveLength(2);
    expect(output.budgetDenied).toBe(true);
    expect(output.cursor).toBe(priorCursor);
    expect(output.requestCount).toBe(2);
  });

  it('the UNBOUNDED core transport (createSafeFetch) is unchanged and never charges', async () => {
    await setBudget('playstation_blog', 0); // zero authority on purpose
    const safe = createSafeFetch((async () => okXml(RSS_BODY)) as typeof fetch);
    const result = await safe({
      url: 'https://blog.playstation.com/feed/',
      headers: {},
      byteCap: INGESTION_LIMITS.maxFeedBytes,
      timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
      maxRedirects: INGESTION_LIMITS.maxRedirects,
      allowedHosts: ['blog.playstation.com'],
    });
    expect(result.ok).toBe(true); // non-ingestion/test transport: unlimited by design
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(0);
  });
});

describe('R10 raw-port: handler-level sequences on REAL workerd D1', () => {
  const INGESTION_POLL_HOLD_MS = 120_000;

  /**
   * Make the fenced terminal state write OWN the window: the state UPDATE
   * is fenced on `next_poll_at = scheduledForMs + hold`, so every direct
   * execution aligns the seeded/marked next_poll_at with the payload the
   * same way the scheduler's reservation would (holdUntil = scheduled +
   * hold). Returns the payload to pass.
   */
  async function alignWindow(sourceId: string, scheduledForMs: number): Promise<number> {
    await db.run({
      sql: 'UPDATE source_state SET next_poll_at = ? WHERE source_id = ?',
      params: [scheduledForMs + INGESTION_POLL_HOLD_MS, sourceId],
    });
    return scheduledForMs;
  }

  /** Payload for a follow-up execution that owns the CURRENT window. */
  async function nextWindowPayload(sourceId: string): Promise<number> {
    const row = await db.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id = ?',
      params: [sourceId],
    });
    const scheduledForMs = row!.next_poll_at - INGESTION_POLL_HOLD_MS;
    return scheduledForMs;
  }

  const handlerWith = (fetchFn: typeof fetch, nowMs: () => number = () => NOW) =>
    createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn,
      idGenerator: { newId: () => `r18-${Math.random().toString(36).slice(2, 10)}` },
      secrets: (name) =>
        name === 'YOUTUBE_API_KEY'
          ? 'fixture-not-a-real-key'
          : name === 'REDDIT_CLIENT_ID'
            ? 'fixture-id'
            : name === 'REDDIT_CLIENT_SECRET'
              ? 'fixture-secret'
              : undefined,
      nowMs: nowMs,
      random: () => 0.5,
    });

  it('budget-denied poll commits budget_exhausted terminal state with the PRIOR cursor and no items', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 1);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls === 1 ? redir('https://blog.playstation.com/feed/final') : okXml(RSS_BODY);
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    const outcome = await handlerWith(fetchFn).execute({
      jobId: 'r18-denied',
      generation: 1,
      payload: { sourceId: 'playstation_blog', scheduledForMs },
    });
    expect(outcome).toEqual({ kind: 'success' }); // one poll attempt durably recorded
    expect(rawCalls).toBe(1);
    const stateRow = await db.first<{
      last_error: string | null;
      consecutive_failures: number;
      next_poll_at: number;
      requests_today: number;
      cursor: string | null;
    }>({
      sql: 'SELECT last_error, consecutive_failures, next_poll_at, requests_today, cursor FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(stateRow?.last_error).toBe('budget_exhausted');
    expect(stateRow?.consecutive_failures).toBe(0); // budget is not a source fault
    expect(stateRow?.cursor).toBeNull(); // prior cursor preserved (seeded cursor is null)
    expect(stateRow?.requests_today).toBe(1); // durable charge readback
    expect((stateRow?.next_poll_at ?? 0) - NOW).toBe(10 * 60 * 1000); // budget pacing
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('the SAME saved window resumes correctly after the budget becomes available', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 1);
    // First poll: denied at the redirect hop (the only unit was spent on hop 0).
    let phase = 1;
    let resumedCalls = 0;
    const fetchFn = (async () => {
      if (phase === 1) {
        return redir('https://blog.playstation.com/feed/final');
      }
      resumedCalls += 1;
      return resumedCalls === 1
        ? redir('https://blog.playstation.com/feed/final')
        : okXml(RSS_BODY);
    }) as typeof fetch;
    const firstScheduledForMs = await alignWindow('playstation_blog', NOW);
    await handlerWith(fetchFn).execute({
      jobId: 'r18-resume-1',
      generation: 1,
      payload: { sourceId: 'playstation_blog', scheduledForMs: firstScheduledForMs },
    });
    // Budget becomes available again (cap raised) — the SAME saved window
    // (prior cursor, prior validators) is refetched and completes.
    phase = 2;
    await setBudget('playstation_blog', 3);
    const resumedScheduledForMs = await nextWindowPayload('playstation_blog');
    const outcome = await handlerWith(fetchFn).execute({
      jobId: 'r18-resume-2',
      generation: 1,
      payload: { sourceId: 'playstation_blog', scheduledForMs: resumedScheduledForMs },
    });
    expect(outcome).toEqual({ kind: 'success' });
    expect(resumedCalls).toBe(2); // the redirect sequence ran in full this time
    const stateRow = await db.first<{ last_error: string | null; requests_today: number }>({
      sql: 'SELECT last_error, requests_today FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(stateRow?.last_error).toBeNull();
    expect(stateRow?.requests_today).toBe(3); // 1 (denied poll) + 2 (redirect + final)
    const items = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(items?.n).toBe(1);
  });

  it('Steam windows: later denial preserves the window; rotation advances ONLY on completion', async () => {
    await enable('steam_news_watchlist');
    await db.run({
      sql: "UPDATE sources SET config_json=json_set(config_json,'$.apps',json('[570,440,730]'),'$.appsPerBatch',2) WHERE id='steam_news_watchlist'",
    });
    await setBudget('steam_news_watchlist', 1);
    let rawCalls = 0;
    const appids: string[] = [];
    const fetchFn = (async (url: string | URL | RequestInfo) => {
      rawCalls += 1;
      appids.push(new URL(String(url)).searchParams.get('appid') ?? '');
      return okJson('{"appnews":{"newsitems":[]}}');
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('steam_news_watchlist', NOW);
    // cap 1: app1 consumes the unit; app2's authorization is DENIED — no
    // second raw request, window [570,440] preserved, no rotation.
    await handlerWith(fetchFn).execute({
      jobId: 'r18-steam-1',
      generation: 1,
      payload: { sourceId: 'steam_news_watchlist', scheduledForMs },
    });
    expect(rawCalls).toBe(1); // NO extra network after the denial
    expect(appids).toEqual(['570']);
    const cursorAfterDenial = await db.first<{ cursor: string | null }>({
      sql: 'SELECT cursor FROM source_state WHERE source_id = ?',
      params: ['steam_news_watchlist'],
    });
    // The prior cursor is preserved EXACTLY (seeded null stays null — the
    // R04 invariant: nothing invented, nothing wiped).
    expect(cursorAfterDenial!.cursor).toBeNull();

    // Budget available again: the SAME window [570,440] (a null cursor
    // deterministically normalizes to start 0) completes and the cursor
    // advances to (0 + 2) mod 3 = 2.
    await setBudget('steam_news_watchlist', 5);
    const resumedScheduledForMs = await nextWindowPayload('steam_news_watchlist');
    await handlerWith(fetchFn).execute({
      jobId: 'r18-steam-2',
      generation: 1,
      payload: { sourceId: 'steam_news_watchlist', scheduledForMs: resumedScheduledForMs },
    });
    expect(rawCalls).toBe(3); // 1 (denied poll) + 2 (the completed window)
    expect(appids.slice(1)).toEqual(['570', '440']); // the SAME window was retried
    const cursorAfterResume = await db.first<{ cursor: string | null }>({
      sql: 'SELECT cursor FROM source_state WHERE source_id = ?',
      params: ['steam_news_watchlist'],
    });
    const completedCursor = JSON.parse(cursorAfterResume!.cursor ?? '{}') as { start?: number };
    expect(completedCursor.start).toBe(2); // rotation advanced ONLY on the completed window
  });

  it('YouTube playlist/details: later denial defers the whole window; resume commits items', async () => {
    await enable('youtube_official_watchlist');
    await db.run({
      sql: "UPDATE sources SET config_json=json_set(config_json,'$.playlists',json('[\"PLreview123456\"]')) WHERE id='youtube_official_watchlist'",
    });
    await setBudget('youtube_official_watchlist', 1);
    let rawCalls = 0;
    const fetchFn = (async (url: string | URL | RequestInfo) => {
      rawCalls += 1;
      void url;
      return okJson(
        '{"items":[{"contentDetails":{"videoId":"dQw4w9WgXcQ"},"snippet":{"title":"t"}}]}',
      );
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('youtube_official_watchlist', NOW);
    // cap 1: the playlist page consumes the unit; the details call's
    // authorization is DENIED — the raw details fetch is never issued.
    await handlerWith(fetchFn).execute({
      jobId: 'r18-yt-1',
      generation: 1,
      payload: { sourceId: 'youtube_official_watchlist', scheduledForMs },
    });
    expect(rawCalls).toBe(1); // playlist page only; details DENIED → no second raw call
    const ytState1 = await db.first<{ last_error: string | null; cursor: string | null }>({
      sql: 'SELECT last_error, cursor FROM source_state WHERE source_id = ?',
      params: ['youtube_official_watchlist'],
    });
    expect(ytState1?.last_error).toBe('budget_exhausted');
    expect(ytState1?.cursor).toBeNull(); // prior cursor preserved through the denial
    const itemsAfterDenial = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['youtube_official_watchlist'],
    });
    expect(itemsAfterDenial?.n).toBe(0); // no items from an incomplete denied sequence

    // Resume with budget: both requests run and items commit.
    await setBudget('youtube_official_watchlist', 5);
    const resumedScheduledForMs = await nextWindowPayload('youtube_official_watchlist');
    await handlerWith(fetchFn).execute({
      jobId: 'r18-yt-2',
      generation: 1,
      payload: { sourceId: 'youtube_official_watchlist', scheduledForMs: resumedScheduledForMs },
    });
    expect(rawCalls).toBe(3); // 1 (denied pass) + 2 (playlist + details)
    const items = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['youtube_official_watchlist'],
    });
    expect(items?.n).toBe(1);
  });

  it('RSS multi-target: a later denial discards earlier feeds\u2019 items and preserves the prior cursor', async () => {
    await enable('itch_discovery'); // registry ships TWO endpointTemplates
    await setBudget('itch_discovery', 1);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls === 1
        ? okXml(RSS_BODY)
        : Promise.reject(new TypeError('canary: never reached'));
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('itch_discovery', NOW);
    // cap 1: feed1 consumes the unit; feed2's authorization is DENIED.
    await handlerWith(fetchFn).execute({
      jobId: 'r18-rss-multi-1',
      generation: 1,
      payload: { sourceId: 'itch_discovery', scheduledForMs },
    });
    expect(rawCalls).toBe(1); // feed1 done, feed2 DENIED → no second raw call
    const rssState = await db.first<{ last_error: string | null; cursor: string | null }>({
      sql: 'SELECT last_error, cursor FROM source_state WHERE source_id = ?',
      params: ['itch_discovery'],
    });
    expect(rssState?.last_error).toBe('budget_exhausted');
    expect(rssState?.cursor).toBeNull(); // PRIOR cursor — feed1's progress NOT persisted
    const itemsAfterDenial = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['itch_discovery'],
    });
    expect(itemsAfterDenial?.n).toBe(0); // no items from an incomplete denied sequence

    // Resume: both feeds fetch DISTINCT bodies (identical bodies would be
    // deduped into one item), items commit.
    await setBudget('itch_discovery', 5);
    const RSS_BODY_2 = RSS_BODY.replace('ps-news-1', 'ps-news-2').replace('new-game', 'new-game-2');
    let resumedFeed = 0;
    const fetchFn2 = (async () => {
      resumedFeed += 1;
      return resumedFeed === 1 ? okXml(RSS_BODY) : okXml(RSS_BODY_2);
    }) as typeof fetch;
    const resumedScheduledForMs = await nextWindowPayload('itch_discovery');
    await handlerWith(fetchFn2).execute({
      jobId: 'r18-rss-multi-2',
      generation: 1,
      payload: { sourceId: 'itch_discovery', scheduledForMs: resumedScheduledForMs },
    });
    const itemsAfterResume = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['itch_discovery'],
    });
    expect(itemsAfterResume?.n).toBe(2); // one item per feed after the resumed window
  });

  it('GitHub multi-repo: later denial keeps the prior etag cursor; resume completes', async () => {
    await enable('github_release_watchlist');
    await db.run({
      sql: "UPDATE sources SET config_json=json_set(config_json,'$.repositories',json('[\"owner/first\",\"owner/second\"]')) WHERE id='github_release_watchlist'",
    });
    await setBudget('github_release_watchlist', 1);
    let rawCalls = 0;
    const releases =
      '[{"id":1,"tag_name":"v1.0.0","name":"v1","html_url":"https://github.com/owner/first/releases/v1.0.0"}]';
    const fetchFn = (async (url: string | URL | RequestInfo) => {
      rawCalls += 1;
      void url;
      return okJson(releases);
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('github_release_watchlist', NOW);
    // cap 1: repo1 consumes the unit; repo2's authorization is DENIED.
    await handlerWith(fetchFn).execute({
      jobId: 'r18-gh-1',
      generation: 1,
      payload: { sourceId: 'github_release_watchlist', scheduledForMs },
    });
    expect(rawCalls).toBe(1); // repo1 fetched; repo2 denied → no second raw call
    const ghState = await db.first<{ last_error: string | null; cursor: string | null }>({
      sql: 'SELECT last_error, cursor FROM source_state WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });
    expect(ghState?.last_error).toBe('budget_exhausted');
    expect(ghState?.cursor).toBeNull(); // prior cursor — repo1's etag NOT persisted

    await setBudget('github_release_watchlist', 5);
    const resumedScheduledForMs = await nextWindowPayload('github_release_watchlist');
    await handlerWith(fetchFn).execute({
      jobId: 'r18-gh-2',
      generation: 1,
      payload: { sourceId: 'github_release_watchlist', scheduledForMs: resumedScheduledForMs },
    });
    expect(rawCalls).toBe(3); // 1 (denied pass) + 2 (both repos)
    const items = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });
    expect(items?.n).toBeGreaterThanOrEqual(1);
  });

  it('Reddit token+API path: token denial stops before the API with ZERO raw requests; resume completes both', async () => {
    await enable('reddit_crack_signals');
    await setBudget('reddit_crack_signals', 0);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return Promise.reject(new TypeError('canary: never reached'));
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('reddit_crack_signals', NOW);
    // quota 0: the token request's authorization is DENIED at hop 0.
    await handlerWith(fetchFn).execute({
      jobId: 'r18-reddit-1',
      generation: 1,
      payload: { sourceId: 'reddit_crack_signals', scheduledForMs },
    });
    expect(rawCalls).toBe(0); // token request denied → ZERO raw requests
    const redditState = await db.first<{ last_error: string | null }>({
      sql: 'SELECT last_error FROM source_state WHERE source_id = ?',
      params: ['reddit_crack_signals'],
    });
    expect(redditState?.last_error).toBe('budget_exhausted');

    // Resume: token + listing succeed.
    await setBudget('reddit_crack_signals', 5);
    const listingBody =
      '{"data":{"after":"t3_after_1","children":[{"data":{"id":"abc123","name":"t3_abc123","title":"Signal","permalink":"/r/CrackWatch/comments/abc123/signal/","created_utc":1759700000}}]}}';
    const fetchFn2 = (async (url: string | URL | RequestInfo) => {
      rawCalls += 1;
      if (String(url).includes('/api/v1/access_token')) {
        return okJson('{"access_token":"fixture-token","token_type":"bearer"}');
      }
      return okJson(listingBody);
    }) as typeof fetch;
    const resumedScheduledForMs = await nextWindowPayload('reddit_crack_signals');
    await handlerWith(fetchFn2).execute({
      jobId: 'r18-reddit-2',
      generation: 1,
      payload: { sourceId: 'reddit_crack_signals', scheduledForMs: resumedScheduledForMs },
    });
    expect(rawCalls).toBe(2); // token + listing (the denied pass made zero calls)
    const items = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
      params: ['reddit_crack_signals'],
    });
    expect(items?.n).toBe(1);
  });

  it('mid-sequence missing source surfaces the permanent ingestion_source_missing outcome', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 5);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      if (rawCalls === 1) {
        // The source row vanishes AFTER hop 0 consumed its unit.
        await db.run({ sql: "DELETE FROM source_state WHERE source_id = 'playstation_blog'" });
        await db.run({ sql: "DELETE FROM sources WHERE id = 'playstation_blog'" });
        return redir('https://blog.playstation.com/feed/final');
      }
      return okXml(RSS_BODY);
    }) as typeof fetch;
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    const outcome = await handlerWith(fetchFn).execute({
      jobId: 'r18-vanished',
      generation: 1,
      payload: { sourceId: 'playstation_blog', scheduledForMs },
    });
    expect(outcome).toEqual({ kind: 'permanent', reasonCode: 'ingestion_source_missing' });
    expect(rawCalls).toBe(1); // hop0 only — hop1 was refused with ZERO raw requests
  });

  it('D1 failure at the FIRST authorization: no unauthorized raw call, distinct retry path, no state write', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 5);
    const failingExecutor: DbExecutor = {
      ...db,
      batch: async () => {
        throw new Error('simulated D1 outage');
      },
    };
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return okXml(RSS_BODY);
    }) as typeof fetch;
    const handler = createSourcePollHandler({
      executor: failingExecutor,
      connectors: createConnectorRegistry(),
      fetchFn,
      idGenerator: { newId: () => 'r18-infra-1' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
    });
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    const outcome = await handler.execute({
      jobId: 'r18-infra-1',
      generation: 1,
      payload: { sourceId: 'playstation_blog', scheduledForMs },
    });
    // Distinct stable infrastructure classification — job retry, NOT quota
    // exhaustion, NOT a provider failure, NOT unknown-job poison.
    expect(outcome).toEqual({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    expect(rawCalls).toBe(0); // failed closed BEFORE any network
    const stateRow = await db.first<{ cursor: string | null; last_error: string | null }>({
      sql: 'SELECT cursor, last_error FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(stateRow?.cursor).toBeNull(); // seeded state untouched — durable cursor unchanged
    expect(stateRow?.last_error).toBeNull(); // NO terminal state write on the infra path
  });

  it('D1 failure at a LATER authorization: charged units stand, cursor unchanged, retry path', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 5);
    let authorizations = 0;
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return rawCalls === 1 ? redir('https://blog.playstation.com/feed/final') : okXml(RSS_BODY);
    }) as typeof fetch;
    const failingExecutor: DbExecutor = {
      ...db,
      batch: async (statements) => {
        authorizations += 1;
        if (authorizations === 2) {
          throw new Error('simulated D1 outage at hop 1');
        }
        return db.batch(statements);
      },
    };
    const handler = createSourcePollHandler({
      executor: failingExecutor,
      connectors: createConnectorRegistry(),
      fetchFn,
      idGenerator: { newId: () => 'r18-infra-2' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
    });
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    const outcome = await handler.execute({
      jobId: 'r18-infra-2',
      generation: 1,
      payload: { sourceId: 'playstation_blog', scheduledForMs },
    });
    expect(outcome).toEqual({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    expect(rawCalls).toBe(1); // hop0 happened (authorized + attempted); hop1 refused
    // The durable charge from hop 0 STANDS (no hidden observed-count loss).
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
    const stateRow = await db.first<{ cursor: string | null; last_error: string | null }>({
      sql: 'SELECT cursor, last_error FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(stateRow?.last_error).toBeNull(); // NO terminal state write on the infra path
    expect(stateRow?.cursor).toBeNull(); // durable cursor unchanged
  });

  it('charged-but-not-attempted crash window: an authorization without any fetch stays charged', async () => {
    await setBudget('playstation_blog', 2);
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('authorized');
    // The process dies here — before any raw fetch. The unit REMAINS charged
    // (disclosed conservative under-utilization; never exactly-once usage).
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
    // And with the cap lowered to the current usage, the next unit is denied.
    await setBudget('playstation_blog', 1);
    expect(
      (await authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW })).kind,
    ).toBe('denied');
  });
});
