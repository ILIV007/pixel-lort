import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry, type Registry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { createSteamNewsConnector } from '../../src/connectors/steam-news';
import { createYoutubePlaylistsConnector } from '../../src/connectors/youtube-playlists';
import { createRssConnector } from '../../src/connectors/rss';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import type { WorkerEnv } from '../../src/shared/types/env';

/**
 * Round 1.3 permanent coverage (real workerd D1 + scripted SafeFetchExecutor
 * fakes):
 *
 * COVERAGE PRECISION (corrected in Round 1.3.1): the fetch fake used here
 * (tests/helpers/fetch-mock.ts createFetchMock) is a scripted
 * SafeFetchExecutor — it does NOT execute createSafeFetch and does NOT see
 * raw `typeof fetch` calls. Tests in this file are therefore CONNECTOR
 * CONTRACT tests, not raw-HTTP integration tests. The raw-HTTP → real
 * createSafeFetch integration coverage lives in tests/integration/
 * round12-r01-r02.test.ts (accepted) and, since Round 1.3.1,
 * tests/integration/round131-real-http-port.test.ts (Steam + YouTube seed →
 * owner provisioning → REAL createSafeFetch → scripted raw fetch, incl.
 * off-allowlist redirect rejection before a second raw request or
 * credential disclosure).
 *
 * R03 — coherent strict configuration contract: seeded Steam/YouTube
 * descriptors plus valid owner watchlists pass preflight through the REAL
 * connector port; strict schemas reject unknown keys; documented
 * descriptor fields (endpoint/detailsEndpoint) are explicitly validated
 * against the PINNED official endpoints — arbitrary endpoints fail
 * preflight and are never silently ignored; forbidden-search/download
 * policies stay enforced; the YouTube credential is header-only.
 *
 * R07 — field ownership: re-import preserves owner watchlists (apps,
 * playlists, repositories, subreddits), enabled, priority,
 * interval_seconds and daily_request_budget overrides, and the ENTIRE
 * source_state; refreshes only registry-owned descriptor fields via the
 * atomic in-row json_patch merge; malformed persisted config fails
 * visibly WITHOUT destructive reset.
 *
 * R08 — catalog reconciliation: missing source rows AND missing state
 * rows are repaired even when the sources table is not empty; new rows
 * stay disabled; reconciliation is bounded and atomic (a failed repair
 * leaves the prior state exactly intact); repeated and overlapping passes
 * converge. No new schema, migration, metadata table, or KV dependency.
 */

const NOW = 1_770_000_000_000;
const db: DbExecutor = createDbExecutor(env.DB);

const registry = (): Registry => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('registry invalid');
  return r.registry;
};
const seed = (reg: Registry = registry(), at = NOW): Promise<unknown> =>
  seedSourcesFromRegistry(db, reg, at);

const resolution = () => {
  const r = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'true',
    JOBS: { send: async () => {} },
    DLQ: { send: async () => {} },
  } as unknown as WorkerEnv);
  if (r.kind !== 'ready') throw new Error('engine not ready');
  return r;
};

const schedule = (executor: DbExecutor = db, nowMs = NOW) =>
  scheduleDueSources({
    executor,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs,
  });

const counts = async (): Promise<{ sources: number; states: number }> => {
  const s = await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM sources' });
  const st = await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM source_state' });
  return { sources: s!.n, states: st!.n };
};

const configOf = async (id: string): Promise<Record<string, unknown>> => {
  const row = await db.first<{ config_json: string }>({
    sql: 'SELECT config_json FROM sources WHERE id = ?',
    params: [id],
  });
  return JSON.parse(row!.config_json) as Record<string, unknown>;
};

const setConfigKey = async (id: string, key: string, value: unknown): Promise<void> => {
  await db.run({
    sql: `UPDATE sources SET config_json = json_set(config_json, '$.${key}', json('${JSON.stringify(
      value,
    )}')) WHERE id = ?`,
    params: [id],
  });
};

