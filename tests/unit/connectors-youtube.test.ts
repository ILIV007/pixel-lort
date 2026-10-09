import { describe, expect, it } from 'vitest';
import {
  createYoutubePlaylistsConnector,
  YoutubeRuntimeConfigSchema,
} from '../../src/connectors/youtube-playlists';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * YouTube playlists connector contract (Phase 4 — ADR-0039 §1): official
 * playlistItems + videos-details ONLY; X-Goog-Api-key HEADER (never a
 * query-string secret); the forbidden search endpoint / video download are
 * schema-pinned; watchlist and credentials preflight.
 */

const SOURCE_ID = 'youtube_official_watchlist';
const CONFIG = { useSearchEndpoint: false, downloadVideo: false, playlists: ['PLtest123456'] };
const SECRETS = { YOUTUBE_API_KEY: 'test-key-value' };

const PLAYLIST_RESPONSE = JSON.stringify({
  items: [
    {
      snippet: {
        title: 'Trailer One',
        description: 'First trailer',
        publishedAt: '2025-10-06T10:00:00Z',
      },
      contentDetails: { videoId: 'vid1' },
    },
    { snippet: { title: 'No id item' }, contentDetails: {} },
  ],
});

const VIDEOS_RESPONSE = JSON.stringify({
  items: [
    { id: 'vid1', snippet: { publishedAt: '2025-10-06T09:59:59Z', channelTitle: 'Game Channel' } },
  ],
});

describe('youtube connector — policy pins', () => {
  it('rejects runtime config that enables the search endpoint or downloads', () => {
    expect(
      YoutubeRuntimeConfigSchema.safeParse({
        useSearchEndpoint: true,
        downloadVideo: false,
        playlists: ['PLx1234567890'],
      }).success,
    ).toBe(false);
    expect(
      YoutubeRuntimeConfigSchema.safeParse({
        useSearchEndpoint: false,
        downloadVideo: true,
        playlists: ['PLx1234567890'],
      }).success,
    ).toBe(false);
  });

  it('blocks an empty watchlist and missing credentials separately', () => {
    const connector = createYoutubePlaylistsConnector();
    const empty = connector.preflight(
      { useSearchEndpoint: false, downloadVideo: false, playlists: [] },
      () => 'k',
    );
    expect(empty).toMatchObject({ ok: false, reason: 'watchlist_empty' });
    const noKey = connector.preflight(CONFIG, () => undefined);
    expect(noKey).toMatchObject({ ok: false, reason: 'credentials_missing' });
    expect(connector.preflight(CONFIG, () => 'k')).toEqual({ ok: true });
  });
});

describe('youtube connector — fetch contract', () => {
  it('calls playlistItems then ONE videos call; key in HEADER only', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: PLAYLIST_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: VIDEOS_RESPONSE },
    ]);
    const connector = createYoutubePlaylistsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('changed');
    expect(result.requestCount).toBe(2);
    expect(mock.calls[0]?.url).toContain('www.googleapis.com/youtube/v3/playlistItems');
    expect(mock.calls[0]?.url).toContain('playlistId=PLtest123456');
    expect(mock.calls[0]?.url).not.toContain('key=');
    expect(mock.calls[0]?.headers['x-goog-api-key']).toBe('test-key-value');
    expect(mock.calls[1]?.url).toContain('www.googleapis.com/youtube/v3/videos');
    expect(mock.calls[1]?.headers['x-goog-api-key']).toBe('test-key-value');

    expect(result.items).toHaveLength(1); // the no-videoId item is malformed-counted
    expect(result.items[0]?.externalId).toBe('youtube-playlists:vid1');
    expect(result.items[0]?.canonicalUrl).toBe('https://www.youtube.com/watch?v=vid1');
    // Authoritative publishedAt from the videos-details contract.
    expect(result.items[0]?.publishedAtMs).toBe(Date.parse('2025-10-06T09:59:59Z'));
    expect(result.items[0]?.author).toBe('Game Channel');
  });

  it('keeps playlistItems data when the details call fails (degraded)', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: PLAYLIST_RESPONSE },
      { failReason: 'timeout' },
    ]);
    const connector = createYoutubePlaylistsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(1);
    // publishedAt falls back to the playlistItems snippet value.
    expect(result.items[0]?.publishedAtMs).toBe(Date.parse('2025-10-06T10:00:00Z'));
  });

  it('maps provider auth rejection to credentials_rejected', async () => {
    const mock = createFetchMock([{ status: 403 }]);
    const connector = createYoutubePlaylistsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('credentials_rejected');
  });

  it('maps 429 to rate_limited with Retry-After', async () => {
    const mock = createFetchMock([{ status: 429, headers: { 'retry-after': '30' } }]);
    const connector = createYoutubePlaylistsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(30);
  });

  it('fails safe on malformed JSON', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: 'nope' },
    ]);
    const connector = createYoutubePlaylistsConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('response_malformed');
  });

  it('never performs a search-endpoint call in the implemented path', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: PLAYLIST_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: VIDEOS_RESPONSE },
    ]);
    const connector = createYoutubePlaylistsConnector();
    await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    for (const call of mock.calls) {
      expect(call.url).not.toContain('/search?');
    }
  });
});
