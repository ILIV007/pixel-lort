import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { createSteamNewsConnector } from '../../src/connectors/steam-news';
import { createYoutubePlaylistsConnector } from '../../src/connectors/youtube-playlists';
import { createRssConnector } from '../../src/connectors/rss';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { readIngestionBudget } from '../../src/adapters/db/ingestion-budget-store';
import type { WorkerEnv } from '../../src/shared/types/env';
const NOW = 1770000000000;
const db = createDbExecutor(env.DB);
const registry = () => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('registry invalid');
  return r.registry;
};
const seed = () => seedSourcesFromRegistry(db, registry(), NOW);
const state = { etag: null, lastModified: null, cursor: null };
const resolution = (flag = 'true') => {
  const r = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: flag,
    JOBS: { send: async () => {} },
    DLQ: { send: async () => {} },
  } as unknown as WorkerEnv);
  if (r.kind !== 'ready') throw new Error('engine not ready');
  return r;
};
beforeEach(async () => {
  // Round 1.9 (R09) fixture adaptation — SETUP ONLY: this file hosts the
  // ORIGINAL R09 acceptance, which must turn green through the REAL product
  // ownership path. Ownership is a schema-4 capability (migration candidate
  // 0004), so THIS file's disposable test database applies the explicit
  // test-only ROUND19_MIGRATION_PLAN (0001–0003 + the 0004 candidate;
  // disposable workerd D1 ONLY — never applied anywhere real). All test
  // names, scripts, payloads and assertion lines below are UNCHANGED;
  // the two additional R10 fixture rows are documented at that test.
  await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
});
it('R03a: seeded Steam config plus owner apps must pass preflight', async () => {
  await seed();
  await db.run({
    sql: "UPDATE sources SET config_json=json_set(config_json,'$.apps',json('[570,440]')) WHERE id='steam_news_watchlist'",
  });
  const row = await db.first<{ config_json: string }>({
    sql: "SELECT config_json FROM sources WHERE id='steam_news_watchlist'",
  });
  expect(
    createSteamNewsConnector().preflight(JSON.parse(row!.config_json), () => undefined),
  ).toEqual({ ok: true });
});
it('R03b: seeded YouTube config plus owner playlist and key must pass preflight', async () => {
  await seed();
  await db.run({
    sql: "UPDATE sources SET config_json=json_set(config_json,'$.playlists',json('[\"PLreview123456\"]')) WHERE id='youtube_official_watchlist'",
  });
  const row = await db.first<{ config_json: string }>({
    sql: "SELECT config_json FROM sources WHERE id='youtube_official_watchlist'",
  });
  expect(
    createYoutubePlaylistsConnector().preflight(
      JSON.parse(row!.config_json),
      () => 'fixture-not-a-real-key',
    ),
  ).toEqual({ ok: true });
});
it('R04: Steam batching must eventually visit watched apps after the first batch', async () => {
  const mock = createFetchMock(
    Array.from({ length: 4 }, () => ({
      status: 200,
      bodyText: '{"appnews":{"newsitems":[]}}',
    })),
  );
  const connector = createSteamNewsConnector();
  const input = {
    sourceId: 'steam_news_watchlist',
    config: { apps: [570, 440, 730], appsPerBatch: 2, maxItemsPerApp: 3 },
    state,
    effects: connectorEffects(mock.fetchFn, {}),
  };
  const first = await connector.fetch(input);
  await connector.fetch({
    ...input,
    state: { ...state, cursor: first.cursor },
  });
  expect(mock.calls.map((c) => new URL(c.url).searchParams.get('appid'))).toContain('730');
});
it('R05: RSS multi-feed Retry-After must preserve the longest lower bound', async () => {
  const mock = createFetchMock([
    { status: 429, headers: { 'retry-after': '7200' } },
    { status: 429, headers: { 'retry-after': '60' } },
  ]);
  const result = await createRssConnector().fetch({
    sourceId: 'itch_discovery',
    config: {
      endpointTemplates: ['https://itch.io/feed/new.xml', 'https://itch.io/feed/updated.xml'],
    },
    state,
    effects: connectorEffects(mock.fetchFn, {}),
  });
  expect(result.retryAfterSeconds).toBe(7200);
});
it('R06: YouTube must count earlier successful calls when a later playlist fails', async () => {
  const mock = createFetchMock([{ status: 200, bodyText: '{"items":[]}' }, { status: 500 }]);
  const result = await createYoutubePlaylistsConnector().fetch({
    sourceId: 'youtube_official_watchlist',
    config: {
      useSearchEndpoint: false,
      downloadVideo: false,
      playlists: ['PLreview123456', 'PLreview654321'],
    },
    state,
    effects: connectorEffects(mock.fetchFn, {
      YOUTUBE_API_KEY: 'fixture-not-a-real-key',
    }),
  });
  expect(mock.calls).toHaveLength(2);
  expect(result.requestCount).toBe(2);
});
it('R07: seeding import must preserve an owner-configured runtime watchlist', async () => {
  await seed();
  await db.run({
    sql: "UPDATE sources SET config_json=json_set(config_json,'$.apps',json('[570]')) WHERE id='steam_news_watchlist'",
  });
  await seed();
  const row = await db.first<{ config_json: string }>({
    sql: "SELECT config_json FROM sources WHERE id='steam_news_watchlist'",
  });
  expect(JSON.parse(row!.config_json).apps).toEqual([570]);
});
it('R08: interrupted catalog seeding must recover on a later cron pass', async () => {
  // ── SUPPLIED FAULT INJECTION (original, retained verbatim as review
  // reference) ─────────────────────────────────────────────────────────
  //   let calls = 0;
  //   const broken = {
  //     ...db,
  //     run: async (...args: Parameters<typeof db.run>) => {
  //       calls++;
  //       if (calls === 3) throw new Error('injected storage failure');
  //       return db.run(...args);
  //     },
  //   };
  //
  // ADAPTATION REASON (Round 1.3, reviewer-authorized): the Round 1.2
  // candidate seeded with ~28 loose executor.run statements (2 per
  // source), so `db.run` call #3 hit the second source's upsert and left
  // a genuinely PARTIAL catalog. R08 now requires bounded ATOMIC
  // reconciliation: seedSourcesFromRegistry issues ONE D1 batch for the
  // whole catalog (all-or-nothing on real workerd D1), so `db.run` is no
  // longer the storage boundary of the seed. ONLY the injection point
  // moved — from `run` call #3 to the first `batch` call — so the same
  // "storage dies during seeding" fault still exercises the code. The
  // supplied failure/recovery assertions below are UNCHANGED; real D1
  // rollback coverage (the failed batch must leave ZERO rows) and the
  // legacy-partial-state fixtures live in round13-r03-r07-r08.test.ts.
  let batchCalls = 0;
  const broken = {
    ...db,
    batch: async (...args: Parameters<typeof db.batch>) => {
      batchCalls++;
      if (batchCalls === 1) throw new Error('injected storage failure');
      return db.batch(...args);
    },
  };
  await expect(seedSourcesFromRegistry(broken, registry(), NOW)).rejects.toThrow();
  // REAL D1 ROLLBACK COVERAGE (new, reviewer-requested): the atomic batch
  // must have rolled back completely — not a single source or state row.
  const sourcesAfterFailure = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM sources',
  });
  expect(sourcesAfterFailure!.n).toBe(0);
  const statesAfterFailure = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_state',
  });
  expect(statesAfterFailure!.n).toBe(0);
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const count = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM sources',
  });
  expect(count!.n).toBe(14);
});
it('R09: a new source reservation must hold until after now, not in 1970', async () => {
  await seed();
  await db.run({
    sql: "UPDATE sources SET enabled=1 WHERE id='playstation_blog'",
  });
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const row = await db.first<{ next_poll_at: number }>({
    sql: "SELECT next_poll_at FROM source_state WHERE source_id='playstation_blog'",
  });
  expect(row!.next_poll_at).toBeGreaterThan(NOW);
});
it('R10: redirects must not consume requests beyond a one-request daily budget', async () => {
  // Round 1.9 (R09) fixture adaptation — SETUP ONLY (two additions, the
  // script, invocation and BOTH assertion lines below are unchanged):
  // under ownership the handler (1) ACQUIRES the window at claim time
  // (A1 branch (i): owner NULL AND next_poll_at = the payload marker) and
  // (2) commits behind the ownership fence, which requires the job row to
  // exist CLAIMED with the exact generation. The fixture therefore seeds
  // the marker at the payload's scheduledForMs (NOW — replacing the legacy
  // marker+hold value; the hold is now written BY A1 itself) and inserts
  // the claimed job row the context references. No assertion changed.
  await seed();
  await db.run({
    sql: "UPDATE sources SET enabled=1,daily_request_budget=1 WHERE id='playstation_blog'",
  });
  await db.run({
    sql: "UPDATE source_state SET next_poll_at=? WHERE source_id='playstation_blog'",
    params: [NOW],
  });
  await db.run({
    sql: `INSERT INTO jobs
            (id, type, aggregate_type, aggregate_id, status, priority, run_after,
             attempts, max_attempts, lease_until, idempotency_key, payload_json,
             last_error, created_at, updated_at, dlq_delivered_at)
          VALUES ('fixture-job', 'sources.fetch_poll', 'source', 'playstation_blog',
                  'claimed', 40, ?, 1, 3, NULL, 'review-r10-fixture', ?, NULL, ?, ?, NULL)`,
    params: [NOW, JSON.stringify({ sourceId: 'playstation_blog', scheduledForMs: NOW }), NOW, NOW],
  });
  let calls = 0;
  // Round 1.8 (R10) fixture adaptation — SETUP ONLY: the raw scripted fetch
  // is now passed directly to the handler (`fetchFn`), which builds the
  // mandatory budgeted ingestion transport itself. The script, invocation
  // and both assertion lines below are unchanged.
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://blog.playstation.com/feed/final' },
        })
      : new Response('<rss><channel></channel></rss>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
  }) as typeof fetch;
  const handler = createSourcePollHandler({
    executor: db,
    connectors: createConnectorRegistry(),
    fetchFn,
    idGenerator: { newId: () => crypto.randomUUID() },
    secrets: () => undefined,
    nowMs: () => NOW,
    random: () => 0.5,
  });
  await handler.execute({
    jobId: 'fixture-job',
    generation: 1,
    payload: { sourceId: 'playstation_blog', scheduledForMs: NOW },
  });
  const usage = await readIngestionBudget(db, {
    sourceId: 'playstation_blog',
    nowMs: NOW,
  });
  expect({ networkCalls: calls, usage }).toEqual({ networkCalls: 1, usage: 1 });
});
it('D01: disabling ingestion should pause a pending poll instead of permanently poisoning it', async () => {
  const engine = resolution('false').engine;
  const created = await engine.createDurableJob({
    type: 'sources.fetch_poll',
    idempotencyKey: 'review-gate-off',
    payload: { sourceId: 'playstation_blog', scheduledForMs: NOW },
  });
  if (created.kind !== 'created') throw new Error('job creation failed');
  const row = await db.first<{ id: string }>({
    sql: "SELECT id FROM jobs WHERE idempotency_key='review-gate-off'",
  });
  await engine.consumeMessage('review-msg', {
    version: 1,
    jobId: row!.id,
    type: 'sources.fetch_poll',
    attempt: 1,
    traceId: 'review-trace',
  });
  const after = await db.first<{ status: string }>({
    sql: 'SELECT status FROM jobs WHERE id=?',
    params: [row!.id],
  });
  expect(after!.status).not.toBe('dead_letter');
});