/**
 * LEGACY PARTIAL CATALOG fixture (R08): simulates a catalog left behind by
 * an interrupted old-style (pre-batch) seed — three sources exist, one of
 * them missing its source_state row entirely, owner customizations in
 * place, eleven registry entries absent.
 */
async function seedLegacyPartialCatalog(): Promise<void> {
  const T = `INSERT INTO sources
    (id, name, connector, lane, trust_tier, enabled, interval_seconds, priority,
     daily_request_budget, approval_policy, attribution_template, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.run({
    sql: T,
    params: [
      'steam_news_watchlist',
      'Steam News (legacy)',
      'steam-news',
      'official',
      90,
      1, // owner ENABLED this source
      600,
      10, // owner priority override
      500,
      'auto',
      null,
      JSON.stringify({
        appsPerBatch: 10,
        maxItemsPerApp: 3,
        endpoint: 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/',
        apps: [570], // owner watchlist
      }),
      NOW,
      NOW,
    ],
  });
  await db.run({
    sql: T,
    params: [
      'playstation_blog',
      'PlayStation Blog',
      'rss',
      'official',
      90,
      0,
      300,
      80,
      300,
      'auto',
      null,
      JSON.stringify({ endpoint: 'https://blog.playstation.com/feed/' }),
      NOW,
      NOW,
    ],
  });
  await db.run({
    sql: T,
    params: [
      'github_release_watchlist',
      'GitHub Releases (legacy)',
      'github-releases',
      'official',
      90,
      0,
      900,
      80,
      999, // owner budget override
      'auto',
      null,
      JSON.stringify({ repositories: ['owner/repo'], includePrereleases: false }),
      NOW,
      NOW,
    ],
  });
  // State rows for TWO of the three sources — github is missing its state
  // row entirely (the R08 "missing state" case). The owner-enabled steam
  // row carries a FUTURE window so the scheduler must NOT touch it here
  // (reconciliation preserves owner state; only a due source is scheduled).
  await db.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                    requests_today, cursor, etag, updated_at)
          VALUES ('steam_news_watchlist', ?, 1, 3, 'legacy-cursor', '"legacy-etag"', ?)`,
    params: [NOW + 3_600_000, NOW],
  });
  await db.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                    requests_today, updated_at)
          VALUES ('playstation_blog', 0, 0, 0, ?)`,
    params: [NOW],
  });
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
});

describe('R03: coherent strict configuration contract', () => {
  it('steam: seeded descriptor + owner watchlist pass preflight and drive the REAL connector port (scripted SafeFetch fake — not raw HTTP)', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570, 440]);
    const config = await configOf('steam_news_watchlist');
    expect(createSteamNewsConnector().preflight(config, () => undefined)).toEqual({ ok: true });

    const mock = createFetchMock(
      Array.from({ length: 2 }, (_, i) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          appnews: {
            appid: i === 0 ? 570 : 440,
            newsitems: [
              {
                gid: `gid-${i}`,
                title: `Patch notes ${i}`,
                url: `https://store.steampowered.com/news/app/${i}/`,
                contents: 'Fixed several issues.',
                date: 1_769_000_000,
              },
            ],
          },
        }),
      })),
    );
    const result = await createSteamNewsConnector().fetch({
      sourceId: 'steam_news_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(2);
    expect(result.requestCount).toBe(2);
    expect(mock.calls.map((c) => new URL(c.url).hostname)).toEqual([
      'api.steampowered.com',
      'api.steampowered.com',
    ]);
  });

  it('steam: a tampered (non-official) endpoint descriptor fails preflight — never silently ignored', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570]);
    await setConfigKey(
      'steam_news_watchlist',
      'endpoint',
      'https://evil.example/ISteamNews/GetNewsForApp/v2/',
    );
    const config = await configOf('steam_news_watchlist');
    expect(createSteamNewsConnector().preflight(config, () => undefined).ok).toBe(false);
  });

  it('steam: a plain-http endpoint descriptor fails preflight', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570]);
    await setConfigKey(
      'steam_news_watchlist',
      'endpoint',
      'http://api.steampowered.com/ISteamNews/GetNewsForApp/v2/',
    );
    const config = await configOf('steam_news_watchlist');
    expect(createSteamNewsConnector().preflight(config, () => undefined).ok).toBe(false);
  });

  it('steam: unknown config keys are rejected (strict schemas kept)', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570]);
    await setConfigKey('steam_news_watchlist', 'injectedKey', 'https://evil.example/');
    const config = await configOf('steam_news_watchlist');
    expect(createSteamNewsConnector().preflight(config, () => undefined).ok).toBe(false);
  });

  it('steam: official host restriction preserved (allowedHosts)', () => {
    expect(createSteamNewsConnector().allowedHosts({})).toEqual(['api.steampowered.com']);
  });

  it('youtube: forbidden search endpoint policy stays enforced', async () => {
    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    await setConfigKey('youtube_official_watchlist', 'useSearchEndpoint', true);
    const config = await configOf('youtube_official_watchlist');
    expect(
      createYoutubePlaylistsConnector().preflight(config, () => 'fixture-not-a-real-key').ok,
    ).toBe(false);
  });

  it('youtube: forbidden video-download policy stays enforced', async () => {
    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    await setConfigKey('youtube_official_watchlist', 'downloadVideo', true);
    const config = await configOf('youtube_official_watchlist');
    expect(
      createYoutubePlaylistsConnector().preflight(config, () => 'fixture-not-a-real-key').ok,
    ).toBe(false);
  });

  it('youtube: tampered endpoint/detailsEndpoint descriptors fail preflight', async () => {
    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    await setConfigKey(
      'youtube_official_watchlist',
      'endpoint',
      'https://www.googleapis.com/evil/v3/playlistItems',
    );
    const tampered = await configOf('youtube_official_watchlist');
    expect(
      createYoutubePlaylistsConnector().preflight(tampered, () => 'fixture-not-a-real-key').ok,
    ).toBe(false);
    await setConfigKey(
      'youtube_official_watchlist',
      'endpoint',
      'https://www.googleapis.com/youtube/v3/playlistItems',
    );
    await setConfigKey(
      'youtube_official_watchlist',
      'detailsEndpoint',
      'https://googleapis.evil.com/youtube/v3/videos',
    );
    const tamperedDetails = await configOf('youtube_official_watchlist');
    expect(
      createYoutubePlaylistsConnector().preflight(tamperedDetails, () => 'fixture-not-a-real-key')
        .ok,
    ).toBe(false);
  });

  it('youtube: missing credential still fails preflight with credentials_missing', async () => {
    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    const config = await configOf('youtube_official_watchlist');
    const preflight = createYoutubePlaylistsConnector().preflight(config, () => undefined);
    expect(preflight).toEqual({ ok: false, reason: 'credentials_missing' });
  });

  it('youtube: official host restriction preserved and API key is HEADER-ONLY (never in the URL)', async () => {
    expect(createYoutubePlaylistsConnector().allowedHosts({})).toEqual(['www.googleapis.com']);

    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', [
      'PLreview123456',
      'PLreview654321',
    ]);
    const config = await configOf('youtube_official_watchlist');
    expect(
      createYoutubePlaylistsConnector().preflight(config, () => 'fixture-not-a-real-key'),
    ).toEqual({ ok: true });

    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          items: [
            {
              snippet: { title: 'Trailer', publishedAt: '2026-02-01T00:00:00Z' },
              contentDetails: { videoId: 'vid000000001' },
            },
          ],
        }),
      },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"items":[]}' },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"items":[]}' },
    ]);
    await createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_official_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, { YOUTUBE_API_KEY: 'fixture-not-a-real-key' }),
    });
    // 2 playlistItems pages + 1 videos-details call (a video was collected).
    expect(mock.calls).toHaveLength(3);
    for (const call of mock.calls) {
      expect(new URL(call.url).hostname).toBe('www.googleapis.com');
      expect(call.url).not.toContain('fixture-not-a-real-key');
      expect(call.url).not.toContain('key=');
      expect(call.headers['x-goog-api-key']).toBe('fixture-not-a-real-key');
    }
  });

  it('rss: official connector port still drives seeded descriptor endpoints (scripted SafeFetch fake — not raw HTTP)', async () => {
    await seed();
    const config = await configOf('playstation_blog');
    expect(createRssConnector().preflight(config, () => undefined)).toEqual({ ok: true });
    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        bodyText:
          '<rss><channel><item><title>Hello</title><link>https://blog.playstation.com/one</link>' +
          '<guid>one</guid><pubDate>Mon, 02 Feb 2026 00:00:00 GMT</pubDate>' +
          '<description>First post.</description></item></channel></rss>',
      },
    ]);
    const result = await createRssConnector().fetch({
      sourceId: 'playstation_blog',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, {}),
    });
    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe('https://blog.playstation.com/feed/');
  });
});

