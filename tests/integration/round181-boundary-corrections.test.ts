/**
 * Round 1.8.1 — permanent boundary-correction regressions (B1–B4).
 *
 * TWO explicitly labeled families, mirroring the Round 1.8 suite layout:
 *
 * 1. RAW-PORT family: REAL `createIngestionSafeFetch` over scripted raw
 *    `typeof fetch` functions — deadline-bounded authorization waits
 *    (B1, real timers, not fake clock jumps), typed infrastructure errors
 *    carrying observed attempts (B4, transport boundary).
 * 2. REAL workerd D1 handler family: the REAL `createSourcePollHandler`
 *    with REAL D1 (`env.DB`) and scripted raw fetch — validator
 *    preservation through the REAL commit path (B2), Retry-After
 *    carry-through and real scheduling incl. a later quota raise (B3),
 *    poll observed-attempt totals on authority throws, distinct from
 *    durable charges (B4).
 *
 * NO provider network (AGENTS.md §4). R09 is NOT touched here.
 * The 8 Posidon evidence tests are registered byte-identical in
 * tests/integration/posidon-round18-counterexamples.test.ts (all GREEN);
 * THIS suite adds the additional required cases on top.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  authorizeIngestionUnit,
  readIngestionBudget,
} from '../../src/adapters/db/ingestion-budget-store';
import {
  createIngestionSafeFetch,
  SafeFetchAuthorityError,
  type SafeFetchInput,
  type SafeFetchUnitGrant,
} from '../../src/shared/http/safe-http';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { createRssConnector } from '../../src/connectors/rss';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { connectorEffects } from '../helpers/fetch-mock';
import { INGESTION_BUDGET_RETRY_MS, INGESTION_POLL_HOLD_MS } from '../../src/shared/config/phase4';
import type { LogFields, Logger } from '../../src/observability/logger';

const NOW = 1_770_000_000_000;
const db = createDbExecutor(env.DB);

const INPUT: SafeFetchInput = {
  url: 'https://blog.playstation.com/feed/',
  headers: { accept: 'application/xml' },
  byteCap: 2048,
  timeoutMs: 100,
  maxRedirects: 2,
  allowedHosts: ['blog.playstation.com'],
};

const SAVED = {
  cursor: '{"saved-window":true}',
  etag: '"saved-etag"',
  lastModified: 'Mon, 02 Feb 2026 00:00:00 GMT',
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Capturing fake logger (fields kept raw for assertions, never a sink). */
function capturingLogger(): Logger & {
  lines: readonly { level: string; message: string; fields: LogFields }[];
} {
  const lines: { level: string; message: string; fields: LogFields }[] = [];
  const record = (level: string) => (message: string, fields?: LogFields) => {
    lines.push({ level, message, fields: fields ?? {} });
  };
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => capturingLogger(),
  };
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs', 'budgets']) {
    await db.run({ sql: `DELETE FROM ${t}` });
  }
  const reg = parseEmbeddedRegistry();
  if (!reg.ok) throw new Error('invalid registry');
  await seedSourcesFromRegistry(db, reg.registry, NOW);
});

async function setBudget(sourceId: string, cap: number): Promise<void> {
  await db.run({
    sql: 'UPDATE sources SET daily_request_budget=? WHERE id=?',
    params: [cap, sourceId],
  });
}

async function enable(sourceId: string): Promise<void> {
  await db.run({ sql: 'UPDATE sources SET enabled=1 WHERE id=?', params: [sourceId] });
}

async function saveState(
  sourceId: string,
  state: { cursor: string | null; etag: string | null; lastModified: string | null },
): Promise<void> {
  await db.run({
    sql: 'UPDATE source_state SET cursor=?, etag=?, last_modified=? WHERE source_id=?',
    params: [state.cursor, state.etag, state.lastModified, sourceId],
  });
}

/** Align the seeded next_poll_at so the fenced terminal write owns the window. */
async function alignWindow(sourceId: string, scheduledForMs: number): Promise<number> {
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=? WHERE source_id=?',
    params: [scheduledForMs + INGESTION_POLL_HOLD_MS, sourceId],
  });
  return scheduledForMs;
}

