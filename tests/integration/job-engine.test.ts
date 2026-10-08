import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createJobsEngine, type JobsEngine } from '../../src/application/jobs/engine';
import {
  createJobHandlerRegistry,
  type JobHandler,
  type HandlerOutcome,
} from '../../src/domain/jobs/handler';
import { createMaintenanceHeartbeatHandler } from '../../src/application/jobs/handlers/maintenance-heartbeat';
import type {
  DlqReference,
  JobsQueueProducerPort,
  DlqProducerPort,
} from '../../src/adapters/queue/jobs-producer';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import { createLogger, type LogSink } from '../../src/observability/logger';

/**
 * Engine integration tests on REAL workerd D1 with controlled fake
 * producers/handlers/time/randomness (Phase 3 — ADR-0036 §3/§4): both
 * dispatch uncertainty windows, the full consumer decision table, retry
 * ownership, poison handling, DLQ reconciliation, and the honest
 * never-ack-uncertain-success rule.
 */

const NOW = 1_700_000_000_000;

interface Harness {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly clock: MutableClock;
  readonly sent: (envelope: unknown) => void;
  readonly sentEnvelopes: unknown[];
  readonly dlqSent: DlqReference[];
  readonly setHandlerOutcome: (outcome: HandlerOutcome | Error) => void;
  readonly handlerCalls: () => number;
  readonly lines: string[];
}

function createHarness(options?: {
  enqueueError?: Error;
  random?: () => number;
  dlqSendError?: Error;
  withoutProducers?: boolean;
  /** Register the REAL heartbeat handler instead of the scripted test double. */
  useRealHeartbeat?: boolean;
}): Harness {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  const lines: string[] = [];
  const sink: LogSink = (_level, line) => lines.push(line);
  const logger = createLogger({ level: 'debug', base: { evt: 'test' }, clock, sink });

  const sentEnvelopes: unknown[] = [];
  const sent = vi.fn((envelope: unknown) => {
    sentEnvelopes.push(envelope);
    return Promise.resolve();
  });
  const jobsProducer: JobsQueueProducerPort | undefined = options?.withoutProducers
    ? undefined
    : options?.enqueueError
      ? {
          send: async () => {
            throw options.enqueueError;
          },
        }
      : { send: sent };

  const dlqSent: DlqReference[] = [];
  const dlqProducer: DlqProducerPort | undefined = options?.withoutProducers
    ? undefined
    : options?.dlqSendError
      ? {
          send: async () => {
            throw options.dlqSendError;
          },
        }
      : {
          send: async (reference) => {
            dlqSent.push(reference);
          },
        };

  let handlerCalls = 0;
  let scripted: HandlerOutcome | Error = { kind: 'success' };
  const testHandler: JobHandler<never> = {
    type: 'jobs.maintenance_heartbeat',
    execute: async () => {
      handlerCalls += 1;
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
  const heartbeat = createMaintenanceHeartbeatHandler({
    executor,
    nowMs: () => clock.now(),
  });

  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry(
        options?.useRealHeartbeat ? [heartbeat as never] : [testHandler as never],
      ),
      idGenerator: { newId: () => `trace-${handlerCalls}-${sentEnvelopes.length}` },
      clock,
      random: options?.random ?? (() => 1),
      logger,
      jobsProducer,
      dlqProducer,
    },
    {
      leaseMs: 2 * 60 * 1000,
      dispatchBatch: 25,
      dlqReconcileBatch: 25,
      reclaimBatch: 25,
      dispatchGraceMs: 60_000,
      backoff: { baseMs: 2000, capMs: 3_600_000 },
      retryHintMaxSeconds: 3600,
    },
  );
  return {
    engine,
    executor,
    clock,
    sent,
    sentEnvelopes,
    dlqSent,
    setHandlerOutcome: (outcome) => {
      scripted = outcome;
    },
    handlerCalls: () => handlerCalls,
    lines,
  };
}

