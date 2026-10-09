import { describe, expect, it } from 'vitest';
import {
  createGithubReleasesConnector,
  GithubRuntimeConfigSchema,
} from '../../src/connectors/github-releases';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * GitHub releases connector contract (Phase 4 — ADR-0039 §1): configured
 * repositories only, prerelease policy, bounded pagination, conditional
 * GET via If-None-Match, optional Bearer token (header only).
 */

const SOURCE_ID = 'github_release_watchlist';
const CONFIG = { repositories: ['owner/repo-a', 'owner/repo-b'], includePrereleases: false };

const RELEASES_RESPONSE = JSON.stringify([
  {
    id: 1001,
    tag_name: 'v1.2.0',
    name: 'Release 1.2.0',
    html_url: 'https://github.com/owner/repo-a/releases/tag/v1.2.0',
    prerelease: false,
    draft: false,
    published_at: '2025-10-06T10:00:00Z',
    body: '## Changes\n- fix A\n- https://example.com/bin.zip',
    author: { login: 'maintainer1' },
  },
  {
    id: 1000,
    tag_name: 'v1.3.0-rc1',
    name: 'Release 1.3.0 RC1',
    html_url: 'https://github.com/owner/repo-a/releases/tag/v1.3.0-rc1',
    prerelease: true,
    draft: false,
    published_at: '2025-10-06T09:00:00Z',
    body: 'rc',
    author: { login: 'maintainer1' },
  },
  {
    id: 999,
    tag_name: 'v0.9.0-draft',
    name: 'Draft release',
    html_url: 'https://github.com/owner/repo-a/releases/tag/v0.9.0-draft',
    prerelease: false,
    draft: true,
    published_at: null,
    body: 'wip',
  },
]);

describe('github connector — preflight', () => {
  it('blocks an empty watchlist (registry ships none — nothing invented)', () => {
    const connector = createGithubReleasesConnector();
    expect(
      connector.preflight({ repositories: [], includePrereleases: false }, () => undefined),
    ).toMatchObject({
      ok: false,
      reason: 'watchlist_empty',
    });
    expect(connector.plannedRequestCount({ repositories: [], includePrereleases: false })).toBe(0);
    expect(connector.preflight(CONFIG, () => undefined)).toEqual({ ok: true });
  });

  it('rejects malformed repository identifiers (no URL injection)', () => {
    expect(
      GithubRuntimeConfigSchema.safeParse({
        repositories: ['owner/sub/deep'],
        includePrereleases: false,
      }).success,
    ).toBe(false);
    expect(
      GithubRuntimeConfigSchema.safeParse({
        repositories: ['../../etc'],
        includePrereleases: false,
      }).success,
    ).toBe(false);
  });
});

describe('github connector — fetch contract', () => {
  it('requests releases per repo, applies prerelease policy, normalizes', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"rel-etag-a"' },
        bodyText: RELEASES_RESPONSE,
      },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '[]' },
    ]);
    const connector = createGithubReleasesConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(result.requestCount).toBe(2);
    expect(mock.calls[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo-a/releases?per_page=25&page=1',
    );

    // Draft AND prerelease filtered under includePrereleases:false.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.externalId).toBe('github-releases:1001');
    expect(result.items[0]?.canonicalUrl).toBe(
      'https://github.com/owner/repo-a/releases/tag/v1.2.0',
    );
    expect(result.items[0]?.author).toBe('maintainer1');
    // Download-shaped link stripped from the body text.
    expect(result.items[0]?.excerpt).not.toContain('.zip');

    // Etag stored per repo for conditional GET.
    const cursor = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
    expect(cursor['owner/repo-a']).toBe('"rel-etag-a"');
  });

  it('sends If-None-Match from the cursor and treats 304 as unchanged', async () => {
    const mock = createFetchMock([
      { status: 304 },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '[]' },
    ]);
    const connector = createGithubReleasesConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: {
        etag: null,
        lastModified: null,
        cursor: JSON.stringify({ 'owner/repo-a': '"rel-etag-a"' }),
      },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(mock.calls[0]?.headers['if-none-match']).toBe('"rel-etag-a"');
    expect(result.status).toBe('changed'); // repo-b returned 200 (empty)
  });

  it('reports not_modified when every repo returns 304', async () => {
    const mock = createFetchMock([{ status: 304 }, { status: 304 }]);
    const connector = createGithubReleasesConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('not_modified');
    expect(result.items).toHaveLength(0);
  });

  it('includes prereleases when the policy allows them', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: RELEASES_RESPONSE },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '[]' },
    ]);
    const connector = createGithubReleasesConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: { repositories: ['owner/repo-a'], includePrereleases: true },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    // rc1 included, draft still excluded.
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.externalId).toBe('github-releases:1000');
  });

  it('sends the optional Bearer token in the header only', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '[]' },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '[]' },
    ]);
    const connector = createGithubReleasesConnector();
    await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, { GITHUB_TOKEN: 'gh-token-value' }),
    });
    expect(mock.calls[0]?.headers['authorization']).toBe('Bearer gh-token-value');
    for (const call of mock.calls) {
      expect(call.url).not.toContain('gh-token-value');
    }
  });

  it('maps 401/403 to credentials_rejected and 429 to rate_limited', async () => {
    const connector = createGithubReleasesConnector();
    const mock401 = createFetchMock([
      { status: 401 },
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '[]' },
    ]);
    const rejected = await connector.fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock401.fetchFn, { GITHUB_TOKEN: 'x' }),
    });
    expect(rejected.status).toBe('failed');
    expect(rejected.failureReason).toBe('credentials_rejected');

    const mock429 = createFetchMock([{ status: 429, headers: { 'retry-after': '90' } }]);
    const limited = await connector.fetch({
      sourceId: SOURCE_ID,
      config: { repositories: ['owner/repo-a'], includePrereleases: false },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock429.fetchFn),
    });
    expect(limited.status).toBe('rate_limited');
    expect(limited.retryAfterSeconds).toBe(90);
  });

  it('fails safe on malformed JSON', async () => {
    const mock = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '["unterminated' },
    ]);
    const connector = createGithubReleasesConnector();
    const result = await connector.fetch({
      sourceId: SOURCE_ID,
      config: { repositories: ['owner/repo-a'], includePrereleases: false },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('response_malformed');
  });
});