describe('Round 1.8.1 B1 — the absolute deadline bounds the authorization wait (raw port, real timers)', () => {
  it('slow-but-timely grant: the raw attempt uses the REAL recomputed remaining budget, not the stale pre-auth value', async () => {
    const timeoutMs = 60;
    let fetchEnteredAt = 0;
    const startedAt = Date.now();
    const fetch = createIngestionSafeFetch({
      // Real ~30 ms authority wait (timely: 30 < 60), NOT a fake clock jump.
      authorizeUnit: async () => {
        await sleep(30);
        return { kind: 'granted' };
      },
      fetchFn: async (_url, init) => {
        fetchEnteredAt = Date.now();
        // Hold until the sequence deadline aborts us: the abort must fire at
        // the RECOMPUTED remainder (~60 ms from sequence start = ~30 ms after
        // the grant), never at the stale 60 ms measured from grant time.
        return await new Promise<Response>((resolve) => {
          init?.signal?.addEventListener('abort', () =>
            resolve(new Response('late-body', { status: 200 })),
          );
        });
      },
    });
    const result = await fetch({ ...INPUT, timeoutMs });
    const elapsed = Date.now() - startedAt;
    expect(result).toEqual({
      ok: false,
      reason: 'timeout',
      requestCount: 1,
    });
    // The raw attempt DID start (timely grant) and BEFORE the deadline.
    expect(fetchEnteredAt).toBeGreaterThan(startedAt);
    expect(fetchEnteredAt - startedAt).toBeLessThan(timeoutMs);
    // Total elapsed ≈ deadline from SEQUENCE start (~60 ms). A stale
    // post-grant timer would only fire ~30 ms later (≥ 85 ms here).
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10);
    expect(elapsed).toBeLessThan(timeoutMs + 25);
  });

  it('never-settling authorizer is bounded by the deadline; a LATE grant never resumes the network', async () => {
    let release: ((grant: SafeFetchUnitGrant) => void) | undefined;
    let rawCalls = 0;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: () =>
        new Promise<SafeFetchUnitGrant>((resolve) => {
          release = resolve;
        }),
      fetchFn: async () => {
        rawCalls += 1;
        return new Response(null, { status: 200 });
      },
    });
    const pending = fetch({ ...INPUT, timeoutMs: 15 });
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: 'timeout', requestCount: 0 });
    release?.({ kind: 'granted' }); // late grant AFTER the timeout answer
    await sleep(25);
    expect(rawCalls).toBe(0); // a late grant can NEVER resume the network
  });

  it('redirect-hop authorization stalls: timeout after the observed hop 0, no hop-1 raw attempt', async () => {
    let calls = 0;
    let release: ((grant: SafeFetchUnitGrant) => void) | undefined;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ kind: 'granted' } as SafeFetchUnitGrant);
        }
        return new Promise<SafeFetchUnitGrant>((resolve) => {
          release = resolve;
        });
      },
      fetchFn: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://blog.playstation.com/feed/final' },
        }),
    });
    const result = await fetch({ ...INPUT, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: 'timeout', requestCount: 1 });
    release?.({ kind: 'granted' });
    await sleep(20);
    expect(result).toEqual({ ok: false, reason: 'timeout', requestCount: 1 }); // unchanged
  });

  it('REAL D1 charge disclosure: an authority that charges then stalls past the deadline leaves the unit durably charged with ZERO raw attempts', async () => {
    await setBudget('playstation_blog', 1);
    let rawCalls = 0;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: async () => {
        // REAL atomic D1 charge, then the authority stalls past the deadline.
        const grant = await authorizeIngestionUnit(db, {
          sourceId: 'playstation_blog',
          nowMs: NOW,
        });
        if (grant.kind !== 'authorized') {
          return { kind: 'budget_denied' };
        }
        await sleep(60); // deadline (20 ms) expires during this wait
        return { kind: 'granted' };
      },
      fetchFn: async () => {
        rawCalls += 1;
        return new Response(null, { status: 200 });
      },
    });
    const result = await fetch({ ...INPUT, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: 'timeout', requestCount: 0 });
    expect(rawCalls).toBe(0);
    // The conservative charge window: the committed unit STANDS. No refund,
    // no claimed cancellation. Charged units (1) ≠ observed attempts (0).
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });

  it('authorizer throw on the FIRST hop (top-level): typed infrastructure error, observed 0, no raw payload, no raw request', async () => {
    let rawCalls = 0;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: async () => {
        throw new Error('SECRET-OUTAGE-TEXT must-never-leak');
      },
      fetchFn: async () => {
        rawCalls += 1;
        return new Response(null, { status: 200 });
      },
    });
    let caught: unknown;
    try {
      await fetch(INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SafeFetchAuthorityError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toHaveProperty('requestCount', 0);
    const typed = caught as SafeFetchAuthorityError;
    expect(typed.message).toBe('safe fetch budget authority failed'); // stable, no raw text
    expect(typed.message.includes('SECRET-OUTAGE-TEXT')).toBe(false);
    expect(rawCalls).toBe(0);
  });
});

