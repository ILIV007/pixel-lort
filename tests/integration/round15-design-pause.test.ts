/**
 * ROUND 1.5 DESIGN LAB — disabled-by-policy pause proofs on REAL workerd D1.
 *
 * These proofs run on the CURRENT schema 3 (the default accepted migration
 * set 0001–0003) — the pause design is DDL-INDEPENDENT, and this file is
 * itself the proof of that claim.
 *
 * What these proofs DO prove (design document §5/§8):
 *  - the D01 semantics: with the ingestion gate OFF a delivered poll job is
 *    acknowledged `paused_by_policy` BEFORE the atomic claim — the durable
 *    row stays pending, `attempts` never moves, and the row is NEVER
 *    poisoned or dead-lettered (Round 1.5 instruction 5);
 *  - OFF cycles are lossless and write-free; a near-exhausted row
 *    (`attempts = max−1`) can never be dead-lettered by pauses; expired
 *    claims of PAUSED types stay claimed (dormant, zero mutations) during
 *    OFF — the policy precedes recovery/exhaustion handling (Round 1.5.1
 *    B2 correction) — and resume under ordinary attempt economics when ON;
 *  - dispatch fairness: policy-paused types are excluded from the candidate
 *    scans IN SQL — a page full of paused rows cannot starve other types;
 *  - bounded resumption: with the gate back ON the very next dispatch pass
 *    resumes the paused rows (≤ 1 cron interval);
 *  - the three failure classes stay DISTINCT: unknown type poisons
 *    `job_type_unregistered` (unchanged); a schema-known type with a missing
 *    handler and no policy pause poisons `handler_misconfigured` (a visible
 *    wiring bug); a policy-mapped type with its gate OFF pauses (expected
 *    operation, policy precedence BEFORE the misconfiguration probe);
 *  - cancellation is NOT dead-lettering: the guarded `cancelled` transition
 *    is terminal, invisible to the DLQ reconciliation scan, and honoured by
 *    consumers.
 *
 * What these proofs DO NOT prove: product behavior (nothing under `src/`
 * changed; the shipped D01 failure remains exactly as accepted — RED), and
 * multi-isolate concurrency (single-isolate workerd; D1 batch atomicity is
 * delegated to the established accepted evidence).
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { claimJob, scanPendingDlqDeliveries } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import {
  consumeWithPolicy,
  dispatchPassWithPolicy,
  type DesignDispatchSummary,
} from '../design/round15-lab-pipeline';
import { cancelSupersededPollJob } from '../design/round15-ownership';

const NOW = 1_771_000_000_000;
const INTERVAL = 3_600;
const SOURCE = 'playstation_blog';
const db = createDbExecutor(env.DB);

const POLL_OFF = { ingestionGateOn: false };
const POLL_ON = { ingestionGateOn: true };

async function insertJob(input: {
  type: string;
  aggregateId?: string | null;
  payloadJson: string;
  status?: string;
  attempts?: number;
  maxAttempts?: number;
  runAfterMs?: number;
}): Promise<string> {
  const id = cryptoIdGenerator.newId();
  await db.run({
    sql: `INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority,
                             run_after, attempts, max_attempts, lease_until,
                             idempotency_key, payload_json, last_error, created_at,
                             updated_at, dlq_delivered_at)
          VALUES (?, ?, 'source', ?, ?, 40, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL)`,
    params: [
      id,
      input.type,
      input.aggregateId ?? null,
      input.status ?? 'pending',
      input.runAfterMs ?? NOW,
      input.attempts ?? 0,
      input.maxAttempts ?? 3,
      `key:${id}`,
      input.payloadJson,
      NOW,
      NOW,
    ],
  });
  return id;
}

const pollJob = (sourceId = SOURCE, scheduledForMs = 0) =>
  canonicalizeJson({ sourceId, scheduledForMs });

async function readJob(id: string) {
  return (await db.first<{
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    dlq_delivered_at: number | null;
    updated_at: number;
  }>({
    sql: 'SELECT status, attempts, max_attempts, last_error, dlq_delivered_at, updated_at FROM jobs WHERE id = ?',
    params: [id],
  }))!;
}

async function seedSource(sourceId = SOURCE): Promise<void> {
  await db.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled,
                                interval_seconds, priority, daily_request_budget,
                                approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'PS Blog', 'rss', 'official', 80, 1, ?, 50, 100, 'auto', '{}', ?, ?)`,
    params: [sourceId, INTERVAL, NOW, NOW],
  });
  await db.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                     requests_today, updated_at)
          VALUES (?, 0, 0, 0, ?)`,
    params: [sourceId, NOW],
  });
}

let fetchCalls = 0;

/**
 * STUB poll handler for the resume paths: the pause design is
 * DDL-INDEPENDENT and runs on schema 3, so these proofs gate a SIMPLE
 * counting handler — the full ownership-design handler is exercised on the
 * schema-4 lab (round15-design-ownership / round15-design-recovery).
 */