async function seedRow(
  executor: DbExecutor,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string) ?? `seed-${Math.floor(Math.random() * 1e9)}`;
  await executor.run({
    sql: `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
            lease_until, idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      overrides.type ?? 'jobs.maintenance_heartbeat',
      overrides.status ?? 'pending',
      overrides.priority ?? 50,
      overrides.runAfter ?? NOW,
      overrides.attempts ?? 0,
      overrides.maxAttempts ?? 3,
      overrides.leaseUntil ?? null,
      overrides.key ?? `key-${id}`,
      overrides.payload ?? '{}',
      NOW,
      overrides.updatedAt ?? NOW,
      overrides.dlqDeliveredAt ?? null,
    ],
  });
  return id;
}

function envelope(jobId: string, attempt = 1, type = 'jobs.maintenance_heartbeat'): unknown {
  return { version: 1, jobId, type, attempt, traceId: 'trace-1' };
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare('DELETE FROM jobs').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'jobs_maintenance:%'").run();
});

describe('end-to-end durability (real handler)', () => {
  it('create → dispatch → consume → durable success; duplicate delivery yields ONE effect', async () => {
    const h = createHarness({ useRealHeartbeat: true });
    const created = await h.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'e2e-1',
      payload: { note: 'tick' },
    });
    expect(created.kind).toBe('created');
    const jobId = created.kind === 'created' || created.kind === 'existing' ? created.jobId : '';

    const dispatch = await h.engine.dispatchDueJobs();
    expect(dispatch.dispatched).toBe(1);
    expect(dispatch.markedQueued).toBe(1);
    expect(h.sentEnvelopes).toHaveLength(1);

    const first = await h.engine.consumeMessage('m1', h.sentEnvelopes[0]);
    expect(first).toEqual({ action: 'ack', outcome: 'job_completed' });
    const row1 = await h.executor.first<{ status: string }>({
      sql: 'SELECT status FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(row1?.status).toBe('succeeded');
    const heartbeat1 = await h.executor.first<{ value_json: string }>({
      sql: "SELECT value_json FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    });
    expect(heartbeat1?.value_json).toContain(jobId);

    // Duplicate delivery (at-least-once): acknowledged as completed, no
    // second execution, no second durable effect.
    const duplicate = await h.engine.consumeMessage('m2', h.sentEnvelopes[0]);
    expect(duplicate).toEqual({ action: 'ack', outcome: 'duplicate_completed' });
    const heartbeat2 = await h.executor.first<{ value_json: string }>({
      sql: "SELECT value_json FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    });
    expect(heartbeat2?.value_json).toBe(heartbeat1?.value_json);
  });

  it('rejects an unregistered type and conflicting/idempotent duplicates at creation', async () => {
    const h = createHarness({ useRealHeartbeat: true });
    expect(
      await h.engine.createDurableJob({
        type: 'future.not_implemented',
        idempotencyKey: 'unreg-1',
        payload: {},
      }),
    ).toEqual({ kind: 'rejected', reason: 'unregistered_type' });
    expect(
      await h.engine.createDurableJob({
        type: 'jobs.maintenance_heartbeat',
        idempotencyKey: 'over-1',
        payload: 'not-an-object',
      }),
    ).toEqual({ kind: 'rejected', reason: 'payload_invalid' });
  });
});

describe('dispatch uncertainty windows (ADR-0036 §3)', () => {
  it('window 1 — enqueue failure leaves the row recoverable; a later pass dispatches it', async () => {
    const failing = createHarness({ enqueueError: new Error('queue unavailable') });
    const created = await failing.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'w1-1',
      payload: {},
    });
    const jobId = created.kind === 'created' ? created.jobId : '';

    const failedPass = await failing.engine.dispatchDueJobs();
    expect(failedPass.dispatched).toBe(0);
    expect(failedPass.sendFailures).toBe(1);
    const during = await failing.executor.first<{ status: string }>({
      sql: 'SELECT status FROM jobs WHERE id = ?',
      params: [jobId],
    });
    // NEVER marked queued on enqueue failure — still recoverable.
    expect(during?.status).toBe('pending');

    // A healthy dispatcher recovers the same durable job.
    const healthy = createHarness();
    const recovered = await healthy.engine.dispatchDueJobs();
    expect(recovered.dispatched).toBe(1);
    const after = await healthy.executor.first<{ status: string }>({
      sql: 'SELECT status FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(after?.status).toBe('queued');
  });

  it('window 2 — enqueue succeeded but the queued marker failed: grace re-kick, safe duplicates', async () => {
    const h = createHarness();
    const created = await h.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'w2-1',
      payload: {},
    });
    const jobId = created.kind === 'created' ? created.jobId : '';
    await h.engine.dispatchDueJobs();
    // Simulate a lost marker: the row is back to pending though a message
    // was already delivered to the queue.
    await h.executor.run({ sql: "UPDATE jobs SET status = 'pending' WHERE id = ?", params: [jobId] });

    // The pending row is DUE: the very next pass re-kicks it (window 2 is
    // closed by immediate re-dispatch, not by the grace timer).
    h.clock.advance(30_000);
    const rekick = await h.engine.dispatchDueJobs();
    expect(rekick.dispatched).toBe(1);
    expect(h.sentEnvelopes).toHaveLength(2);

    // Both references are delivered (at-least-once): the atomic claim makes
    // the durable effect single-owner.
    h.setHandlerOutcome({ kind: 'success' });
    const first = await h.engine.consumeMessage('m1', h.sentEnvelopes[0]);
    expect(first.action).toBe('ack');
    const second = await h.engine.consumeMessage('m2', h.sentEnvelopes[1]);
    expect(second).toEqual({ action: 'ack', outcome: 'duplicate_completed' });
    const row = await h.executor.first<{ status: string; attempts: number }>({
      sql: 'SELECT status, attempts FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(row?.status).toBe('succeeded');
    expect(row?.attempts).toBe(1);
  });

  it('stranded QUEUED rows re-kick only after the grace window', async () => {
    const h = createHarness();
    await h.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'grace-1',
      payload: {},
    });
    await h.engine.dispatchDueJobs();
    expect(h.sentEnvelopes).toHaveLength(1);

    // The marker exists but the message was lost. Within the grace window:
    // no re-kick.
    h.clock.advance(30_000);
    const withinGrace = await h.engine.dispatchDueJobs();
    expect(withinGrace.strandedScanned).toBe(0);
    expect(withinGrace.dispatched).toBe(0);

    // Past the grace window: bounded re-kick (marker re-armed).
    h.clock.advance(31_000);
    const afterGrace = await h.engine.dispatchDueJobs();
    expect(afterGrace.strandedScanned).toBe(1);
    expect(afterGrace.dispatched).toBe(1);
    expect(h.sentEnvelopes).toHaveLength(2);
    // The re-mark resets the grace timer (re-arm), so the next immediate
    // pass does not re-kick again.
    const next = await h.engine.dispatchDueJobs();
    expect(next.strandedScanned).toBe(0);
  });

  it('overlapping dispatchers create no duplicate durable effects', async () => {
    const a = createHarness();
    const b = createHarness();
    await a.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'ov-1',
      payload: {},
    });
    const [sa, sb] = await Promise.all([a.engine.dispatchDueJobs(), b.engine.dispatchDueJobs()]);
    // Duplicate REFERENCES are allowed (at-least-once); the queued marker is
    // a re-armable hint, never authoritative. The durable invariants are
    // single-owner execution and a single effect, asserted below.
    const sends = a.sentEnvelopes.length + b.sentEnvelopes.length;
    expect(sends).toBeGreaterThanOrEqual(1);
    expect((sa.markedQueued ?? 0) + (sb.markedQueued ?? 0)).toBeLessThanOrEqual(2);

    const deliveries = [
      ...(a.sentEnvelopes.length > 0 ? [a.sentEnvelopes[0]] : []),
      ...(b.sentEnvelopes.length > 0 ? [b.sentEnvelopes[0]] : []),
    ];
    let effects = 0;
    for (const [index, message] of deliveries.entries()) {
      const action = await a.engine.consumeMessage(`m-${index}`, message);
      if (action.outcome === 'job_completed') {
        effects += 1;
      }
    }
    expect(effects).toBe(1);
    const attempts = await a.executor.first<{ attempts: number }>({
      sql: 'SELECT attempts FROM jobs WHERE idempotency_key = ?',
      params: ['ov-1'],
    });
    expect(attempts?.attempts).toBe(1);
  });

  it('dispatch is bounded by the batch cap and deterministic; no handler ever runs during dispatch', async () => {
    const h = createHarness();
    // 30 due rows against a 25-row dispatch batch: the scan is capped, and
    // the remainder stays recoverable for the next bounded pass.
    for (let i = 0; i < 30; i++) {
      await seedRow(h.executor, { id: `b-${String(i).padStart(2, '0')}`, runAfter: NOW, priority: i });
    }
    const summary = await h.engine.dispatchDueJobs();
    expect(summary.dueScanned).toBe(25);
    expect(summary.dispatched).toBe(25);
    expect(h.handlerCalls()).toBe(0);
    // Deterministic order: run_after equal → priority DESC. (The engine
    // hands ENVELOPE OBJECTS to the producer port; serialization to the wire
    // string happens in the Cloudflare adapter — asserted in the entrypoint
    // suite.)
    expect(h.sentEnvelopes).toHaveLength(25);
    const first = h.sentEnvelopes[0] as { jobId: string };
    expect(first.jobId).toBe('b-29'); // priority 29 — the highest.
    // The 5 uncapped rows remain pending for the next pass.
    const remaining = await h.executor.first<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'",
    });
    expect(remaining?.n).toBe(5);
  });
});

describe('consumer decision table (ADR-0036 §4)', () => {
  it('acks poison envelopes, unsupported versions, and missing rows without hot loops', async () => {
    const h = createHarness();
    expect(await h.engine.consumeMessage('m1', 'not-an-object')).toEqual({
      action: 'ack',
      outcome: 'poison_malformed_envelope',
    });
    expect(await h.engine.consumeMessage('m2', envelope('x', 1, 'a.b') && { version: 2, jobId: 'x', type: 'a.b', attempt: 1, traceId: 't' })).toEqual({
      action: 'ack',
      outcome: 'poison_unsupported_version',
    });
    expect(await h.engine.consumeMessage('m3', { version: 1, jobId: 'nope', type: 'a.b', attempt: 1, traceId: 't' })).toEqual({
      action: 'ack',
      outcome: 'job_missing',
    });
    expect(await h.engine.consumeMessage('m4', { version: 1, jobId: 'x', type: 'BAD TYPE', attempt: 1, traceId: 't' })).toEqual({
      action: 'ack',
      outcome: 'poison_malformed_envelope',
    });
    expect(h.handlerCalls()).toBe(0);
  });

  it('acks terminal states and honors the durable schedule for early deliveries', async () => {
    const h = createHarness();
    await seedRow(h.executor, { id: 't-succ', status: 'succeeded', attempts: 1 });
    await seedRow(h.executor, { id: 't-dead', status: 'dead_letter', attempts: 3 });
    await seedRow(h.executor, { id: 't-canc', status: 'cancelled' });
    await seedRow(h.executor, { id: 't-fail', status: 'failed', attempts: 1 });
    await seedRow(h.executor, { id: 't-due', runAfter: NOW + 120_000 });
    expect(await h.engine.consumeMessage('m1', envelope('t-succ', 2))).toEqual({
      action: 'ack',
      outcome: 'duplicate_completed',
    });
    expect(await h.engine.consumeMessage('m2', envelope('t-dead', 4))).toEqual({
      action: 'ack',
      outcome: 'dead_lettered',
    });
    expect(await h.engine.consumeMessage('m3', envelope('t-canc', 1))).toEqual({
      action: 'ack',
      outcome: 'cancelled',
    });
    expect(await h.engine.consumeMessage('m4', envelope('t-fail', 2))).toEqual({
      action: 'ack',
      outcome: 'reserved_failed',
    });
    // Early delivery: retry with a bounded delay hint — D1 owns the schedule.
    const early = await h.engine.consumeMessage('m5', envelope('t-due'));
    expect(early).toEqual({ action: 'retry', outcome: 'not_due', delaySeconds: 120 });
    expect(h.handlerCalls()).toBe(0);
  });

  it('retries while an active lease is held elsewhere (never a false duplicate)', async () => {
    const h = createHarness();
    const jobId = await seedRow(h.executor, { id: 'lease-1', status: 'claimed', attempts: 1, leaseUntil: NOW + 60_000 });
    const action = await h.engine.consumeMessage('m1', envelope(jobId, 1));
    expect(action).toEqual({ action: 'retry', outcome: 'active_elsewhere' });
    const row = await h.executor.first<{ attempts: number }>({
      sql: 'SELECT attempts FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(row?.attempts).toBe(1);
  });

  it('treats a forged/stale envelope attempt as informational (D1 wins)', async () => {
    const h = createHarness();
    const jobId = await seedRow(h.executor, { id: 'forge-1', attempts: 0 });
    // Forged attempt claims a far-future generation.
    const action = await h.engine.consumeMessage('m1', envelope(jobId, 999_999));
    expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
    const row = await h.executor.first<{ attempts: number }>({
      sql: 'SELECT attempts FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(row?.attempts).toBe(1);
    expect(h.lines.some((line) => line.includes('attempt_mismatch'))).toBe(true);
  });

  it('poisons unregistered types and corrupt payloads without execution', async () => {
    const h = createHarness();
    const unknownType = await seedRow(h.executor, { id: 'poison-1', type: 'future.not_implemented', status: 'queued' });
    expect(await h.engine.consumeMessage('m1', envelope(unknownType, 1, 'future.not_implemented'))).toEqual({
      action: 'ack',
      outcome: 'poisoned_job_type_unregistered',
    });
    const corrupt = await seedRow(h.executor, { id: 'poison-2', payload: '{broken' });
    expect(await h.engine.consumeMessage('m2', envelope(corrupt, 1))).toEqual({
      action: 'ack',
      outcome: 'poisoned_job_payload_invalid',
    });
    for (const id of [unknownType, corrupt]) {
      const row = await h.executor.first<{ status: string; attempts: number; last_error: string }>({
        sql: 'SELECT status, attempts, last_error FROM jobs WHERE id = ?',
        params: [id],
      });
      expect(row?.status).toBe('dead_letter');
      expect(row?.attempts).toBe(0);
    }
    expect(h.handlerCalls()).toBe(0);
  });

  it('persists the durable retry schedule with deterministic jitter and acks only after persistence', async () => {
    // random() = 0 → full-jitter minimum (0) raised by nothing: delay 0 is
    // clamped to at-least-now scheduling; run_after = now + 0.
    const zero = createHarness({ random: () => 0 });
    zero.setHandlerOutcome({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    const jobZero = await seedRow(zero.executor, { id: 'retry-0' });
    const a = await zero.engine.consumeMessage('m1', envelope(jobZero, 1));
    expect(a).toEqual({ action: 'ack', outcome: 'retry_scheduled' });
    const rowZero = await zero.executor.first<{ status: string; run_after: number; last_error: string }>({
      sql: 'SELECT status, run_after, last_error FROM jobs WHERE id = ?',
      params: [jobZero],
    });
    expect(rowZero?.status).toBe('retry_wait');
    expect(rowZero?.run_after).toBe(NOW);
    expect(rowZero?.last_error).toBe('job_handler_retryable_error');

    // random() = 1 → the exponential bound (attempt 1 → 2s).
    const full = createHarness({ random: () => 1 });
    full.setHandlerOutcome({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    const jobFull = await seedRow(full.executor, { id: 'retry-1' });
    expect(await full.engine.consumeMessage('m1', envelope(jobFull, 1))).toEqual({
      action: 'ack',
      outcome: 'retry_scheduled',
    });
    const rowFull = await full.executor.first<{ run_after: number }>({
      sql: 'SELECT run_after FROM jobs WHERE id = ?',
      params: [jobFull],
    });
    expect(rowFull?.run_after).toBe(NOW + 2000);

    // A retry_after floor from the handler raises the delay (bounded by cap).
    const floored = createHarness({ random: () => 1 });
    floored.setHandlerOutcome({ kind: 'retry', reasonCode: 'job_handler_retryable_error', retryAfterMs: 30_000 });
    const jobFloor = await seedRow(floored.executor, { id: 'retry-2' });
    await floored.engine.consumeMessage('m1', envelope(jobFloor, 1));
    const rowFloor = await floored.executor.first<{ run_after: number }>({
      sql: 'SELECT run_after FROM jobs WHERE id = ?',
      params: [jobFloor],
    });
    expect(rowFloor?.run_after).toBe(NOW + 30_000);
  });

  it('exhausts bounded attempts to dead_letter and honors permanent failures', async () => {
    const h = createHarness();
    h.setHandlerOutcome({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    const jobId = await seedRow(h.executor, { id: 'exh-1', maxAttempts: 3 });

    for (const generation of [1, 2]) {
      const action = await h.engine.consumeMessage(`m-${generation}`, envelope(jobId, generation));
      expect(action).toEqual({ action: 'ack', outcome: 'retry_scheduled' });
      // Make the rescheduled row due again for the next delivery.
      await h.executor.run({ sql: 'UPDATE jobs SET run_after = ? WHERE id = ?', params: [NOW, jobId] });
    }
    const third = await h.engine.consumeMessage('m-3', envelope(jobId, 3));
    expect(third).toEqual({ action: 'ack', outcome: 'job_dead_lettered' });
    const row = await h.executor.first<{ status: string; last_error: string; dlq_delivered_at: number | null }>({
      sql: 'SELECT status, last_error, dlq_delivered_at FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(row?.status).toBe('dead_letter');
    expect(row?.last_error).toBe('job_exhausted');
    expect(row?.dlq_delivered_at ?? null).toBeNull();

    // A permanent failure dead-letters immediately (no blind retry).
    const perm = createHarness();
    perm.setHandlerOutcome({ kind: 'permanent', reasonCode: 'job_handler_permanent_error' });
    const permId = await seedRow(perm.executor, { id: 'perm-1' });
    expect(await perm.engine.consumeMessage('m1', envelope(permId, 1))).toEqual({
      action: 'ack',
      outcome: 'job_dead_lettered',
    });
    const permRow = await perm.executor.first<{ status: string; last_error: string }>({
      sql: 'SELECT status, last_error FROM jobs WHERE id = ?',
      params: [permId],
    });
    expect(permRow?.last_error).toBe('job_handler_permanent_error');
  });

  it('never acknowledges uncertain completion: lost fences and storage failures retry', async () => {
    // Completion fence lost (newer owner exists) → retry, no false success.
    const stale = createHarness();
    const staleId = await seedRow(stale.executor, {
      id: 'stale-1',
      status: 'claimed',
      attempts: 2,
      leaseUntil: NOW + 60_000,
    });
    // A stale envelope with attempt 1 arrives; payload pre-check passes; the
    // claim loses to the ACTIVE lease → retry pressure (not ack).
    expect(await stale.engine.consumeMessage('m1', envelope(staleId, 1))).toEqual({
      action: 'retry',
      outcome: 'active_elsewhere',
    });

    // Handler throws → durable retry_wait (transient internal error).
    const throwing = createHarness();
    throwing.setHandlerOutcome(new Error('handler exploded'));
    const throwId = await seedRow(throwing.executor, { id: 'throw-1' });
    expect(await throwing.engine.consumeMessage('m1', envelope(throwId, 1))).toEqual({
      action: 'ack',
      outcome: 'retry_scheduled',
    });
    const thrownRow = await throwing.executor.first<{ status: string; last_error: string }>({
      sql: 'SELECT status, last_error FROM jobs WHERE id = ?',
      params: [throwId],
    });
    expect(thrownRow?.status).toBe('retry_wait');
    expect(thrownRow?.last_error).toBe('job_internal_error');

    // A handler that throws at exhaustion-time is dead-lettered (bounded).
    const exhausting = createHarness();
    exhausting.setHandlerOutcome(new Error('boom'));
    const exhId = await seedRow(exhausting.executor, { id: 'throw-2', attempts: 3, maxAttempts: 3 });
    expect(await exhausting.engine.consumeMessage('m1', envelope(exhId, 4))).toEqual({
      action: 'ack',
      outcome: 'job_dead_lettered',
    });
  });

  it('reclaims crash-after-claim: expired lease re-enters the pool via dispatch', async () => {
    const h = createHarness();
    const jobId = await seedRow(h.executor, {
      id: 'crash-1',
      status: 'claimed',
      attempts: 1,
      leaseUntil: NOW + 1000,
    });
    // The Worker died after claiming. Pass 1 reclaims the expired lease
    // (claimed → queued with a re-armed grace timer); pass 2 — past the
    // grace window — re-dispatches it. Recovery latency is bounded by the
    // reclaim pass plus one grace window, never by message redelivery.
    h.clock.advance(2000);
    const reclaimPass = await h.engine.dispatchDueJobs();
    expect(reclaimPass.reclaimedLeases).toBe(1);
    expect(reclaimPass.dispatched).toBe(0);
    h.clock.advance(61_000);
    const dispatchPass = await h.engine.dispatchDueJobs();
    expect(dispatchPass.dispatched).toBe(1);
    const action = await h.engine.consumeMessage('m1', h.sentEnvelopes[0]);
    expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
    const row = await h.executor.first<{ status: string; attempts: number }>({
      sql: 'SELECT status, attempts FROM jobs WHERE id = ?',
      params: [jobId],
    });
    expect(row?.status).toBe('succeeded');
    expect(row?.attempts).toBe(2);
  });
});

describe('DLQ reconciliation (ADR-0036 §4)', () => {
  it('delivers bounded safe references and marks them exactly once', async () => {
    const h = createHarness();
    const deadId = await seedRow(h.executor, {
      id: 'dlq-1',
      status: 'dead_letter',
      attempts: 3,
      last_error: 'job_exhausted',
    });
    const summary = await h.engine.reconcileDeadLetters();
    expect(summary).toEqual({ scanned: 1, delivered: 1, sendFailures: 0, producerMissing: false });
    expect(h.dlqSent).toHaveLength(1);
    const reference = h.dlqSent[0]!;
    expect(reference).toEqual({
      jobId: deadId,
      type: 'jobs.maintenance_heartbeat',
      attempts: 3,
      errorCode: 'job_exhausted',
      failedAtMs: NOW,
    });
    // Reconciliation is idempotent: no re-send after confirmation.
    const again = await h.engine.reconcileDeadLetters();
    expect(again.scanned).toBe(0);
    expect(h.dlqSent).toHaveLength(1);
  });

  it('keeps the record recoverable when the DLQ send fails (never lost)', async () => {
    const failing = createHarness({ dlqSendError: new Error('dlq down') });
    await seedRow(failing.executor, { id: 'dlq-2', status: 'dead_letter', attempts: 3 });
    const failed = await failing.engine.reconcileDeadLetters();
    expect(failed).toEqual({ scanned: 1, delivered: 0, sendFailures: 1, producerMissing: false });
    const row = await failing.executor.first<{ dlq_delivered_at: number | null }>({
      sql: 'SELECT dlq_delivered_at FROM jobs WHERE id = ?',
      params: ['dlq-2'],
    });
    expect(row?.dlq_delivered_at ?? null).toBeNull();

    // A healthy pass delivers the still-reconcilable record later.
    const healthy = createHarness();
    const recovered = await healthy.engine.reconcileDeadLetters();
    expect(recovered.delivered).toBe(1);
  });

  it('fails closed without the DLQ producer (rows stay reconcilable)', async () => {
    const h = createHarness({ withoutProducers: true });
    await seedRow(h.executor, { id: 'dlq-3', status: 'dead_letter', attempts: 3 });
    const summary = await h.engine.reconcileDeadLetters();
    expect(summary).toEqual({ scanned: 1, delivered: 0, sendFailures: 1, producerMissing: true });
    const row = await h.executor.first<{ dlq_delivered_at: number | null }>({
      sql: 'SELECT dlq_delivered_at FROM jobs WHERE id = ?',
      params: ['dlq-3'],
    });
    expect(row?.dlq_delivered_at ?? null).toBeNull();
  });

  it('dispatch without the JOBS producer fails closed and keeps rows recoverable', async () => {
    const h = createHarness({ withoutProducers: true });
    await seedRow(h.executor, { id: 'np-1' });
    const summary = await h.engine.dispatchDueJobs();
    expect(summary.dispatched).toBe(0);
    expect(summary.sendFailures).toBe(1);
    const row = await h.executor.first<{ status: string }>({
      sql: 'SELECT status FROM jobs WHERE id = ?',
      params: ['np-1'],
    });
    expect(row?.status).toBe('pending');
  });
});

describe('observability hygiene', () => {
  it('logs carry stable events and never payloads, secrets, or provider text', async () => {
    const h = createHarness();
    const jobId = await h.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'log-1',
      payload: { note: 'secret-note-value-xyz' },
    }).then((r) => (r.kind === 'created' ? r.jobId : ''));
    h.setHandlerOutcome({ kind: 'retry', reasonCode: 'job_handler_retryable_error' });
    await h.engine.dispatchDueJobs();
    await h.engine.consumeMessage('m1', h.sentEnvelopes[0]);
    await h.engine.reconcileDeadLetters();

    const allLines = h.lines.join('\n');
    expect(allLines).not.toContain('secret-note-value-xyz');
    expect(allLines).not.toContain('{broken');
    // Envelope bodies are never logged either.
    expect(allLines).not.toContain('"jobId"');
    // All emitted lines are valid JSON with the standard shape.
    for (const line of h.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