describe('Round 1.8.1 B2 — budget-denied windows preserve prior validators through the REAL handler (workerd D1, non-null fixtures)', () => {
  it('later-feed denial: non-null cursor/etag/last_modified survive EXACTLY; no partial per-feed progress', async () => {
    await enable('itch_discovery'); // registry ships TWO endpointTemplates
    await setBudget('itch_discovery', 1); // feed 1 consumes the unit, feed 2 is denied
    await saveState('itch_discovery', SAVED);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>n</title><link>https://itch.io/x</link><guid>g1</guid></item></channel></rss>`,
        { status: 200, headers: { 'content-type': 'application/rss+xml' } },
      );
    }) as typeof fetch;
    const logger = capturingLogger();
    const handler = createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn,
      idGenerator: { newId: () => 'r181-b2-1' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
      logger,
    });
    const scheduledForMs = await alignWindow('itch_discovery', NOW);
    expect(
      await handler.execute({
        jobId: 'r181-b2-1',
        generation: 1,
        payload: { sourceId: 'itch_discovery', scheduledForMs },
      }),
    ).toEqual({ kind: 'success' });
    expect(rawCalls).toBe(1); // feed 2 denied with zero raw requests
    const row = await db.first<{
      cursor: string | null;
      etag: string | null;
      last_modified: string | null;
      last_error: string | null;
    }>({
      sql: 'SELECT cursor, etag, last_modified, last_error FROM source_state WHERE source_id=?',
      params: ['itch_discovery'],
    });
    // EXACT prior state: validators non-null and unchanged, no per-feed
    // advancement from the one completed feed, no items.
    expect(row).toEqual({
      cursor: SAVED.cursor,
      etag: SAVED.etag,
      last_modified: SAVED.lastModified,
      last_error: 'budget_exhausted',
    });
    const items = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id=?',
      params: ['itch_discovery'],
    });
    expect(items?.n).toBe(0);
  });

  it('redirect denial: the unit spent on hop 0 does not weaken prior validator persistence', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 1); // hop 0 consumes it, hop 1 denied
    await saveState('playstation_blog', SAVED);
    let rawCalls = 0;
    const fetchFn = (async () => {
      rawCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://blog.playstation.com/feed/final' },
      });
    }) as typeof fetch;
    const handler = createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn,
      idGenerator: { newId: () => 'r181-b2-2' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
    });
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    expect(
      await handler.execute({
        jobId: 'r181-b2-2',
        generation: 1,
        payload: { sourceId: 'playstation_blog', scheduledForMs },
      }),
    ).toEqual({ kind: 'success' });
    expect(rawCalls).toBe(1);
    const row = await db.first<{
      cursor: string | null;
      etag: string | null;
      last_modified: string | null;
      last_error: string | null;
    }>({
      sql: 'SELECT cursor, etag, last_modified, last_error FROM source_state WHERE source_id=?',
      params: ['playstation_blog'],
    });
    expect(row).toEqual({
      cursor: SAVED.cursor,
      etag: SAVED.etag,
      last_modified: SAVED.lastModified,
      last_error: 'budget_exhausted',
    });
  });
});