function buildPollHandler(): never {
  fetchCalls = 0;
  return {
    type: 'sources.fetch_poll',
    execute: async () => {
      fetchCalls += 1;
      return { kind: 'success' };
    },
  } as never;
}

function pollHandlers(): ReturnType<typeof createJobHandlerRegistry> {
  return createJobHandlerRegistry([buildPollHandler()]);
}

const heartbeatStub = {
  type: 'jobs.maintenance_heartbeat',
  execute: async () => ({ kind: 'success' }),
} as never;

/** Poll + heartbeat handlers (a FULLY wired deployment for gate-ON passes). */
function allHandlers(): ReturnType<typeof createJobHandlerRegistry> {
  return createJobHandlerRegistry([buildPollHandler(), heartbeatStub]);
}

const heartbeatHandlers = () =>
  createJobHandlerRegistry([
    {
      type: 'jobs.maintenance_heartbeat',
      execute: async () => ({ kind: 'success' }),
    } as never,
  ]);

const envelopeFor = (jobId: string, type: string, attempt = 1) => ({
  version: 1 as const,
  jobId,
  type,
  attempt,
  traceId: 'lab-trace',
});

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs']) {
    await db.run({ sql: `DELETE FROM ${table}` });
  }
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
});

it('P-P1: gate OFF — the delivery is paused BEFORE the claim; the row is never poisoned', async () => {
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_OFF },
    'msg-1',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW,
  );
  // The D01 semantics: acknowledged pause, NOT a dead letter.
  expect(action).toEqual({ action: 'ack', outcome: 'paused_by_policy' });
  const row = await readJob(jobId);
  expect(row.status).toBe('pending'); // paused by policy — still pending
  expect(row.attempts).toBe(0); // no attempt burn (pause is pre-claim)
  expect(row.last_error).toBeNull(); // no poison code, no error
  expect(row.dlq_delivered_at).toBeNull(); // never enters the DLQ path
});

it('P-P2: gate ON — the very next dispatch pass resumes and executes the poll', async () => {
  await seedSource();
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  // Pause first (gate off), then flip the gate on.
  await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_OFF },
    'msg-1',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW,
  );
  expect((await readJob(jobId)).status).toBe('pending');
  // Dispatch pass with the gate ON: the row is due and is sent.
  const sent: string[] = [];
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers: pollHandlers(),
    producer: {
      send: async (envelope) => {
        sent.push(envelope.jobId);
      },
    },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
  });
  expect(summary.dispatched).toBe(1);
  expect(sent).toEqual([jobId]);
  expect(summary.policyPaused).toBe(0);
  // The delivery executes the (stub) poll handler end-to-end.
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-2',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1); // the handler executed exactly once
  const row = await readJob(jobId);
  expect(row.status).toBe('succeeded');
});

it('P-P3: three OFF cycles are lossless and write-free; resumption still works', async () => {
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  const before = await readJob(jobId);
  for (let cycle = 1; cycle <= 3; cycle++) {
    const action = await consumeWithPolicy(
      { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_OFF },
      `msg-off-${cycle}`,
      envelopeFor(jobId, 'sources.fetch_poll'),
      NOW + cycle * 1_000,
    );
    expect(action).toEqual({ action: 'ack', outcome: 'paused_by_policy' });
    const after = await readJob(jobId);
    // BIT-IDENTICAL: the pause performs NO durable write at all.
    expect(after).toEqual(before);
  }
  // Gate ON: dispatch + execute succeed (nothing was lost or degraded).
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers: pollHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 10_000,
    gates: POLL_ON,
  });
  expect(summary.dispatched).toBe(1);
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-on',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW + 11_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
});

