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
 * Entrypoint activation tests on REAL workerd D1 (Phase 3 — ADR-0036 §7):
 * the fail-closed matrix for cron and queue paths.
 *
 * - disabled (default): cron is a structured no-op; queue messages retry.
 * - enabled + DB (no producers): dispatch fails closed per send (stable
 *   logs, rows stay recoverable); consumption works end-to-end when a
 *   message is delivered (binding-independent consumer).
 * - enabled + DB + fake JOBS producer: full dispatch pass.
 * - enabled WITHOUT DB: config_invalid — no dispatch, no ack.
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

  it('enabled + DB without producers: bounded pass fails closed, rows stay recoverable', async () => {
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
    // Fail closed: no producer → the row is NOT marked queued.
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

  it('enabled + fake JOBS producer: dispatches a bounded reference', async () => {
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
    };
    await worker.scheduled(
      createTestScheduledController('*/5 * * * *', NOW),
      envJobs,
      createTestExecutionContext(),
    );
    expect(sentEnvelopes).toHaveLength(1);
    const wire = JSON.parse(sentEnvelopes[0] as string) as Record<string, unknown>;
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

  it('enabled + DB: processes a real delivery end-to-end and acks durable success', async () => {
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
    const envJobs: WorkerEnv = { ...createTestEnv(), JOBS_ENABLED: 'true', DB: env.DB };
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

  it('enabled + malformed message: acks the poison message (no hot loop)', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = fakeBatch([{ id: 'm2', body: 'garbage', ack, retry }]);
    const envJobs: WorkerEnv = { ...createTestEnv(), JOBS_ENABLED: 'true', DB: env.DB };
    await worker.queue(batch, envJobs, createTestExecutionContext());
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
