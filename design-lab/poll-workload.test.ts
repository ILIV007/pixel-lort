/**
 * R1.10.3 DESIGN LAB — Phase 4.3 STEP 2 poll-pipeline WORKLOAD harness
 * (REAL workerd D1).
 *
 * DESIGN-LAB evidence — NOT accepted product source, NOT product tests.
 *
 * Unlike the cost ledger (which replays the accepted per-poll statement
 * sequence stage by stage), THIS harness drives the REAL end-to-end poll
 * pipeline exactly as wired in production:
 *
 *   scheduler (scheduleDueSources: capability + completeness probe +
 *     due scan + atomic owned scheduling)
 *   -> durable job -> dispatch (engine.dispatchDueJobs -> producer
 *     envelope)
 *   -> engine claim (read + CAS)
 *   -> authorization per hop (authorizeIngestionUnit inside the handler's
 *     mandatory budgeted ingestion transport)
 *   -> network fake (scripted raw fetch: 200 / 304 / redirect / 500)
 *   -> classification + normalize (REAL RSS connector)
 *   -> commit (accepted ownership-fenced per-item batch + fenced state)
 *   -> job terminal.
 *
 * Measured workloads (guide §6 / 4.3): 304 conditional GET, redirect,
 * failure, 1-item, 100-item (connector cap), max-rows × max-bytes shape,
 * multi-source batch + overlapping-scheduler concurrency.
 *
 * UNITS (audit-tools/trace/d1-instrument.ts v3 vocabulary, unchanged):
 *   - executionApiCallAttempts ("xAPI") = terminal executions + batch()
 *     calls — ONE per execution-API call regardless of carried statements;
 *   - statementsAttempted = terminal executions + statements submitted
 *     into batches;
 *   - rows: the local engine's own meta rows_written estimates WHEN the
 *     metadata is available; unavailable metadata is LABELED, never
 *     zero-filled.
 * The mapping to the documented Free-plan "Queries per Worker invocation
 * = 50" row is a SEPARATE documented question (both interpretations are
 * carried in free-plan/ documents) — no cloud quota conclusion is drawn
 * here.
 *
 * HONESTY LABELS (mandatory): LOCAL workerd proxy measurements on a
 * disposable SQLite-backed D1. NO cloud quota enforcement, NO CPU
 * evidence — `wallMsLocal` is LOCAL WALL TIME and is NOT cloud CPU; the
 * multi-source scenario consumes envelopes SEQUENTIALLY in one workerd
 * invocation and is NOT a claim about cloud-side concurrency. Free
 * readiness stays NOT_READY until owner/Posidon end-to-end evidence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, MIGRATIONS } from '../tests/helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../src/adapters/db/db-executor';
import {
  createJobsEngine,
  DEFAULT_ENGINE_BOUNDS,
  type JobsEngine,
} from '../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../src/domain/jobs/handler';
import { createMaintenanceHeartbeatHandler } from '../src/application/jobs/handlers/maintenance-heartbeat';
import {
  createSourcePollHandler,
  type SourcePollHandlerOptions,
} from '../src/application/ingestion/poll-handler';
import { scheduleDueSources } from '../src/application/ingestion/scheduler';
import { createConnectorRegistry } from '../src/connectors/registry';
import type { JobsQueueProducerPort, DlqProducerPort } from '../src/adapters/queue/jobs-producer';
import type { QueueEnvelope } from '../src/domain/jobs/envelope';
import { fixedClock, type MutableClock } from '../src/shared/time/clock';
import { createRawFetchMock } from '../tests/helpers/fetch-mock';
import { parseEmbeddedRegistry } from '../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../src/adapters/db/source-registry-store';
import {
  createD1Stats,
  deriveCounts,
  instrumentD1,
  resetStats,
  snapshot,
  type D1Stats,
} from '../audit-tools/trace/d1-instrument';
import { labLog } from './lab-log';

const NOW = 1_770_000_000_000;

/** All seven RSS registry entries (the only implemented connector here). */
const RSS_SOURCES = [
  'playstation_blog',
  'xbox_wire',
  'ign_games',
  'eurogamer_news',
  'moddb_news',
  'moddb_headlines',
  'itch_discovery',
] as const;

/* ------------------------------------------------------------------ */
/* Feed fixtures                                                       */
/* ------------------------------------------------------------------ */