it('P-P4: a near-exhausted row is never dead-lettered by pauses', async () => {
  await seedSource();
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
    attempts: 2,
    maxAttempts: 3,
  });
  // OFF: paused (pre-claim), attempts untouched, NOT dead-lettered.
  const paused = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_OFF },
    'msg-1',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW,
  );
  expect(paused).toEqual({ action: 'ack', outcome: 'paused_by_policy' });
  expect((await readJob(jobId)).status).toBe('pending');
  expect((await readJob(jobId)).attempts).toBe(2);
  // ON: the FINAL attempt executes normally (the pause never pre-empted it).
  await dispatchPassWithPolicy({
    executor: db,
    handlers: pollHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-2',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  const row = await readJob(jobId);
  expect(row.status).toBe('succeeded');
  expect(row.attempts).toBe(3);
});

/**
 * ROUND 1.5.1 SUPERSESSION NOTE (P-P5 — documented, not silent).
 *
 * The ORIGINAL Round 1.5 P-P5 asserted the superseded recovery behavior:
 *   `expect(offSummary.reclaimedLeases).toBe(1)` and
 *   `expect(rowDuringOff.status).toBe('queued')` — i.e. an expired claim of
 *   a PAUSED type was RECLAIMED to `queued` during a gate-OFF pass.
 *
 * The independent review's counterexamples CE2/CE3 (and the Round 1.5.1
 * instructions, item 3) supersede exactly that behavior: the pause policy
 * must precede exhaustion handling and candidate selection in the RECOVERY
 * path, paused expired claims must not be requeued/dead-lettered during OFF,
 * and they must not consume active recovery scan slots. P-P5 below asserts
 * the CORRECTED contract for the SAME scenario (proof identity retained;
 * nothing weakened — the OFF-side assertions are STRICTER: zero recovery
 * mutations and a fully untouched row). The full OFF/ON recovery register
 * (attempts=max, max−1, cycles, fairness, terminal rows) lives in
 * `round15-design-recovery-policy.test.ts`.
 */
it('P-P5 (corrected): an expired claim of a PAUSED type stays claimed during OFF and is recovered when ON', async () => {
  await seedSource();
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  // Simulate an in-flight execution whose worker died: claimed, lease expired.
  await claimJob(db, jobId, NOW);
  await db.run({
    sql: 'UPDATE jobs SET lease_until = ? WHERE id = ?',
    params: [NOW - 5_000, jobId],
  });
  const before = await readJob(jobId);
  // OFF dispatch pass: policy-aware recovery — the paused type is resolved
  // BEFORE selection: NOT reclaimed, NOT dead-lettered, ZERO mutations.
  const offSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: pollHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_OFF,
  });
  expect(offSummary.reclaimedLeases).toBe(0);
  expect(offSummary.reclaimedExhausted).toBe(0);
  expect(offSummary.pausedExpiredObserved).toBe(1);
  expect(offSummary.dispatched).toBe(0);
  const rowDuringOff = await readJob(jobId);
  expect(rowDuringOff.status).toBe('claimed'); // dormant, NOT queued, NOT terminal
  expect(rowDuringOff.attempts).toBe(before.attempts); // attempts preserved exactly
  expect(rowDuringOff.last_error).toBe(before.last_error); // no error written
  expect(rowDuringOff.updated_at).toBe(before.updated_at); // the pass wrote NOTHING
  // ON dispatch pass (grace 0): the row is no longer excluded — the ordinary
  // recovery economics apply (budget intact → queued), then it is sent.
  const onSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: pollHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
    dispatchGraceMs: 0,
  });
  expect(onSummary.reclaimedLeases).toBe(1);
  expect(onSummary.pausedExpiredObserved).toBe(0);
  expect(onSummary.dispatched).toBe(1);
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-2',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1);
});

it('P-P6: dispatch fairness — 30 paused rows cannot starve other types', async () => {
  const otherIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    await insertJob({
      type: 'sources.fetch_poll',
      aggregateId: `src_${i}`,
      payloadJson: pollJob(`src_${i}`),
    });
  }
  for (let i = 0; i < 5; i++) {
    otherIds.push(
      await insertJob({
        type: 'jobs.maintenance_heartbeat',
        aggregateId: null,
        payloadJson: canonicalizeJson({}),
      }),
    );
  }
  const sent: string[] = [];
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers: heartbeatHandlers(),
    producer: {
      send: async (envelope) => {
        sent.push(envelope.jobId);
      },
    },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_OFF,
    dispatchBatch: 25,
  });
  // The paused rows are excluded IN SQL: they consume ZERO scan slots, so
  // the whole non-gated population fits the page and is dispatched.
  expect(summary.dueScanned).toBe(5);
  expect(summary.dispatched).toBe(5);
  expect(summary.policyPaused).toBe(30);
  expect(sent.sort()).toEqual([...otherIds].sort());
  // Paused rows: untouched, still pending, zero writes.
  const pausedRow = await db.first<{ status: string; attempts: number }>({
    sql: "SELECT status, attempts FROM jobs WHERE type='sources.fetch_poll' LIMIT 1",
  });
  expect(pausedRow!.status).toBe('pending');
  expect(pausedRow!.attempts).toBe(0);
});

