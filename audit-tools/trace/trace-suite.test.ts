/**
 * R1.10.2 AUDIT TOOLING — LOCAL entrypoint trace suite v2 (NOT accepted source).
 *
 * Corrected + extended edition of the R1.10.1 suite per the R1.10.2 manager
 * findings (TR-01…TR-06) and NEXT_GLM_PROMPT_R1_10_2.md §4. Every trace:
 *
 *  - runs a REAL worker entrypoint (HTTP webhook / cron scheduled / queue
 *    consumer) inside workerd against a DISPOSABLE local D1;
 *  - uses SCRIPTED RAW fetch only (globalThis.fetch override) and FAKE
 *    queue producer bindings — no real network, no real Queues, no
 *    Cloudflare account, no secrets;
 *  - states the EXPECTED schema (config) and the APPLIED schema (read from
 *    schema_metadata on the raw, uninstrumented binding) explicitly;
 *  - keeps fixture preparation and validation reads on the RAW binding,
 *    OUTSIDE the measured window, and resets counters immediately before
 *    ONE measured entrypoint call (ONE window per report);
 *  - reports CORRECTED UNITS (TR-01): prepares are construction only;
 *    execution-API-call attempts = terminalAttempts + batchAttempts;
 *    statements attempted = terminalAttempts + batchStatements; every
 *    available result metadata record is captured and absent metadata is
 *    labeled unavailable (never zero-filled).
 *
 * HONESTY LABELS (mandatory, unchanged): every number is a LOCAL workerd +
 * miniflare D1 proxy measurement. It does NOT prove Cloudflare-side CPU
 * (network wait is not CPU), does NOT emulate Cloudflare quota enforcement,
 * and local rows_read/rows_written meta is the LOCAL engine's estimate —
 * NOT a cloud billable counter. Free-plan conformance stays
 * NOT_READY_FOR_INGESTION_ON_FREE for the advertised batch-10/100-item
 * profile until owner-approved cloud measurement.
 *
 * COUNT SEPARATION: these 28 traces + the 9 instrument unit controls are
 * TOOL-TEST counts. They are NEVER added to the accepted product suite's
 * 1142 assertions or its subsets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/entrypoints/worker';
import {
  applyMigrations,
  ROUND19_MIGRATION_PLAN,
} from '../../tests/helpers/migrations';
import {
  createD1Stats,
  deriveCounts,
  instrumentD1,
  resetStats,
  snapshot,
  type D1Stats,
} from './d1-instrument';
import { createRawFetchMock, type RawFetchMock } from '../../tests/helpers/fetch-mock';
import type { QueueEnvelope } from '../../src/domain/jobs/envelope';

/* ------------------------------------------------------------------ */
/* Fixture constants (obvious fakes — never real secrets/IDs)          */
/* ------------------------------------------------------------------ */

const NOW = 1_770_000_000_000; // fixed trace clock (within Tehran day boundaries)
const FAKE_WEBHOOK_SECRET = 'trace-webhook-secret-0000000000000000';
const OWNER_ID = '1000000001';
const FOREIGN_ID = '2000000002';
/** Matches the accepted BOT_TOKEN_PATTERN /^[0-9]{6,16}:[A-Za-z0-9_-]{30,}$/ — obvious fixture. */
const FAKE_BOT_TOKEN = '123456789:trace-fake-bot-token-aaaaaaaaaaaaaaaaaaaaaaa';

const FAKE_CONNECTOR_SECRETS = {
  YOUTUBE_API_KEY: 'trace-fake-youtube-key-0000000000',
  REDDIT_CLIENT_ID: 'trace-fake-reddit-client-id',
  REDDIT_CLIENT_SECRET: 'trace-fake-reddit-client-secret-0000000000',
};

/* ------------------------------------------------------------------ */
/* Module-level instrument state                                       */
/* ------------------------------------------------------------------ */

let stats: D1Stats;
let instrumentedDb: D1Database;
const rawDb = () => env.DB as D1Database;

/* ------------------------------------------------------------------ */
/* Small fixture helpers (all writes/reads on the RAW binding)         */
/* ------------------------------------------------------------------ */

async function appliedSchemaVersion(): Promise<number> {
  const row = await rawDb()
    .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
    .first<{ value: string }>();
  const parsed = row === null ? 0 : Number.parseInt(row.value, 10);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

/**
 * Shared-storage repair: the R19-01 traces (T-26/T-27) intentionally corrupt
 * `schema_metadata.schema_version`; this helper restores the TRUE applied
 * version from the durable schema shape (the 0004 candidate is applied ⇔
 * source_state carries poll_owner_job_id) so the next test's migration
 * helper can proceed. Disposable test D1 only — never a real database.
 */
async function repairAppliedSchemaMetadata(): Promise<void> {
  let row: { value: string } | null;
  try {
    row = await rawDb()
      .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
      .first<{ value: string }>();
  } catch {
    return; // fresh DB — the schema_metadata table does not exist yet
  }
  if (row === null) return; // table exists, row missing — nothing to repair
  const parsed = Number.parseInt(row.value, 10);
  if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 4) return; // healthy
  const col = await rawDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM pragma_table_info('source_state') WHERE name = 'poll_owner_job_id'",
    )
    .first<{ n: number }>();
  const version = (col?.n ?? 0) > 0 ? '4' : '3';
  await rawDb()
    .prepare(`UPDATE schema_metadata SET value = ? WHERE key = 'schema_version'`)
    .bind(version)
    .run();
}

async function scalar(sql: string, params: readonly unknown[] = []): Promise<number> {
  const stmt = rawDb().prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  const row = await bound.first<{ n: number | null }>();
  return row?.n ?? -1;
}

interface FakeQueueBinding {
  readonly sent: QueueEnvelope[];
  send: (body: unknown) => Promise<void>;
}

function fakeQueue(): FakeQueueBinding {
  const sent: QueueEnvelope[] = [];
  return {
    sent,
    send: async (body: unknown) => {
      sent.push(body as QueueEnvelope);
    },
  };
}