describe('R07: field ownership and safe re-import', () => {
  it('re-import preserves owner watchlists across ALL connector families', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570, 440]);
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    await setConfigKey('github_release_watchlist', 'repositories', ['owner/one', 'owner/two']);
    await setConfigKey('reddit_crack_signals', 'subreddits', ['GCrevive']);
    await seed();

    expect((await configOf('steam_news_watchlist'))['apps']).toEqual([570, 440]);
    expect((await configOf('youtube_official_watchlist'))['playlists']).toEqual(['PLreview123456']);
    expect((await configOf('github_release_watchlist'))['repositories']).toEqual([
      'owner/one',
      'owner/two',
    ]);
    expect((await configOf('reddit_crack_signals'))['subreddits']).toEqual(['GCrevive']);
  });

  it('re-import preserves owner overrides: enabled, priority, interval_seconds, daily_request_budget', async () => {
    await seed();
    await db.run({
      sql: `UPDATE sources SET enabled = 1, priority = 7, interval_seconds = 4321,
            daily_request_budget = 42 WHERE id = 'steam_news_watchlist'`,
    });
    await seed();
    const row = await db.first<{
      enabled: number;
      priority: number;
      interval_seconds: number;
      daily_request_budget: number;
    }>({
      sql: 'SELECT enabled, priority, interval_seconds, daily_request_budget FROM sources WHERE id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(row).toMatchObject({
      enabled: 1,
      priority: 7,
      interval_seconds: 4321,
      daily_request_budget: 42,
    });
  });

  it('re-import refreshes ONLY registry-owned descriptor fields (atomic in-row merge)', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570]); // owner key

    // A NEW catalog revision: rename + retier + retime policy + new batch
    // size (registry-owned keys). Built as a typed Registry — the same
    // object shape the validator produces for a future blueprint bump.
    const revised: Registry = {
      ...registry(),
      sources: registry().sources.map((s) =>
        s.id === 'steam_news_watchlist'
          ? {
              ...s,
              name: 'Steam News (revised)',
              trustTier: 88,
              approvalPolicy: 'threshold',
              config: { appsPerBatch: 5, maxItemsPerApp: 3 },
            }
          : s,
      ),
    };
    await seed(revised, NOW + 1000);

    const row = await db.first<{
      name: string;
      trust_tier: number;
      approval_policy: string;
      config_json: string;
    }>({
      sql: 'SELECT name, trust_tier, approval_policy, config_json FROM sources WHERE id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(row!.name).toBe('Steam News (revised)');
    expect(row!.trust_tier).toBe(88);
    expect(row!.approval_policy).toBe('threshold');
    const config = JSON.parse(row!.config_json) as Record<string, unknown>;
    expect(config['appsPerBatch']).toBe(5); // registry-owned key refreshed
    expect(config['apps']).toEqual([570]); // owner key preserved
    expect(config['endpoint']).toBe('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/');
  });

  it('existing source_state is preserved ENTIRELY by re-import', async () => {
    await seed();
    await db.run({
      sql: `UPDATE source_state SET next_poll_at = 999, cursor = 'owner-cursor',
            etag = '"owner-etag"', consecutive_failures = 2, requests_today = 5
            WHERE source_id = 'steam_news_watchlist'`,
    });
    await seed();
    const state = await db.first<{
      next_poll_at: number;
      cursor: string | null;
      etag: string | null;
      consecutive_failures: number;
      requests_today: number;
    }>({
      sql: 'SELECT next_poll_at, cursor, etag, consecutive_failures, requests_today FROM source_state WHERE source_id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(state).toMatchObject({
      next_poll_at: 999,
      cursor: 'owner-cursor',
      etag: '"owner-etag"',
      consecutive_failures: 2,
      requests_today: 5,
    });
  });

  it('malformed persisted config fails VISIBLY without destructive reset (atomic rollback)', async () => {
    await seed();
    await db.run({
      sql: "UPDATE sources SET config_json = '{broken' WHERE id = 'steam_news_watchlist'",
    });
    const before = await db.first<{ updated_at: number }>({
      sql: "SELECT updated_at FROM sources WHERE id = 'playstation_blog'",
    });

    // The merge raises inside the batch → the WHOLE batch rolls back.
    await expect(seed(registry(), NOW + 1000)).rejects.toThrow();

    // No destructive reset: the malformed value is untouched.
    const steam = await db.first<{ config_json: string }>({
      sql: "SELECT config_json FROM sources WHERE id = 'steam_news_watchlist'",
    });
    expect(steam!.config_json).toBe('{broken');
    // Atomicity: no OTHER row was refreshed either (updated_at unchanged).
    const after = await db.first<{ updated_at: number }>({
      sql: "SELECT updated_at FROM sources WHERE id = 'playstation_blog'",
    });
    expect(after!.updated_at).toBe(before!.updated_at);

    // Visible recovery: once the owner repairs the value, imports work.
    await db.run({
      sql: `UPDATE sources SET config_json = ? WHERE id = 'steam_news_watchlist'`,
      params: [
        JSON.stringify({
          appsPerBatch: 10,
          maxItemsPerApp: 3,
          endpoint: 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/',
        }),
      ],
    });
    await expect(seed(registry(), NOW + 2000)).resolves.toBeTruthy();
  });

  it('a concurrent-style owner edit between two re-imports is never lost (no read-modify-write window)', async () => {
    await seed();
    await seed(registry(), NOW + 1000);
    // Owner change lands BETWEEN imports (the merge reads the CURRENT row
    // inside the UPDATE statement itself, so there is no app-layer read
    // whose snapshot could go stale).
    await setConfigKey('steam_news_watchlist', 'apps', [730]);
    await seed(registry(), NOW + 2000);
    expect((await configOf('steam_news_watchlist'))['apps']).toEqual([730]);
  });
});