describe('Round 1.8.1 B3 — observed provider bounds survive a later denial; real scheduling never shortens either bound', () => {
  function budgetedTransport(sourceId: string, raw: typeof fetch) {
    return createIngestionSafeFetch({
      fetchFn: raw,
      authorizeUnit: async () => {
        const g = await authorizeIngestionUnit(db, { sourceId, nowMs: NOW });
        return g.kind === 'authorized'
          ? { kind: 'granted' }
          : g.kind === 'denied'
            ? { kind: 'budget_denied' }
            : { kind: 'source_missing' };
      },
    });
  }

  it('RSS: multiple 429 lower bounds (3600 then 7200) then denial — the strongest survives', async () => {
    await setBudget('itch_discovery', 2);
    let calls = 0;
    const fetchFn = budgetedTransport('itch_discovery', async () => {
      calls += 1;
      if (calls <= 2) {
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': calls === 1 ? '3600' : '7200' },
        });
      }
      return new Response(null, { status: 200 }); // never reached — denied first
    });
    const result = await createRssConnector().fetch({
      sourceId: 'itch_discovery',
      config: {
        endpointTemplates: [
          'https://itch.io/feed/a',
          'https://itch.io/feed/b',
          'https://itch.io/feed/c',
        ],
      },
      state: SAVED,
      effects: connectorEffects(fetchFn, {}),
    });
    expect({
      calls,
      denied: result.budgetDenied,
      retryAfterSeconds: result.retryAfterSeconds,
      requests: result.requestCount,
    }).toEqual({ calls: 2, denied: true, retryAfterSeconds: 7200, requests: 2 });
  });

  it('RSS: an HTTP-date bound survives a later denial; invalid/missing headers never erase it', async () => {
    await setBudget('itch_discovery', 3);
    const httpDate = new Date(NOW + 3_600_000).toUTCString();
    let calls = 0;
    const fetchFn = budgetedTransport('itch_discovery', async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { 'retry-after': httpDate } });
      }
      if (calls === 2) {
        return new Response(null, { status: 429, headers: { 'retry-after': 'soon' } }); // invalid
      }
      if (calls === 3) {
        return new Response(null, { status: 429 }); // missing
      }
      return new Response(null, { status: 200 }); // never reached — denied
    });
    const result = await createRssConnector().fetch({
      sourceId: 'itch_discovery',
      config: {
        endpointTemplates: [
          'https://itch.io/feed/a',
          'https://itch.io/feed/b',
          'https://itch.io/feed/c',
          'https://itch.io/feed/d',
        ],
      },
      state: SAVED,
      effects: connectorEffects(fetchFn, {}),
    });
    expect({ calls, denied: result.budgetDenied }).toEqual({ calls: 3, denied: true });
    expect(result.retryAfterSeconds).not.toBeNull();
    expect(result.retryAfterSeconds! * 1000).toBeGreaterThanOrEqual(3_540_000);
  });

  it('RSS: a ZERO bound stays a valid bound through denial (never null, never erased)', async () => {
    await setBudget('itch_discovery', 1); // feed 1 observes the bound, feed 2 is denied
    let calls = 0;
    const fetchFn = budgetedTransport('itch_discovery', async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response(null, { status: 200 }); // never reached — denied
    });
    const result = await createRssConnector().fetch({
      sourceId: 'itch_discovery',
      config: { endpointTemplates: ['https://itch.io/feed/a', 'https://itch.io/feed/b'] },
      state: SAVED,
      effects: connectorEffects(fetchFn, {}),
    });
    expect({ calls, denied: result.budgetDenied }).toEqual({ calls: 1, denied: true });
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('GitHub: an earlier 1800 s bound survives a later one-unit denial', async () => {
    await setBudget('playstation_blog', 1);
    let calls = 0;
    const fetchFn = budgetedTransport('playstation_blog', async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { 'retry-after': '1800' } });
      }
      return new Response(null, { status: 200 }); // never reached — denied
    });
    const result = await createGithubReleasesConnector().fetch({
      sourceId: 'playstation_blog',
      config: { repositories: ['owner/one', 'owner/two'], includePrereleases: false },
      state: SAVED,
      effects: connectorEffects(fetchFn, {}),
    });
    expect({
      calls,
      denied: result.budgetDenied,
      retryAfterSeconds: result.retryAfterSeconds,
      requests: result.requestCount,
    }).toEqual({ calls: 1, denied: true, retryAfterSeconds: 1800, requests: 1 });
  });

  it('REAL handler/D1: zero-bound denied window schedules EXACTLY at the budget-defer minimum; a raised quota refetches the whole window later', async () => {
    await enable('itch_discovery');
    await setBudget('itch_discovery', 1); // feed 1 observes the 0-bound, feed 2 is denied
    let rawCalls = 0;
    const handler = createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn: (async () => {
        rawCalls += 1;
        return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      }) as typeof fetch,
      idGenerator: { newId: () => 'r181-b3-1' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
    });
    const scheduledForMs = await alignWindow('itch_discovery', NOW);
    expect(
      await handler.execute({
        jobId: 'r181-b3-1',
        generation: 1,
        payload: { sourceId: 'itch_discovery', scheduledForMs },
      }),
    ).toEqual({ kind: 'success' });
    expect(rawCalls).toBe(1); // feed 1 observed (0-bound), feed 2 denied
    const deniedRow = await db.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id=?',
      params: ['itch_discovery'],
    });
    // max(budget defer 600 000, observed 0) = the budget defer, EXACTLY —
    // zero is honored as a real bound (not unknown) and never shortens it.
    expect(deniedRow?.next_poll_at).toBe(NOW + INGESTION_BUDGET_RETRY_MS);

    // Quota raised before the next poll: the deferred window refetches WHOLE
    // (both feeds this time) and completes normally at the scheduled window.
    await setBudget('itch_discovery', 50);
    const now2 = NOW + INGESTION_BUDGET_RETRY_MS;
    const scheduled2 = await alignWindow('itch_discovery', now2);
    let rawCalls2 = 0;
    const handler2 = createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn: (async () => {
        rawCalls2 += 1;
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>n</title><link>https://itch.io/x</link><guid>g1</guid></item></channel></rss>`,
          { status: 200, headers: { 'content-type': 'application/rss+xml' } },
        );
      }) as typeof fetch,
      idGenerator: { newId: () => 'r181-b3-2' },
      secrets: () => undefined,
      nowMs: () => now2,
      random: () => 0.5,
    });
    expect(
      await handler2.execute({
        jobId: 'r181-b3-2',
        generation: 1,
        payload: { sourceId: 'itch_discovery', scheduledForMs: scheduled2 },
      }),
    ).toEqual({ kind: 'success' });
    expect(rawCalls2).toBe(2); // BOTH deferred feeds refetched — nothing lost
    const finalRow = await db.first<{ last_error: string | null; next_poll_at: number }>({
      sql: 'SELECT last_error, next_poll_at FROM source_state WHERE source_id=?',
      params: ['itch_discovery'],
    });
    expect(finalRow?.last_error).toBeNull();
    expect(finalRow!.next_poll_at).toBeGreaterThan(now2);
  });
});

