import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createJobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { createJobsQueueProducer } from '../../src/adapters/queue/jobs-producer';
import { fixedClock } from '../../src/shared/time/clock';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import worker from '../../src/entrypoints/worker';
import { createTestEnv, createTestExecutionContext } from '../helpers/test-env';

/**
 * INDEPENDENT Phase 3 acceptance regressions (review of v1.3.0 → fixed in
 * v1.3.1, ADR-0037). Six tests, asserted exactly as delivered by the
 * reviewer:
 *
 * 1. the REAL producer wire body must execute end-to-end with NO manual
 *    test-only JSON.parse anywhere in the path (producer → delivered body →
 *    consumer → sustained success);
 * 2. an expired final allowed claim must not execute attempt
 *    `max_attempts + 1` — the budget is enforced at the atomic claim
 *    boundary and the job lands in `dead_letter` without re-execution;
 * 3. an enabled runtime with no JOBS/DLQ binding fails configuration
 *    instead of becoming ready;
 * 4. an invalid present JOBS_ENABLED is not silently treated as disabled;
 * 5. readiness rejects enabled jobs without the required runtime bindings;
 * 6. readiness rejects a malformed present jobs flag.
 */

const NOW = 1700000000000;

beforeEach(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare('DELETE FROM jobs').run();
});

async function seed(id: string, status = 'pending', attempts = 0) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
      lease_until, idempotency_key, payload_json, created_at, updated_at)
     VALUES (?, 'jobs.maintenance_heartbeat', ?, 50, ?, ?, 3, ?, ?, '{}', ?, ?)`,
  )
    .bind(id, status, NOW, attempts, status === 'claimed' ? NOW - 1 : null, id, NOW, NOW)
    .run();
}

function harness() {
  let calls = 0;
  const wire: unknown[] = [];
  const clock = fixedClock(NOW);
  const engine = createJobsEngine({
    executor: createDbExecutor(env.DB),
    clock,
    random: () => 0.5,
    idGenerator: { newId: () => 'review-trace' },
    handlers: createJobHandlerRegistry([
      {
        type: 'jobs.maintenance_heartbeat',
        execute: async () => {
          calls++;
          return { kind: 'success' } as const;
        },
      },
    ]),
    jobsProducer: createJobsQueueProducer({
      send: async (body: unknown) => {
        wire.push(body);
      },
    } as unknown as Queue),
  });
  return { engine, wire, calls: () => calls };
}

describe('independent Phase 3 acceptance regressions', () => {
  it('real producer wire body must execute without manual test-only JSON.parse', async () => {
    await seed('wire');
    const h = harness();
    await h.engine.dispatchDueJobs();
    expect(h.wire).toHaveLength(1);
    const action = await h.engine.consumeMessage('m-wire', h.wire[0]);
    expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
    expect(h.calls()).toBe(1);
  });

  it('an expired final allowed claim must not execute attempt max_attempts + 1', async () => {
    await seed('exhausted', 'claimed', 3);
    const h = harness();
    await h.engine.consumeMessage('m-limit', {
      version: 1,
      jobId: 'exhausted',
      type: 'jobs.maintenance_heartbeat',
      attempt: 4,
      traceId: 't',
    });
    expect(h.calls()).toBe(0);
    const row = await env.DB.prepare('SELECT status,attempts FROM jobs WHERE id=?')
      .bind('exhausted')
      .first<{ status: string; attempts: number }>();
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(3);
  });

  it('enabled runtime with no JOBS/DLQ binding must fail configuration rather than become ready', () => {
    expect(resolveJobsEngine({ JOBS_ENABLED: 'true', DB: env.DB }).kind).toBe('config_invalid');
  });

  it('invalid present JOBS_ENABLED is not silently treated as disabled', () => {
    expect(resolveJobsEngine({ JOBS_ENABLED: 'not-a-flag', DB: env.DB }).kind).toBe(
      'config_invalid',
    );
  });

  it('readiness rejects enabled jobs without required runtime bindings', async () => {
    const r = await worker.fetch(
      new Request('https://pixel.test/health/ready'),
      { ...createTestEnv(), JOBS_ENABLED: 'true', DB: env.DB },
      createTestExecutionContext(),
    );
    expect(r.status).toBe(503);
  });

  it('readiness rejects a malformed present jobs flag', async () => {
    const r = await worker.fetch(
      new Request('https://pixel.test/health/ready'),
      { ...createTestEnv(), JOBS_ENABLED: 'invalid', DB: env.DB },
      createTestExecutionContext(),
    );
    expect(r.status).toBe(503);
  });
});
