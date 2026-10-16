import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { createSteamNewsConnector } from '../../src/connectors/steam-news';
import {
  createSourcePollHandler,
  type SourcePollHandlerOptions,
} from '../../src/application/ingestion/poll-handler';
import {
  createJobsEngine,
  DEFAULT_ENGINE_BOUNDS,
  type JobsEngine,
} from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import {
  createFetchMock,
  createRawFetchMock,
  type QueuedResponse,
  connectorEffects,
} from '../helpers/fetch-mock';
import type {
  JobsQueueProducerPort,
  DlqProducerPort,
} from '../../src/adapters/queue/jobs-producer';
import type { QueueEnvelope } from '../../src/domain/jobs/envelope';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import { createSafeFetch } from '../../src/shared/http/safe-http';
import { INGESTION_POLL_HOLD_MS } from '../../src/shared/config/phase4';

/**
 * Round 1.7 (R04) — Steam bounded PERSISTENT CYCLIC ROTATION, production
 * path evidence on REAL local workerd D1:
 *
 * 1. Persistence proof: two polls through the REAL poll handler + existing
 *    commit store persist and reload the rotation cursor, visiting the tail.
 *    This harness reuses its handler/registry; separate manager evidence
 *    reconstructs fresh handler/registry/HTTP dependencies between polls.
 * 2. Real batch failure (primary-key collision raising inside the atomic
 *    items+state batch): the durable cursor does NOT advance; a later
 *    successful poll through the REAL handler recovers and rotates.
 * 3. Failure-path matrix over a scripted SafeFetchExecutor fake (clearly
 *    labeled — NOT raw HTTP): early and later transport/HTTP/JSON failures
 *    and 429 preserve the selected window's cursor; a subsequent
 *    successful retry revisits the same window and then rotates; observed
 *    requestCount and Retry-After semantics are preserved.
 * 4. TRUE transport-port test: scripted RAW `typeof fetch` → REAL
 *    `createSafeFetch` → Steam connector across TWO cursor windows,
 *    asserting the pinned official host/endpoint, bounded call count and
 *    exact configured app IDs.
 *
 * Deterministic fixtures only; no real provider requests (AGENTS.md §4).
 * R09's known concurrency/ownership gap is NOT fixed or hidden here:
 * sequential rotation assumes the existing single-owner poll window.
 */

const NOW = 1_770_000_000_000;
const SOURCE_ID = 'steam_news_watchlist';

const db: DbExecutor = createDbExecutor(env.DB);

const newsBody = (appid: number, gid: string): string =>
  JSON.stringify({
    appnews: {
      appid,
      newsitems: [
        {
          gid,
          title: `Patch notes ${appid}`,
          url: `https://store.steampowered.com/news/app/${appid}/view/${gid}`,
          contents: 'Fixed several issues.',
          date: 1_769_000_000,
        },
      ],
    },
  });

const emptyBody = (appid: number): string => JSON.stringify({ appnews: { appid, newsitems: [] } });

const okJson = (body: string): QueuedResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyText: body,
});

interface EngineHarness {
  readonly clock: MutableClock;
  // Round 1.8 (R10) fixture adaptation — SETUP ONLY: the handler builds its
  // own budgeted ingestion transport from the RAW transport, so this
  // handler-level harness records raw calls via `createRawFetchMock()`
  // (same queued response shape). No assertion, label, or test body changed.
  readonly mock: ReturnType<typeof createRawFetchMock>;
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  /** Delivered queue envelopes in order (for direct consumeMessage use). */
  readonly sentEnvelopes: QueueEnvelope[];
  /** Drain only envelopes delivered after the last drain (unique ids). */
  readonly drain: () => Promise<number>;
  /** Force a FIXED item id for the next polls (batch-failure injection). */
  readonly setFixedItemId: (fixed: string | null) => void;
}

/**
 * FULL production pipeline harness on real D1 (scheduler → durable job →
 * queue envelope → engine → REAL poll handler → scripted source HTTP →
 * atomic commit). The harness constructs its connector/handler
 * dependencies only when createEngineHarness() is called, not each schedule.
 */