describe('R08: repair partial catalogs (bounded atomic reconciliation)', () => {
  it('empty catalog: one pass seeds all 14 sources + 14 state rows, every row disabled', async () => {
    const outcome = await schedule();
    expect(outcome.kind).toBe('scheduled');
    if (outcome.kind !== 'scheduled') return;
    expect(outcome.seeded).toBe(true);
    expect(await counts()).toEqual({ sources: 14, states: 14 });
    const enabled = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM sources WHERE enabled = 1',
    });
    expect(enabled!.n).toBe(0); // nothing activates implicitly
  });

  it('legacy partial catalog: missing source rows AND missing state rows are repaired; owner settings intact; new rows disabled', async () => {
    await seedLegacyPartialCatalog();
    expect(await counts()).toEqual({ sources: 3, states: 2 }); // not empty — and not complete

    const outcome = await schedule();
    if (outcome.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(outcome.seeded).toBe(true);
    expect(await counts()).toEqual({ sources: 14, states: 14 });

    // Owner settings fully intact after the repair.
    const steam = await db.first<{
      enabled: number;
      priority: number;
      config_json: string;
    }>({
      sql: 'SELECT enabled, priority, config_json FROM sources WHERE id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(steam!.enabled).toBe(1);
    expect(steam!.priority).toBe(10);
    expect(JSON.parse(steam!.config_json)['apps']).toEqual([570]);
    const githubBudget = await db.first<{ daily_request_budget: number }>({
      sql: 'SELECT daily_request_budget FROM sources WHERE id = ?',
      params: ['github_release_watchlist'],
    });
    expect(githubBudget!.daily_request_budget).toBe(999);

    // Owner runtime state untouched; the MISSING state row was created.
    const steamState = await db.first<{ next_poll_at: number; cursor: string | null }>({
      sql: 'SELECT next_poll_at, cursor FROM source_state WHERE source_id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(steamState).toMatchObject({
      next_poll_at: NOW + 3_600_000,
      cursor: 'legacy-cursor',
    });
    const githubState = await db.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });
    expect(githubState!.next_poll_at).toBe(0);

    // All REPAIRED-IN rows remain disabled — the owner decides activation.
    const enabled = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM sources WHERE enabled = 1',
    });
    expect(enabled!.n).toBe(1); // only the legacy owner-enabled steam row
  });

  it('complete catalog: a normal pass does NOT re-run the reconciliation', async () => {
    await seed();
    const outcome = await schedule();
    if (outcome.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(outcome.seeded).toBe(false);
  });

  it('failed reconciliation leaves the prior state EXACTLY intact (bounded atomic writes)', async () => {
    await seedLegacyPartialCatalog();
    let batchCalls = 0;
    const broken = {
      ...db,
      batch: async (...args: Parameters<typeof db.batch>) => {
        batchCalls++;
        if (batchCalls === 1) throw new Error('injected storage failure');
        return db.batch(...args);
      },
    };
    await expect(schedule(broken)).rejects.toThrow();
    // Nothing partially applied: still exactly the legacy 3 sources / 2
    // states, owner data untouched.
    expect(await counts()).toEqual({ sources: 3, states: 2 });
    const steam = await db.first<{ enabled: number }>({
      sql: 'SELECT enabled FROM sources WHERE id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(steam!.enabled).toBe(1);

    // Recovery on a later pass completes the catalog.
    await schedule();
    expect(await counts()).toEqual({ sources: 14, states: 14 });
  });

  it('repeated passes and overlapping reconciliations converge without duplication', async () => {
    await seedLegacyPartialCatalog();
    await schedule();
    // Repeated passes: stable counts, no re-seed, owner data intact.
    const pass2 = await schedule();
    if (pass2.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(pass2.seeded).toBe(false);
    const pass3 = await schedule();
    if (pass3.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(pass3.seeded).toBe(false);
    expect(await counts()).toEqual({ sources: 14, states: 14 });
    expect((await configOf('steam_news_watchlist'))['apps']).toEqual([570]);

    // Overlapping reconciliation from a legacy partial state again: two
    // concurrent passes both observe incompleteness; the atomic idempotent
    // batch converges without duplication or error.
    await db.run({ sql: 'DELETE FROM source_state' });
    await db.run({ sql: 'DELETE FROM sources' });
    await seedLegacyPartialCatalog();
    await Promise.all([schedule(), schedule()]);
    expect(await counts()).toEqual({ sources: 14, states: 14 });
    expect((await configOf('steam_news_watchlist'))['apps']).toEqual([570]);
  });

  it('reconciliation never invents catalog content: github watchlist default only applies on FIRST insert', async () => {
    await seedLegacyPartialCatalog();
    // github's registry config ships repositories: [] — the legacy row's
    // OWNER watchlist must survive the repair untouched (and remain valid
    // for preflight: a non-empty owner watchlist needs no invented IDs).
    await schedule();
    expect((await configOf('github_release_watchlist'))['repositories']).toEqual(['owner/repo']);
    const githubConnector = createGithubReleasesConnector();
    expect(
      githubConnector.preflight(await configOf('github_release_watchlist'), () => undefined),
    ).toEqual({ ok: true });
  });
});