interface FeedItemShape {
  readonly link: string;
  readonly title: string;
  readonly bodyText: string;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function rssFeed(items: readonly FeedItemShape[], etag: string): string {
  const entries = items
    .map(
      (item, i) => `  <item>
    <title>${xmlEscape(item.title)}</title>
    <link>${xmlEscape(item.link)}</link>
    <guid isPermaLink="false">wl-${etag}-${i}</guid>
    <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
    <description><![CDATA[${item.bodyText}]]></description>
  </item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>workload feed</title>
${entries}
</channel></rss>`;
}

/** Normal shape: short fields (the everyday RSS envelope). */
function normalItems(n: number, tag: string): FeedItemShape[] {
  return Array.from({ length: n }, (_, i) => ({
    link: `https://workload.example/${tag}/article-${i}`,
    title: `Workload title ${i}`,
    bodyText: `Workload excerpt ${i}`,
  }));
}

/**
 * Max documented per-item shape through the REAL connector: canonical URL
 * at the ≈2 KiB documented assumption (2010-char ASCII path), title at the
 * 512-char cap, excerpt at the 512-char cap. rawJson derives from the raw
 * fields (bounded by the documented caps) — no fixture bypasses the
 * normalizer.
 */
function maxItems(n: number, tag: string): FeedItemShape[] {
  return Array.from({ length: n }, (_, i) => ({
    link: `https://workload.example/${'p'.repeat(2010)}/${tag}-${i}`,
    title: 't'.repeat(511) + String(i % 10),
    bodyText: 'e'.repeat(512),
  }));
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface WorkloadHarness {
  readonly executor: DbExecutor;
  readonly engine: JobsEngine;
  readonly clock: MutableClock;
  readonly mock: ReturnType<typeof createRawFetchMock>;
  readonly handlerOptions: SourcePollHandlerOptions;
}

let idCounter = 0;

function createWorkloadHarness(): WorkloadHarness {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(wrapped as D1Database, { clock });
  const mock = createRawFetchMock();

  const handlerOptions: SourcePollHandlerOptions = {
    executor,
    connectors: createConnectorRegistry(),
    fetchFn: mock.fetchFn,
    idGenerator: {
      newId: () => `wl-item-${(idCounter += 1)}`,
    },
    secrets: () => undefined,
    nowMs: () => clock.now(),
    random: () => 0.5, // exact jitter center: deterministic schedules
  };

  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      pendingEnvelopes.push(envelope);
    },
  };
  const dlqProducer: DlqProducerPort = {
    send: async () => {},
  };

  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createMaintenanceHeartbeatHandler({ executor, nowMs: () => clock.now() }) as never,
        createSourcePollHandler(handlerOptions) as never,
      ]),
      idGenerator: {
        newId: () => `wl-job-${(idCounter += 1)}`,
      },
      clock,
      random: () => 0.5,
      jobsProducer,
      dlqProducer,
    },
    DEFAULT_ENGINE_BOUNDS,
  );

  return { executor, engine, clock, mock, handlerOptions };
}

let stats: D1Stats;
let wrapped: D1Database;

async function seedAndEnable(executor: DbExecutor, ids: readonly string[]): Promise<void> {
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) throw new Error('registry invalid');
  await seedSourcesFromRegistry(executor, registry.registry, NOW);
  for (const id of ids) {
    await executor.run({ sql: 'UPDATE sources SET enabled = 1 WHERE id = ?', params: [id] });
  }
}

async function itemCount(executor: DbExecutor, sourceId: string): Promise<number> {
  const row = await executor.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: [sourceId],
  });
  return row?.n ?? 0;
}

interface SourceStateRow {
  readonly next_poll_at: number;
  readonly etag: string | null;
  readonly cursor: string | null;
  readonly consecutive_failures: number;
  readonly last_error: string | null;
  readonly requests_today: number;
}

async function sourceState(executor: DbExecutor, sourceId: string): Promise<SourceStateRow | null> {
  return executor.first<SourceStateRow>({
    sql: `SELECT next_poll_at, etag, cursor, consecutive_failures, last_error, requests_today
            FROM source_state WHERE source_id = ?`,
    params: [sourceId],
  });
}

/* ------------------------------------------------------------------ */
/* Measured cycle                                                      */
/* ------------------------------------------------------------------ */

interface StageMeasure {
  readonly api: number;
  readonly stmt: number;
}

