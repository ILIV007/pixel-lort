import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createRssConnector } from '../../src/connectors/rss';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { createYoutubePlaylistsConnector } from '../../src/connectors/youtube-playlists';
import { createFetchMock, connectorEffects, type QueuedResponse } from '../helpers/fetch-mock';
import { createSafeFetch } from '../../src/shared/http/safe-http';
import type { ConnectorEffects } from '../../src/connectors/contract';

/** A scripted SafeFetchExecutor response queue. */
type Script = readonly QueuedResponse[];

/**
 * Round 1.4 permanent coverage — R05 and R06.
 *
 * R05 (strongest Retry-After lower bound): a multi-feed/multi-repository
 * fetch that observes several 429s must report the STRONGEST applicable
 * Retry-After lower bound across ALL of them. Retry-After is a lower
 * bound ("do not retry before N seconds"), so the MAXIMUM wins:
 *   - a later shorter bound never erases an earlier longer one;
 *   - a later missing or invalid header (parsed → null) carries no
 *     information and never erases an earlier valid bound;
 *   - zero is a REAL observed bound (delta-seconds "0" or an
 *     already-past HTTP-date) — distinct from null (unknown) — and is
 *     preserved when it is the only observation, but never erases a
 *     stronger one;
 *   - the bound survives when successful and rate-limited portions
 *     coexist (items from the successful portion are still returned);
 *   - HTTP-date headers are parsed against the INJECTED clock
 *     (effects.nowMs), including reversed response orders.
 *
 * R06 (truthful aggregate YouTube request counting): EVERY YouTube
 * return path reports the aggregate requestCount of ALL issued HTTP
 * attempts — earlier successful playlistItems calls, redirect hops, the
 * details/enrichment call — with each attempt counted exactly once
 * (observed counts, never planned substitutes, no clamping). This does
 * NOT change item/cursor/failure-classification semantics and does NOT
 * fix R10's pre-network budget authority.
 *
 * Port levels (mirrors the accepted Round 1.2/1.3.1 layering):
 *   - connector-contract tests inject a scripted SafeFetchExecutor
 *     (createFetchMock) — cheap exhaustive matrices;
 *   - real-port tests drive scripted RAW `typeof fetch` fakes through
 *     the PRODUCTION createSafeFetch (URL guard, allowlist, manual
 *     redirect validation, header handling) — the counting and
 *     header-parsing behavior is proven end-to-end, not just against a
 *     SafeFetch-shaped fake.
 */

const db = createDbExecutor(env.DB);
const NOW = 1_770_000_000_000; // 2026-02-02T00:00:00Z — matches connectorEffects

const RSS_FEEDS = ['https://feeds.example/news.xml', 'https://feeds.example/updates.xml'];
const RSS_THREE_FEEDS = [...RSS_FEEDS, 'https://feeds.example/archive.xml'];
const RSS_CONFIG = { endpointTemplates: RSS_FEEDS };
const GITHUB_CONFIG = {
  repositories: ['octocat/hello', 'octocat/world'],
  includePrereleases: false,
};
const YOUTUBE_CONFIG = {
  useSearchEndpoint: false,
  downloadVideo: false,
  playlists: ['PLreview123456', 'PLreview654321'],
};
const STATE = { etag: null, lastModified: null, cursor: null } as const;

const VALID_RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title>
<item>
  <title>Round 1.4 shipped</title>
  <link>https://feeds.example/post/hello</link>
  <guid isPermaLink="false">round14-1</guid>
  <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
  <description><![CDATA[<p>Hello</p>]]></description>
