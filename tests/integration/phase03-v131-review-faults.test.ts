import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
import { createJobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry, type HandlerOutcome } from '../../src/domain/jobs/handler';
import { fixedClock } from '../../src/shared/time/clock';
const NOW = 1700000000000;
beforeEach(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare('DELETE FROM jobs').run();
});
async function seed(id: string, attempts = 0, status = 'pending', lease: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO jobs(id,type,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,created_at,updated_at) VALUES (?,'jobs.maintenance_heartbeat',?,50,?,?,3,?,?,'{}',?,?)`,
  )
    .bind(id, status, NOW, attempts, lease, id, NOW, NOW)
    .run();
}
function harness(
  target: string,
  mode: 'false' | 'throw',
  outcome: HandlerOutcome = { kind: 'success' },
) {
  const base = createDbExecutor(env.DB);
  const clock = fixedClock(NOW);
  const execute = vi.fn(async () => outcome);
  const exec: DbExecutor = {
    ...base,
    run: async (s: DbStatement) => {
      if (s.sql.includes(target)) {
        if (mode === 'throw') throw new Error('review_storage_failure');
        return { changes: 0, durationMs: 0 };
      }
      return base.run(s);
    },
  };
  const engine = createJobsEngine({
    executor: exec,
    clock,
    random: () => 0.5,
    idGenerator: { newId: () => crypto.randomUUID() },
    handlers: createJobHandlerRegistry([{ type: 'jobs.maintenance_heartbeat', execute }]),
  });
  return { engine, execute, clock, base };
}
const body = (id: string) => ({
  version: 1,
  jobId: id,
  type: 'jobs.maintenance_heartbeat',
  attempt: 1,
  traceId: 't',
});
describe('independent terminal-persistence fault matrix', () => {
  for (const mode of ['false', 'throw'] as const) {
    for (const [target, outcome] of [
      ["SET status = 'succeeded'", { kind: 'success' }],
      ["SET status = 'retry_wait'", { kind: 'retry', reasonCode: 'job_internal_error' }],
      [
        "SET status = 'dead_letter'",
        { kind: 'permanent', reasonCode: 'job_handler_permanent_error' },
      ],
    ] as const) {
      it(`${mode} on ${target} never acks uncertain state`, async () => {
        await seed('fault');
        const h = harness(target, mode, outcome);
        expect((await h.engine.consumeMessage('m', body('fault'))).action).toBe('retry');
        const row = await h.base.first<{ status: string }>({
          sql: 'SELECT status FROM jobs WHERE id=?',
          params: ['fault'],
        });
        expect(row?.status).toBe('claimed');
      });
    }
    it(`${mode} on exhaustion transition never acks or executes`, async () => {
      await seed('spent', 3, 'claimed', NOW - 1);
      const h = harness("SET status = 'dead_letter'", mode);
      expect((await h.engine.consumeMessage('m', body('spent'))).action).toBe('retry');
      expect(h.execute).not.toHaveBeenCalled();
    });
  }
  it('repeated completion write failure reaches budget without fourth execution', async () => {
    await seed('repeat');
    const h = harness("SET status = 'succeeded'", 'throw');
    for (let i = 0; i < 3; i++) {
      expect((await h.engine.consumeMessage('m' + i, body('repeat'))).action).toBe('retry');
      h.clock.advance(120001);
    }
    expect((await h.engine.consumeMessage('last', body('repeat'))).action).toBe('ack');
    expect(h.execute).toHaveBeenCalledTimes(3);
    const row = await h.base.first<{ status: string; attempts: number }>({
      sql: 'SELECT status,attempts FROM jobs WHERE id=?',
      params: ['repeat'],
    });
    expect(row).toEqual({ status: 'dead_letter', attempts: 3 });
  });
  it('active final attempt is not prematurely exhausted', async () => {
    await seed('active', 3, 'claimed', NOW + 10000);
    const h = harness('not-a-statement', 'throw');
    expect((await h.engine.consumeMessage('m', body('active'))).outcome).toBe('active_elsewhere');
    expect(h.execute).not.toHaveBeenCalled();
  });
});