interface WorkloadRow {
  readonly id: string;
  readonly scenario: string;
  readonly sources: number;
  readonly itemsCommitted: number;
  readonly rawHttpRequests: number;
  readonly schedule: StageMeasure;
  readonly dispatch: StageMeasure;
  readonly consume: StageMeasure;
  readonly executionApiCallAttempts: number;
  readonly statementsAttempted: number;
  readonly statementsCompleted: number;
  readonly statementsNotConfirmedCompleted: number;
  readonly metaRowsWrittenDelta: number;
  readonly metaRowsWrittenPresenceDelta: number;
  readonly metaRecordsUnavailableDelta: number;
  readonly wallMsLocal: number;
  readonly units: string;
  readonly honesty: string;
  readonly outcome: Record<string, unknown>;
}

interface CycleOptions {
  /** Consume all dispatched envelopes (default true). */
  readonly consume?: boolean;
  /** A SECOND scheduler pass BEFORE dispatch/consume (overlapping cron). */
  readonly overlappingSecondPass?: boolean;
}

interface CycleResult {
  readonly row: Omit<WorkloadRow, 'id' | 'scenario' | 'itemsCommitted'>;
  readonly envelopes: QueueEnvelope[];
  readonly schedule: Extract<Awaited<ReturnType<typeof scheduleDueSources>>, { kind: 'scheduled' }>;
  readonly secondPass?: Extract<
    Awaited<ReturnType<typeof scheduleDueSources>>,
    { kind: 'scheduled' }
  >;
}

function stageDelta(before: Readonly<D1Stats>): StageMeasure {
  const after = deriveCounts(stats);
  const prev = deriveCounts(before as D1Stats);
  return {
    api: after.executionApiCallAttempts - prev.executionApiCallAttempts,
    stmt: after.statementsAttempted - prev.statementsAttempted,
  };
}

function metaDelta(before: Readonly<D1Stats>): {
  rowsWritten: number;
  rowsWrittenPresence: number;
  unavailable: number;
} {
  const prev = before as D1Stats;
  return {
    rowsWritten: stats.metaAggregates.sums.rowsWritten - prev.metaAggregates.sums.rowsWritten,
    rowsWrittenPresence:
      stats.metaAggregates.presence.rowsWritten - prev.metaAggregates.presence.rowsWritten,
    unavailable: stats.metaAggregates.unavailableTotal - prev.metaAggregates.unavailableTotal,
  };
}

async function runMeasuredCycle(h: WorkloadHarness, opts: CycleOptions = {}): Promise<CycleResult> {
  resetStats(stats);
  const t0 = Date.now();

  const snapSchedule = snapshot(stats);
  const schedule = await scheduleDueSources({
    executor: h.executor,
    engine: h.engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: h.clock.now(),
  });
  const scheduleMeasure = stageDelta(snapSchedule);
  if (schedule.kind !== 'scheduled') {
    throw new Error(`scheduler pass failed: ${schedule.kind}`);
  }

  let secondPass: CycleResult['secondPass'];
  if (opts.overlappingSecondPass === true) {
    const second = await scheduleDueSources({
      executor: h.executor,
      engine: h.engine,
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: h.clock.now(),
    });
    if (second.kind !== 'scheduled') {
      throw new Error(`overlapping scheduler pass failed: ${second.kind}`);
    }
    secondPass = second;
  }

  const snapDispatch = snapshot(stats);
  await h.engine.dispatchDueJobs();
  const dispatchMeasure = stageDelta(snapDispatch);

  const snapConsume = snapshot(stats);
  const envelopes: QueueEnvelope[] = pendingEnvelopes.splice(0);
  if (opts.consume !== false) {
    for (let i = 0; i < envelopes.length; i += 1) {
      await h.engine.consumeMessage(`wl-msg-${i}`, envelopes[i] as QueueEnvelope);
    }
  }
  const consumeMeasure = stageDelta(snapConsume);
  const meta = metaDelta(snapConsume);
  const wallMs = Date.now() - t0;

  const total = deriveCounts(stats);
  const rawHttpRequests = h.mock.calls.length - rawCallsSeen;
  rawCallsSeen = h.mock.calls.length;

  return {
    row: {
      schedule: scheduleMeasure,
      dispatch: dispatchMeasure,
      consume: consumeMeasure,
      executionApiCallAttempts: total.executionApiCallAttempts,
      statementsAttempted: total.statementsAttempted,
      statementsCompleted: total.statementsCompleted,
      statementsNotConfirmedCompleted: total.statementsNotConfirmedCompleted,
      metaRowsWrittenDelta: meta.rowsWritten,
      metaRowsWrittenPresenceDelta: meta.rowsWrittenPresence,
      metaRecordsUnavailableDelta: meta.unavailable,
      wallMsLocal: wallMs,
      rawHttpRequests,
      units:
        'xAPI = execution-API call attempts (terminal + batch, v3 instrument); STMT = statements attempted; rows = LOCAL meta rows_written deltas WHEN available (unavailable = labeled, never zero-filled)',
      honesty:
        'DESIGN-LAB, LOCAL workerd proxy only; wallMsLocal is LOCAL WALL TIME, NOT cloud CPU; sequential envelope consumption is NOT cloud concurrency evidence; no cloud quota/billing conclusion',
      outcome: {},
    },
    envelopes,
    schedule,
    secondPass,
  };
}

