import { describe, expect, it } from 'vitest';
import { createSteamNewsConnector, SteamRuntimeConfigSchema } from '../../src/connectors/steam-news';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * Steam News connector contract (Phase 4 — ADR-0039 §1): GetNewsForApp v2
 * (keyless), bounded configured app watchlist, per-app item limits,
 * malformed JSON fails safe.
 */

const SOURCE_ID = 'steam_news_watchlist';
const CONFIG = { appsPerBatch: 10, maxItemsPerApp: 3, apps: [570, 440] };

const STEAM_RESPONSE = JSON.stringify({
  appnews: {
    appid: 570,
    newsitems: [
      {
        gid: '12345',
        title: 'Dota 2 Update',
        url: 'https://store.steampowered.com/news/app/570/view/12345',
        contents: '<p>Balance update</p>',
        author: 'Valve',
        date: 1_759_723_200,
      },
      {
        gid: '12346',
        title: 'Second Post',
        url: 'https://store.steampowered.com/news/app/570/view/12346',
        date: 1_759_636_800,
      },
    ],
  },
});

describe('steam-news connector — preflight', () => {
  it('blocks an empty watchlist with a stable reason', () => {
    const connector = createSteamNewsConnector();
    expect(connector.preflight({ appsPerBatch: 10, maxItemsPerApp: 3, apps: [] }, () => undefined)).toMatchObject({
      ok: false,
      reason: 'watchlist_empty',
    });
    expect(connector.plannedRequestCount({ appsPerBatch: 10, maxItemsPerApp: 3, apps: [] })).toBe(0);
  });

  it('accepts a configured watchlist and plans per-app requests', () => {
    const connector = createSteamNewsConnector();
    expect(connector.preflight(CONFIG, () => undefined)).toEqual({ ok: true });
    expect(connector.plannedRequestCount(CONFIG)).toBe(2);
  });

  it('rejects invalid runtime config shapes', () => {
    expect(SteamRuntimeConfigSchema.safeParse({ appsPerBatch: 'x' }).success).toBe(false);
    expect(
      SteamRuntimeConfigSchema.safeParse({ appsPerBatch: 5, maxItemsPerApp: 3, apps: [-1] }).success,
    ).toBe(false);
  });
});

describe('steam-news connector — fetch contract', () => {
  it('requests the documented v2 endpoint per app and normalizes items', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: STEAM_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ appnews: { appid: 440, newsitems: [] } }) },
    ]);
    const connector = createSteamNewsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(result.requestCount).toBe(2);
    expect(mock.calls[0]?.url).toContain('api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=3');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.externalId).toBe('steam-news:12345');
    expect(result.items[0]?.excerpt).toBe('Balance update');
    expect(result.items[0]?.publishedAtMs).toBe(1_759_723_200_000);
  });

  it('never sends an API key (GetNewsForApp v2 is keyless)', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: STEAM_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"appnews":{}}' },
    ]);
    const connector = createSteamNewsConnector();
    await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, { YOUTUBE_API_KEY: 'leak-check' }),
    });
    const allHeaders = JSON.stringify(mock.calls.map((c) => c.headers));
    expect(allHeaders).not.toContain('leak-check');
    expect(allHeaders.toLowerCase()).not.toContain('key');
  });

  it('fails safe on malformed JSON', async () => {
    const mock = createFetchMock([{ status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{not json' }]);
    const connector = createSteamNewsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('response_malformed');
  });

  it('treats a missing newsitems array conservatively', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"unexpected":true}' },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"appnews":{}}' },
    ]);
    const connector = createSteamNewsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(result.malformedCount).toBeGreaterThanOrEqual(1);
    expect(result.items).toHaveLength(0);
  });

  it('maps 429 with Retry-After and HTTP errors to failed', async () => {
    const connector = createSteamNewsConnector();
    const mock429 = createFetchMock([{ status: 429, headers: { 'retry-after': '60' } }]);
    const limited = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock429.fetchFn),
    });
    expect(limited.status).toBe('rate_limited');
    expect(limited.retryAfterSeconds).toBe(60);

    const mock500 = createFetchMock([{ status: 503 }]);
    const broken = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock500.fetchFn),
    });
    expect(broken.status).toBe('failed');
  });
});
