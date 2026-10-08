import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import worker from '../../src/entrypoints/worker';
import {
  createTestEnv,
  createTestExecutionContext,
  createTestScheduledController,
} from '../helpers/test-env';
import type { WorkerEnv } from '../../src/shared/types/env';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';

/**
 * Entrypoint activation tests on REAL workerd D1 (Phase 3 — ADR-0036 §7;
 * activation gating tightened by ADR-0037): the fail-closed matrix for cron
 * and queue paths.
 *
 * - disabled (default): cron is a structured no-op; queue messages retry.
 * - enabled WITHOUT both queue bindings (JOBS/DLQ) or the DB:
 *   config_invalid — cron is a no-op, queue messages retry; nothing ever
 *   half-runs, and readiness reports not_ready (covered in the review
 *   regression suite).
 * - enabled + DB + fake JOBS/DLQ producers: the full dispatch pass, with
 *   the wire body asserted as the CANONICAL ENVELOPE OBJECT (ADR-0037 —
 *   no manual JSON round trip anywhere in the path).
 *
 * v1.3.1 final review additions (fault suite companion):
 * - worker.queue-LEVEL producer→consumer round trip: the real cron dispatch
 *   output (captured wire body) is delivered to worker.queue and must
 *   complete durably; a duplicate delivery stays safe (one durable effect).
 * - entrypoint persistence-fault: a terminal-write storage exception must
 *   surface as message.retry() with NO ack (the durable row stays claimed) —
 *   never a false success, with worker.queue's backstop preserved.
 * - each missing binding (DB / JOBS / DLQ) fails configuration SEPARATELY,
 *   and an invalid queue activation retries without executing a handler.
 */

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare('DELETE FROM jobs').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'jobs_maintenance:%'").run();
});

interface FakeMessage {
  readonly id: string;
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { delaySeconds?: number }) => void;
}

function fakeBatch(messages: FakeMessage[]): MessageBatch<unknown> {
  return {
    queue: 'pixel-jobs-preview',
    messages,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<unknown>;
}

/** Minimal fake queue producer binding (records nothing; accepts sends). */
function fakeQueue(): Queue<unknown> {
  return { send: async () => {} } as unknown as Queue<unknown>;
}

describe('scheduled entrypoint activation', () => {
  it('disabled (default): a structured no-op that never dispatches', async () => {
    const envBase = createTestEnv();
    const ctx = createTestExecutionContext();
    await expect(
      worker.scheduled(createTestScheduledController('*/5 * * * *', NOW), envBase, ctx),
    ).resolves.toBeUndefined();
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('enabled without both queue bindings: config_invalid — cron no-op, rows stay recoverable', async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
        idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
       VALUES ('cron-1', 'jobs.maintenance_heartbeat', 'pending', 50, ?, 0, 3,
        'key-cron-1', '{}', ?, ?, NULL)`,
    )
      .bind(NOW, NOW, NOW)
      .run();
    const envJobs: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
    };
    await expect(
      worker.scheduled(
        createTestScheduledController('*/5 * * * *', NOW),
        envJobs,
        createTestExecutionContext(),
      ),
    ).resolves.toBeUndefined();
    // Fail closed: a missing required binding is config_invalid — the pass
    // never dispatches, and the row stays recoverable (ADR-0037).
    const row = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?')
      .bind('cron-1')
      .first<{ status: string }>();
    expect(row?.status).toBe('pending');
  });

  it('enabled without DB: config_invalid — no dispatch, no crash', async () => {
    const envNoDb: WorkerEnv = { ...createTestEnv(), JOBS_ENABLED: 'true' };
    await expect(
      worker.scheduled(
        createTestScheduledController('*/5 * * * *', NOW),
        envNoDb,
        createTestExecutionContext(),
      ),
    ).resolves.toBeUndefined();
  });

  it('enabled + DB + fake JOBS/DLQ producers: dispatches the canonical envelope OBJECT', async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
        idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
       VALUES ('cron-2', 'jobs.maintenance_heartbeat', 'pending', 50, ?, 0, 3,
        'key-cron-2', '{}', ?, ?, NULL)`,
    )
      .bind(NOW, NOW, NOW)
      .run();
    const sentEnvelopes: unknown[] = [];
    const envJobs: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: {
        send: (body: unknown) => {
          sentEnvelopes.push(body);
          return Promise.resolve();
        },
      } as unknown as Queue<unknown>,
      DLQ: fakeQueue(),
    };
    await worker.scheduled(
      createTestScheduledController('*/5 * * * *', NOW),
      envJobs,
      createTestExecutionContext(),
    );
    expect(sentEnvelopes).toHaveLength(1);
    // The wire body IS the envelope object (single canonical transfer
    // contract — ADR-0037). No string decode anywhere in the path.
    const wire = sentEnvelopes[0] as Record<string, unknown>;
    expect(wire).toMatchObject({
      version: 1,
      jobId: 'cron-2',
      type: 'jobs.maintenance_heartbeat',
      attempt: 1,
    });
    const row = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?')
      .bind('cron-2')
      .first<{ status: string }>();
    expect(row?.status).toBe('queued');
  });
});