it('P-P7: bounded resumption — with the gate ON everything resumes within bounded passes', async () => {
  for (let i = 0; i < 30; i++) {
    await insertJob({
      type: 'sources.fetch_poll',
      aggregateId: `src_${i}`,
      payloadJson: pollJob(`src_${i}`),
    });
  }
  for (let i = 0; i < 5; i++) {
    await insertJob({
      type: 'jobs.maintenance_heartbeat',
      aggregateId: null,
      payloadJson: canonicalizeJson({}),
    });
  }
  const pass1 = await dispatchPassWithPolicy({
    executor: db,
    handlers: allHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_ON,
    dispatchBatch: 25,
  });
  expect(pass1.dispatched).toBe(25);
  expect(pass1.policyPaused).toBe(0);
  // Pass-1 deliveries are consumed (simulated terminal outcomes), so the
  // second pass sees ONLY the remaining 10 due rows: everything resumed
  // within bounded passes (25 per pass, deterministic order).
  await db.run({ sql: "UPDATE jobs SET status = 'succeeded' WHERE status = 'queued'" });
  // Rows are marked queued; the second pass dispatches the remaining 10.
  const pass2 = await dispatchPassWithPolicy({
    executor: db,
    handlers: allHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 61_000,
    gates: POLL_ON,
    dispatchBatch: 25,
    dispatchGraceMs: 0,
  });
  expect(pass2.dispatched).toBe(10);
  const pending = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'",
  });
  expect(pending!.n).toBe(0);
});

it('P-P8: an unknown type still poisons with the DISTINCT accepted code (unchanged)', async () => {
  const jobId = await insertJob({ type: 'unknown.type', aggregateId: null, payloadJson: '{}' });
  // Consumer path: payload parse fails → poison (accepted behavior).
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-1',
    envelopeFor(jobId, 'unknown.type'),
    NOW,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'poisoned_job_type_unregistered' });
  let row = await readJob(jobId);
  expect(row.status).toBe('dead_letter');
  expect(row.last_error).toBe('job_type_unregistered');
  // Dispatch path: same poison at the scan (accepted behavior).
  const jobId2 = await insertJob({ type: 'unknown.type', aggregateId: null, payloadJson: '{}' });
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers: pollHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_ON,
  });
  expect(summary.poisonedUnregistered).toBe(1);
  row = await readJob(jobId2);
  expect(row.status).toBe('dead_letter');
  expect(row.last_error).toBe('job_type_unregistered');
});

it('P-P9: a missing handler WITHOUT a policy pause is a DISTINCT misconfiguration poison', async () => {
  // Schema-known type, gate ON, but THIS deployment registered no handler.
  const jobId = await insertJob({
    type: 'jobs.maintenance_heartbeat',
    aggregateId: null,
    payloadJson: canonicalizeJson({}),
  });
  const action = await consumeWithPolicy(
    {
      executor: db,
      handlers: createJobHandlerRegistry([]),
      idGenerator: cryptoIdGenerator,
      gates: POLL_ON,
    },
    'msg-1',
    envelopeFor(jobId, 'jobs.maintenance_heartbeat'),
    NOW,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'poisoned_handler_misconfigured' });
  const row = await readJob(jobId);
  expect(row.status).toBe('dead_letter');
  expect(row.last_error).toBe('handler_misconfigured'); // NOT job_type_unregistered
  // Dispatch path reports the same distinct class.
  const jobId2 = await insertJob({
    type: 'jobs.maintenance_heartbeat',
    aggregateId: null,
    payloadJson: canonicalizeJson({}),
  });
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers: createJobHandlerRegistry([]),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_ON,
  });
  expect(summary.misconfiguredPoisoned).toBe(1);
  expect((await readJob(jobId2)).last_error).toBe('handler_misconfigured');
});