const pendingEnvelopes: QueueEnvelope[] = [];
let rawCallsSeen = 0;

function emitWorkload(row: WorkloadRow): void {
  labLog('LABWORKLOAD[' + JSON.stringify(row) + ']');
}

/* ------------------------------------------------------------------ */
/* Migrations + reset                                                  */
/* ------------------------------------------------------------------ */

beforeEach(async () => {
  await applyMigrations(env.DB, MIGRATIONS);
  await wrappedReset();
  stats = createD1Stats();
  wrapped = instrumentD1(env.DB as D1Database, stats);
  pendingEnvelopes.length = 0;
  rawCallsSeen = 0;
});

async function wrappedReset(): Promise<void> {
  for (const t of ['source_items', 'source_state', 'sources', 'jobs']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare(`DELETE FROM budgets WHERE scope = 'ingestion'`).run();
}

/* ------------------------------------------------------------------ */
/* Workload scenarios                                                  */
/* ------------------------------------------------------------------ */

describe('R1.10.3 design lab Phase 4.3 step 2 — REAL poll pipeline workload (real workerd D1)', () => {
  it('W-01 single source, 1 new item, 1 hop (changed)', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    h.mock.setResponses([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"wl-1"' },
        bodyText: rssFeed(normalItems(1, 'w01'), '1'),
      },
    ]);

    const cycle = await runMeasuredCycle(h);
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);
    const state = await sourceState(h.executor, RSS_SOURCES[0]);

    expect(cycle.schedule.jobsCreated).toBe(1);
    expect(cycle.envelopes).toHaveLength(1);
    expect(inserted).toBe(1);
    expect(state).not.toBeNull();
    expect(state?.consecutive_failures).toBe(0);
    // Success schedules strictly past the poll moment (interval + jitter).
    expect(state ? state.next_poll_at : 0).toBeGreaterThan(NOW);

    emitWorkload({
      ...cycle.row,
      id: 'W-01',
      scenario:
        'single source, 1 new item, 1 hop, changed (scheduler->claim->authorize->fetch->commit)',
      sources: 1,
      itemsCommitted: inserted,
      outcome: {
        jobsCreated: cycle.schedule.jobsCreated,
        envelopes: cycle.envelopes.length,
        nextPollAt: state?.next_poll_at ?? null,
        consecutiveFailures: state?.consecutive_failures ?? null,
      },
    });
  });

  it('W-02 single source, 100 new items (connector cap), 1 hop', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    h.mock.setResponses([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"wl-2"' },
        bodyText: rssFeed(normalItems(100, 'w02'), '2'),
      },
    ]);

    const cycle = await runMeasuredCycle(h);
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);

    expect(cycle.schedule.jobsCreated).toBe(1);
    expect(inserted).toBe(100);

    emitWorkload({
      ...cycle.row,
      id: 'W-02',
      scenario: 'single source, 100 new items (connector cap), 1 hop, changed',
      sources: 1,
      itemsCommitted: inserted,
      outcome: { jobsCreated: cycle.schedule.jobsCreated, inserted },
    });
  });

  it('W-03 single source, 304 not_modified on the SECOND poll (conditional GET)', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    h.mock.setResponses([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"wl-3"' },
        bodyText: rssFeed(normalItems(3, 'w03'), '3'),
      },
    ]);

    // Warm-up cycle (NOT measured): establishes validators + schedule.
    await runMeasuredCycle(h);
    const afterFirst = await itemCount(h.executor, RSS_SOURCES[0]);
    const stateBefore = await sourceState(h.executor, RSS_SOURCES[0]);
    expect(afterFirst).toBe(3);
    expect(stateBefore?.cursor).not.toBeNull();

    // Advance the clock past the scheduled window; the next poll MUST send
    // the stored validators and land on 304.
    h.clock.advance((stateBefore?.next_poll_at ?? NOW) - h.clock.now() + 1_000);
    h.mock.setResponses([{ status: 304, headers: {} }]);

    const measured = await runMeasuredCycle(h);
    const stateAfter = await sourceState(h.executor, RSS_SOURCES[0]);
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);

    expect(measured.envelopes).toHaveLength(1);
    // Conditional GET actually used the stored validator.
    const conditionalCall = h.mock.calls[h.mock.calls.length - 1];
    expect(conditionalCall?.headers['if-none-match']).toBe('"wl-3"');
    // 304: ZERO new items; cursor + etag pass through unchanged.
    expect(inserted).toBe(3);
    expect(stateAfter?.etag).toBe(stateBefore?.etag);
    expect(stateAfter?.cursor).toBe(stateBefore?.cursor);
    expect(stateAfter?.consecutive_failures).toBe(0);

    emitWorkload({
      ...measured.row,
      id: 'W-03',
      scenario:
        'single source, 304 not_modified second poll (conditional GET, validators preserved)',
      sources: 1,
      itemsCommitted: 0,
      outcome: {
        itemsAfter: inserted,
        etagPreserved: stateAfter?.etag === stateBefore?.etag,
        cursorPreserved: stateAfter?.cursor === stateBefore?.cursor,
        requestsToday: stateAfter?.requests_today ?? null,
      },
    });
  });

  it('W-04 single source, redirect then 200 (2 authorized hops)', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    // The redirect target MUST stay on the configured endpoint's origin:
    // safe-http re-validates EVERY hop against the source-bound allowlist
    // (accepted Phase 4.2 behavior) — a cross-host redirect is refused.
    const sourceRow = await h.executor.first<{ config_json: string }>({
      sql: 'SELECT config_json FROM sources WHERE id = ?',
      params: [RSS_SOURCES[0] as string],
    });
    const endpoint = (JSON.parse(sourceRow?.config_json ?? '{}') as Record<string, unknown>)[
      'endpoint'
    ] as string;
    expect(endpoint.startsWith('https://')).toBe(true);
    const redirectTarget = `${new URL(endpoint).origin}/moved-feed`;
    h.mock.setResponses([
      { status: 301, headers: { location: redirectTarget } },
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"wl-4"' },
        bodyText: rssFeed(normalItems(2, 'w04'), '4'),
      },
    ]);

    const cycle = await runMeasuredCycle(h);
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);
    const state = await sourceState(h.executor, RSS_SOURCES[0]);

    expect(cycle.envelopes).toHaveLength(1);
    // TWO raw HTTP requests (301 followed manually by safe-http).
    expect(cycle.row.rawHttpRequests).toBe(2);
    expect(inserted).toBe(2);
    // Per-hop budget authority: EXACTLY ONE unit per hop.
    expect(state?.requests_today).toBe(2);

    emitWorkload({
      ...cycle.row,
      id: 'W-04',
      scenario: 'single source, 301 redirect + 200 (2 hops, per-hop authorization)',
      sources: 1,
      itemsCommitted: inserted,
      outcome: {
        rawRequests: cycle.row.rawHttpRequests,
        requestsToday: state?.requests_today ?? null,
      },
    });
  });

  it('W-05 single source, HTTP 500 provider failure', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    h.mock.setResponses([{ status: 500, headers: {} }]);

    const cycle = await runMeasuredCycle(h);
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);
    const state = await sourceState(h.executor, RSS_SOURCES[0]);

    expect(cycle.envelopes).toHaveLength(1);
    // Provider-side failure: ZERO items, ladder grows, job still succeeds
    // (the poll attempt itself is durably recorded).
    expect(inserted).toBe(0);
    expect(state?.consecutive_failures).toBe(1);
    expect(state?.last_error).toBe('http_status_error');

    emitWorkload({
      ...cycle.row,
      id: 'W-05',
      scenario: 'single source, HTTP 500 (provider failure, adaptive backoff, zero items)',
      sources: 1,
      itemsCommitted: inserted,
      outcome: {
        consecutiveFailures: state?.consecutive_failures ?? null,
        lastError: state?.last_error ?? null,
      },
    });
  });

  it('W-06 single source, 100 items at the max documented shape (max rows x max bytes)', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    const items = maxItems(100, 'w06');
    const feed = rssFeed(items, '6');
    const feedBytes = feed.length;
    h.mock.setResponses([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"wl-6"' },
        bodyText: feed,
      },
    ]);

    const cycle = await runMeasuredCycle(h);
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);

    // Feed respects the 2 MiB cap; the connector cap is 100 items.
    expect(feedBytes).toBeLessThan(2 * 1024 * 1024);
    expect(inserted).toBe(100);
    const longestLink = items.reduce((acc, item) => Math.max(acc, item.link.length), 0);
    expect(longestLink).toBeGreaterThan(2000);

    emitWorkload({
      ...cycle.row,
      id: 'W-06',
      scenario:
        'single source, 100 items at max documented shape (URL ~2KiB + title/excerpt 512 caps), changed',
      sources: 1,
      itemsCommitted: inserted,
      outcome: {
        feedBytes,
        longestCanonicalUrlChars: longestLink,
        inserted,
      },
    });
  });

  it('W-07 seven RSS sources in ONE pass + overlapping second pass (sequential consumption)', async () => {
    const h = createWorkloadHarness();
    await seedAndEnable(h.executor, RSS_SOURCES);
    // One raw request PER CONFIGURED FEED URL (itch_discovery carries two
    // endpointTemplates; the other six sources one endpoint each). The
    // response queue is sized from the ACTUAL stored configs, and the
    // measured cycle must consume EXACTLY that many raw requests.
    let totalFeeds = 0;
    for (const id of RSS_SOURCES) {
      const row = await h.executor.first<{ config_json: string }>({
        sql: 'SELECT config_json FROM sources WHERE id = ?',
        params: [id as string],
      });
      const cfg = JSON.parse(row?.config_json ?? '{}') as Record<string, unknown>;
      totalFeeds += typeof cfg['endpoint'] === 'string' ? 1 : 0;
      const templates = cfg['endpointTemplates'];
      if (Array.isArray(templates)) {
        totalFeeds += templates.filter((t) => typeof t === 'string').length;
      }
    }
    expect(totalFeeds).toBe(8);
    const changedResponse = {
      status: 200,
      headers: { 'content-type': 'application/rss+xml', etag: '"wl-7"' },
      bodyText: rssFeed(normalItems(2, 'w07'), '7'),
    };
    h.mock.setResponses(Array.from({ length: totalFeeds }, () => changedResponse));

    // The SECOND scheduler pass runs BEFORE dispatch/consume: overlapping
    // cron semantics — the atomic window hold must absorb it (0 new jobs).
    const cycle = await runMeasuredCycle(h, { overlappingSecondPass: true });

    expect(cycle.schedule.jobsCreated).toBe(7);
    expect(cycle.secondPass?.jobsCreated).toBe(0);
    expect(cycle.envelopes).toHaveLength(7);
    // Exactly one raw HTTP request per configured feed — no extra fetches.
    expect(cycle.row.rawHttpRequests).toBe(totalFeeds);
    // Every source polls clean: two items committed, zero failures.
    for (const id of RSS_SOURCES) {
      expect(await itemCount(h.executor, id as string)).toBe(2);
      const state = await sourceState(h.executor, id as string);
      expect(state?.consecutive_failures).toBe(0);
    }

    const perSourceXapi = cycle.row.consume.api / 7;
    emitWorkload({
      ...cycle.row,
      id: 'W-07',
      scenario:
        '7 RSS sources (8 feed URLs), one pass, 2 items per feed + overlapping second pass absorbed (0 jobs); envelopes consumed SEQUENTIALLY',
      sources: 7,
      itemsCommitted: 14,
      outcome: {
        jobsCreatedFirstPass: cycle.schedule.jobsCreated,
        jobsCreatedOverlappingPass: cycle.secondPass?.jobsCreated ?? null,
        envelopes: cycle.envelopes.length,
        totalFeedsConfigured: totalFeeds,
        rawRequests: cycle.row.rawHttpRequests,
        consumeXapiPerSourceLocal: Math.round(perSourceXapi * 100) / 100,
      },
    });
  });
});
