import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry, type Registry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { createSteamNewsConnector } from '../../src/connectors/steam-news';
import { createYoutubePlaylistsConnector } from '../../src/connectors/youtube-playlists';
import { connectorEffects } from '../helpers/fetch-mock';
import { createSafeFetch } from '../../src/shared/http/safe-http';

/**
 * Round 1.3.1 permanent coverage — REAL HTTP-port integration:
 *
 *   seed → owner provisioning → connector → REAL createSafeFetch →
 *   scripted RAW typeof fetch
 *
 * The Round 1.3 connector tests (round13-r03-r07-r08.test.ts) drive the
 * real connector port but inject a scripted SafeFetchExecutor directly
 * (tests/helpers/fetch-mock.ts createFetchMock) — they never execute
 * createSafeFetch itself and are therefore connector CONTRACT tests, not
 * raw-HTTP integration tests. That gap is closed here, mirroring the
 * accepted Round 1.2 pattern (round12-r01-r02.test.ts): the mock below is
 * a RAW `typeof fetch` fake returning real Response objects, and the
 * connector effects bundle is wired through the PRODUCTION createSafeFetch
 * (URL guard, allowlist, manual redirect validation, credential-header
 * stripping, bounded body read) with no test double in between.
 *
 * Covered here: Steam and YouTube successful requests (pinned official
 * URLs), header-only YouTube credentials (key in the X-Goog-Api-Key
 * header, never in any URL), and rejection of an off-allowlist redirect
 * BEFORE a second raw request is attempted or any credential could be
 * disclosed to the redirect target.
 */

const db: DbExecutor = createDbExecutor(env.DB);
const NOW = 1_770_000_000_000;

const STEAM_ENDPOINT = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const EVIL_HOST = 'https://evil.example';

const registry = (): Registry => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('registry invalid');
  return r.registry;
};

const seed = (at = NOW) => seedSourcesFromRegistry(db, registry(), at);

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

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
});

/**
 * Scripted RAW fetch (typeof fetch) — feeds the REAL createSafeFetch port.
 * Returns real Response objects and records every raw call (url, method,
 * headers) exactly as createSafeFetch issued them.
 */
interface RawScriptedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | null;
}

interface RawRecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function createRawFetchMock(script: readonly RawScriptedResponse[]): {
  fetchFn: typeof fetch;
  calls: RawRecordedCall[];
} {
  const calls: RawRecordedCall[] = [];
  const queue = [...script];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers });
    const next = queue.shift();
    if (next === undefined) {
      return new Response(null, { status: 500 });
    }
    return new Response(next.body ?? null, { status: next.status, headers: next.headers });
  };
  return { fetchFn, calls };
}

function steamNewsBody(appId: number, gid: string): string {
  return JSON.stringify({
    appnews: {
      appid: appId,
      newsitems: [
        {
          gid,
          title: `Patch notes ${appId}`,
          url: `https://store.steampowered.com/news/app/${appId}/`,
          contents: 'Fixed several issues.',
          date: 1_769_000_000,
        },
      ],
    },
  });
}

describe('Round 1.3.1: Steam through the REAL createSafeFetch port (raw fetch)', () => {
  it('seed → owner provisioning → preflight → connector → real port → pinned official URLs', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570, 440]);
    const config = await configOf('steam_news_watchlist');
    expect(createSteamNewsConnector().preflight(config, () => undefined)).toEqual({ ok: true });

    const raw = createRawFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: steamNewsBody(570, 'gid-570'),
      },
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: steamNewsBody(440, 'gid-440'),
      },
    ]);
    const result = await createSteamNewsConnector().fetch({
      sourceId: 'steam_news_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {}),
    });

    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(2);
    expect(result.requestCount).toBe(2);
    expect(raw.calls).toHaveLength(2);
    for (const call of raw.calls) {
      const url = new URL(call.url);
      expect(url.hostname).toBe('api.steampowered.com'); // official host only
      expect(url.pathname).toBe('/ISteamNews/GetNewsForApp/v2/'); // pinned official endpoint
    }
    // One request per watched app, in watchlist order, official parameters.
    expect(new URL(raw.calls[0]!.url).searchParams.get('appid')).toBe('570');
    expect(new URL(raw.calls[1]!.url).searchParams.get('appid')).toBe('440');
    expect(raw.calls[0]!.headers['accept']).toBe('application/json');
  });

  it('off-allowlist redirect is rejected BEFORE a second raw request', async () => {
    await seed();
    await setConfigKey('steam_news_watchlist', 'apps', [570]);
    const config = await configOf('steam_news_watchlist');

    const raw = createRawFetchMock([
      { status: 302, headers: { location: `${EVIL_HOST}/harvest` } },
      // A second scripted response must NEVER be consumed.
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"appnews":{}}' },
    ]);
    const result = await createSteamNewsConnector().fetch({
      sourceId: 'steam_news_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {}),
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.requestCount).toBe(1);
    expect(raw.calls).toHaveLength(1); // redirect target never contacted
    expect(new URL(raw.calls[0]!.url).hostname).toBe('api.steampowered.com');
  });
});