describe('Round 1.8.1 B4 — authority throws keep the poll observed-attempt total, separate from charges (REAL handler/D1)', () => {
  it('first TOP-LEVEL throw: retry outcome, observedRequests 0, no raw, no terminal state write', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 5);
    let rawCalls = 0;
    const logger = capturingLogger();
    // Make the FIRST authorization fail at the D1 boundary (infrastructure).
    const failingDb: DbExecutor = {
      ...db,
      batch: async () => {
        throw new Error('simulated D1 outage at first authorization');
      },
    };
    const failingHandler = createSourcePollHandler({
      executor: failingDb,
      connectors: createConnectorRegistry(),
      fetchFn: (async () => {
        rawCalls += 1;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      idGenerator: { newId: () => 'r181-b4-1b' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
      logger,
    });
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    expect(
      await failingHandler.execute({
        jobId: 'r181-b4-1',
        generation: 1,
        payload: { sourceId: 'playstation_blog', scheduledForMs },
      }),
    ).toEqual({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    expect(rawCalls).toBe(0);
    const warn = logger.lines.find(
      (line) => line.message === 'ingestion.poll.budget_authority_unavailable',
    );
    expect(warn?.fields['observedRequests']).toBe(0);
    expect(JSON.stringify(logger.lines)).not.toContain('simulated D1 outage');
    const stateRow = await db.first<{ last_error: string | null; cursor: string | null }>({
      sql: 'SELECT last_error, cursor FROM source_state WHERE source_id=?',
      params: ['playstation_blog'],
    });
    expect(stateRow?.last_error).toBeNull();
    expect(stateRow?.cursor).toBeNull();
  });

  it('prior completed sequences + redirect-hop throw: observedRequests aggregates prior (2) + failing (0) EXACTLY once', async () => {
    await enable('itch_discovery'); // two registry feeds
    await setBudget('itch_discovery', 5);
    let rawCalls = 0;
    let authorizations = 0;
    const logger = capturingLogger();
    const failingDb: DbExecutor = {
      ...db,
      batch: async (statements) => {
        authorizations += 1;
        // Feed 1 completes BOTH hops (302→200 = 2 raw, 2 charged). Feed 2's
        // authorization then hits the outage.
        if (authorizations === 3) {
          throw new Error('simulated D1 outage at feed 2');
        }
        return db.batch(statements);
      },
    };
    const handler = createSourcePollHandler({
      executor: failingDb,
      connectors: createConnectorRegistry(),
      fetchFn: (async () => {
        rawCalls += 1;
        return rawCalls === 1
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://itch.io/games/newest.xml' },
            })
          : new Response(
              `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`,
              { status: 200, headers: { 'content-type': 'application/rss+xml' } },
            );
      }) as typeof fetch,
      idGenerator: { newId: () => 'r181-b4-2' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
      logger,
    });
    const scheduledForMs = await alignWindow('itch_discovery', NOW);
    expect(
      await handler.execute({
        jobId: 'r181-b4-2',
        generation: 1,
        payload: { sourceId: 'itch_discovery', scheduledForMs },
      }),
    ).toEqual({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    expect(rawCalls).toBe(2); // feed 1's redirect hop + final hop
    const warn = logger.lines.find(
      (line) => line.message === 'ingestion.poll.budget_authority_unavailable',
    );
    expect(warn).toBeDefined();
    // SAFE OBSERVED total: feed 1's two raw attempts + feed 2's zero = 2,
    // aggregated exactly once (NOT 3, NOT 0).
    expect(warn?.fields['observedRequests']).toBe(2);
    expect(JSON.stringify(logger.lines)).not.toContain('simulated D1 outage'); // no raw text
    // NO terminal state write.
    const stateRow = await db.first<{ last_error: string | null }>({
      sql: 'SELECT last_error FROM source_state WHERE source_id=?',
      params: ['itch_discovery'],
    });
    expect(stateRow?.last_error).toBeNull();
  });

  it('charged-but-not-attempted gap: observed (0) is exposed SEPARATELY from the standing durable charge (1)', async () => {
    await enable('playstation_blog');
    await setBudget('playstation_blog', 5);
    let rawCalls = 0;
    const logger = capturingLogger();
    // The authorization SUCCEEDS in D1 (a real charge) and then the
    // authority infrastructure dies before returning the grant.
    const chargeThenDie: DbExecutor = {
      ...db,
      batch: async (statements) => {
        await db.batch(statements); // the unit is durably charged FIRST
        throw new Error('crash after the durable charge');
      },
    };
    const crashingHandler = createSourcePollHandler({
      executor: chargeThenDie,
      connectors: createConnectorRegistry(),
      fetchFn: (async () => {
        rawCalls += 1;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      idGenerator: { newId: () => 'r181-b4-3b' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
      logger,
    });
    const scheduledForMs = await alignWindow('playstation_blog', NOW);
    expect(
      await crashingHandler.execute({
        jobId: 'r181-b4-3',
        generation: 1,
        payload: { sourceId: 'playstation_blog', scheduledForMs },
      }),
    ).toEqual({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    expect(rawCalls).toBe(0);
    const warn = logger.lines.find(
      (line) => line.message === 'ingestion.poll.budget_authority_unavailable',
    );
    expect(warn?.fields['observedRequests']).toBe(0); // OBSERVED, not charged
    // The durable charge STANDS (conservative window) — deliberately
    // DIFFERENT from the observed total, proving neither is derived from
    // the other.
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });
});