interface FakeMessage {
  readonly id: string;
  readonly body: unknown;
  acked: boolean;
  retryDelay?: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

function fakeBatch(bodies: unknown[], queue = 'pixel-jobs-preview') {
  const messages: FakeMessage[] = bodies.map((body, i) => {
    const m: FakeMessage = {
      id: `msg-${i}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      acked: false,
      ack() {
        m.acked = true;
      },
      retry(opts?: { delaySeconds?: number }) {
        m.retryDelay = opts?.delaySeconds;
      },
    };
    return m;
  });
  return {
    queue,
    messages,
    ackAll() {
      for (const m of messages) m.ack();
    },
    retryAll() {
      for (const m of messages) m.retry();
    },
  };
}

function traceEnv(
  schema: 3 | 4,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    APP_VERSION: '1.4.0',
    ENVIRONMENT: 'preview',
    LOG_LEVEL: 'warn',
    APP_COMMIT: 'trace-local',
    SCHEMA_VERSION: String(schema),
    TELEGRAM_INGRESS_ENABLED: 'true',
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'false',
    WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    OWNER_TELEGRAM_ID: OWNER_ID,
    DB: instrumentedDb,
    ...overrides,
  };
}

function webhookRequest(body: string, secret: string | undefined = FAKE_WEBHOOK_SECRET): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== undefined) headers['x-telegram-bot-api-secret-token'] = secret;
  return new Request('https://example.com/telegram/webhook', { method: 'POST', headers, body });
}

function ctx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function controller(): ScheduledController {
  return {
    cron: '*/5 * * * *',
    scheduledTime: NOW,
    noRetry: () => {},
  } as unknown as ScheduledController;
}

/** RSS feed fixture with n items (deterministic guids). */
function rss(n: number, guidPrefix = 't'): string {
  return (
    '<?xml version="1.0"?><rss version="2.0"><channel><title>trace fixture</title>' +
    Array.from(
      { length: n },
      (_, i) =>
        `<item><title>Item ${i}</title><link>https://blog.playstation.com/${guidPrefix}-${i}</link>` +
        `<guid isPermaLink="false">${guidPrefix}-${i}</guid>` +
        `<pubDate>Tue, 03 Feb 2026 10:00:00 +0000</pubDate>` +
        `<description><![CDATA[<p>body ${i}</p>]]></description></item>`,
    ).join('') +
    '</channel></rss>'
  );
}

/** Scripted Bot API success for sendMessage (fake-but-valid transport). */
function useBotApiTransport(calls?: { urls: string[] }): void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls?.urls.push(url);
    if (url.includes('api.telegram.org')) {
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 777, chat: { id: OWNER_ID }, date: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('unexpected host', { status: 599 });
  }) as typeof fetch;
  void previous; // restored by afterEach
}

let savedFetch: typeof fetch | undefined;

function useScriptedFetch(mock: RawFetchMock): void {
  savedFetch = globalThis.fetch;
  globalThis.fetch = mock.fetchFn as typeof fetch;
}

/**
 * NOTE ON STORAGE: this audit config shares ONE disposable D1 across the
 * tests of this file (no per-test isolation is configured). Every describe
 * block therefore resets the ingestion tables in beforeEach BEFORE any
 * migration plan application, and the schema-4 block applies the 0004
 * candidate only AFTER outstanding poll jobs are cleared (its partial
 * unique index requires an empty outstanding set — R09-P15 semantics).
 */
beforeEach(() => {
  stats = createD1Stats();
  instrumentedDb = instrumentD1(rawDb(), stats);
  savedFetch = undefined;
});

afterEach(() => {
  if (savedFetch !== undefined) {
    globalThis.fetch = savedFetch;
    savedFetch = undefined;
  }
});

async function cleanIngestionTables(): Promise<void> {
  for (const t of ['source_items', 'source_state', 'sources', 'jobs']) {
    await rawDb().prepare(`DELETE FROM ${t}`).run();
  }
  await rawDb().prepare(`DELETE FROM budgets WHERE scope = 'ingestion'`).run();
}

/* ------------------------------------------------------------------ */
/* Schema-4 active-ingestion fixtures (REAL cron paths, unmeasured)    */
/* ------------------------------------------------------------------ */

/** ONE real gate-ON cron pass (fixture accumulation, UNMEASURED). */
async function runGateOnCronPass(schema: 3 | 4): Promise<FakeQueueBinding> {
  const jobs = fakeQueue();
  const dlq = fakeQueue();
  const e = traceEnv(schema, {
    JOBS: jobs as unknown,
    DLQ: dlq as unknown,
    SOURCE_INGESTION_ENABLED: 'true',
    ...FAKE_CONNECTOR_SECRETS,
  });
  await worker.scheduled(controller(), e as never, ctx());
  return jobs;
}

/**
 * Fixture prep via the REAL cron: pass 1 seeds the registry (enabled=0),
 * the fixture enables the requested sources, pass 2 schedules due jobs.
 * Everything here is OUTSIDE any measured window.
 */
async function produceJobsViaCron(
  schema: 3 | 4,
  enabledSourceIds: 'all' | readonly string[],
): Promise<FakeQueueBinding> {
  await runGateOnCronPass(schema);
  if (enabledSourceIds === 'all') {
    await rawDb().prepare('UPDATE sources SET enabled = 1').run();
  } else {
    const placeholders = enabledSourceIds.map(() => '?').join(', ');
    await rawDb()
      .prepare(`UPDATE sources SET enabled = CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END`)
      .bind(...enabledSourceIds)
      .run();
  }
  return runGateOnCronPass(schema);
}