it('P-P10: policy precedence — a paused type with a missing handler PAUSES (never poisons)', async () => {
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  // Gate OFF + no handler registered: the pause decides FIRST.
  const action = await consumeWithPolicy(
    {
      executor: db,
      handlers: createJobHandlerRegistry([]),
      idGenerator: cryptoIdGenerator,
      gates: POLL_OFF,
    },
    'msg-1',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'paused_by_policy' });
  const row = await readJob(jobId);
  expect(row.status).toBe('pending');
  expect(row.last_error).toBeNull();
});

it('P-P11: cancellation is terminal, DLQ-invisible, and honoured by consumers', async () => {
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  // A dead_letter row STAYS visible to the DLQ scan regardless of the gate
  // (terminal rows are never paused; reconciliation is unchanged).
  const deadId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: 'src_dlq',
    payloadJson: pollJob('src_dlq'),
    status: 'dead_letter',
  });
  const dlqRows = await scanPendingDlqDeliveries(db, 10);
  expect(dlqRows.map((r) => r.id)).toContain(deadId);

  // Guarded cancellation (C.3 remediation primitive): only non-terminal
  // dispatchable rows can be cancelled.
  const cancelled = await cancelSupersededPollJob(db, jobId, NOW);
  expect(cancelled).toBe(true);
  const row = await readJob(jobId);
  expect(row.status).toBe('cancelled');
  expect(row.last_error).toBe('job_cancelled_superseded');
  expect(row.dlq_delivered_at).toBeNull();
  // Cancellation is NOT dead-lettering: the DLQ scan does NOT see it.
  const dlqAfter = await scanPendingDlqDeliveries(db, 10);
  expect(dlqAfter.map((r) => r.id)).not.toContain(jobId);
  // Consumers acknowledge the explicit cancellation.
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-1',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'cancelled' });
  expect((await readJob(jobId)).status).toBe('cancelled');
  // The guarded transition refuses terminal rows (no double-cancel, no
  // resurrection of dead rows).
  const secondCancel = await cancelSupersededPollJob(db, jobId, NOW + 1);
  expect(secondCancel).toBe(false);
  const deadCancel = await cancelSupersededPollJob(db, deadId, NOW + 1);
  expect(deadCancel).toBe(false);
});

it('P-P12: a policy-paused poll never reaches the connector or the budget', async () => {
  await seedSource();
  const jobId = await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: SOURCE,
    payloadJson: pollJob(),
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: pollHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_OFF },
    'msg-1',
    envelopeFor(jobId, 'sources.fetch_poll'),
    NOW,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'paused_by_policy' });
  expect(fetchCalls).toBe(0); // no network under a paused policy
  const budget = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM budgets WHERE scope='ingestion'",
  });
  expect(budget!.n).toBe(0); // no budget spend either
});

it('P-P13: dispatch summary counters are honest (design observability)', async () => {
  // Pass A — gate ON, fully wired registry: poll + heartbeat dispatch; the
  // unknown type poisons.
  await insertJob({ type: 'sources.fetch_poll', aggregateId: SOURCE, payloadJson: pollJob() });
  await insertJob({ type: 'unknown.type', aggregateId: null, payloadJson: '{}' });
  await insertJob({
    type: 'jobs.maintenance_heartbeat',
    aggregateId: null,
    payloadJson: canonicalizeJson({}),
  });
  let summary: DesignDispatchSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: allHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_ON,
  });
  expect(summary.dispatched).toBe(2);
  expect(summary.poisonedUnregistered).toBe(1);
  expect(summary.misconfiguredPoisoned).toBe(0);
  expect(summary.policyPaused).toBe(0);
  // Pass B — gate OFF, fresh rows, fully wired registry: the poll pauses
  // (counted, untouched), the heartbeat dispatches, nothing poisons.
  await insertJob({
    type: 'sources.fetch_poll',
    aggregateId: 'src_off',
    payloadJson: pollJob('src_off'),
  });
  await insertJob({
    type: 'jobs.maintenance_heartbeat',
    aggregateId: null,
    payloadJson: canonicalizeJson({}),
  });
  summary = await dispatchPassWithPolicy({
    executor: db,
    handlers: allHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_OFF,
  });
  expect(summary.dispatched).toBe(1);
  expect(summary.policyPaused).toBe(1);
  expect(summary.poisonedUnregistered).toBe(0);
  expect(summary.misconfiguredPoisoned).toBe(0);
  const pausedRow = await db.first<{ status: string; attempts: number }>({
    sql: "SELECT status, attempts FROM jobs WHERE aggregate_id = 'src_off'",
  });
  expect(pausedRow!.status).toBe('pending');
  expect(pausedRow!.attempts).toBe(0);
});
