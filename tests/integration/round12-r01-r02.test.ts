import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  commitPollResults,
  reserveSourcePoll,
  type IngestItemRow,
  type PollTerminalState,
} from '../../src/adapters/db/source-ingest-store';
import { createSafeFetch } from '../../src/shared/http/safe-http';
import { createRssConnector } from '../../src/connectors/rss';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { connectorEffects } from '../helpers/fetch-mock';

/**
 * Round 1.2 narrow-patch acceptance tests (R01 + R02) — REAL workerd D1
 * and the REAL safe-http port (raw fetch → createSafeFetch → connector),
 * never a mocked SafeFetch, per the Round 1.2 review instructions.
 *
 * R01: exact 3xx status classes through the production port — 301/302/303/
 *      307/308 followed, 304 terminal, 300/305/306 explicitly not
 *      followable; URL/redirect/security validation preserved; RSS
 *      conditional-GET and GitHub 304 coverage end-to-end.
 * R02: two targeted conflict clauses — duplicates by each business key are
 *      harmless; unrelated primary-key collisions and NOT NULL/CHECK
 *      violations abort the WHOLE batch; mixed valid/invalid batches roll
 *      back atomically; cursor/state unchanged after any batch failure.
 */

const db: DbExecutor = createDbExecutor(env.DB);
const NOW = 1_770_000_000_000; // 2026-02-02T00:00:00Z — after all fixtures

const RSS_ENDPOINT = 'https://blog.playstation.com/feed/';

const VALID_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>PS Blog</title>
<item>
  <title>New Game Announced</title>
  <link>https://blog.playstation.com/article/new-game?utm_source=rss</link>
  <guid isPermaLink="false">ps-news-1</guid>
  <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
  <description><![CDATA[<p>A big announcement</p>]]></description>
