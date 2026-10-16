import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import worker from '../../src/entrypoints/worker';
import {
  createTestEnv,
  createTestExecutionContext,
  createTestScheduledController,
} from '../helpers/test-env';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import {
  createJobsEngine,
  DEFAULT_ENGINE_BOUNDS,
  type JobsEngine,
} from '../../src/application/jobs/engine';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { createMaintenanceHeartbeatHandler } from '../../src/application/jobs/handlers/maintenance-heartbeat';
import {
  createSourcePollHandler,
  type SourcePollHandlerOptions,
} from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
// Round 1.8 (R10) fixture adaptation — SETUP ONLY: the handler builds its
// own budgeted ingestion transport from the RAW transport, so this handler-
// level harness feeds it `createRawFetchMock()` (same queued response
// shape) instead of the SafeFetchExecutor fake. No assertion, label, or
// test body changed.
import { createRawFetchMock } from '../helpers/fetch-mock';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import type {
  JobsQueueProducerPort,
  DlqProducerPort,
  DlqReference,
} from '../../src/adapters/queue/jobs-producer';
import type { QueueEnvelope } from '../../src/domain/jobs/envelope';
import type { JobsPolicyGates } from '../../src/domain/jobs/policy';
import type { JobRow } from '../../src/adapters/db/job-store';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import type { WorkerEnv } from '../../src/shared/types/env';

/**
 * ROUND 1.6 — D01 LOSSLESS POLICY PAUSE: production-path tests (ADR-0040).
 *
 * The reviewed Round 1.5.1 pause/recovery design is now implemented in the
 * REAL product path: `resolveJobsEngine` passes the strictly parsed
 * per-invocation gate snapshot to the real engine; the engine pauses
 * policy-mapped types whose gate is off (consume: `paused_by_policy` ack
 * BEFORE the atomic claim — zero durable writes; dispatch/recovery: the
 * paused types are excluded IN SQL so they never consume scan slots), while
 * schema-known handler-missing types with their gate NOT holding them are a
 * DISTINCT visible `handler_misconfigured` class.
 *
 * Every test here runs on REAL workerd D1 through the REAL engine, REAL
 * environment factory, REAL poll/heartbeat handlers and (for entrypoint
 * tests) the REAL cron/queue entrypoints. Queue producers are fake; the
 * connector harness uses a scripted SafeFetchExecutor fake, NOT raw HTTP
 * through createSafeFetch. These are D01 policy tests, not new HTTP-port
 * security proofs (no live providers, no credentials).
 *
 * Attempt economics under test (the OFF economics contract):
 * - pauses happen BEFORE the claim, so `attempts` never moves while a gate
 *   is off; a row at attempts = max−1 can never be dead-lettered by pauses;
 * - expired claimed poll work stays dormant (claimed, expired lease) during
 *   OFF — attempts and error/exhaustion information preserved exactly,
 *   never reset, never rewritten, never DLQ'd;
 * - ON economics stay ordinary: genuine spent attempts dead-letter through
 *   ordinary exhaustion; a near-final row resumes with only its actual
 *   final claim increment; already-terminal rows stay terminal.
 */

const NOW = 1_770_000_000_000;

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

const POLL_PAYLOAD = { sourceId: 'playstation_blog', scheduledForMs: NOW };

function pollEnvelope(jobId: string, attempt = 1, type = 'sources.fetch_poll'): QueueEnvelope {
  return { version: 1, jobId, type, attempt, traceId: 'trace-d01' };
}