function createEngineHarness(startMs: number): EngineHarness {
  const clock = fixedClock(startMs);
  const executor = createDbExecutor(env.DB, { clock });
  const mock = createRawFetchMock();

  const fixedItemId = { value: null as string | null };
  const handlerOptions: SourcePollHandlerOptions = {
    executor,
    connectors: createConnectorRegistry(),
    fetchFn: mock.fetchFn,
    idGenerator: {
      newId: () => fixedItemId.value ?? `item-${Math.random().toString(36).slice(2, 10)}`,
    },
    secrets: () => undefined, // identical semantics: the old bundle carried no secrets
    nowMs: () => clock.now(),
    random: () => 0.5,
  };

  const sentEnvelopes: QueueEnvelope[] = [];
  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      sentEnvelopes.push(envelope);
    },
  };
  const dlqProducer: DlqProducerPort = { send: async () => {} };

  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([createSourcePollHandler(handlerOptions) as never]),
      idGenerator: {
        newId: () => `job-${sentEnvelopes.length}-${Math.random().toString(36).slice(2, 8)}`,
      },
      clock,
      random: () => 0.5,
      jobsProducer,
      dlqProducer,
    },
    DEFAULT_ENGINE_BOUNDS,
  );

  let consumed = 0;
  const drain = async (): Promise<number> => {
    const dispatch = await engine.dispatchDueJobs();
    let drained = 0;
    while (consumed < sentEnvelopes.length) {
      const envelope = sentEnvelopes[consumed]!;
      const action = await engine.consumeMessage(`msg-round17-${consumed}`, envelope);
      expect(action.action).toBe('ack');
      consumed += 1;
      drained += 1;
    }
    expect(dispatch.dispatched).toBe(drained);
    return drained;
  };

  return {
    clock,
    mock,
    engine,
    executor,
    sentEnvelopes,
    drain,
    setFixedItemId: (fixed: string | null) => {
      fixedItemId.value = fixed;
    },
  };
}

async function schedule(harness: EngineHarness): Promise<number> {
  const outcome = await scheduleDueSources({
    executor: harness.executor,
    engine: harness.engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: harness.clock.now(),
  });
  if (outcome.kind !== 'scheduled') throw new Error('expected scheduled');
  return outcome.jobsCreated;
}

const cursorOf = async (executor: DbExecutor): Promise<string | null> => {
  const row = await executor.first<{ cursor: string | null }>({
    sql: 'SELECT cursor FROM source_state WHERE source_id = ?',
    params: [SOURCE_ID],
  });
  return row?.cursor ?? null;
};

const itemCount = async (executor: DbExecutor): Promise<number> => {
  const row = await executor.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: [SOURCE_ID],
  });
  return row?.n ?? -1;
};

async function provisionSteam(
  executor: DbExecutor,
  apps: number[],
  appsPerBatch = 2,
): Promise<void> {
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) throw new Error('registry invalid');
  await seedSourcesFromRegistry(executor, registry.registry, NOW);
  await executor.run({ sql: 'UPDATE sources SET enabled = 1 WHERE id = ?', params: [SOURCE_ID] });
  await executor.run({
    sql: `UPDATE sources SET config_json = json_set(config_json,
            '$.apps', json('${JSON.stringify(apps)}'),
            '$.appsPerBatch', json('${appsPerBatch}')) WHERE id = ?`,
    params: [SOURCE_ID],
  });
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
});