</item>
</channel></rss>`;

/** Scripted RAW fetch (typeof fetch) — feeds the REAL createSafeFetch port. */
interface RawScriptedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | null;
}

function createRawFetchMock(script: readonly RawScriptedResponse[]): {
  fetchFn: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const queue = [...script];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: String(input), headers });
    const next = queue.shift();
    if (next === undefined) {
      return new Response(null, { status: 500 });
    }
    return new Response(next.body ?? null, { status: next.status, headers: next.headers });
  };
  return { fetchFn, calls };
}

function itemRow(overrides: Partial<IngestItemRow> = {}): IngestItemRow {
  return {
    id: `item-${Math.random().toString(36).slice(2, 10)}`,
    sourceId: 'playstation_blog',
    externalId: 'ext-1',
    canonicalUrl: 'https://blog.playstation.com/article-1',
    title: 'A title',
    excerpt: null,
    author: null,
    publishedAtMs: NOW,
    fetchedAtMs: NOW,
    contentHash: 'hash-1',
    rawJson: '{}',
    ...overrides,
  };
}

function terminalState(overrides: Partial<PollTerminalState> = {}): PollTerminalState {
  return {
    cursor: 'cursor-1',
    etag: null,
    lastModified: null,
    nextPollAtMs: NOW + 300_000,
    success: true,
    lastChangedAtMs: NOW,
    lastError: null,
    consecutiveFailures: 0,
    circuitOpenUntilMs: null,
    requestsToday: 1,
    budgetDate: '2026-02-02',
    ...overrides,
  };
}

/** Full source_state snapshot for unchanged-after-failure assertions. */
async function snapshotState(sourceId: string): Promise<Record<string, unknown> | null> {
  const row = await db.first<Record<string, unknown>>({
    sql: 'SELECT * FROM source_state WHERE source_id = ?',
    params: [sourceId],
  });
  return row;
}

async function countItems(): Promise<number> {
  const row = await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM source_items' });
  return row!.n;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  await db.run({ sql: 'DELETE FROM source_items' });
  await db.run({ sql: 'DELETE FROM source_state' });
  await db.run({ sql: 'DELETE FROM sources' });
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('invalid registry');
  await seedSourcesFromRegistry(db, r.registry, NOW);
});

describe('R01: conditional HTTP responses through the REAL safe-http port', () => {
  it('accepts 304 Not Modified as a terminal response (no Location needed)', async () => {
    const { fetchFn } = createRawFetchMock([{ status: 304 }]);
    const safe = createSafeFetch(fetchFn);
    const result = await safe({
      url: RSS_ENDPOINT,
      headers: { 'if-none-match': '"v1"' },
      byteCap: 2_097_152,
      timeoutMs: 1_000,
      maxRedirects: 2,
      allowedHosts: ['blog.playstation.com'],
    });
    expect(result).toMatchObject({ ok: true, status: 304, requestCount: 1, bodyText: '' });
  });

  it('follows exactly 301/302/303/307/308 with per-hop validation', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { fetchFn, calls } = createRawFetchMock([
        { status, headers: { location: '/next' } },
        { status: 200, headers: { 'content-type': 'text/plain' }, body: 'final' },
      ]);
      const safe = createSafeFetch(fetchFn);
      const result = await safe({
        url: 'https://allowed.test/feed',
        headers: {},
        byteCap: 2_097_152,
        timeoutMs: 1_000,
        maxRedirects: 3,
        allowedHosts: ['allowed.test'],
      });
      expect(result, `status ${status} must be followed`).toMatchObject({
        ok: true,
        status: 200,
        requestCount: 2,
      });
      if (result.ok) {
        expect(result.finalUrl).toBe('https://allowed.test/next');
        expect(result.bodyText).toBe('final');
      }
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toBe('https://allowed.test/next');
    }
  });

  it('never follows 300/305/306 — terminal typed failure, no second request', async () => {
    for (const status of [300, 305, 306]) {
      const { fetchFn, calls } = createRawFetchMock([
        // Location present on purpose: the status class alone decides.
        { status, headers: { location: 'https://allowed.test/elsewhere' } },
      ]);
      const safe = createSafeFetch(fetchFn);
      const result = await safe({
        url: 'https://allowed.test/feed',
        headers: {},
        byteCap: 2_097_152,
        timeoutMs: 1_000,
        maxRedirects: 3,
        allowedHosts: ['allowed.test'],
      });
      expect(result, `status ${status} must not be followed`).toEqual({
        ok: false,
        reason: 'redirect_status_not_followable',
        requestCount: 1,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('preserves redirect validation: scheme, allowlist, and hop limit', async () => {
    // Non-HTTPS redirect target rejected.
    const insecure = createRawFetchMock([
      { status: 302, headers: { location: 'http://allowed.test/x' } },
    ]);
    const insecureResult = await createSafeFetch(insecure.fetchFn)({
      url: 'https://allowed.test/feed',
      headers: {},
      byteCap: 2_097_152,
      timeoutMs: 1_000,
      maxRedirects: 3,
      allowedHosts: ['allowed.test'],
    });
    expect(insecureResult).toMatchObject({
      ok: false,
      reason: 'scheme_not_https',
      requestCount: 1,
    });

    // Off-allowlist redirect host rejected.
    const evil = createRawFetchMock([
      { status: 302, headers: { location: 'https://evil.test/x' } },
    ]);
    const evilResult = await createSafeFetch(evil.fetchFn)({
      url: 'https://allowed.test/feed',
      headers: {},
      byteCap: 2_097_152,
      timeoutMs: 1_000,
      maxRedirects: 3,
      allowedHosts: ['allowed.test'],
    });
    expect(evilResult).toMatchObject({ ok: false, reason: 'host_not_allowed', requestCount: 1 });

    // Hop limit still enforced.
    const loop = createRawFetchMock([
      { status: 302, headers: { location: '/b' } },
      { status: 302, headers: { location: '/c' } },
    ]);
    const loopResult = await createSafeFetch(loop.fetchFn)({
      url: 'https://allowed.test/a',
      headers: {},
      byteCap: 2_097_152,
      timeoutMs: 1_000,
      maxRedirects: 1,
      allowedHosts: ['allowed.test'],
    });
    expect(loopResult).toMatchObject({ ok: false, reason: 'redirect_limit', requestCount: 2 });
  });

  it('still strips credential headers across an origin change and keeps them same-origin', async () => {
    // Cross-origin redirect: Authorization MUST be stripped on hop 2.
    const cross = createRawFetchMock([
      { status: 302, headers: { location: 'https://b.test/x' } },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
    ]);
    const crossExecutor = createSafeFetch(cross.fetchFn);
    const crossResult = await crossExecutor({
      url: 'https://a.test/feed',
      headers: { authorization: 'Bearer secret' },
      byteCap: 2_097_152,
      timeoutMs: 1_000,
      maxRedirects: 2,
      allowedHosts: ['a.test', 'b.test'],
    });
    expect(crossResult).toMatchObject({ ok: true, status: 200 });
    expect(cross.calls[1]!.headers['authorization']).toBeUndefined();

    // Same-origin redirect: the header is preserved (origin unchanged).
    const same = createRawFetchMock([
      { status: 302, headers: { location: 'https://a.test/x' } },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
    ]);
    const sameExecutor = createSafeFetch(same.fetchFn);
    const sameResult = await sameExecutor({
      url: 'https://a.test/feed',
      headers: { authorization: 'Bearer secret' },
      byteCap: 2_097_152,
      timeoutMs: 1_000,
      maxRedirects: 2,
      allowedHosts: ['a.test'],
    });
    expect(sameResult).toMatchObject({ ok: true, status: 200 });
    expect(same.calls[1]!.headers['authorization']).toBe('Bearer secret');
  });

  it('RSS conditional-GET end-to-end: 200 with validators then 304 → not_modified', async () => {
    const connector = createRssConnector();
    const config = { endpoint: RSS_ENDPOINT };

    // Poll 1: 200 with validators → changed, validators stored in the cursor.
    const poll1 = createRawFetchMock([
      {
        status: 200,
        headers: {
          'content-type': 'application/rss+xml',
          etag: '"v1"',
          'last-modified': 'Mon, 06 Oct 2025 10:00:00 +0000',
        },
        body: VALID_FEED,
      },
    ]);
    const out1 = await connector.fetch({
      sourceId: 'playstation_blog',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(poll1.fetchFn)),
    });
    expect(out1.status).toBe('changed');
    expect(out1.items).toHaveLength(1);
    expect(out1.requestCount).toBe(1);
    const cursor1 = JSON.parse(out1.cursor ?? '{}') as Record<string, { etag: string | null }>;
    expect(cursor1[RSS_ENDPOINT]?.etag).toBe('"v1"');

    // Commit poll 1 through the REAL D1 boundary (pin the scanned marker,
    // mirroring the scheduler: scan sees next_poll_at=NOW, reserves the hold).
    await db.run({
      sql: "UPDATE source_state SET next_poll_at=? WHERE source_id='playstation_blog'",
      params: [NOW],
    });
    const reserved1 = await reserveSourcePoll(db, {
      sourceId: 'playstation_blog',
      scheduledForMs: NOW,
      nowMs: NOW,
    });
    expect(reserved1.kind).toBe('reserved');
    const item: IngestItemRow = {
      ...itemRow({ externalId: out1.items[0]!.externalId }),
      title: out1.items[0]!.title,
    };
    const commit1 = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [item],
      state: terminalState({ cursor: out1.cursor, nextPollAtMs: NOW + 300_000 }),
      holdUntilMs: reserved1.kind === 'reserved' ? reserved1.holdUntilMs : 0,
      nowMs: NOW,
    });
    expect(commit1.inserted).toBe(1);

    // Poll 2: conditional GET carries BOTH validators; 304 → not_modified.
    const poll2 = createRawFetchMock([{ status: 304 }]);
    const out2 = await connector.fetch({
      sourceId: 'playstation_blog',
      config,
      state: { etag: null, lastModified: null, cursor: out1.cursor },
      effects: connectorEffects(createSafeFetch(poll2.fetchFn)),
    });
    expect(out2.status).toBe('not_modified');
    expect(out2.items).toHaveLength(0);
    expect(out2.requestCount).toBe(1);
    expect(poll2.calls[0]!.headers['if-none-match']).toBe('"v1"');
    expect(poll2.calls[0]!.headers['if-modified-since']).toBe('Mon, 06 Oct 2025 10:00:00 +0000');
    expect(out2.cursor).toBe(out1.cursor); // 304 keeps the validator entry

    // Commit poll 2: state advances, no new items.
    const stateAfter1 = await snapshotState('playstation_blog');
    const reserved2 = await reserveSourcePoll(db, {
      sourceId: 'playstation_blog',
      scheduledForMs: NOW + 300_000,
      nowMs: NOW + 300_000,
    });
    expect(reserved2.kind).toBe('reserved');
    const commit2 = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [],
      state: terminalState({
        cursor: out2.cursor,
        nextPollAtMs: NOW + 600_000,
        requestsToday: 2,
      }),
      holdUntilMs: reserved2.kind === 'reserved' ? reserved2.holdUntilMs : 0,
      nowMs: NOW + 300_000,
    });
    expect(commit2.stateWriteWon).toBe(true);
    expect(commit2.inserted).toBe(0);
    expect(await countItems()).toBe(1); // no new rows from the 304 poll
    const stateAfter2 = await snapshotState('playstation_blog');
    expect(stateAfter2!.cursor).toBe(stateAfter1!.cursor); // validators preserved
  });

  it('RSS feed behind a same-host 302 through the real port → changed', async () => {
    const connector = createRssConnector();
    const redirecting = createRawFetchMock([
      { status: 302, headers: { location: '/feed-real' } },
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        body: VALID_FEED,
      },
    ]);
    const out = await connector.fetch({
      sourceId: 'playstation_blog',
      config: { endpoint: RSS_ENDPOINT },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(redirecting.fetchFn)),
    });
    expect(out.status).toBe('changed');
    expect(out.items).toHaveLength(1);
    expect(out.requestCount).toBe(2);
    expect(redirecting.calls[1]!.url).toBe('https://blog.playstation.com/feed-real');
  });

  it('GitHub releases 304 through the real port → not_modified with validators sent', async () => {
    const connector = createGithubReleasesConnector();
    const config = { repositories: ['octocat/hello'], includePrereleases: true };
    const releasesUrl = 'https://api.github.com/repos/octocat/hello/releases?per_page=25&page=1';
    const releaseBody = JSON.stringify([
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

    // Poll 1: 200 with ETag → changed, etag stored in the cursor.
    const poll1 = createRawFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"gh1"' },
        body: releaseBody,
      },
    ]);
    const out1 = await connector.fetch({
      sourceId: 'github_demo',
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(poll1.fetchFn)),
    });
    expect(out1.status).toBe('changed');
    expect(out1.items).toHaveLength(1);
    const cursor1 = JSON.parse(out1.cursor ?? '{}') as Record<string, string>;
    expect(cursor1['octocat/hello']).toBe('"gh1"');

    // Poll 2: conditional GET with If-None-Match → 304 → not_modified.
    const poll2 = createRawFetchMock([{ status: 304 }]);
    const out2 = await connector.fetch({
      sourceId: 'github_demo',
      config,
      state: { etag: null, lastModified: null, cursor: out1.cursor },
      effects: connectorEffects(createSafeFetch(poll2.fetchFn)),
    });
    expect(out2.status).toBe('not_modified');
    expect(out2.items).toHaveLength(0);
    expect(out2.requestCount).toBe(1);
    expect(poll2.calls[0]!.url).toBe(releasesUrl);
    expect(poll2.calls[0]!.headers['if-none-match']).toBe('"gh1"');
  });
});

describe('R02: precisely scoped duplicate handling on real workerd D1', () => {
  it('absorbs a duplicate external_id and classifies it honestly', async () => {
    const first = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow({ id: 'a1', externalId: 'e1', canonicalUrl: 'u1' })],
      state: terminalState(),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    expect(first.inserted).toBe(1);
    expect(await countItems()).toBe(1);

    // Same external_id, DIFFERENT canonical_url: only the external key fires.
    const second = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow({ id: 'a2', externalId: 'e1', canonicalUrl: 'u2' })],
      state: terminalState(),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    expect(second.duplicateExternal).toBe(1);
    expect(second.inserted).toBe(0);
    expect(await countItems()).toBe(1);
  });

  it('absorbs a duplicate canonical_url and classifies it honestly', async () => {
    await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow({ id: 'b1', externalId: 'e1', canonicalUrl: 'u1' })],
      state: terminalState(),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    // Fresh external_id, SAME canonical_url: only the url key fires.
    const second = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow({ id: 'b2', externalId: 'e2', canonicalUrl: 'u1' })],
      state: terminalState(),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    expect(second.duplicateUrl).toBe(1);
    expect(second.inserted).toBe(0);
    expect(await countItems()).toBe(1);
  });

  it('aborts on an unrelated primary-key collision; state unchanged', async () => {
    await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow({ id: 'pk-fixed', externalId: 'e1', canonicalUrl: 'u1' })],
      state: terminalState({ cursor: 'before-crash' }),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    const before = await snapshotState('playstation_blog');
    expect(await countItems()).toBe(1);

    // SAME primary key with FRESH business keys: the PK collision is NOT
    // suppressed by the two targeted clauses — it must raise and roll the
    // whole batch back.
    await expect(
      commitPollResults(db, {
        sourceId: 'playstation_blog',
        items: [itemRow({ id: 'pk-fixed', externalId: 'e9', canonicalUrl: 'u9' })],
        state: terminalState({ cursor: 'must-not-land' }),
        holdUntilMs: 0,
        nowMs: NOW,
      }),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });

    expect(await countItems()).toBe(1);
    const after = await snapshotState('playstation_blog');
    expect(after).toEqual(before); // cursor/state bit-identical
  });

  it('aborts on a NOT NULL violation; cursor/state unchanged', async () => {
    const before = await snapshotState('playstation_blog');
    await expect(
      commitPollResults(db, {
        sourceId: 'playstation_blog',
        items: [itemRow({ title: null as unknown as string })],
        state: terminalState({ cursor: 'must-not-advance' }),
        holdUntilMs: 0,
        nowMs: NOW,
      }),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });
    expect(await countItems()).toBe(0);
    expect(await snapshotState('playstation_blog')).toEqual(before);
  });

  it('CHECK constraints on the real table reject invalid rows (batch-abort precondition)', async () => {
    await expect(
      db.run({
        sql: `INSERT INTO source_items
                (id, source_id, external_id, canonical_url, title, body_excerpt, author,
                 published_at, fetched_at, content_hash, raw_json, processing_status)
              VALUES ('chk', 'playstation_blog', 'ce', NULL, 't', NULL, NULL, NULL, 1, 'h', '{}', 'bogus')`,
      }),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });
  });

  it('mixed valid/invalid batch rolls back atomically; cursor/state unchanged', async () => {
    const before = await snapshotState('playstation_blog');
    await expect(
      commitPollResults(db, {
        sourceId: 'playstation_blog',
        items: [
          itemRow({ id: 'valid-1', externalId: 'ev', canonicalUrl: 'uv' }),
          itemRow({
            id: 'invalid-1',
            externalId: 'eb',
            canonicalUrl: 'ub',
            title: null as unknown as string,
          }),
        ],
        state: terminalState({ cursor: 'must-not-land' }),
        holdUntilMs: 0,
        nowMs: NOW,
      }),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });

    // The VALID row must NOT survive an aborted batch (all-or-nothing).
    const validRow = await db.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE id = ?',
      params: ['valid-1'],
    });
    expect(validRow).toBeNull();
    expect(await countItems()).toBe(0);
    expect(await snapshotState('playstation_blog')).toEqual(before);
  });

  it('both business-key duplicates inside ONE batch stay harmless (multi-item commit)', async () => {
    await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow({ id: 'm0', externalId: 'me', canonicalUrl: 'mu' })],
      state: terminalState(),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    const result = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [
        itemRow({ id: 'm1', externalId: 'me', canonicalUrl: 'other-url' }), // external dup
        itemRow({ id: 'm2', externalId: 'other-ext', canonicalUrl: 'mu' }), // url dup
        itemRow({ id: 'm3', externalId: 'fresh-e', canonicalUrl: 'fresh-u' }), // inserts
      ],
      state: terminalState(),
      holdUntilMs: 0,
      nowMs: NOW,
    });
    expect(result.inserted).toBe(1);
    expect(result.duplicateExternal).toBe(1);
    expect(result.duplicateUrl).toBe(1);
    expect(await countItems()).toBe(2);
  });
});
