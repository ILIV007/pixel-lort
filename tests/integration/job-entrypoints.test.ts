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