async function seedJob(
  executor: DbExecutor,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string) ?? `d01-${Math.floor(Math.random() * 1e9)}`;
  await executor.run({
    sql: `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
            lease_until, idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      overrides.type ?? 'sources.fetch_poll',
      overrides.status ?? 'pending',
      overrides.priority ?? 50,
      overrides.runAfter ?? NOW,
      overrides.attempts ?? 0,
      overrides.maxAttempts ?? 3,
      overrides.leaseUntil ?? null,
      overrides.key ?? `d01-key-${id}`,
      overrides.payload ?? JSON.stringify(POLL_PAYLOAD),
      NOW,
      overrides.updatedAt ?? NOW,
      overrides.dlqDeliveredAt ?? null,
    ],
  });
  return id;
}

const FULL_COLUMNS = `id, type, aggregate_type, aggregate_id, status, priority, run_after,
  attempts, max_attempts, lease_until, idempotency_key, payload_json, last_error,
  created_at, updated_at, dlq_delivered_at`;

async function readJobRow(executor: DbExecutor, id: string): Promise<JobRow> {
  const row = await executor.first<JobRow>({
    sql: `SELECT ${FULL_COLUMNS} FROM jobs WHERE id = ?`,
    params: [id],
  });
  if (row === null) {
    throw new Error(`job row missing: ${id}`);
  }
  return row;
}

async function seedEnabledSource(executor: DbExecutor): Promise<void> {
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) throw new Error('registry invalid');
  await seedSourcesFromRegistry(executor, registry.registry, NOW);
  await executor.run({ sql: "UPDATE sources SET enabled = 1 WHERE id = 'playstation_blog'" });
}

interface ResolvedHarness {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly sentEnvelopes: QueueEnvelope[];
  readonly dlqSent: DlqReference[];
}

/**
 * Production resolution path: REAL config parsing, REAL environment
 * factory, REAL D1 — with fake queue producer bindings that record sends.
 * With the gate OFF the poll handler is (correctly) never registered.
 */
function createResolvedHarness(flag: string, overrides: Partial<WorkerEnv> = {}): ResolvedHarness {
  const executor = createDbExecutor(env.DB);
  const sentEnvelopes: QueueEnvelope[] = [];
  const dlqSent: DlqReference[] = [];
  const jobsQueue = {
    send: async (body: QueueEnvelope) => {
      sentEnvelopes.push(body);
    },
  } as unknown as Queue;
  const dlqQueue = {
    send: async (reference: DlqReference) => {
      dlqSent.push(reference);
    },
  } as unknown as Queue;
  const resolution = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: flag,
    JOBS: jobsQueue,
    DLQ: dlqQueue,
    ...overrides,
  } as unknown as WorkerEnv);
  if (resolution.kind !== 'ready') throw new Error(`engine not ready: ${resolution.kind}`);
  return { engine: resolution.engine, executor, sentEnvelopes, dlqSent };
}

interface PolicyHarness {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly clock: MutableClock;
  readonly sentEnvelopes: QueueEnvelope[];
  readonly dlqSent: DlqReference[];
  readonly mock: ReturnType<typeof createRawFetchMock>;
}

/**
 * REAL engine + REAL poll/heartbeat handlers with a scripted RAW transport
 * (the handler builds the mandatory budgeted ingestion transport from it,
 * Round 1.8 R10) and an EXPLICIT per-invocation gate snapshot — the exact
 * wiring `resolveJobsEngine` performs, with the raw transport scripted (no
 * live providers). Omitting `gates` reproduces the direct-construction
 * harnesses used by every accepted Phase 3/4 suite (every gate ON, no
 * pause).
 */
function createPolicyHarness(gates?: JobsPolicyGates): PolicyHarness {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  const mock = createRawFetchMock();
  const handlerOptions: SourcePollHandlerOptions = {
    executor,
    connectors: createConnectorRegistry(),
    fetchFn: mock.fetchFn,
    idGenerator: { newId: () => `item-${Math.random().toString(36).slice(2, 10)}` },
    secrets: () => undefined, // identical semantics: the old bundle carried no secrets
    nowMs: () => clock.now(),
    random: () => 0.5,
  };
  const sentEnvelopes: QueueEnvelope[] = [];
  const dlqSent: DlqReference[] = [];
  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      sentEnvelopes.push(envelope);
    },
  };
  const dlqProducer: DlqProducerPort = {
    send: async (reference) => {
      dlqSent.push(reference);
    },
  };
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createMaintenanceHeartbeatHandler({ executor, nowMs: () => clock.now() }) as never,
        createSourcePollHandler(handlerOptions) as never,
      ]),
      idGenerator: {
        newId: () => `job-${sentEnvelopes.length}-${Math.random().toString(36).slice(2, 8)}`,
      },
      clock,
      random: () => 0.5,
      jobsProducer,
      dlqProducer,
      ...(gates === undefined ? {} : { policyGates: gates }),
    },
    DEFAULT_ENGINE_BOUNDS,
  );
  return { engine, executor, clock, sentEnvelopes, dlqSent, mock };
}

/** Fake queue binding + fake delivered messages for the REAL entrypoints. */
function fakeQueueBinding(): { queue: Queue; sent: QueueEnvelope[] } {
  const sent: QueueEnvelope[] = [];
  return {
    queue: { send: async (body: QueueEnvelope) => void sent.push(body) } as unknown as Queue,
    sent,
  };
}

interface FakeMessage extends Message {
  acked: boolean;
  retried: boolean;
  retryOptions?: { delaySeconds?: number };
}

function fakeMessage(id: string, body: unknown): FakeMessage {
  const message = {
    id,
    body,
    acked: false,
    retried: false,
    retryOptions: undefined as { delaySeconds?: number } | undefined,
    ack() {
      message.acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      message.retried = true;
      message.retryOptions = options;
    },
  };
  return message as unknown as FakeMessage;
}

function fakeBatch(messages: FakeMessage[]): MessageBatch<unknown> {
  return {
    queue: 'pixel-jobs-preview',
    messages,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<unknown>;
}

function entrypointEnv(
  jobsQueue: Queue,
  dlqQueue: Queue,
  overrides: Partial<WorkerEnv> = {},
): WorkerEnv {
  return {
    ...createTestEnv(),
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'false',
    DB: env.DB,
    JOBS: jobsQueue,
    DLQ: dlqQueue,
    ...overrides,
  } as WorkerEnv;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM budgets WHERE scope='ingestion'").run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'jobs_maintenance:%'").run();
});

describe('consumer pause — production resolution (the D01 contract)', () => {
  it('acks a delivered paused poll as paused_by_policy BEFORE the claim — durable row byte-identical', async () => {
    const h = createResolvedHarness('false');
    const created = await h.engine.createDurableJob({
      type: 'sources.fetch_poll',
      idempotencyKey: 'd01-off-1',
      payload: POLL_PAYLOAD,
    });
    if (created.kind !== 'created') throw new Error('job creation failed');
    const before = await readJobRow(h.executor, created.jobId);
    expect(before.status).toBe('pending');

    await expect(h.engine.consumeMessage('m1', pollEnvelope(created.jobId))).resolves.toEqual({
      action: 'ack',
      outcome: 'paused_by_policy',
    });

    // ZERO durable writes: the full row is byte-identical after the pause.
    expect(await readJobRow(h.executor, created.jobId)).toEqual(before);
  });

  it('repeated OFF cycles perform zero durable writes — attempts=max−1 and error info preserved', async () => {
    const h = createResolvedHarness('false');
    const id = await seedJob(h.executor, {
      id: 'd01-near-final',
      status: 'retry_wait',
      attempts: 2,
      maxAttempts: 3,
    });
    await h.executor.run({
      sql: "UPDATE jobs SET last_error = 'ingestion_connector_unavailable' WHERE id = ?",
      params: [id],
    });
    const before = await readJobRow(h.executor, id);
    expect(before.attempts).toBe(2);
    expect(before.max_attempts).toBe(3);
    expect(before.last_error).toBe('ingestion_connector_unavailable');

    for (let cycle = 1; cycle <= 3; cycle++) {
      await expect(h.engine.consumeMessage(`m-${cycle}`, pollEnvelope(id))).resolves.toEqual({
        action: 'ack',
        outcome: 'paused_by_policy',
      });
      expect(await readJobRow(h.executor, id)).toEqual(before);
    }
  });

  it('the DURABLE row type is the pause authority — a forged envelope type can neither bypass nor misapply it', async () => {
    // (a) Durable poll under a heartbeat-typed envelope: still paused.
    const off = createResolvedHarness('false');
    const pollId = await seedJob(off.executor, { id: 'd01-forged-1' });
    await expect(
      off.engine.consumeMessage('m1', pollEnvelope(pollId, 1, 'jobs.maintenance_heartbeat')),
    ).resolves.toEqual({ action: 'ack', outcome: 'paused_by_policy' });
    expect((await readJobRow(off.executor, pollId)).status).toBe('pending');

    // (b) Durable heartbeat under a poll-typed envelope with the gate ON:
    //     NOT paused — the enabled durable type executes normally.
    const on = createResolvedHarness('true');
    const beatId = await seedJob(on.executor, {
      id: 'd01-forged-2',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
    });
    await expect(
      on.engine.consumeMessage('m2', pollEnvelope(beatId, 1, 'sources.fetch_poll')),
    ).resolves.toEqual({ action: 'ack', outcome: 'job_completed' });
    expect((await readJobRow(on.executor, beatId)).status).toBe('succeeded');
  });

  it('unknown and malformed messages keep their explicit poison classes (unchanged)', async () => {
    const h = createResolvedHarness('false');
    const unknownId = await seedJob(h.executor, {
      id: 'd01-unknown',
      type: 'future.not_implemented',
      payload: '{}',
    });
    await expect(h.engine.consumeMessage('m1', pollEnvelope(unknownId))).resolves.toEqual({
      action: 'ack',
      outcome: 'poisoned_job_type_unregistered',
    });
    const row = await readJobRow(h.executor, unknownId);
    expect(row.status).toBe('dead_letter');
    expect(row.last_error).toBe('job_type_unregistered');

    const action = await h.engine.consumeMessage('m2', { version: 1 });
    expect(action.action).toBe('ack');
    expect(action.outcome.startsWith('poison_')).toBe(true);
  });

  it('policy ON with a missing handler is a DISTINCT visible handler_misconfigured class — never a silent pause', async () => {
    // Gate ON but the deployment did not register the poll handler: a
    // wiring bug. Pre-claim poison with the DISTINCT code (no attempt burn).
    const harness = createPolicyHarness({ ingestionGateOn: true });
    const miswired = createJobsEngine(
      {
        executor: harness.executor,
        handlers: createJobHandlerRegistry([]),
        idGenerator: { newId: () => 'miswired' },
        clock: harness.clock,
        random: () => 0.5,
        policyGates: { ingestionGateOn: true },
      },
      DEFAULT_ENGINE_BOUNDS,
    );
    const id = await seedJob(harness.executor, { id: 'd01-miswired' });
    await expect(miswired.consumeMessage('m1', pollEnvelope(id))).resolves.toEqual({
      action: 'ack',
      outcome: 'poisoned_handler_misconfigured',
    });
    const row = await readJobRow(harness.executor, id);
    expect(row.status).toBe('dead_letter');
    expect(row.last_error).toBe('handler_misconfigured');
    expect(row.attempts).toBe(0); // pre-claim — the attempt budget is intact
    expect(row.dlq_delivered_at ?? null).toBeNull();
  });

  it('the pause takes precedence over the misconfiguration probe (paused type with no handler)', async () => {
    // The resolved OFF engine never registers the poll handler — a paused
    // type with a missing handler is EXPECTED gate-off operation.
    const h = createResolvedHarness('false');
    const id = await seedJob(h.executor, { id: 'd01-precedence' });
    await expect(h.engine.consumeMessage('m3', pollEnvelope(id))).resolves.toEqual({
      action: 'ack',
      outcome: 'paused_by_policy',
    });
    const row = await readJobRow(h.executor, id);
    expect(row.status).toBe('pending');
    expect(row.last_error ?? null).toBeNull();
  });

  it('invalid gate values fail closed and JOBS_ENABLED=false stays disabled', () => {
    const invalid = resolveJobsEngine({
      DB: env.DB,
      JOBS_ENABLED: 'true',
      SOURCE_INGESTION_ENABLED: 'yes',
      JOBS: { send: async () => {} },
      DLQ: { send: async () => {} },
    } as unknown as WorkerEnv);
    expect(invalid.kind).toBe('config_invalid');

    const disabled = resolveJobsEngine({
      DB: env.DB,
      JOBS_ENABLED: 'false',
      SOURCE_INGESTION_ENABLED: 'false',
    } as unknown as WorkerEnv);
    expect(disabled.kind).toBe('disabled');
  });
});

describe('dispatch-side pause — SQL exclusion and fairness', () => {
  it('a page full of paused rows cannot starve enabled work — paused rows consume ZERO scan slots', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    for (let i = 0; i < 25; i++) {
      await seedJob(h.executor, { id: `paused-${String(i).padStart(2, '0')}` });
    }
    const beatId = await seedJob(h.executor, {
      id: 'enabled-heartbeat',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
    });

    const summary = await h.engine.dispatchDueJobs();

    // The heartbeat is dispatched in the FIRST pass; the 25 paused rows are
    // invisible to the due page (SQL exclusion) and only counted.
    expect(summary.dueScanned).toBe(1);
    expect(summary.dispatched).toBe(1);
    expect(summary.policyPaused).toBe(25);
    expect(summary.poisonedUnregistered).toBe(0);
    expect(summary.misconfiguredPoisoned).toBe(0);
    expect(h.sentEnvelopes).toHaveLength(1);
    expect(h.sentEnvelopes[0]?.jobId).toBe(beatId);
    expect(h.sentEnvelopes[0]?.type).toBe('jobs.maintenance_heartbeat');

    // Every paused row is byte-identical: no send, no status write, no time.
    for (let i = 0; i < 25; i++) {
      const row = await readJobRow(h.executor, `paused-${String(i).padStart(2, '0')}`);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.updated_at).toBe(NOW);
    }
    expect((await readJobRow(h.executor, beatId)).status).toBe('queued');
  });

  it('stranded queued paused rows never re-dispatch while OFF; enabled stranded work still does', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    const pausedId = await seedJob(h.executor, {
      id: 'stranded-paused',
      status: 'queued',
      attempts: 1,
      updatedAt: NOW - 61_000,
    });
    const beatId = await seedJob(h.executor, {
      id: 'stranded-heartbeat',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
      status: 'queued',
      updatedAt: NOW - 61_000,
    });

    const summary = await h.engine.dispatchDueJobs();
    expect(summary.strandedScanned).toBe(1);
    expect(summary.dispatched).toBe(1);
    expect(summary.policyPaused).toBe(0); // paused row was never in the page
    expect(h.sentEnvelopes.map((e) => e.jobId)).toEqual([beatId]);
    const pausedRow = await readJobRow(h.executor, pausedId);
    expect(pausedRow.status).toBe('queued');
    expect(pausedRow.updated_at).toBe(NOW - 61_000); // untouched

    // Once the gate is ON the SAME stranded row re-dispatches past grace.
    const on = createPolicyHarness({ ingestionGateOn: true });
    const resumed = await on.engine.dispatchDueJobs();
    expect(resumed.strandedScanned).toBe(1);
    expect(resumed.dispatched).toBe(1);
    expect(on.sentEnvelopes.map((e) => e.jobId)).toEqual([pausedId]);
  });

  it('gate ON resumes paused due work through the same bounded page (bounded, honest)', async () => {
    const off = createPolicyHarness({ ingestionGateOn: false });
    for (let i = 0; i < 24; i++) {
      await seedJob(off.executor, { id: `resume-${String(i).padStart(2, '0')}` });
    }
    const beatId = await seedJob(off.executor, {
      id: 'resume-heartbeat',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
    });
    const offSummary = await off.engine.dispatchDueJobs();
    expect(offSummary.dispatched).toBe(1);
    expect(offSummary.policyPaused).toBe(24);

    const on = createPolicyHarness({ ingestionGateOn: true });
    const onSummary = await on.engine.dispatchDueJobs();
    // All 24 paused polls resume through the SAME bounded page. The
    // heartbeat is NOT part of this page: it was already dispatched during
    // OFF (status queued, waiting on the queue consumer) — no duplicate send.
    expect(onSummary.dueScanned).toBe(24);
    expect(onSummary.dispatched).toBe(24);
    expect(onSummary.policyPaused).toBe(0);
    const sentIds = new Set(on.sentEnvelopes.map((e) => e.jobId));
    expect(sentIds.has(beatId)).toBe(false);
    for (let i = 0; i < 24; i++) {
      expect(sentIds).toContain(`resume-${String(i).padStart(2, '0')}`);
    }
  });
});

describe('policy-aware expired-claim recovery (B2)', () => {
  it('paused expired FINAL claims are never dead-lettered while OFF — dormant, exactly once nothing', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    const id = await seedJob(h.executor, {
      id: 'dormant-final',
      status: 'claimed',
      attempts: 3,
      maxAttempts: 3,
      leaseUntil: NOW - 1000,
    });
    const before = await readJobRow(h.executor, id);

    const summary = await h.engine.dispatchDueJobs();
    expect(summary.reclaimedLeases).toBe(0);
    expect(summary.reclaimedExhausted).toBe(0);
    expect(summary.pausedExpiredObserved).toBe(1);
    expect(await readJobRow(h.executor, id)).toEqual(before); // byte-identical

    // Never visible to DLQ reconciliation — no dead-letter happened.
    const dlq = await h.engine.reconcileDeadLetters();
    expect(dlq.scanned).toBe(0);
    expect(h.dlqSent).toHaveLength(0);
  });

  it('paused expired near-final claims stay dormant across repeated OFF passes — attempts and error intact', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    const id = await seedJob(h.executor, {
      id: 'dormant-near-final',
      status: 'claimed',
      attempts: 2,
      maxAttempts: 3,
      leaseUntil: NOW - 1000,
    });
    await h.executor.run({
      sql: "UPDATE jobs SET last_error = 'job_handler_retryable_error' WHERE id = ?",
      params: [id],
    });
    const before = await readJobRow(h.executor, id);

    for (let pass = 1; pass <= 3; pass++) {
      const summary = await h.engine.dispatchDueJobs();
      expect(summary.reclaimedLeases).toBe(0);
      expect(summary.reclaimedExhausted).toBe(0);
      expect(summary.pausedExpiredObserved).toBe(1);
      expect(await readJobRow(h.executor, id)).toEqual(before);
    }
  });

  it('paused expired claims never consume active recovery scan slots — enabled work is recovered in the FIRST page', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    // 25 paused expired claims with EARLIER leases: without the SQL
    // exclusion they would fill the entire reclaimBatch page ahead of the
    // enabled heartbeat (head-of-line delay — the CE3 counterexample).
    for (let i = 0; i < 25; i++) {
      await seedJob(h.executor, {
        id: `dormant-${String(i).padStart(2, '0')}`,
        status: 'claimed',
        leaseUntil: NOW - 2000,
      });
    }
    const beatId = await seedJob(h.executor, {
      id: 'enabled-expired',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
      status: 'claimed',
      leaseUntil: NOW - 1000,
    });

    const summary = await h.engine.dispatchDueJobs();
    expect(summary.reclaimedLeases).toBe(1);
    expect(summary.pausedExpiredObserved).toBe(25);
    // Honest resume bounds: the recovered claim becomes queued and waits the
    // stranded-queue grace — it does NOT dispatch on the same pass.
    expect(h.sentEnvelopes).toHaveLength(0);
    expect((await readJobRow(h.executor, beatId)).status).toBe('queued');
    for (let i = 0; i < 25; i++) {
      const row = await readJobRow(h.executor, `dormant-${String(i).padStart(2, '0')}`);
      expect(row.status).toBe('claimed');
      expect(row.lease_until).toBe(NOW - 2000); // dormant, untouched
    }
  });

  it('ON: the dormant near-final claim resumes with only its ACTUAL final claim increment and completes', async () => {
    const off = createPolicyHarness({ ingestionGateOn: false });
    await seedEnabledSource(off.executor);
    const id = await seedJob(off.executor, {
      id: 'resume-final-attempt',
      status: 'claimed',
      attempts: 2,
      maxAttempts: 3,
      leaseUntil: NOW - 1000,
    });
    await off.executor.run({
      sql: "UPDATE jobs SET last_error = 'job_handler_retryable_error' WHERE id = ?",
      params: [id],
    });
    // Dormant during OFF: no recovery rewrite, no attempt movement.
    const dormant = await off.engine.dispatchDueJobs();
    expect(dormant.pausedExpiredObserved).toBe(1);
    expect(dormant.reclaimedLeases).toBe(0);
    expect((await readJobRow(off.executor, id)).attempts).toBe(2);

    // Gate ON: ordinary recovery requeues the claim (budget intact)...
    const on = createPolicyHarness({ ingestionGateOn: true });
    on.mock.setResponses([{ status: 200, bodyText: VALID_FEED }]);
    const reclaimPass = await on.engine.dispatchDueJobs();
    expect(reclaimPass.reclaimedLeases).toBe(1);
    expect(reclaimPass.reclaimedExhausted).toBe(0);
    const queued = await readJobRow(on.executor, id);
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(2); // recovery NEVER writes attempts

    // ...the recovered row waits the stranded-queue grace (honest resume
    // bounds — it does NOT dispatch on the same pass)...
    const gracePass = await on.engine.dispatchDueJobs();
    expect(gracePass.dispatched).toBe(0);
    expect(on.sentEnvelopes).toHaveLength(0);

    // ...then dispatches past the grace and completes with ONE final claim.
    on.clock.advance(61_000);
    const dispatchPass = await on.engine.dispatchDueJobs();
    expect(dispatchPass.dispatched).toBe(1);
    expect(on.sentEnvelopes).toHaveLength(1);
    await expect(on.engine.consumeMessage('m1', on.sentEnvelopes[0])).resolves.toEqual({
      action: 'ack',
      outcome: 'job_completed',
    });
    const final = await readJobRow(on.executor, id);
    expect(final.status).toBe('succeeded');
    expect(final.attempts).toBe(3); // the ACTUAL final execution generation
    expect(final.lease_until ?? null).toBeNull();
  });

  it('ON: a genuinely exhausted dormant claim dead-letters exactly once through ordinary exhaustion', async () => {
    const h = createPolicyHarness({ ingestionGateOn: true });
    const id = await seedJob(h.executor, {
      id: 'exhausted-dormant',
      status: 'claimed',
      attempts: 3,
      maxAttempts: 3,
      leaseUntil: NOW - 1000,
    });

    const pass = await h.engine.dispatchDueJobs();
    expect(pass.reclaimedExhausted).toBe(1);
    expect(pass.reclaimedLeases).toBe(0);
    const row = await readJobRow(h.executor, id);
    expect(row.status).toBe('dead_letter');
    expect(row.last_error).toBe('job_exhausted');
    expect(row.attempts).toBe(3); // preserved — never reset or incremented
    expect(row.dlq_delivered_at ?? null).toBeNull();

    // Exactly once: visible to reconciliation, delivered, then silent.
    const dlq = await h.engine.reconcileDeadLetters();
    expect(dlq.delivered).toBe(1);
    expect(h.dlqSent).toHaveLength(1);
    expect(h.dlqSent[0]?.jobId).toBe(id);
    const again = await h.engine.reconcileDeadLetters();
    expect(again.scanned).toBe(0);
    const later = await h.engine.dispatchDueJobs();
    expect(later.reclaimedExhausted).toBe(0); // terminal rows are never re-judged
    expect((await readJobRow(h.executor, id)).status).toBe('dead_letter');
  });

  it('already-terminal rows remain terminal regardless of the gate', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    const succeededId = await seedJob(h.executor, {
      id: 'terminal-succeeded',
      status: 'succeeded',
      attempts: 1,
    });
    const deadId = await seedJob(h.executor, {
      id: 'terminal-dead',
      status: 'dead_letter',
      attempts: 3,
    });
    await h.executor.run({
      sql: "UPDATE jobs SET last_error = 'job_exhausted' WHERE id = ?",
      params: [deadId],
    });
    const cancelledId = await seedJob(h.executor, {
      id: 'terminal-cancelled',
      status: 'cancelled',
    });
    const succeededBefore = await readJobRow(h.executor, succeededId);
    const deadBefore = await readJobRow(h.executor, deadId);
    const cancelledBefore = await readJobRow(h.executor, cancelledId);

    // OFF dispatch leaves terminals untouched; redeliveries ack their
    // unchanged safe classes.
    const summary = await h.engine.dispatchDueJobs();
    expect(summary.dueScanned).toBe(0);
    expect(summary.reclaimedExhausted).toBe(0);
    expect(await readJobRow(h.executor, succeededId)).toEqual(succeededBefore);
    expect(await readJobRow(h.executor, deadId)).toEqual(deadBefore);
    expect(await readJobRow(h.executor, cancelledId)).toEqual(cancelledBefore);
    await expect(h.engine.consumeMessage('m1', pollEnvelope(succeededId))).resolves.toEqual({
      action: 'ack',
      outcome: 'duplicate_completed',
    });
    await expect(h.engine.consumeMessage('m2', pollEnvelope(deadId))).resolves.toEqual({
      action: 'ack',
      outcome: 'dead_lettered',
    });
    await expect(h.engine.consumeMessage('m3', pollEnvelope(cancelledId))).resolves.toEqual({
      action: 'ack',
      outcome: 'cancelled',
    });

    // ON dispatch never resurrects a terminal row.
    const on = createPolicyHarness({ ingestionGateOn: true });
    const onSummary = await on.engine.dispatchDueJobs();
    expect(onSummary.dueScanned).toBe(0);
    expect(onSummary.dispatched).toBe(0);
    expect(onSummary.reclaimedExhausted).toBe(0);
    expect(await readJobRow(on.executor, deadId)).toEqual(deadBefore);
  });
});

describe('OFF economics — durable work is preserved, never rewritten or dropped', () => {
  it('retry_wait error information survives OFF passes intact and resumes when ON', async () => {
    const off = createPolicyHarness({ ingestionGateOn: false });
    const id = await seedJob(off.executor, {
      id: 'retry-paused',
      status: 'retry_wait',
      runAfter: NOW,
    });
    await off.executor.run({
      sql: "UPDATE jobs SET last_error = 'ingestion_connector_unavailable' WHERE id = ?",
      params: [id],
    });
    const before = await readJobRow(off.executor, id);

    const offSummary = await off.engine.dispatchDueJobs();
    expect(offSummary.dueScanned).toBe(0);
    expect(offSummary.policyPaused).toBe(1);
    expect(await readJobRow(off.executor, id)).toEqual(before);

    const on = createPolicyHarness({ ingestionGateOn: true });
    const onSummary = await on.engine.dispatchDueJobs();
    expect(onSummary.dueScanned).toBe(1);
    expect(onSummary.dispatched).toBe(1);
    expect(on.sentEnvelopes.map((e) => e.jobId)).toEqual([id]);
    const resumed = await readJobRow(on.executor, id);
    expect(resumed.status).toBe('queued');
    expect(resumed.last_error).toBe('ingestion_connector_unavailable'); // preserved
  });

  it('no number of OFF passes creates DLQ work for paused rows', async () => {
    const h = createPolicyHarness({ ingestionGateOn: false });
    await seedJob(h.executor, {
      id: 'dlq-check-pending',
      status: 'pending',
    });
    await seedJob(h.executor, {
      id: 'dlq-check-dormant',
      status: 'claimed',
      attempts: 3,
      maxAttempts: 3,
      leaseUntil: NOW - 1000,
    });
    for (let pass = 1; pass <= 3; pass++) {
      await h.engine.dispatchDueJobs();
      const dlq = await h.engine.reconcileDeadLetters();
      expect(dlq.scanned).toBe(0);
      expect(h.dlqSent).toHaveLength(0);
    }
    const statuses = await h.executor.query<{ status: string }>({
      sql: 'SELECT status FROM jobs ORDER BY id ASC',
    });
    expect(statuses.rows.map((r) => r.status).sort()).toEqual(['claimed', 'pending']);
  });
});

describe('entrypoints — production cron/queue wiring (gate OFF)', () => {
  it('cron (gate OFF) dispatches only enabled types and spends no ingestion budget', async () => {
    const jobs = fakeQueueBinding();
    const dlq = fakeQueueBinding();
    const executor = createDbExecutor(env.DB);
    await seedJob(executor, { id: 'cron-paused-poll', runAfter: 0 });
    await seedJob(executor, {
      id: 'cron-heartbeat',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
      runAfter: 0,
    });

    await worker.scheduled(
      createTestScheduledController('*/5 * * * *', NOW),
      entrypointEnv(jobs.queue, dlq.queue),
      createTestExecutionContext(),
    );

    // Only the enabled type went to the queue; the paused poll stayed
    // durable and untouched; no ingestion budget was spent.
    expect(jobs.sent).toHaveLength(1);
    expect(jobs.sent[0]?.type).toBe('jobs.maintenance_heartbeat');
    const pollRow = await readJobRow(executor, 'cron-paused-poll');
    expect(pollRow.status).toBe('pending');
    expect(pollRow.attempts).toBe(0);
    const budgets = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM budgets WHERE scope='ingestion'",
    ).first<{ n: number }>();
    expect(budgets?.n).toBe(0);
  });

  it('queue (gate OFF) acks the paused poll delivery and completes enabled work in the same batch — no dropped durable jobs', async () => {
    const jobs = fakeQueueBinding();
    const dlq = fakeQueueBinding();
    const envOff = entrypointEnv(jobs.queue, dlq.queue);
    const executor = createDbExecutor(env.DB);
    const pollId = await seedJob(executor, { id: 'queue-paused-poll' });
    const beatId = await seedJob(executor, {
      id: 'queue-heartbeat',
      type: 'jobs.maintenance_heartbeat',
      payload: '{}',
    });
    const pollBefore = await readJobRow(executor, pollId);

    const pollMessage = fakeMessage('qmsg-1', pollEnvelope(pollId));
    const beatMessage = fakeMessage(
      'qmsg-2',
      pollEnvelope(beatId, 1, 'jobs.maintenance_heartbeat'),
    );
    await worker.queue(fakeBatch([pollMessage, beatMessage]), envOff, createTestExecutionContext());

    // Paused poll: ACKED (not retried into a hot loop), zero durable writes.
    expect(pollMessage.acked).toBe(true);
    expect(pollMessage.retried).toBe(false);
    expect(await readJobRow(executor, pollId)).toEqual(pollBefore);
    // Enabled work in the SAME batch completed durably.
    expect(beatMessage.acked).toBe(true);
    expect((await readJobRow(executor, beatId)).status).toBe('succeeded');
    // No poll network/ingestion-budget use while OFF.
    const budgets = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM budgets WHERE scope='ingestion'",
    ).first<{ n: number }>();
    expect(budgets?.n).toBe(0);
  });

  it('global JOBS_ENABLED=false still retries delivered queue work (never ACK-drops)', async () => {
    const jobs = fakeQueueBinding();
    const dlq = fakeQueueBinding();
    const envDisabled = entrypointEnv(jobs.queue, dlq.queue, { JOBS_ENABLED: 'false' });
    const executor = createDbExecutor(env.DB);
    const pollId = await seedJob(executor, { id: 'disabled-poll' });
    const before = await readJobRow(executor, pollId);

    const message = fakeMessage('qmsg-3', pollEnvelope(pollId));
    await worker.queue(fakeBatch([message]), envDisabled, createTestExecutionContext());

    expect(message.acked).toBe(false);
    expect(message.retried).toBe(true);
    expect(await readJobRow(executor, pollId)).toEqual(before);
  });

  it('present-but-invalid gate value fails closed at the queue entrypoint (messages retry)', async () => {
    const jobs = fakeQueueBinding();
    const dlq = fakeQueueBinding();
    const envInvalid = entrypointEnv(jobs.queue, dlq.queue, {
      SOURCE_INGESTION_ENABLED: 'yes',
    });
    const executor = createDbExecutor(env.DB);
    const pollId = await seedJob(executor, { id: 'invalid-flag-poll' });
    const before = await readJobRow(executor, pollId);

    const message = fakeMessage('qmsg-4', pollEnvelope(pollId));
    await worker.queue(fakeBatch([message]), envInvalid, createTestExecutionContext());

    expect(message.acked).toBe(false);
    expect(message.retried).toBe(true);
    expect(await readJobRow(executor, pollId)).toEqual(before);
  });
});