</item>
</channel></rss>`;

const RELEASE_BODY = JSON.stringify([
  {
    id: 101,
    tag_name: 'v1.0.0',
    name: 'Release 1',
    html_url: 'https://github.com/octocat/hello/releases/v1.0.0',
    prerelease: false,
    draft: false,
    published_at: '2026-01-05T00:00:00Z',
    body: 'notes',
    author: { login: 'dev' },
  },
]);

/** Effects with an EXPLICITLY injected clock (HTTP-date parsing depends on it). */
function effectsWithClock(
  fetchFn: Parameters<typeof connectorEffects>[0],
  nowMs: number,
): ConnectorEffects {
  return {
    safeFetch: fetchFn,
    nowMs: () => nowMs,
    random: () => 0.5,
    secrets: () => undefined,
  };
}

/** HTTP-date form of Retry-After for an absolute epoch-ms instant. */
function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
});

// ────────────────────────────────────────────────────────────────────────────
// R05 — RSS connector contract (fake SafeFetchExecutor)
// ────────────────────────────────────────────────────────────────────────────

describe('R05 RSS: strongest Retry-After lower bound across feeds', () => {
  const fetch = (responses: Script, nowMs = NOW) =>
    createRssConnector().fetch({
      sourceId: 'rss_review',
      config: RSS_CONFIG,
      state: STATE,
      effects: effectsWithClock(createFetchMock(responses).fetchFn, nowMs),
    });

  it('a later shorter bound must not erase an earlier longer one (reversed order vs supplied R05)', async () => {
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '60' } },
      { status: 429, headers: { 'retry-after': '7200' } },
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(7200);
    expect(result.requestCount).toBe(2);
  });

  it('a later MISSING header must not erase an earlier valid bound', async () => {
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '1800' } },
      { status: 429 }, // no retry-after header at all
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(1800);
  });

  it('a later INVALID header must not erase an earlier valid bound', async () => {
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '1800' } },
      { status: 429, headers: { 'retry-after': 'soon-but-neither-seconds-nor-date' } },
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(1800);
  });

  it('zero is a real bound but never erases a stronger one (both orders)', async () => {
    const zeroThenLong = await fetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '600' } },
    ]);
    expect(zeroThenLong.retryAfterSeconds).toBe(600);
    const longThenZero = await fetch([
      { status: 429, headers: { 'retry-after': '600' } },
      { status: 429, headers: { 'retry-after': '0' } },
    ]);
    expect(longThenZero.retryAfterSeconds).toBe(600);
  });

  it('a lone zero bound is reported as 0 — never confused with missing/null', async () => {
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429 }, // missing header must not erase the zero either
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('HTTP-date bounds parse against the INJECTED clock; strongest wins in reversed order', async () => {
    const later = httpDate(NOW + 120_000); // → 120s
    const sooner = httpDate(NOW + 30_000); // → 30s
    const first = await fetch(
      [
        { status: 429, headers: { 'retry-after': later } },
        { status: 429, headers: { 'retry-after': sooner } },
      ],
      NOW,
    );
    expect(first.retryAfterSeconds).toBe(120);
    const reversed = await fetch(
      [
        { status: 429, headers: { 'retry-after': sooner } },
        { status: 429, headers: { 'retry-after': later } },
      ],
      NOW,
    );
    expect(reversed.retryAfterSeconds).toBe(120);
  });

  it('an already-past HTTP-date parses to the zero bound and never erases a stronger one', async () => {
    const past = httpDate(NOW - 60_000); // ≤ 0 → 0
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '900' } },
      { status: 429, headers: { 'retry-after': past } },
    ]);
    expect(result.retryAfterSeconds).toBe(900);
  });

  it('successful and rate-limited portions coexist: items and the bound are both preserved', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/xml' },
        bodyText: VALID_RSS_FEED,
      },
      { status: 429, headers: { 'retry-after': '300' } },
    ]);
    const result = await createRssConnector().fetch({
      sourceId: 'rss_review',
      config: RSS_CONFIG,
      state: STATE,
      effects: effectsWithClock(mock.fetchFn, NOW),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.items).toHaveLength(1); // the successful feed's durable items survive
    expect(result.retryAfterSeconds).toBe(300); // and so does the strongest bound
    expect(result.requestCount).toBe(2);
    expect(result.malformedCount).toBe(0);
  });

  it('three feeds: 60 → missing → 30 still reports 60 (max survives interleaved nulls)', async () => {
    const result = await createRssConnector().fetch({
      sourceId: 'rss_review',
      config: { endpointTemplates: RSS_THREE_FEEDS },
      state: STATE,
      effects: effectsWithClock(
        createFetchMock([
          { status: 429, headers: { 'retry-after': '60' } },
          { status: 429 },
          { status: 429, headers: { 'retry-after': '30' } },
        ]).fetchFn,
        NOW,
      ),
    });
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.requestCount).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// R05 — GitHub releases connector contract (fake SafeFetchExecutor)
// ────────────────────────────────────────────────────────────────────────────

describe('R05 GitHub: strongest Retry-After lower bound across repositories', () => {
  const fetch = (responses: Script, nowMs = NOW) =>
    createGithubReleasesConnector().fetch({
      sourceId: 'github_review',
      config: GITHUB_CONFIG,
      state: STATE,
      effects: effectsWithClock(createFetchMock(responses).fetchFn, nowMs),
    });

  it('a later shorter bound must not erase an earlier longer one', async () => {
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '7200' } },
      { status: 429, headers: { 'retry-after': '45' } },
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(7200);
    expect(result.requestCount).toBe(2);
  });

  it('reversed order: a later longer bound is still reported (max, not first)', async () => {
    const result = await fetch([
      { status: 429, headers: { 'retry-after': '45' } },
      { status: 429, headers: { 'retry-after': '7200' } },
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(7200);
  });

  it('missing and invalid headers after a valid bound never erase it', async () => {
    const result = await createGithubReleasesConnector().fetch({
      sourceId: 'github_review',
      config: {
        repositories: ['octocat/hello', 'octocat/world', 'octocat/other'],
        includePrereleases: false,
      },
      state: STATE,
      effects: effectsWithClock(
        createFetchMock([
          { status: 429, headers: { 'retry-after': '600' } },
          { status: 429 },
          { status: 429, headers: { 'retry-after': 'not-a-date' } },
        ]).fetchFn,
        NOW,
      ),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(600);
    expect(result.requestCount).toBe(3);
  });

  it('zero is a real bound but never erases a stronger one', async () => {
    const zeroThenLong = await fetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '120' } },
    ]);
    expect(zeroThenLong.retryAfterSeconds).toBe(120);
    const longThenZero = await fetch([
      { status: 429, headers: { 'retry-after': '120' } },
      { status: 429, headers: { 'retry-after': '0' } },
    ]);
    expect(longThenZero.retryAfterSeconds).toBe(120);
  });

  it('a lone zero bound is reported as 0 — distinct from missing/null', async () => {
    const result = await fetch([{ status: 429, headers: { 'retry-after': '0' } }]);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('HTTP-date bounds parse against the INJECTED clock; strongest wins in reversed order', async () => {
    const later = httpDate(NOW + 45_000); // → 45s
    const sooner = httpDate(NOW + 15_000); // → 15s
    const first = await fetch(
      [
        { status: 429, headers: { 'retry-after': later } },
        { status: 429, headers: { 'retry-after': sooner } },
      ],
      NOW,
    );
    expect(first.retryAfterSeconds).toBe(45);
    const reversed = await fetch(
      [
        { status: 429, headers: { 'retry-after': sooner } },
        { status: 429, headers: { 'retry-after': later } },
      ],
      NOW,
    );
    expect(reversed.retryAfterSeconds).toBe(45);
  });

  it('successful and rate-limited portions coexist: items and the bound are both preserved', async () => {
    const result = await fetch([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: RELEASE_BODY,
      },
      { status: 429, headers: { 'retry-after': '90' } },
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.items).toHaveLength(1); // the successful repo's releases survive
    expect(result.retryAfterSeconds).toBe(90);
    expect(result.requestCount).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// R06 — YouTube aggregate request counting (connector contract, fake executor)
// ────────────────────────────────────────────────────────────────────────────

describe('R06 YouTube: aggregate requestCount on EVERY return path', () => {
  const fetch = (responses: Parameters<typeof createFetchMock>[0]) =>
    createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_review',
      config: YOUTUBE_CONFIG,
      state: STATE,
      effects: connectorEffects(createFetchMock(responses).fetchFn, {
        YOUTUBE_API_KEY: 'fixture-not-a-real-key',
      }),
    });

  const playlistOk = (videoId: string): QueuedResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({
      items: [{ contentDetails: { videoId }, snippet: { title: 'Video' } }],
    }),
  });

  it('success-then-429: the earlier successful call is retained in the aggregate', async () => {
    const result = await fetch([
      playlistOk('vid000000001'),
      { status: 429, headers: { 'retry-after': '30' } },
    ]);
    expect(result.status).toBe('rate_limited');
    expect(result.requestCount).toBe(2); // NOT the lone 429's own count
    expect(result.retryAfterSeconds).toBe(30);
  });

  it('success-then-transport-error: aggregate retained', async () => {
    const result = await fetch([playlistOk('vid000000001'), { failReason: 'network_error' }]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.requestCount).toBe(2);
  });

  it('success-then-401: aggregate retained on the credentials path', async () => {
    const result = await fetch([playlistOk('vid000000001'), { status: 401 }]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('credentials_rejected');
    expect(result.requestCount).toBe(2);
  });

  it('success-then-403: aggregate retained on the credentials path', async () => {
    const result = await fetch([playlistOk('vid000000001'), { status: 403 }]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('credentials_rejected');
    expect(result.requestCount).toBe(2);
  });

  it('success-then-other-HTTP-failure (404): aggregate retained', async () => {
    const result = await fetch([playlistOk('vid000000001'), { status: 404 }]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.requestCount).toBe(2);
  });

  it('success-then-content-type-error: aggregate retained', async () => {
    const result = await fetch([
      playlistOk('vid000000001'),
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bodyText: '<html/>' },
    ]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('unexpected_content_type');
    expect(result.requestCount).toBe(2);
  });

  it('success-then-malformed-JSON: aggregate retained (regression pin for the parse path)', async () => {
    const result = await fetch([
      playlistOk('vid000000001'),
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"items":' },
    ]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('response_malformed');
    expect(result.requestCount).toBe(2);
  });

  it('multi-playlist success-then-failure with the details call: all counts retained', async () => {
    const result = await fetch([
      playlistOk('vid000000001'),
      playlistOk('vid000000002'),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          items: [
            { id: 'vid000000001', snippet: { publishedAt: '2026-02-01T00:00:00Z' } },
            { id: 'vid000000002', snippet: { publishedAt: '2026-02-02T00:00:00Z' } },
          ],
        }),
      },
    ]);
    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(2);
    expect(result.requestCount).toBe(3); // 2 playlistItems pages + 1 details call
  });

  it('details/enrichment failure still counts the enrichment request in the aggregate', async () => {
    // Single-playlist config so the 500 is consumed by the DETAILS call
    // (two-playlist configs would hand it to the second playlist page).
    const result = await createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_review',
      config: { useSearchEndpoint: false, downloadVideo: false, playlists: ['PLreview123456'] },
      state: STATE,
      effects: connectorEffects(
        createFetchMock([playlistOk('vid000000001'), { status: 500 }]).fetchFn,
        { YOUTUBE_API_KEY: 'fixture-not-a-real-key' },
      ),
    });
    expect(result.status).toBe('changed');
    expect(result.items).toHaveLength(1); // playlistItems data survives (degraded)
    expect(result.requestCount).toBe(2); // playlist page + failed details call
  });

  it('observed counts are reported even when lower than planned (no planned-count substitution)', async () => {
    const connector = createYoutubePlaylistsConnector();
    const planned = connector.plannedRequestCount(YOUTUBE_CONFIG);
    expect(planned).toBe(3); // 2 playlistItems pages + 1 details call
    const result = await fetch([{ status: 429, headers: { 'retry-after': '10' } }]);
    expect(result.status).toBe('rate_limited');
    expect(result.requestCount).toBe(1); // OBSERVED — the 2nd playlist + details never ran
  });
});

// ────────────────────────────────────────────────────────────────────────────
// R06 — REAL createSafeFetch port: scripted RAW fetch (typeof fetch)
// ────────────────────────────────────────────────────────────────────────────

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

/** Scripted RAW fetch — feeds the REAL createSafeFetch; records every raw call. */
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

describe('R06 YouTube through the REAL createSafeFetch port (raw fetch)', () => {
  const fetch = (raw: ReturnType<typeof createRawFetchMock>) =>
    createYoutubePlaylistsConnector().fetch({
      sourceId: 'youtube_official_watchlist',
      config: YOUTUBE_CONFIG,
      state: STATE,
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {
        YOUTUBE_API_KEY: 'fixture-not-a-real-key',
      }),
    });

  it('allowed redirect before a later failure: aggregate retains redirect hops + earlier success', async () => {
    // Playlist 1: 302 → SAME-HOST redirect (allowlisted) → 200 with items.
    // That is 2 raw HTTP attempts for the first playlist alone. Playlist 2
    // then fails with 500. The aggregate MUST be 3 — every issued attempt
    // counted exactly once, nothing lost.
    const raw = createRawFetchMock([
      {
        status: 302,
        headers: {
          location:
            'https://www.googleapis.com/youtube/v3/playlistItems' +
            '?part=snippet,contentDetails&playlistId=PLreview123456&maxResults=25',
        },
      },
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ contentDetails: { videoId: 'vid000000001' }, snippet: { title: 'A' } }],
        }),
      },
      { status: 500 },
    ]);
    const result = await fetch(raw);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.requestCount).toBe(3); // 2 hops for playlist 1 + 1 for playlist 2
    expect(raw.calls).toHaveLength(3);
    // The header-only credential rode every hop to the OFFICIAL origin —
    // and never appeared in any URL.
    for (const call of raw.calls) {
      const url = new URL(call.url);
      expect(url.hostname).toBe('www.googleapis.com');
      expect(call.headers['x-goog-api-key']).toBe('fixture-not-a-real-key');
      expect(url.searchParams.get('key')).toBeNull();
      expect(call.url).not.toContain('fixture-not-a-real-key');
    }
  });

  it('denied off-allowlist redirect: no extra raw request, aggregate = the single attempt', async () => {
    const raw = createRawFetchMock([
      { status: 302, headers: { location: 'https://evil.example/collect' } },
      // Must NEVER be consumed — proves no second raw request happened.
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"items":[]}',
      },
    ]);
    const result = await fetch(raw);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.requestCount).toBe(1); // the one attempt that WAS issued
    expect(raw.calls).toHaveLength(1); // redirect target never contacted
    expect(new URL(raw.calls[0]!.url).hostname).toBe('www.googleapis.com');
  });

  it('real-port 429 after an earlier successful call: aggregate 2 + Retry-After parsed', async () => {
    const raw = createRawFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ contentDetails: { videoId: 'vid000000001' }, snippet: { title: 'A' } }],
        }),
      },
      { status: 429, headers: { 'retry-after': '45' } },
    ]);
    const result = await fetch(raw);

    expect(result.status).toBe('rate_limited');
    expect(result.requestCount).toBe(2); // earlier success + the 429
    expect(result.retryAfterSeconds).toBe(45); // header survives the REAL port
  });
});

describe('R05 through the REAL createSafeFetch port (raw fetch)', () => {
  it('RSS: strongest bound across two raw 429s (7200 vs 60) survives the real port', async () => {
    const raw = createRawFetchMock([
      { status: 429, headers: { 'retry-after': '7200' } },
      { status: 429, headers: { 'retry-after': '60' } },
    ]);
    const result = await createRssConnector().fetch({
      sourceId: 'rss_review',
      config: RSS_CONFIG,
      state: STATE,
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {}),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(7200); // NOT the later shorter 60
    expect(result.requestCount).toBe(2);
    expect(raw.calls).toHaveLength(2);
  });

  it('GitHub: HTTP-date Retry-After parsed against the clock through the real port', async () => {
    const raw = createRawFetchMock([
      { status: 429, headers: { 'retry-after': httpDate(NOW + 120_000) } }, // → 120s
      { status: 429, headers: { 'retry-after': httpDate(NOW + 30_000) } }, // → 30s
    ]);
    const result = await createGithubReleasesConnector().fetch({
      sourceId: 'github_review',
      config: GITHUB_CONFIG,
      state: STATE,
      effects: connectorEffects(createSafeFetch(raw.fetchFn), {}),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(120); // strongest of the two date bounds
    expect(result.requestCount).toBe(2);
    expect(raw.calls).toHaveLength(2);
  });
});