describe('R04 persistence proof — real workerd D1 through the REAL poll handler', () => {
  it('first successful poll persists the cursor; the real handler reloads it and visits the tail', async () => {
    const h = createEngineHarness(NOW);
    await provisionSteam(h.executor, [570, 440, 730], 2);
    h.mock.setResponses([okJson(emptyBody(570)), okJson(emptyBody(440))]);

    // Poll 1: full production path — scheduler → durable job → engine →
    // REAL poll handler → atomic items/state commit.
    expect(await schedule(h)).toBe(1);
    expect(await h.drain()).toBe(1);
    expect(h.mock.calls.map((c) => new URL(c.url).searchParams.get('appid'))).toEqual([
      '570',
      '440',
    ]);

    const cursor1 = await cursorOf(h.executor);
    expect(cursor1).not.toBeNull();
    const parsed1 = JSON.parse(cursor1!) as { v: number; n: number; start: number; fp: string };
    expect(parsed1).toMatchObject({ v: 1, n: 3, start: 2 });

    // Poll 2: the same real handler/registry reload the DURABLE cursor
    // and visit the tail. Fresh reconstruction is covered separately by
    // Posidon's independent acceptance evidence, outside this suite.
    h.clock.advance(601_000); // past the 600s poll interval + hold
    h.mock.setResponses([okJson(emptyBody(730)), okJson(emptyBody(570))]);
    expect(await schedule(h)).toBe(1);
    expect(await h.drain()).toBe(1);
    expect(h.mock.calls.slice(2).map((c) => new URL(c.url).searchParams.get('appid'))).toEqual([
      '730',
      '570',
    ]);
    const parsed2 = JSON.parse((await cursorOf(h.executor))!) as { start: number };
    expect(parsed2.start).toBe((2 + 2) % 3); // (start + selectedCount) mod length
  });

  it('failed D1 batch (PK collision inside the atomic commit) does NOT advance the durable cursor; the REAL handler recovers', async () => {
    const h = createEngineHarness(NOW);
    await provisionSteam(h.executor, [570, 440, 730], 2);

    // Poll 1 succeeds and persists cursor C1 (window [570,440]).
    h.mock.setResponses([okJson(newsBody(570, 'gid-a')), okJson(newsBody(440, 'gid-b'))]);
    expect(await schedule(h)).toBe(1);
    expect(await h.drain()).toBe(1);
    const cursor1 = await cursorOf(h.executor);
    expect(cursor1).not.toBeNull();
    const itemsAfterPoll1 = await itemCount(h.executor);
    expect(itemsAfterPoll1).toBe(2);

    // Prime the collision: an UNRELATED existing row owns the id the
    // handler's deterministic generator will emit. The two targeted
    // business-key conflict clauses do NOT absorb it (different source and
    // external id), so the insert RAISES inside the atomic batch —
    // exactly the R02 no-ignite guarantee under a real workerd D1 batch.
    await h.executor.run({
      sql: `INSERT INTO source_items
              (id, source_id, external_id, title, fetched_at, content_hash, raw_json)
            VALUES ('collision-id', 'playstation_blog', 'unrelated-external', 'unrelated', ?, 'hash', '{}')`,
      params: [NOW],
    });

    // Poll 2 through the FULL production path with a colliding id
    // generator: the whole atomic batch (items AND fenced state) aborts.
    h.setFixedItemId('collision-id');
    h.clock.advance(601_000);
    h.mock.setResponses([okJson(newsBody(730, 'gid-c')), okJson(newsBody(570, 'gid-d'))]);
    expect(await schedule(h)).toBe(1);
    const dispatch = await h.engine.dispatchDueJobs();
    expect(dispatch.dispatched).toBe(1);
    const envelope = h.sentEnvelopes[1]!;
    const action = await h.engine.consumeMessage('msg-round17-batch-failure', envelope);
    // The handler's commit raised inside the atomic batch → the engine
    // durably reschedules it as a transient internal error; the deliverer
    // acks the message because the retry is durable in the jobs table.
    expect(action).toMatchObject({ action: 'ack', outcome: 'retry_scheduled' });
    h.setFixedItemId(null);

    // The durable cursor is UNCHANGED (C1), the aborted batch's items are
    // gone, and the fenced poll window is untouched.
    expect(await cursorOf(h.executor)).toBe(cursor1);
    expect(await itemCount(h.executor)).toBe(itemsAfterPoll1);

    // Recovery: remove the conflicting row, then run the REAL poll handler
    // again with the SAME durable due marker (next_poll_at survived the
    // rollback, so the fenced window is still exactly the scheduler's).
    await h.executor.run({ sql: "DELETE FROM source_items WHERE id = 'collision-id'" });
    const stateAfterAbort = await h.executor.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id = ?',
      params: [SOURCE_ID],
    });
    const dueMarker = stateAfterAbort!.next_poll_at - INGESTION_POLL_HOLD_MS;
    h.mock.setResponses([okJson(newsBody(730, 'gid-e')), okJson(newsBody(570, 'gid-f'))]);
    const recoveryHandler = createSourcePollHandler({
      executor: h.executor,
      connectors: createConnectorRegistry(),
      fetchFn: h.mock.fetchFn,
      idGenerator: { newId: () => `recovery-${Math.random().toString(36).slice(2, 8)}` },
      secrets: () => undefined,
      nowMs: () => h.clock.now(),
      random: () => 0.5,
    });
    const outcome = await recoveryHandler.execute({
      jobId: 'round17-recovery',
      generation: 1,
      payload: { sourceId: SOURCE_ID, scheduledForMs: dueMarker },
    });
    expect(outcome).toMatchObject({ kind: 'success' });

    // The SAME window ([730,570]) was retried successfully and ONLY NOW
    // advanced the durable cursor.
    expect(h.mock.calls.slice(4).map((c) => new URL(c.url).searchParams.get('appid'))).toEqual([
      '730',
      '570',
    ]);
    const cursor3 = await cursorOf(h.executor);
    expect(cursor3).not.toBeNull();
    expect(cursor3).not.toBe(cursor1);
    expect(JSON.parse(cursor3!)['start']).toBe((2 + 2) % 3);
    expect(await itemCount(h.executor)).toBe(itemsAfterPoll1 + 2);
  });

  it('budget-exhausted polls keep the cursor exactly as persisted (nothing invented, nothing wiped)', async () => {
    const h = createEngineHarness(NOW);
    await provisionSteam(h.executor, [570, 440, 730], 2);
    // Exhaust the source's daily budget BEFORE scheduling: the handler's
    // budget-exhausted terminal path must preserve the (null) cursor.
    await h.executor.run({
      sql: 'UPDATE sources SET daily_request_budget = 0 WHERE id = ?',
      params: [SOURCE_ID],
    });
    h.mock.setResponses([]);
    expect(await schedule(h)).toBe(1);
    expect(await h.drain()).toBe(1);
    expect(h.mock.calls).toHaveLength(0); // no network on budget exhaustion
    expect(await cursorOf(h.executor)).toBeNull();
  });
});