describe('Round 1.3.1: YouTube through the REAL createSafeFetch port (raw fetch)', () => {
  it('seed → owner provisioning → preflight → connector → real port → header-only credential', async () => {
    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    const config = await configOf('youtube_official_watchlist');
    expect(
      createYoutubePlaylistsConnector().preflight(config, () => 'fixture-not-a-real-key'),
    ).toEqual({ ok: true });

    const raw = createRawFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              snippet: { title: 'Trailer', publishedAt: '2026-02-01T00:00:00Z' },
              contentDetails: { videoId: 'vid000000001' },
            },
          ],
        }),
      },
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: 'vid000000001',
              snippet: { publishedAt: '2026-02-01T00:00:00Z', channelTitle: 'Official' },
              contentDetails: { duration: 'PT2M' },
            },
          ],
        }),
      },
    ]);
    const result = await createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_official_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {
        YOUTUBE_API_KEY: 'fixture-not-a-real-key',
      }),
    });

    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(1);
    expect(result.requestCount).toBe(2);
    // playlistItems page + ONE videos-details call — both official paths.
    expect(raw.calls).toHaveLength(2);
    expect(new URL(raw.calls[0]!.url).pathname).toBe('/youtube/v3/playlistItems');
    expect(new URL(raw.calls[1]!.url).pathname).toBe('/youtube/v3/videos');
    for (const call of raw.calls) {
      const url = new URL(call.url);
      expect(url.hostname).toBe('www.googleapis.com'); // official host only
      // Credential is HEADER-ONLY: present in the X-Goog-Api-Key header,
      // never in the URL (no key= query parameter, no key material anywhere
      // in the raw request line).
      expect(url.searchParams.get('key')).toBeNull();
      expect(call.url).not.toContain('fixture-not-a-real-key');
      expect(call.headers['x-goog-api-key']).toBe('fixture-not-a-real-key');
    }
  });

  it('off-allowlist redirect rejected BEFORE a second raw request or credential disclosure', async () => {
    await seed();
    await setConfigKey('youtube_official_watchlist', 'playlists', ['PLreview123456']);
    const config = await configOf('youtube_official_watchlist');

    const raw = createRawFetchMock([
      { status: 302, headers: { location: `${EVIL_HOST}/collect?key=fixture-not-a-real-key` } },
      // Must NEVER be consumed — proves no second raw request happened.
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[]}' },
    ]);
    const result = await createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_official_watchlist',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {
        YOUTUBE_API_KEY: 'fixture-not-a-real-key',
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.requestCount).toBe(1);
    expect(raw.calls).toHaveLength(1); // the queued second response was never consumed
    const only = raw.calls[0]!;
    // The credential traveled to the OFFICIAL origin only.
    expect(new URL(only.url).hostname).toBe('www.googleapis.com');
    expect(only.headers['x-goog-api-key']).toBe('fixture-not-a-real-key');
    expect(only.url).not.toContain('fixture-not-a-real-key');
    expect(only.url).not.toContain('key=');
    // The off-allowlist redirect target (which echoes the key in its own
    // URL) was never contacted: zero raw requests carried anything to it.
    expect(only.url).not.toContain('evil.example');
  });
});

describe('Round 1.3.1: REAL port semantics for off-allowlist redirects', () => {
  it('createSafeFetch returns host_not_allowed with requestCount = 1 (no hop executed)', async () => {
    const raw = createRawFetchMock([{ status: 302, headers: { location: `${EVIL_HOST}/x` } }]);
    const safeFetch = createSafeFetch(raw.fetchFn);
    const result = await safeFetch({
      url: `${STEAM_ENDPOINT}?appid=570&count=3&maxlength=800&format=json`,
      headers: { accept: 'application/json' },
      byteCap: 1_048_576,
      timeoutMs: 10_000,
      maxRedirects: 3,
      allowedHosts: ['api.steampowered.com'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'host_not_allowed', requestCount: 1 });
    expect(raw.calls).toHaveLength(1); // exactly one raw request, then rejection
    expect(new URL(raw.calls[0]!.url).hostname).toBe('api.steampowered.com');
  });
});
