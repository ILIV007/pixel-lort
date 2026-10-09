import { describe, expect, it } from 'vitest';
import { createRssConnector } from '../../src/connectors/rss';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * RSS/Atom connector contract (Phase 4 — ADR-0039 §1; blueprint §24
 * contract tests): conditional GET headers, 200/304/429 paths, malformed
 * XML, bounded items, content-type enforcement, multi-feed templates.
 */

const ENDPOINT = 'https://blog.playstation.com/feed/';
const CONFIG = { endpoint: ENDPOINT };
const SOURCE_ID = 'playstation_blog';

const VALID_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>PS Blog</title>
<item>
  <title>New Game Announced</title>
  <link>https://blog.playstation.com/article/new-game</link>
  <guid isPermaLink="false">ps-news-1</guid>
  <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
  <description><![CDATA[<p>A big announcement</p>]]></description>
</item>
</channel></rss>`;

function rssConnector() {
  return createRssConnector();
}

describe('rss connector — preflight and planning', () => {
  it('passes preflight with a concrete endpoint and plans one request', () => {
    const connector = rssConnector();
    expect(connector.preflight(CONFIG, () => undefined)).toEqual({ ok: true });
    expect(connector.plannedRequestCount(CONFIG)).toBe(1);
    expect(connector.allowedHosts(CONFIG)).toEqual(['blog.playstation.com']);
  });

  it('blocks an empty configuration with a stable reason', () => {
    const connector = rssConnector();
    expect(connector.preflight({}, () => undefined)).toMatchObject({
      ok: false,
      reason: 'watchlist_empty',
    });
  });

  it('supports bounded endpointTemplates lists', () => {
    const connector = rssConnector();
    const config = {
      endpointTemplates: ['https://a.example/feed.xml', 'https://b.example/feed.xml'],
    };
    expect(connector.preflight(config, () => undefined)).toEqual({ ok: true });
    expect(connector.plannedRequestCount(config)).toBe(2);
  });
});

describe('rss connector — fetch contract', () => {
  it('sends BOTH conditional validators when the cursor holds them', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/rss+xml' }, bodyText: VALID_FEED },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: {
        etag: '"etag-1"',
        lastModified: 'Mon, 06 Oct 2025 09:00:00 GMT',
        cursor: JSON.stringify({
          [ENDPOINT]: { etag: '"etag-1"', lastModified: 'Mon, 06 Oct 2025 09:00:00 GMT' },
        }),
      },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(mock.calls[0]?.headers['if-none-match']).toBe('"etag-1"');
    expect(mock.calls[0]?.headers['if-modified-since']).toBe('Mon, 06 Oct 2025 09:00:00 GMT');
  });

  it('stores per-feed validators in the cursor for the next poll', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        headers: {
          'content-type': 'application/rss+xml',
          etag: '"e2"',
          'last-modified': 'Tue, 07 Oct 2025 09:00:00 GMT',
        },
        bodyText: VALID_FEED,
      },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(result.cursor).not.toBeNull();
    const cursor = JSON.parse(result.cursor ?? '{}') as Record<string, { etag: string | null }>;
    expect(cursor[ENDPOINT]?.etag).toBe('"e2"');
  });

  it('reports not_modified on 304 without items', async () => {
    const mock = createFetchMock([{ status: 304 }]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: '"e"', lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('not_modified');
    expect(result.items).toHaveLength(0);
  });

  it('normalizes changed feed items through the shared module', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'text/xml' }, bodyText: VALID_FEED },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.externalId).toBe('rss:ps-news-1');
    expect(result.items[0]?.canonicalUrl).toBe('https://blog.playstation.com/article/new-game');
    expect(result.items[0]?.excerpt).toBe('A big announcement');
  });

  it('caps items per feed at the bounded limit (keeps newest)', async () => {
    const items = Array.from(
      { length: 150 },
      (_, i) => `<item><title>t${i}</title><guid>g${i}</guid></item>`,
    ).join('');
    const feed = `<rss><channel>${items}</channel></rss>`;
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/xml' }, bodyText: feed },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(result.items.length).toBe(100); // newest-first cap
    expect(result.items[0]?.externalId).toBe('rss:g0');
  });

  it('fails safe on malformed XML with a stable reason', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/xml' },
        bodyText: '<rss><channel><item>',
      },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('response_malformed');
  });

  it('rejects unexpected content types', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html></html>' },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('unexpected_content_type');
  });

  it('maps 429 to rate_limited with the parsed Retry-After', async () => {
    const mock = createFetchMock([{ status: 429, headers: { 'retry-after': '120' } }]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(120);
  });

  it('maps HTTP status errors to a failed poll', async () => {
    const mock = createFetchMock([{ status: 500 }]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
  });

  it('keeps other feeds’ items when one feed of a template list fails', async () => {
    const config = {
      endpointTemplates: ['https://a.example/feed.xml', 'https://b.example/feed.xml'],
    };
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/xml' }, bodyText: VALID_FEED },
      { failReason: 'timeout' },
    ]);
    const connector = rssConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_timeout');
    expect(result.items).toHaveLength(1); // durable items from the healthy feed
  });

  it('never sends credentials for RSS (no secret interaction)', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/xml' }, bodyText: VALID_FEED },
    ]);
    const connector = rssConnector();
    await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, { YOUTUBE_API_KEY: 'should-not-appear' }),
    });
    const headers = JSON.stringify(mock.calls[0]?.headers ?? {});
    expect(headers).not.toContain('should-not-appear');
  });
});