describe('R04 failure-path matrix (scripted SafeFetchExecutor fake — NOT raw HTTP)', () => {
  const CONFIG = { appsPerBatch: 2, maxItemsPerApp: 3, apps: [570, 440, 730] };

  async function pollOnce(
    cursor: string | null,
    responses: readonly QueuedResponse[],
  ): Promise<{
    status: string;
    failureReason: string | null;
    cursor: string | null;
    requestCount: number;
    retryAfterSeconds: number | null;
    appids: string[];
  }> {
    const mock = createFetchMock([...responses]);
    const result = await createSteamNewsConnector().fetch({
      sourceId: SOURCE_ID,
      config: CONFIG,
      state: { etag: null, lastModified: null, cursor },
      effects: connectorEffects(mock.fetchFn, {}),
    });
    return {
      status: result.status,
      failureReason: result.failureReason,
      cursor: result.cursor,
      requestCount: result.requestCount,
      retryAfterSeconds: result.retryAfterSeconds,
      appids: mock.calls.map((c) => new URL(c.url).searchParams.get('appid') ?? ''),
    };
  }

  it('EARLY transport failure preserves the window cursor (never null) and truthful requestCount', async () => {
    // A non-null durable cursor selects window [730,570]; the FIRST
    // request dies at the transport layer.
    const seedPoll = await pollOnce(null, [okJson(emptyBody(570)), okJson(emptyBody(440))]);
    const windowCursor = seedPoll.cursor;
    expect(windowCursor).not.toBeNull();
    const early = await pollOnce(windowCursor, [
      { failReason: 'network_error' },
      okJson(emptyBody(570)),
    ]);
    expect(early.status).toBe('failed');
    expect(early.failureReason).toBe('http_status_error');
    expect(early.appids).toEqual(['730']); // only the first request attempted
    expect(early.requestCount).toBe(1); // truthful
    expect(early.cursor).toBe(windowCursor); // SAME window preserved, never null
  });

  it('LATER HTTP failure preserves the window cursor, counts both requests, and a successful retry rotates', async () => {
    const later = await pollOnce(null, [okJson(emptyBody(570)), { status: 503 }]);
    expect(later.status).toBe('failed');
    expect(later.appids).toEqual(['570', '440']);
    expect(later.requestCount).toBe(2);
    expect(later.cursor).not.toBeNull();
    // The preserved cursor restarts the SAME window on retry…
    const retry = await pollOnce(later.cursor, [okJson(emptyBody(570)), okJson(emptyBody(440))]);
    expect(retry.appids).toEqual(['570', '440']);
    expect(retry.status).toBe('changed');
    // …and the successful retry rotates to the NEXT window.
    const after = await pollOnce(retry.cursor, [okJson(emptyBody(730)), okJson(emptyBody(570))]);
    expect(after.appids).toEqual(['730', '570']);
  });

  it('malformed JSON and unexpected content type preserve the window cursor', async () => {
    const malformed = await pollOnce(null, [
      okJson(emptyBody(570)),
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{not json' },
    ]);
    expect(malformed.status).toBe('failed');
    expect(malformed.requestCount).toBe(2);
    expect(malformed.cursor).not.toBeNull();

    const wrongType = await pollOnce(null, [
      okJson(emptyBody(570)),
      { status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html/>' },
    ]);
    expect(wrongType.status).toBe('failed');
    expect(wrongType.cursor).not.toBeNull();
  });

  it('429 preserves the window cursor, parses Retry-After, and a later success rotates', async () => {
    const limited = await pollOnce(null, [
      okJson(emptyBody(570)),
      { status: 429, headers: { 'retry-after': '60' } },
    ]);
    expect(limited.status).toBe('rate_limited');
    expect(limited.retryAfterSeconds).toBe(60);
    expect(limited.requestCount).toBe(2);
    expect(limited.cursor).not.toBeNull();

    // Same window retried after the rate limit…
    const retry = await pollOnce(limited.cursor, [okJson(emptyBody(570)), okJson(emptyBody(440))]);
    expect(retry.status).toBe('changed');
    expect(retry.appids).toEqual(['570', '440']);
    // …then normal rotation continues.
    const after = await pollOnce(retry.cursor, [okJson(emptyBody(730)), okJson(emptyBody(570))]);
    expect(after.appids).toEqual(['730', '570']);
  });

  it('EARLY 429 on the first request also preserves the window cursor', async () => {
    const seedPoll = await pollOnce(null, [okJson(emptyBody(570)), okJson(emptyBody(440))]);
    const limited = await pollOnce(seedPoll.cursor, [
      { status: 429, headers: { 'retry-after': '120' } },
    ]);
    expect(limited.status).toBe('rate_limited');
    expect(limited.retryAfterSeconds).toBe(120);
    expect(limited.requestCount).toBe(1);
    expect(limited.cursor).toBe(seedPoll.cursor);
  });
});

describe('R04 true transport-port test — RAW typeof fetch → REAL createSafeFetch → connector', () => {
  it('two cursor windows over the REAL SafeFetch port: pinned host/endpoint, bounded calls, exact configured app IDs', async () => {
    await provisionSteam(db, [570, 440, 730], 2);
    const config = JSON.parse(
      (await db.first<{ config_json: string }>({
        sql: 'SELECT config_json FROM sources WHERE id = ?',
        params: [SOURCE_ID],
      }))!.config_json,
    ) as Record<string, unknown>;

    // Scripted RAW fetch (typeof fetch) feeding the PRODUCTION
    // createSafeFetch — no test double in between.
    const rawCalls: { url: string; method: string }[] = [];
    const queue: { status: number; body: string }[] = [];
    const rawFetch: typeof fetch = async (input, init) => {
      rawCalls.push({ url: String(input), method: init?.method ?? 'GET' });
      const next = queue.shift();
      if (next === undefined) {
        return new Response(null, { status: 500 });
      }
      return new Response(next.body, {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    };

    // Window 1: null cursor → [570,440].
    queue.push({ status: 200, body: newsBody(570, 'gid-w1a') });
    queue.push({ status: 200, body: newsBody(440, 'gid-w1b') });
    const first = await createSteamNewsConnector().fetch({
      sourceId: SOURCE_ID,
      config,
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(createSafeFetch(rawFetch), {}),
    });
    expect(first.status).toBe('changed');
    expect(first.cursor).not.toBeNull();

    // Window 2: fresh connector instance, returned cursor → [730,570].
    // This port-only test does not persist it to D1.
    queue.push({ status: 200, body: newsBody(730, 'gid-w2a') });
    queue.push({ status: 200, body: newsBody(570, 'gid-w2b') });
    const second = await createSteamNewsConnector().fetch({
      sourceId: SOURCE_ID,
      config,
      state: { etag: null, lastModified: null, cursor: first.cursor },
      effects: connectorEffects(createSafeFetch(rawFetch), {}),
    });
    expect(second.status).toBe('changed');
    expect(second.cursor).not.toBeNull();
    expect(second.cursor).not.toBe(first.cursor);

    // Bounded call count: exactly one raw request per configured entry.
    expect(rawCalls).toHaveLength(4);
    // Pinned official host + endpoint on EVERY raw call, exact configured
    // app IDs in cyclic order, official parameters.
    const appids = rawCalls.map((c) => new URL(c.url).searchParams.get('appid'));
    expect(appids).toEqual(['570', '440', '730', '570']);
    for (const call of rawCalls) {
      const url = new URL(call.url);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('api.steampowered.com');
      expect(url.pathname).toBe('/ISteamNews/GetNewsForApp/v2/');
      expect(url.searchParams.get('count')).toBe('3');
      expect(url.searchParams.get('format')).toBe('json');
      expect(call.method).toBe('GET');
    }
    // Aggregate request counting stays truthful across both windows.
    expect(first.requestCount).toBe(2);
    expect(second.requestCount).toBe(2);
  });
});
