import { describe, expect, it } from 'vitest';
import { createRedditOauthConnector, RedditRuntimeConfigSchema } from '../../src/connectors/reddit-oauth';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * Reddit OAuth connector contract (Phase 4 — ADR-0039 §1): approved OAuth
 * API ONLY (client_credentials token POST + Bearer listing); no
 * unauthenticated scraping; validated subreddit materialization;
 * stripDownloadLinks honored.
 */

const SOURCE_ID = 'reddit_crack_signals';
const CONFIG = { subreddits: ['CrackWatch'], limit: 25, stripDownloadLinks: true };
const SECRETS = { REDDIT_CLIENT_ID: 'cid-value', REDDIT_CLIENT_SECRET: 'csecret-value' };

const TOKEN_RESPONSE = JSON.stringify({ access_token: 'test-access-token', token_type: 'bearer' });

const LISTING_RESPONSE = JSON.stringify({
  data: {
    after: 't3_next1',
    children: [
      {
        data: {
          name: 't3_abc123',
          title: 'Status update for Game X',
          selftext: 'Cracked: magnet:?xt=urn:btih:NOPE — discussion only',
          permalink: '/r/CrackWatch/comments/abc123/status_update/',
          author: 'watcher1',
          created_utc: 1_759_723_200,
        },
      },
      {
        data: {
          name: 't3_def456',
          title: 'Leak rumor',
          selftext: '',
          permalink: '/r/CrackWatch/comments/def456/leak/',
          author: 'watcher2',
          created_utc: 1_759_636_800,
        },
      },
    ],
  },
});

describe('reddit connector — preflight', () => {
  it('blocks missing credentials and empty watchlists separately', () => {
    const connector = createRedditOauthConnector();
    expect(connector.preflight(CONFIG, () => undefined)).toMatchObject({
      ok: false,
      reason: 'credentials_missing',
    });
    expect(connector.preflight({ subreddits: [], limit: 25 }, () => 'x')).toMatchObject({
      ok: false,
      reason: 'watchlist_empty',
    });
    expect(connector.preflight(CONFIG, (name: string) => (SECRETS as Record<string, string>)[name])).toEqual({ ok: true });
  });

  it('rejects invalid subreddit identifiers (no template injection)', () => {
    expect(RedditRuntimeConfigSchema.safeParse({ subreddits: ['ok/sub'], limit: 25 }).success).toBe(false);
    expect(RedditRuntimeConfigSchema.safeParse({ subreddits: ['..'], limit: 25 }).success).toBe(false);
  });

  it('plans 1 token + N listing requests', () => {
    const connector = createRedditOauthConnector();
    expect(connector.plannedRequestCount(CONFIG)).toBe(2);
    expect(connector.allowedHosts(CONFIG)).toEqual(['www.reddit.com', 'oauth.reddit.com']);
  });
});

describe('reddit connector — fetch contract', () => {
  it('performs the OAuth token POST with Basic auth then Bearer listings', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: TOKEN_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: LISTING_RESPONSE },
    ]);
    const connector = createRedditOauthConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('changed');
    expect(result.requestCount).toBe(2);

    // Token call: POST with the bounded form body and Basic auth header.
    expect(mock.calls[0]?.method).toBe('POST');
    expect(mock.calls[0]?.url).toBe('https://www.reddit.com/api/v1/access_token');
    expect(mock.calls[0]?.headers['authorization']).toContain('Basic ');
    expect(mock.calls[0]?.headers['authorization']).not.toContain('cid-value'); // base64, raw secret not present

    // Listing call: GET on oauth.reddit.com with the Bearer token.
    expect(mock.calls[1]?.method).toBe('GET');
    expect(mock.calls[1]?.url).toBe('https://oauth.reddit.com/r/CrackWatch/new?limit=25&raw_json=1');
    expect(mock.calls[1]?.headers['authorization']).toBe('Bearer test-access-token');

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.externalId).toBe('reddit-oauth:t3_abc123');
    // Canonical public permalink (trailing slash PRESERVED — conservative
    // canonicalization never over-normalizes, ADR-0039 §5).
    expect(result.items[0]?.canonicalUrl).toBe(
      'https://www.reddit.com/r/CrackWatch/comments/abc123/status_update/',
    );
    // stripDownloadLinks removed the magnet from the stored text.
    expect(result.items[0]?.excerpt).not.toContain('magnet');
    expect(result.items[0]?.publishedAtMs).toBe(1_759_723_200_000);
    // `after` cursor retained for observability.
    const cursor = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
    expect(cursor['CrackWatch']).toBe('t3_next1');
  });

  it('never sends credentials or tokens in URLs', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: TOKEN_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: LISTING_RESPONSE },
    ]);
    const connector = createRedditOauthConnector();
    await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    for (const call of mock.calls) {
      expect(call.url).not.toContain('cid-value');
      expect(call.url).not.toContain('csecret-value');
      expect(call.url).not.toContain('test-access-token');
    }
  });

  it('maps 401/403 on either endpoint to credentials_rejected', async () => {
    const connector = createRedditOauthConnector();
    const badToken = createFetchMock([{ status: 401 }]);
    const tokenRejected = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(badToken.fetchFn, SECRETS),
    });
    expect(tokenRejected.status).toBe('failed');
    expect(tokenRejected.failureReason).toBe('credentials_rejected');

    const badListing = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: TOKEN_RESPONSE },
      { status: 403 },
    ]);
    const listingRejected = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(badListing.fetchFn, SECRETS),
    });
    expect(listingRejected.failureReason).toBe('credentials_rejected');
  });

  it('maps 429 with Retry-After on the listing endpoint', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: TOKEN_RESPONSE },
      { status: 429, headers: { 'retry-after': '45' } },
    ]);
    const connector = createRedditOauthConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, SECRETS),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(45);
  });

  it('does not implement unauthenticated scraping (no client-id path)', async () => {
    const connector = createRedditOauthConnector();
    // Without credentials the fetch fails closed before any listing call.
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: TOKEN_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: LISTING_RESPONSE },
    ]);
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, {}), // NO credentials
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('credentials_missing');
    expect(mock.calls).toHaveLength(0); // nothing left the process
  });
});