async function pendingPollJobIds(limit: number): Promise<string[]> {
  const rows = await rawDb()
    .prepare(
      "SELECT id FROM jobs WHERE type = 'sources.fetch_poll' AND status IN ('pending','queued') ORDER BY created_at ASC LIMIT ?",
    )
    .bind(limit)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

async function setSourceConfig(id: string, patch: Record<string, unknown>): Promise<void> {
  const row = await rawDb()
    .prepare('SELECT config_json FROM sources WHERE id = ?')
    .bind(id)
    .first<{ config_json: string }>();
  const config: Record<string, unknown> = row ? JSON.parse(row.config_json) : {};
  Object.assign(config, patch);
  await rawDb()
    .prepare('UPDATE sources SET config_json = ? WHERE id = ?')
    .bind(JSON.stringify(config), id)
    .run();
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

interface ReportContext {
  readonly entrypoint: 'http' | 'cron' | 'queue';
  readonly window: string;
  readonly expectedSchema: 3 | 4;
  readonly flags: Record<string, string | number | boolean>;
}

async function report(label: string, context: ReportContext): Promise<void> {
  const s = snapshot(stats);
  const d = deriveCounts(stats);
  const localMeta = {
    metaRowsRead: s.metaRecords.reduce((a, m) => a + (m.rowsRead ?? 0), 0),
    metaRowsWritten: s.metaRecords.reduce((a, m) => a + (m.rowsWritten ?? 0), 0),
    metaChanges: s.metaRecords.reduce((a, m) => a + (m.changes ?? 0), 0),
  };
  console.log(
    `TRACE[${label}] ` +
      JSON.stringify({
        entrypoint: context.entrypoint,
        window: context.window,
        expectedSchema: context.expectedSchema,
        appliedSchema: await appliedSchemaVersion(),
        flags: context.flags,
        prepares: s.prepares,
        terminalAttempts: s.terminalAttempts,
        terminalCompleted: s.terminalCompleted,
        terminalFailed: s.terminalFailed,
        terminalByMethod: s.terminalByMethod,
        batchAttempts: s.batchAttempts,
        batchCompleted: s.batchCompleted,
        batchFailed: s.batchFailed,
        batchStatements: s.batchStatements,
        batchResultRecords: s.batchResultRecords,
        metaAvailable: d.metaRecordsAvailable,
        metaUnavailable: d.metaRecordsUnavailable,
        executionApiCallAttempts: d.executionApiCallAttempts,
        executionApiCallsCompleted: d.executionApiCallsCompleted,
        executionApiCallsFailed: d.executionApiCallsFailed,
        statementsAttempted: d.statementsAttempted,
        statementsCompleted: d.statementsCompleted,
        localMeta,
        distinctSqlShapes: s.shapes.length,
        sqlShapes: s.shapes.slice(0, 20),
      }),
  );
}

/* ================================================================== */
/* PHASE T-A — schema-3 surface traces (shipped expectation)           */
/* ================================================================== */

describe('R1.10.2 traces — schema 3 surface (audit tooling — outside accepted source)', () => {
  beforeEach(async () => {
    await repairAppliedSchemaMetadata();
    await applyMigrations(rawDb()); // accepted 0001–0003 only
    await cleanIngestionTables();
  });

  it('T-01 webhook NORMAL noop update (offline, shipped preview profile)', async () => {
    const e = traceEnv(3);
    const res = await worker.fetch(
      webhookRequest(JSON.stringify({ update_id: 5001, channel_post: { message_id: 1 } })),
      e as never,
      ctx(),
    );
    expect(res.status).toBe(200);
    await report('T-01 webhook-normal-noop', {
      entrypoint: 'http',
      window: 'one webhook POST (noop channel_post)',
      expectedSchema: 3,
      flags: { ingress: true, jobs: true, ingestion: false },
    });
  });

  it('T-02 webhook DUPLICATE redelivery (delta of the second delivery)', async () => {
    const e = traceEnv(3);
    const body = JSON.stringify({ update_id: 5102, channel_post: { message_id: 2 } });
    await worker.fetch(webhookRequest(body), e as never, ctx());
    resetStats(stats);
    const res2 = await worker.fetch(webhookRequest(body), e as never, ctx());
    expect(res2.status).toBe(200);
    await report('T-02 webhook-duplicate-second-delivery', {
      entrypoint: 'http',
      window: 'SECOND delivery of the SAME update_id (delta window)',
      expectedSchema: 3,
      flags: { ingress: true, jobs: true, ingestion: false },
    });
  });

  it('T-03 webhook UNAUTHORIZED foreign /start (tokenless offline 503 path)', async () => {
    const e = traceEnv(3); // no BOT_TOKEN → tokenless offline mode
    const foreign = JSON.stringify({
      update_id: 5203,
      message: {
        message_id: 3,
        from: { id: Number(FOREIGN_ID), is_bot: false, first_name: 'Foreign' },
        chat: { id: Number(FOREIGN_ID), type: 'private' },
        date: Math.floor(NOW / 1000),
        text: '/start',
      },
    });
    const res = await worker.fetch(webhookRequest(foreign), e as never, ctx());
    console.log(`TRACE[T-03 status] ${res.status} (tokenless offline → retryable 503)`);
    // Shared disposable D1 across this file's tests: count THIS update only.
    const claimRows = await scalar(
      'SELECT COUNT(*) n FROM telegram_updates WHERE update_id = 5203',
    );
    expect(claimRows).toBe(1); // durable claim BEFORE routing
    await report('T-03 webhook-unauthorized-offline', {
      entrypoint: 'http',
      window: 'one webhook POST (foreign /start, no BOT_TOKEN)',
      expectedSchema: 3,
      flags: { ingress: true, jobs: true, ingestion: false, botToken: false },
    });
  });

  it('T-04 webhook OWNER /start with fake-but-valid Telegram transport (full outbound path)', async () => {
    const e = traceEnv(3, { BOT_TOKEN: FAKE_BOT_TOKEN });
    const calls: { urls: string[] } = { urls: [] };
    useBotApiTransport(calls);
    const owner = JSON.stringify({
      update_id: 5304,
      message: {
        message_id: 4,
        from: { id: Number(OWNER_ID), is_bot: false, first_name: 'Owner' },
        chat: { id: Number(OWNER_ID), type: 'private' },
        date: Math.floor(NOW / 1000),
        text: '/start',
      },
    });
    const res = await worker.fetch(webhookRequest(owner), e as never, ctx());
    expect(res.status).toBe(200);
    expect(calls.urls.length).toBe(1);
    expect(calls.urls[0]).toContain('/sendMessage');
    await report('T-04 webhook-owner-start-transport', {
      entrypoint: 'http',
      window: 'one webhook POST (owner /start) incl. ONE scripted sendMessage',
      expectedSchema: 3,
      flags: { ingress: true, jobs: true, ingestion: false, botToken: true, outboundCalls: 1 },
    });
  });

  it('T-05 webhook UNAUTHORIZED foreign /start with transport (denial reply measured)', async () => {
    const e = traceEnv(3, { BOT_TOKEN: FAKE_BOT_TOKEN });
    const calls: { urls: string[] } = { urls: [] };
    useBotApiTransport(calls);
    const foreign = JSON.stringify({
      update_id: 5405,
      message: {
        message_id: 5,
        from: { id: Number(FOREIGN_ID), is_bot: false, first_name: 'Foreign' },
        chat: { id: Number(FOREIGN_ID), type: 'private' },
        date: Math.floor(NOW / 1000),
        text: '/start',
      },
    });
    const res = await worker.fetch(webhookRequest(foreign), e as never, ctx());
    expect(res.status).toBe(200);
    // Claim bookkeeping BEFORE routing; then the minimal denial reply.
    expect(calls.urls.length).toBe(1);
    expect(calls.urls[0]).toContain('/sendMessage');
    const claim = await rawDb()
      .prepare('SELECT status FROM telegram_updates WHERE update_id = 5405')
      .first<{ status: string }>();
    // With transport available the denial IS delivered → the durable claim
    // reaches terminal `processed` (the `failed` terminal is the tokenless
    // offline outcome — traced in T-03).
    expect(claim?.status).toBe('processed');
    await report('T-05 webhook-unauthorized-transport', {
      entrypoint: 'http',
      window: 'one webhook POST (foreign /start) incl. ONE scripted denial sendMessage',
      expectedSchema: 3,
      flags: { ingress: true, jobs: true, ingestion: false, botToken: true, outboundCalls: 1 },
    });
  });

  it('T-06 cron IDLE at shipped preview profile (jobs ON, ingestion OFF)', async () => {
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(3, { JOBS: jobs as unknown, DLQ: dlq as unknown });
    await worker.scheduled(controller(), e as never, ctx());
    expect(jobs.sent.length).toBe(0);
    await report('T-06 cron-idle-gate-off', {
      entrypoint: 'cron',
      window: 'one scheduled pass (gate OFF)',
      expectedSchema: 3,
      flags: { jobs: true, ingestion: false, envelopes: 0 },
    });
  });

  it('T-07 cron INITIAL SEEDING pass only (gate ON, measured window = pass 1)', async () => {
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(3, {
      JOBS: jobs as unknown,
      DLQ: dlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    const seededBefore = await scalar('SELECT COUNT(*) n FROM sources');
    expect(seededBefore).toBe(0);
    await worker.scheduled(controller(), e as never, ctx());
    const seeded = await scalar('SELECT COUNT(*) n FROM sources');
    expect(seeded).toBe(14);
    expect(jobs.sent.length).toBe(0); // all sources enabled=0 → 0 jobs
    await report('T-07 cron-seed-pass', {
      entrypoint: 'cron',
      window: 'ONE scheduled pass (initial registry seeding)',
      expectedSchema: 3,
      flags: { jobs: true, ingestion: true, seededSources: 14, envelopes: 0 },
    });
  });

  it('T-08 cron DUE-SCHEDULING pass only (gate ON, after enabling ONE source; separate window)', async () => {
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(3, {
      JOBS: jobs as unknown,
      DLQ: dlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    await worker.scheduled(controller(), e as never, ctx()); // seed pass (fixture, unmeasured)
    await rawDb().prepare("UPDATE sources SET enabled = 1 WHERE id = 'playstation_blog'").run();
    resetStats(stats);
    await worker.scheduled(controller(), e as never, ctx()); // due pass (MEASURED)
    expect(jobs.sent.length).toBe(1);
    const jobRows = await scalar("SELECT COUNT(*) n FROM jobs WHERE type = 'sources.fetch_poll'");
    expect(jobRows).toBe(1);
    await report('T-08 cron-due-pass', {
      entrypoint: 'cron',
      window: 'ONE scheduled pass (due scan + dispatch after enable-1)',
      expectedSchema: 3,
      flags: { jobs: true, ingestion: true, envelopes: 1, fetchDuringCron: 0 },
    });
  });

  it('T-09 queue consumer BATCH OF 10 at shipped preview profile (gate OFF, all paused_by_policy)', async () => {
    await produceJobsViaCron(3, 'all'); // real cron, unmeasured
    let guard = 0;
    while ((await pendingPollJobIds(10)).length < 10 && guard < 8) {
      guard += 1;
      await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 60_000 * guard).run();
      await runGateOnCronPass(3);
    }
    const ids = await pendingPollJobIds(10);
    expect(ids.length).toBe(10);
    resetStats(stats);
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(3, { JOBS: jobs as unknown, DLQ: dlq as unknown }); // gate OFF profile
    const batch = fakeBatch(
      ids.map((id) => ({
        version: 1,
        jobId: id,
        type: 'sources.fetch_poll',
        attempt: 1,
        traceId: 'trace-t09',
      })),
    );
    const { handleQueue } = await import('../../src/entrypoints/queue');
    await handleQueue(batch as never, e as never, ctx());
    const acked = batch.messages.filter((m) => m.acked).length;
    expect(acked).toBe(10);
    const writes = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(writes).toBe(0);
    await report('T-09 queue-batch10-gate-off', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery of 10 durable poll jobs (gate OFF)',
      expectedSchema: 3,
      flags: { jobs: true, ingestion: false, batchSize: 10, acked: 10, outcome: 'paused_by_policy' },
    });
  });
});

/* ================================================================== */
/* PHASE T-B — schema-4 ACTIVE ingestion traces (candidate migration)  */
/* ================================================================== */

describe('R1.10.2 traces — schema 4 active ingestion (audit tooling — outside accepted source)', () => {
  beforeEach(async () => {
    // 0001–0003 (no-op when already applied) → CLEAN outstanding poll jobs →
    // only then the 0004 candidate (its partial unique index demands an
    // empty outstanding set). Disposable test D1 only; never a real migration.
    await repairAppliedSchemaMetadata();
    await applyMigrations(rawDb());
    await cleanIngestionTables();
    await applyMigrations(rawDb(), ROUND19_MIGRATION_PLAN);
  });

  /** Deliver ONE poll job through the REAL consumer (gate ON, schema 4). */
  async function deliverOnePoll(
    jobId: string,
    attempt = 1,
    traceId = 'trace-poll',
  ): Promise<ReturnType<typeof fakeBatch>> {
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(4, {
      JOBS: jobs as unknown,
      DLQ: dlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    const batch = fakeBatch([
      { version: 1, jobId, type: 'sources.fetch_poll', attempt, traceId },
    ]);
    const { handleQueue } = await import('../../src/entrypoints/queue');
    await handleQueue(batch as never, e as never, ctx());
    return batch;
  }

  it('T-10 ACTIVE schema4 single poll, 0 NEW items via 304 not_modified (second window)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const first = (await pendingPollJobIds(1))[0];
    expect(first).toBeDefined();
    // Window 0 (fixture, unmeasured): 200 RSS with 2 items + etag stored.
    const feed = rss(2, 't10');
    useScriptedFetch(
      createRawFetchMock([
        { status: 200, headers: { 'content-type': 'application/xml', etag: 'W/"t10-etag-1"' }, bodyText: feed },
      ]),
    );
    const batch0 = await deliverOnePoll(first, 1, 'trace-t10-w0');
    expect(batch0.messages[0]?.acked).toBe(true);
    const stored = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(stored).toBe(2);
    // New due window (fixture, unmeasured): schedule the next poll.
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const second = (await pendingPollJobIds(1))[0];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // MEASURED window: conditional GET answered with 304.
    useScriptedFetch(createRawFetchMock([{ status: 304, headers: {} }]));
    resetStats(stats);
    const batch = await deliverOnePoll(second, 1, 'trace-t10-measured');
    expect(batch.messages[0]?.acked).toBe(true);
    const after = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(after).toBe(2); // zero new items
    await report('T-10 poll-0-new-304-not-modified', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (single poll job, 304 answer)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, newItems: 0, transport: '304-not-modified' },
    });
  });

  it('T-11 ACTIVE schema4 single poll, 0 NEW items via EMPTY 200 feed (changed, not 304)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    expect(jobId).toBeDefined();
    // NOTE (TR-03): an empty 200 success is NOT automatically `not_modified`
    // — the RSS connector reports `changed` with zero items here.
    useScriptedFetch(
      createRawFetchMock([
        { status: 200, headers: { 'content-type': 'application/xml' }, bodyText: rss(0, 't11') },
      ]),
    );
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t11');
    expect(batch.messages[0]?.acked).toBe(true);
    const stored = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(stored).toBe(0);
    const state = await rawDb()
      .prepare("SELECT consecutive_failures FROM source_state WHERE source_id = 'playstation_blog'")
      .first<{ consecutive_failures: number }>();
    expect(state?.consecutive_failures).toBe(0); // success pacing, ladder untouched
    await report('T-11 poll-0-new-empty-200', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (single poll job, empty 200 feed)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, newItems: 0, transport: '200-empty-feed' },
    });
  });

  it('T-12 ACTIVE schema4 single poll, 2 NEW items, redirect hop (per-hop charging)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    expect(jobId).toBeDefined();
    useScriptedFetch(
      createRawFetchMock([
        { status: 301, headers: { location: 'https://blog.playstation.com/feed-final.xml' } },
        { status: 200, headers: { 'content-type': 'application/xml' }, bodyText: rss(2, 't12') },
      ]),
    );
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t12');
    expect(batch.messages[0]?.acked).toBe(true);
    const stored = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(stored).toBe(2);
    const charged = await rawDb()
      .prepare("SELECT requests FROM budgets WHERE scope = 'ingestion'")
      .first<{ requests: number }>();
    expect(charged?.requests).toBe(2); // 2 hops → exactly 2 durable units
    await report('T-12 poll-2-new-redirect', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (single poll job, 301→200, 2 items)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, newItems: 2, rawHops: 2, chargedUnits: 2 },
    });
  });

  it('T-13 ACTIVE schema4 single poll, 100 NEW items (worst-supported single-job shape)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    expect(jobId).toBeDefined();
    useScriptedFetch(
      createRawFetchMock([
        { status: 200, headers: { 'content-type': 'application/xml' }, bodyText: rss(100, 't13') },
      ]),
    );
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t13');
    expect(batch.messages[0]?.acked).toBe(true);
    const stored = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(stored).toBe(100);
    await report('T-13 poll-100-new', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (single poll job, 100 new items)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, newItems: 100 },
    });
  });

  it('T-14 ACTIVE schema4 single poll, DUPLICATE-HEAVY 100 (second window, same content)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const feed = rss(100, 't14');
    const first = (await pendingPollJobIds(1))[0];
    useScriptedFetch(
      createRawFetchMock([{ status: 200, headers: { 'content-type': 'application/xml' }, bodyText: feed }]),
    );
    const batch0 = await deliverOnePoll(first, 1, 'trace-t14-w0');
    expect(batch0.messages[0]?.acked).toBe(true);
    expect(await scalar('SELECT COUNT(*) n FROM source_items')).toBe(100);
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const second = (await pendingPollJobIds(1))[0];
    expect(second).not.toBe(first);
    useScriptedFetch(
      createRawFetchMock([{ status: 200, headers: { 'content-type': 'application/xml' }, bodyText: feed }]),
    );
    resetStats(stats);
    const batch = await deliverOnePoll(second, 1, 'trace-t14-measured');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(await scalar('SELECT COUNT(*) n FROM source_items')).toBe(100); // no growth
    await report('T-14 poll-100-all-duplicate', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (single poll job, 100 duplicate items)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, newItems: 0, duplicateItems: 100 },
    });
  });

  it('T-15 ACTIVE schema4 single poll, MIXED 50 new + 50 duplicate', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const firstFeed =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>fixture</title>' +
      Array.from(
        { length: 50 },
        (_, i) =>
          `<item><title>Mix ${i}</title><link>https://blog.playstation.com/t15-${i}</link>` +
          `<guid isPermaLink="false">t15-${i}</guid><pubDate>Tue, 03 Feb 2026 10:00:00 +0000</pubDate></item>`,
      ).join('') +
      '</channel></rss>';
    const first = (await pendingPollJobIds(1))[0];
    useScriptedFetch(
      createRawFetchMock([{ status: 200, headers: { 'content-type': 'application/xml' }, bodyText: firstFeed }]),
    );
    const batch0 = await deliverOnePoll(first, 1, 'trace-t15-w0');
    expect(batch0.messages[0]?.acked).toBe(true);
    expect(await scalar('SELECT COUNT(*) n FROM source_items')).toBe(50);
    const secondFeed =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>fixture</title>' +
      Array.from(
        { length: 100 },
        (_, i) =>
          `<item><title>Mix ${i}</title><link>https://blog.playstation.com/t15-${i}</link>` +
          `<guid isPermaLink="false">t15-${i}</guid><pubDate>Tue, 03 Feb 2026 10:00:00 +0000</pubDate></item>`,
      ).join('') +
      '</channel></rss>';
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const second = (await pendingPollJobIds(1))[0];
    useScriptedFetch(
      createRawFetchMock([{ status: 200, headers: { 'content-type': 'application/xml' }, bodyText: secondFeed }]),
    );
    resetStats(stats);
    const batch = await deliverOnePoll(second, 1, 'trace-t15-measured');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(await scalar('SELECT COUNT(*) n FROM source_items')).toBe(100); // +50 only
    await report('T-15 poll-50new-50duplicate', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (single poll job, 50 new + 50 duplicates)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, newItems: 50, duplicateItems: 50 },
    });
  });

  it('T-16 ACTIVE schema4 BATCH10 through ONE real handleQueue (7 RSS + Steam + YouTube + GitHub)', async () => {
    // Seed pass (unmeasured) → enable EXACTLY the 10 target sources → due pass.
    await runGateOnCronPass(4);
    await rawDb()
      .prepare(
        "UPDATE sources SET enabled = CASE WHEN connector = 'rss' OR id IN ('steam_news_watchlist','youtube_official_watchlist','github_release_watchlist') THEN 1 ELSE 0 END",
      )
      .run();
    await setSourceConfig('steam_news_watchlist', { apps: [570] });
    await setSourceConfig('youtube_official_watchlist', { playlists: ['PLtraceplaylist01'] });
    await setSourceConfig('github_release_watchlist', { repositories: ['trace-fixture/manager'] });
    await runGateOnCronPass(4);
    let guard = 0;
    while ((await pendingPollJobIds(10)).length < 10 && guard < 8) {
      guard += 1;
      await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 60_000 * guard).run();
      await runGateOnCronPass(4);
    }
    const ids = await pendingPollJobIds(10);
    expect(ids.length).toBe(10);
    let fetches = 0;
    const scripted = createRawFetchMock();
    useScriptedFetch({
      ...scripted,
      fetchFn: (async (input: unknown) => {
        fetches += 1;
        const url = String(input);
        void scripted; // response scripted inline below
        if (url.includes('steampowered')) {
          return new Response(JSON.stringify({ appnews: { newsitems: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('googleapis')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('api.github')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(rss(100, 't16'), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      }) as typeof fetch,
    });
    resetStats(stats);
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(4, {
      JOBS: jobs as unknown,
      DLQ: dlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    const batch = fakeBatch(
      ids.map((id) => ({
        version: 1,
        jobId: id,
        type: 'sources.fetch_poll',
        attempt: 1,
        traceId: 'trace-t16',
      })),
    );
    const { handleQueue } = await import('../../src/entrypoints/queue');
    await handleQueue(batch as never, e as never, ctx());
    const acked = batch.messages.filter((m) => m.acked).length;
    expect(acked).toBe(10);
    const items = await scalar('SELECT COUNT(*) n FROM source_items');
    expect(items).toBe(700); // 7 RSS × 100 items
    await report('T-16 queue-batch10-active-schema4', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery of 10 poll jobs (gate ON, schema 4)',
      expectedSchema: 4,
      flags: {
        jobs: true,
        ingestion: true,
        batchSize: 10,
        acked: 10,
        rawFetches: fetches,
        itemsStored: 700,
      },
    });
  });

  it('T-17 CONNECTOR RSS multi-feed bound incl. redirect (endpoint + 2 templates, ≤4 feeds)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    await setSourceConfig('playstation_blog', {
      endpoint: 'https://blog.playstation.com/feed/',
      endpointTemplates: [
        'https://blog.playstation.com/feed-extra-2.xml',
        'https://blog.playstation.com/feed-extra-3.xml',
      ],
    });
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const jobId = (await pendingPollJobIds(1))[0];
    const scripted = createRawFetchMock();
    const urls: string[] = [];
    useScriptedFetch({
      ...scripted,
      fetchFn: (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/feed/')) {
          return new Response(null, {
            status: 301,
            headers: { location: 'https://blog.playstation.com/feed-final.xml' },
          });
        }
        if (url.endsWith('feed-final.xml')) {
          return new Response(rss(2, 't17a'), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          });
        }
        if (url.endsWith('feed-extra-2.xml')) {
          return new Response(rss(2, 't17b'), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          });
        }
        return new Response(rss(2, 't17c'), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      }) as typeof fetch,
    });
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t17');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(urls.length).toBe(4); // feed(→redirect) + feed-final + 2 templates
    expect(await scalar('SELECT COUNT(*) n FROM source_items')).toBe(6);
    await report('T-17 conn-rss-multifeed-redirect', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (RSS source, 3 feeds + 1 redirect hop)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, rawRequests: 4, feeds: 3, newItems: 6 },
    });
  });

  it('T-18 CONNECTOR Steam multi-app bound (3 apps in one poll)', async () => {
    await produceJobsViaCron(4, ['steam_news_watchlist']);
    await setSourceConfig('steam_news_watchlist', { apps: [570, 440, 730], appsPerBatch: 10 });
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const jobId = (await pendingPollJobIds(1))[0];
    const urls: string[] = [];
    const scripted = createRawFetchMock();
    useScriptedFetch({
      ...scripted,
      fetchFn: (async (input: unknown) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ appnews: { newsitems: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t18');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(urls.length).toBe(3); // one request per watched app (bounded by appsPerBatch)
    await report('T-18 conn-steam-multi-app', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (Steam source, 3 apps)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, rawRequests: 3, apps: 3 },
    });
  });

  it('T-19 CONNECTOR YouTube multi-playlist bound (2 playlists + 1 details call)', async () => {
    await produceJobsViaCron(4, ['youtube_official_watchlist']);
    await setSourceConfig('youtube_official_watchlist', {
      playlists: ['PLtraceplaylist01', 'PLtraceplaylist02'],
    });
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const jobId = (await pendingPollJobIds(1))[0];
    const urls: string[] = [];
    const scripted = createRawFetchMock();
    useScriptedFetch({
      ...scripted,
      fetchFn: (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/videos')) {
          // ONE videos-details call for the collected ids.
          return new Response(
            JSON.stringify({
              items: [
                { id: 'tracevid1', snippet: { title: 'V1', publishedAt: '2026-02-03T10:00:00Z' } },
                { id: 'tracevid2', snippet: { title: 'V2', publishedAt: '2026-02-03T09:00:00Z' } },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const playlistId = url.includes('PLtraceplaylist01') ? 'PLtraceplaylist01' : 'PLtraceplaylist02';
        const videoId = playlistId === 'PLtraceplaylist01' ? 'tracevid1' : 'tracevid2';
        return new Response(
          JSON.stringify({
            items: [
              {
                id: `${videoId}-pi`,
                contentDetails: { videoId },
                snippet: {
                  title: `Fixture ${videoId}`,
                  publishedAt: '2026-02-03T08:00:00Z',
                  description: 'fixture',
                  videoOwnerChannelTitle: 'trace-channel',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t19');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(urls.length).toBe(3); // playlistItems ×2 + videos-details ×1
    expect(urls.filter((u) => u.includes('playlistItems')).length).toBe(2);
    expect(urls.filter((u) => u.includes('/videos')).length).toBe(1);
    await report('T-19 conn-youtube-multi-playlist', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (YouTube source, 2 playlists + details)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, rawRequests: 3, playlists: 2 },
    });
  });

  it('T-20 CONNECTOR GitHub multi-repo bound (2 repositories)', async () => {
    await produceJobsViaCron(4, ['github_release_watchlist']);
    await setSourceConfig('github_release_watchlist', {
      repositories: ['trace-fixture/alpha', 'trace-fixture/beta'],
    });
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const jobId = (await pendingPollJobIds(1))[0];
    const urls: string[] = [];
    const scripted = createRawFetchMock();
    useScriptedFetch({
      ...scripted,
      fetchFn: (async (input: unknown) => {
        urls.push(String(input));
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t20');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(urls.length).toBe(2); // one releases request per repository
    await report('T-20 conn-github-multi-repo', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (GitHub source, 2 repositories)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, rawRequests: 2, repositories: 2 },
    });
  });

  it('T-21 CONNECTOR Reddit token + multi-subreddit bound (1 token + 2 listings)', async () => {
    await produceJobsViaCron(4, ['reddit_crack_signals']);
    await setSourceConfig('reddit_crack_signals', { subreddits: ['tracefixa', 'tracefixb'] });
    await rawDb().prepare('UPDATE source_state SET next_poll_at = ?').bind(NOW - 1).run();
    await runGateOnCronPass(4);
    const jobId = (await pendingPollJobIds(1))[0];
    const urls: string[] = [];
    const scripted = createRawFetchMock();
    useScriptedFetch({
      ...scripted,
      fetchFn: (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('www.reddit.com')) {
          return new Response(JSON.stringify({ access_token: 'trace-fixture-access-token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ data: { children: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t21');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(urls.length).toBe(3); // 1 token + 2 subreddit listings
    await report('T-21 conn-reddit-token-and-listings', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (Reddit source, token + 2 listings)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, rawRequests: 3, subreddits: 2 },
    });
  });

  it('T-22 PROVIDER FAILURE: ordinary grant, then transport throw (NOT late-authorization evidence)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    const scripted = createRawFetchMock(); // every attempt THROWS
    useScriptedFetch(scripted);
    // Delivery 1 (MEASURED): the transport authorizer GRANTS ordinarily
    // (budgets row healthy), THEN the raw fetch throws. The durable unit is
    // conservatively charged for the thrown ATTEMPT. This trace is NOT
    // evidence about a LATE authorization grant — that behavior is asserted
    // by the accepted unit suite (round18-r10-budget-authority.test.ts).
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t22-d1');
    expect(batch.messages[0]?.acked).toBe(true); // acked; pacing owned by D1
    const state = await rawDb()
      .prepare("SELECT consecutive_failures, next_poll_at FROM source_state WHERE source_id = 'playstation_blog'")
      .first<{ consecutive_failures: number; next_poll_at: number }>();
    expect(state?.consecutive_failures).toBe(1); // adaptive ladder step
    const charged = await rawDb()
      .prepare("SELECT requests FROM budgets WHERE scope = 'ingestion'")
      .first<{ requests: number }>();
    expect(charged?.requests).toBe(1); // thrown attempt consumed its unit
    await report('T-22 poll-transport-failure-d1', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (grant OK → raw fetch throws)',
      expectedSchema: 4,
      flags: {
        jobs: true,
        ingestion: true,
        label: 'ordinary-grant-then-transport-throw',
        lateAuthorizationClaim: false,
        chargedUnits: 1,
      },
    });
  });

  it('T-23 BUDGET DENIED: zero budget → denied BEFORE any raw fetch (separately labeled)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    await rawDb()
      .prepare("UPDATE sources SET daily_request_budget = 0 WHERE id = 'playstation_blog'")
      .run();
    const jobId = (await pendingPollJobIds(1))[0];
    const scripted = createRawFetchMock();
    useScriptedFetch(scripted);
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t23');
    expect(batch.messages[0]?.acked).toBe(true);
    expect(scripted.calls.length).toBe(0); // denial happens before hop 0
    const state = await rawDb()
      .prepare("SELECT last_error, consecutive_failures FROM source_state WHERE source_id = 'playstation_blog'")
      .first<{ last_error: string | null; consecutive_failures: number }>();
    expect(state?.last_error).toBe('budget_exhausted');
    expect(state?.consecutive_failures).toBe(0); // denial is NOT a ladder failure
    const charged = await rawDb()
      .prepare("SELECT requests FROM budgets WHERE scope = 'ingestion'")
      .first<{ requests: number }>();
    expect(charged?.requests ?? 0).toBe(0); // no durable charge row for a denial
    await report('T-23 poll-budget-denied-hop0', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (daily_request_budget=0)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, label: 'budget-denied', rawFetches: 0, chargedUnits: 0 },
    });
  });

  it('T-24 BUDGET AUTHORITY FAILURE: authority storage fails → typed retry, zero terminal state write', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    const before = await rawDb()
      .prepare("SELECT cursor, etag, last_modified, consecutive_failures FROM source_state WHERE source_id = 'playstation_blog'")
      .first<{ cursor: string | null; etag: string | null; last_modified: string | null; consecutive_failures: number }>();
    await rawDb().prepare('DROP TABLE budgets').run(); // fixture: authority storage out
    const scripted = createRawFetchMock();
    useScriptedFetch(scripted);
    resetStats(stats);
    const batch = await deliverOnePoll(jobId, 1, 'trace-t24');
    // The engine schedules the retry DURABLY (markJobRetryWait) and ACKS the
    // message (at-least-once + durable dispatch; the platform message is
    // consumed — no queue retry storm). A non-acked message would mean the
    // durable retry scheduling itself failed.
    expect(batch.messages[0]?.acked).toBe(true);
    expect(scripted.calls.length).toBe(0); // fail-closed BEFORE network
    const after = await rawDb()
      .prepare("SELECT cursor, etag, last_modified, consecutive_failures FROM source_state WHERE source_id = 'playstation_blog'")
      .first<{ cursor: string | null; etag: string | null; last_modified: string | null; consecutive_failures: number }>();
    expect(after).toEqual(before); // ZERO terminal ingestion effects
    const row = await rawDb()
      .prepare('SELECT status, attempts FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; attempts: number }>();
    expect(row?.status).toBe('retry_wait'); // engine retry bookkeeping only
    // Restore the authority storage EXACTLY (this disposable DB is shared by
    // the file's later traces; the DDL is the accepted 0001 definition).
    await rawDb()
      .prepare(
        'CREATE TABLE IF NOT EXISTS budgets (scope TEXT NOT NULL, budget_key TEXT NOT NULL, bucket_date TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, bytes_transferred INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(scope, budget_key, bucket_date))',
      )
      .run();
    await report('T-24 poll-budget-authority-failure', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (budgets table unavailable)',
      expectedSchema: 4,
      flags: {
        jobs: true,
        ingestion: true,
        label: 'authority-storage-failure',
        rawFetches: 0,
        terminalStateWrites: 0,
      },
    });
  });

  it('T-25 POISON envelope (nonexistent job) → safe ack, no durable row, no DLQ', async () => {
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(4, {
      JOBS: jobs as unknown,
      DLQ: dlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    resetStats(stats);
    const poisonBatch = fakeBatch([
      { version: 1, jobId: 'nonexistent-poison-1', type: 'totally.unknown_type', attempt: 1, traceId: 'trace-t25' },
    ]);
    const { handleQueue } = await import('../../src/entrypoints/queue');
    await handleQueue(poisonBatch as never, e as never, ctx());
    expect(poisonBatch.messages[0]?.acked).toBe(true);
    const row = await rawDb()
      .prepare("SELECT status FROM jobs WHERE id = 'nonexistent-poison-1'")
      .first<{ status: string }>();
    expect(row).toBeNull();
    expect(dlq.sent.length).toBe(0);
    await report('T-25 poison-envelope-nonexistent-job', {
      entrypoint: 'queue',
      window: 'ONE handleQueue delivery (unknown type, nonexistent job)',
      expectedSchema: 4,
      flags: { jobs: true, ingestion: true, durableRowCreated: false, dlqSent: 0 },
    });
  });

  it('T-26 BOUNDED RETRIES → dead-letter TERMINAL ROW (inline DLQ producer NOT called)', async () => {
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    // Corrupt the metadata → capability unresolved → stable retry each delivery.
    await rawDb()
      .prepare("UPDATE schema_metadata SET value = 'not-a-number' WHERE key = 'schema_version'")
      .run();
    const history: Array<Record<string, unknown>> = [];
    for (let delivery = 1; delivery <= 5; delivery++) {
      const jobs = fakeQueue();
      const dlq = fakeQueue();
      const e = traceEnv(4, {
        JOBS: jobs as unknown,
        DLQ: dlq as unknown,
        SOURCE_INGESTION_ENABLED: 'true',
        ...FAKE_CONNECTOR_SECRETS,
      });
      resetStats(stats);
      const batch = fakeBatch([
        { version: 1, jobId, type: 'sources.fetch_poll', attempt: delivery, traceId: `trace-t26-d${delivery}` },
      ]);
      const { handleQueue } = await import('../../src/entrypoints/queue');
      await handleQueue(batch as never, e as never, ctx());
      const row = await rawDb()
        .prepare('SELECT status, attempts FROM jobs WHERE id = ?')
        .bind(jobId)
        .first<{ status: string; attempts: number }>();
      history.push({ delivery, acked: batch.messages[0]?.acked === true, status: row?.status });
      if (row?.status === 'dead_letter') break;
      await rawDb().prepare('UPDATE jobs SET run_after = 0 WHERE id = ?').bind(jobId).run();
      // Only the FINAL delivery window is reported in full; intermediate
      // windows are summarized below (one entrypoint/window each).
      await report(`T-26 retry-delivery-${delivery}`, {
        entrypoint: 'queue',
        window: `ONE handleQueue delivery (bounded retry ${delivery})`,
        expectedSchema: 4,
        flags: { jobs: true, ingestion: true, delivery, schemaMetadataCorrupted: true },
      });
    }
    const final = await rawDb()
      .prepare('SELECT status, attempts, dlq_delivered_at FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; attempts: number; dlq_delivered_at: number | null }>();
    expect(final?.status).toBe('dead_letter');
    console.log(
      'TRACE[T-26 summary] ' +
        JSON.stringify({
          deliveries: history.length,
          history,
          finalStatus: final?.status,
          dlqDeliveredAt: final?.dlq_delivered_at,
          note: 'terminal-row transition only; DLQ producer send traced separately in T-27 (at-least-once reconcile)',
        }),
    );
  });

  it('T-27 CRON DLQ RECONCILIATION SEND: real cron delivers the dead-letter reference to the DLQ producer', async () => {
    // Fixture (unmeasured): drive a job to dead_letter exactly like T-26.
    await produceJobsViaCron(4, ['playstation_blog']);
    const jobId = (await pendingPollJobIds(1))[0];
    await rawDb()
      .prepare("UPDATE schema_metadata SET value = 'not-a-number' WHERE key = 'schema_version'")
      .run();
    const jobs = fakeQueue();
    const dlq = fakeQueue();
    const e = traceEnv(4, {
      JOBS: jobs as unknown,
      DLQ: dlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    const { handleQueue } = await import('../../src/entrypoints/queue');
    for (let delivery = 1; delivery <= 5; delivery++) {
      const batch = fakeBatch([
        { version: 1, jobId, type: 'sources.fetch_poll', attempt: delivery, traceId: `trace-t27-d${delivery}` },
      ]);
      await handleQueue(batch as never, e as never, ctx());
      const row = await rawDb()
        .prepare('SELECT status FROM jobs WHERE id = ?')
        .bind(jobId)
        .first<{ status: string }>();
      if (row?.status === 'dead_letter') break;
      await rawDb().prepare('UPDATE jobs SET run_after = 0 WHERE id = ?').bind(jobId).run();
    }
    const pendingBefore = await rawDb()
      .prepare('SELECT dlq_delivered_at FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ dlq_delivered_at: number | null }>();
    expect(pendingBefore?.dlq_delivered_at).toBeNull();
    expect(dlq.sent.length).toBe(0); // nothing sent inline
    // MEASURED window: ONE real cron pass with ingestion gate OFF (isolate
    // the reconcile effect; the engine still dispatches + reconciles).
    const cronJobs = fakeQueue();
    const cronDlq = fakeQueue();
    const cronEnv = traceEnv(4, {
      JOBS: cronJobs as unknown,
      DLQ: cronDlq as unknown,
      SOURCE_INGESTION_ENABLED: 'false',
    });
    resetStats(stats);
    await worker.scheduled(controller(), cronEnv as never, ctx());
    expect(cronDlq.sent.length).toBe(1); // actual application DLQ SEND
    const ref = cronDlq.sent[0] as { jobId?: string };
    expect(ref.jobId).toBe(jobId);
    const after = await rawDb()
      .prepare('SELECT dlq_delivered_at FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ dlq_delivered_at: number | null }>();
    expect(after?.dlq_delivered_at).not.toBeNull(); // guarded confirmation
    await report('T-27 cron-dlq-reconciliation-send', {
      entrypoint: 'cron',
      window: 'ONE scheduled pass (reconcileDeadLetters over 1 dead-letter row)',
      expectedSchema: 4,
      flags: {
        jobs: true,
        ingestion: false,
        dlqSends: 1,
        label: 'application DLQ send + guarded confirmation; real Queue send/receive LIVE-UNVERIFIED',
      },
    });
  });

  it('T-28 QUEUE OUTAGE >24h: aged durable queued row re-enqueued by the REAL cron (same job id)', async () => {
    // Fixture: seed + enable + due pass → ONE queued job.
    const jobs = await produceJobsViaCron(4, ['playstation_blog']);
    expect(jobs.sent.length).toBe(1);
    const originalJobId = jobs.sent[0].jobId;
    // Fixture: age the durable row past 24 h (queue message assumed lost).
    await rawDb()
      .prepare("UPDATE jobs SET updated_at = ?, created_at = ? WHERE id = ? AND status = 'queued'")
      .bind(NOW - 25 * 3_600_000, NOW - 25 * 3_600_000, originalJobId)
      .run();
    // MEASURED window: ONE real cron pass — stranded queued scan (grace) re-kicks.
    const cronJobs = fakeQueue();
    const cronDlq = fakeQueue();
    const cronEnv = traceEnv(4, {
      JOBS: cronJobs as unknown,
      DLQ: cronDlq as unknown,
      SOURCE_INGESTION_ENABLED: 'true',
      ...FAKE_CONNECTOR_SECRETS,
    });
    resetStats(stats);
    await worker.scheduled(controller(), cronEnv as never, ctx());
    const reenqueued = cronJobs.sent.some((m) => m.jobId === originalJobId);
    void cronDlq;
    expect(reenqueued).toBe(true);
    await report('T-28 queue-outage-recovery-25h', {
      entrypoint: 'cron',
      window: 'ONE scheduled pass over a 25h-old queued row (stranded re-kick)',
      expectedSchema: 4,
      flags: {
        jobs: true,
        ingestion: true,
        sameJobIdReenqueued: true,
        label:
          'application re-kick proof ONLY — does NOT prove real Queue TTL expiry, availability, or delivery after real outage',
      },
    });
  });
});