describe('queue entrypoint activation', () => {
  it('disabled (default): retries instead of acknowledging', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = fakeBatch([
      {
        id: 'm1',
        body: {
          version: 1,
          jobId: 'gone',
          type: 'jobs.maintenance_heartbeat',
          attempt: 1,
          traceId: 't',
        },
        ack,
        retry,
      },
    ]);
    await worker.queue(batch, createTestEnv(), createTestExecutionContext());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });

  it('enabled + DB + required bindings: processes a real delivery end-to-end and acks durable success', async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
        idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
       VALUES ('q-1', 'jobs.maintenance_heartbeat', 'pending', 50, ?, 0, 3,
        'key-q-1', '{}', ?, ?, NULL)`,
    )
      .bind(NOW, NOW, NOW)
      .run();
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = fakeBatch([
      {
        id: 'm1',
        body: {
          version: 1,
          jobId: 'q-1',
          type: 'jobs.maintenance_heartbeat',
          attempt: 1,
          traceId: 't',
        },
        ack,
        retry,
      },
    ]);
    const envJobs: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: fakeQueue(),
      DLQ: fakeQueue(),
    };
    await worker.queue(batch, envJobs, createTestExecutionContext());
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const row = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?')
      .bind('q-1')
      .first<{ status: string }>();
    expect(row?.status).toBe('succeeded');
    const heartbeat = await env.DB.prepare(
      "SELECT value_json FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    ).first<{ value_json: string }>();
    expect(heartbeat?.value_json).toContain('q-1');
  });

  it('enabled but missing required bindings: config_invalid — retries instead of acknowledging', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = fakeBatch([
      {
        id: 'm3',
        body: {
          version: 1,
          jobId: 'q-2',
          type: 'jobs.maintenance_heartbeat',
          attempt: 1,
          traceId: 't',
        },
        ack,
        retry,
      },
    ]);
    const envMisconfigured: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
    };
    await worker.queue(batch, envMisconfigured, createTestExecutionContext());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    // The durable row (if any) was never touched.
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('enabled + malformed message: acks the poison message (no hot loop)', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = fakeBatch([{ id: 'm2', body: 'garbage', ack, retry }]);
    const envJobs: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: fakeQueue(),
      DLQ: fakeQueue(),
    };
    await worker.queue(batch, envJobs, createTestExecutionContext());
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('queue entrypoint fault regressions (v1.3.1 final review)', () => {
  const envelopeFor = (jobId: string) => ({
    version: 1,
    jobId,
    type: 'jobs.maintenance_heartbeat',
    attempt: 1,
    traceId: 't-entrypoint',
  });

  async function seedPending(id: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
        idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
       VALUES (?, 'jobs.maintenance_heartbeat', 'pending', 50, ?, 0, 3,
        ?, '{}', ?, ?, NULL)`,
    )
      .bind(id, NOW, `key-${id}`, NOW, NOW)
      .run();
  }

  it('producer→consumer round trip at worker.queue: dispatched wire body completes durably; duplicate delivery stays safe', async () => {
    await seedPending('rt-1');
    // 1. REAL dispatch path: cron pass sends the envelope OBJECT through the
    //    real producer adapter into a captured queue (no manual JSON.parse).
    const wire: unknown[] = [];
    const envDispatch: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: {
        send: (body: unknown) => {
          wire.push(body);
          return Promise.resolve();
        },
      } as unknown as Queue<unknown>,
      DLQ: fakeQueue(),
    };
    await worker.scheduled(
      createTestScheduledController('*/5 * * * *', NOW),
      envDispatch,
      createTestExecutionContext(),
    );
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ version: 1, jobId: 'rt-1', attempt: 1 });

    // 2. The DELIVERED body is consumed by worker.queue exactly as received.
    const ack = vi.fn();
    const retry = vi.fn();
    const envConsume: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: fakeQueue(),
      DLQ: fakeQueue(),
    };
    await worker.queue(
      fakeBatch([{ id: 'm-rt-1', body: wire[0], ack, retry }]),
      envConsume,
      createTestExecutionContext(),
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const row = await env.DB.prepare('SELECT status, attempts FROM jobs WHERE id = ?')
      .bind('rt-1')
      .first<{ status: string; attempts: number }>();
    expect(row?.status).toBe('succeeded');
    expect(row?.attempts).toBe(1);
    const heartbeat = await env.DB.prepare(
      "SELECT value_json FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    ).first<{ value_json: string }>();
    expect(heartbeat?.value_json).toContain('rt-1');

    // 3. DUPLICATE delivery of the same body: safe — ack, no second durable
    //    effect (row unchanged, heartbeat marker byte-identical).
    const dupAck = vi.fn();
    const dupRetry = vi.fn();
    await worker.queue(
      fakeBatch([{ id: 'm-rt-1-dup', body: wire[0], ack: dupAck, retry: dupRetry }]),
      envConsume,
      createTestExecutionContext(),
    );
    expect(dupAck).toHaveBeenCalledTimes(1);
    expect(dupRetry).not.toHaveBeenCalled();
    const rowAfter = await env.DB.prepare('SELECT status, attempts FROM jobs WHERE id = ?')
      .bind('rt-1')
      .first<{ status: string; attempts: number }>();
    expect(rowAfter).toEqual({ status: 'succeeded', attempts: 1 });
    const heartbeatAfter = await env.DB.prepare(
      "SELECT value_json FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    ).first<{ value_json: string }>();
    expect(heartbeatAfter?.value_json).toBe(heartbeat?.value_json);
  });

  it('entrypoint persistence fault on the terminal write: retry, never ack, row stays claimed', async () => {
    await seedPending('pf-1');
    // Fault injection at the BINDING boundary: the terminal succeeded write
    // throws; every other statement reaches real D1 (same technique as the
    // reviewer fault suite, one layer lower — the entrypoint).
    let terminalWriteAttempts = 0;
    const faultDb = {
      prepare(sql: string) {
        if (sql.includes("SET status = 'succeeded'")) {
          terminalWriteAttempts += 1;
          throw new Error('entrypoint_persistence_fault');
        }
        return env.DB.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    } as unknown as D1Database;
    const ack = vi.fn();
    const retry = vi.fn();
    const envFault: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: faultDb,
      JOBS: fakeQueue(),
      DLQ: fakeQueue(),
    };
    await worker.queue(
      fakeBatch([{ id: 'm-pf-1', body: envelopeFor('pf-1'), ack, retry }]),
      envFault,
      createTestExecutionContext(),
    );
    // The fault hit EXACTLY the terminal completion write (the claim and the
    // handler effect landed on real D1) and the delivery was retried — never
    // acknowledged as success.
    expect(terminalWriteAttempts).toBe(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    const row = await env.DB.prepare('SELECT status, attempts FROM jobs WHERE id = ?')
      .bind('pf-1')
      .first<{ status: string; attempts: number }>();
    expect(row?.status).toBe('claimed');
    expect(row?.attempts).toBe(1);
  });

  it('each missing binding fails configuration SEPARATELY: JOBS only', () => {
    const resolution = resolveJobsEngine({
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      DLQ: fakeQueue(),
    });
    expect(resolution.kind).toBe('config_invalid');
    if (resolution.kind === 'config_invalid') {
      expect(resolution.issues).toEqual(['JOBS:missing_binding']);
    }
  });

  it('each missing binding fails configuration SEPARATELY: DLQ only', () => {
    const resolution = resolveJobsEngine({
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: fakeQueue(),
    });
    expect(resolution.kind).toBe('config_invalid');
    if (resolution.kind === 'config_invalid') {
      expect(resolution.issues).toEqual(['DLQ:missing_binding']);
    }
  });

  it('each missing binding fails configuration SEPARATELY: DB only', () => {
    const resolution = resolveJobsEngine({
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      JOBS: fakeQueue(),
      DLQ: fakeQueue(),
    });
    expect(resolution.kind).toBe('config_invalid');
    if (resolution.kind === 'config_invalid') {
      expect(resolution.issues).toEqual(['DB:missing_binding']);
    }
  });

  it('invalid queue activation (DLQ missing): retries without executing a handler', async () => {
    await seedPending('pf-2');
    const ack = vi.fn();
    const retry = vi.fn();
    const envMisconfigured: WorkerEnv = {
      ...createTestEnv(),
      JOBS_ENABLED: 'true',
      DB: env.DB,
      JOBS: fakeQueue(),
      // DLQ deliberately missing → config_invalid.
    };
    await worker.queue(
      fakeBatch([{ id: 'm-pf-2', body: envelopeFor('pf-2'), ack, retry }]),
      envMisconfigured,
      createTestExecutionContext(),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    // The durable row was never touched (no claim, no handler effect).
    const row = await env.DB.prepare('SELECT status, attempts FROM jobs WHERE id = ?')
      .bind('pf-2')
      .first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: 'pending', attempts: 0 });
    const heartbeat = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    ).first<{ n: number }>();
    expect(heartbeat?.n).toBe(0);
  });
});
