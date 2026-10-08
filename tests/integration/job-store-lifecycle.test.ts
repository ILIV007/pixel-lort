import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  claimJob,
  completeJob,
  createJob,
  findJobById,
  markDlqDelivered,
  markJobDeadLetter,
  markJobQueued,
  markJobRetryWait,
  reclaimExpiredClaims,
  scanDueJobs,
  scanPendingDlqDeliveries,
  scanStrandedQueuedJobs,
  JOB_CLAIM_LEASE_MS,
} from '../../src/adapters/db/job-store';

/**
 * Job store lifecycle tests on REAL workerd D1 (Phase 3 — ADR-0036 §1/§2):
 * idempotent creation under races, atomic claim generation fencing, strict
 * due/lease boundaries, crash-after-claim recovery, stale-owner rejection,
 * terminal immutability, poison transitions, and the bounded recovery
 * scans. All time is injected (no sleeps, no wall clock).
 */

const NOW = 1_700_000_000_000;

let executor: DbExecutor;

interface SeedOverrides {
  readonly id?: string;
  readonly type?: string;
  readonly key?: string;
  readonly status?: string;
  readonly runAfter?: number;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly leaseUntil?: number | null;
  readonly priority?: number;
  readonly payload?: string;
  readonly updatedAt?: number;
}

async function seedJob(overrides: SeedOverrides = {}): Promise<string> {
  const id = overrides.id ?? `job-${executorSeed++}`;
  await executor.run({
    sql: `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
            lease_until, idempotency_key, payload_json, created_at, updated_at, dlq_delivered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
    ],
  });
  return id;
}

let executorSeed = 1;

beforeEach(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare('DELETE FROM jobs').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'jobs_maintenance:%'").run();
  executor = createDbExecutor(env.DB);
  executorSeed = 1;
});

describe('idempotent creation', () => {
  it('creates once and observes the existing job for a compatible retry', async () => {
    const first = await createJob(
      executor,
      {
        id: 'job-a',
        type: 'jobs.maintenance_heartbeat',
        idempotencyKey: 'idem-a',
        canonicalPayloadJson: '{"note":"x"}',
        priority: 50,
        runAfterMs: NOW,
        maxAttempts: 3,
      },
      NOW,
    );
    expect(first).toEqual({ kind: 'created', jobId: 'job-a' });

    const retry = await createJob(
      executor,
      {
        id: 'job-a-again',
        type: 'jobs.maintenance_heartbeat',
        idempotencyKey: 'idem-a',
        canonicalPayloadJson: '{"note":"x"}',
        priority: 10,
        runAfterMs: NOW + 5,
        maxAttempts: 1,
      },
      NOW + 5,
    );
    expect(retry).toEqual({ kind: 'existing', jobId: 'job-a' });

    const rows = await executor.query<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM jobs' });
    expect(rows.rows[0]?.n).toBe(1);
    const row = await findJobById(executor, 'job-a');
    // The ORIGINAL row is authoritative — the retry's differing fields were ignored.
    expect(row?.priority).toBe(50);
  });

  it('reports a conflict for the same key with an incompatible payload (never overwrites)', async () => {
    await seedJob({ id: 'job-a', key: 'idem-c', payload: '{"note":"original"}' });
    const result = await createJob(
      executor,
      {
        id: 'job-b',
        type: 'jobs.maintenance_heartbeat',
        idempotencyKey: 'idem-c',
        canonicalPayloadJson: '{"note":"different"}',
        priority: 50,
        runAfterMs: NOW,
        maxAttempts: 3,
      },
      NOW,
    );
    expect(result).toEqual({ kind: 'conflict', jobId: 'job-a' });
    const row = await findJobById(executor, 'job-a');
    expect(row?.payload_json).toBe('{"note":"original"}');
    expect((await findJobById(executor, 'job-b')) ?? null).toBeNull();
  });

  it('reports a conflict for the same key with an incompatible type', async () => {
    // The stored row has a different type than the conflicting request.
    await seedJob({ id: 'job-a', key: 'idem-t', type: 'future.different_type' });
    const result = await createJob(
      executor,
      {
        id: 'job-b',
        type: 'jobs.maintenance_heartbeat',
        idempotencyKey: 'idem-t',
        // Identical payload but a different type is still incompatible.
        canonicalPayloadJson: '{}',
        priority: 50,
        runAfterMs: NOW,
        maxAttempts: 3,
      },
      NOW,
    );
    expect(result.kind).toBe('conflict');
    expect(result.jobId).toBe('job-a');
  });

  it('admits exactly one row under concurrent creation of the same key', async () => {
    const input = {
      id: 'job-race',
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'idem-race',
      canonicalPayloadJson: '{}',
      priority: 50,
      runAfterMs: NOW,
      maxAttempts: 3,
    };
    const [a, b] = await Promise.all([
      createJob(executor, input, NOW),
      createJob(executor, { ...input, id: 'job-race-2' }, NOW),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['created', 'existing']);
    expect(a.jobId).toBe('job-race');
    const rows = await executor.query<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'idem-race'",
    });
    expect(rows.rows[0]?.n).toBe(1);
  });
});

describe('atomic claim — generation fencing and boundaries', () => {
  it('awards exactly one generation per claim and increments attempts once', async () => {
    await seedJob({ id: 'job-c1' });
    const claim = await claimJob(executor, 'job-c1', NOW);
    expect(claim).toEqual({ kind: 'claimed', generation: 1, payloadJson: '{}' });
    const row = await findJobById(executor, 'job-c1');
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe('claimed');
    expect(row?.lease_until).toBe(NOW + JOB_CLAIM_LEASE_MS);
  });

  it('admits exactly one winner among concurrent claims', async () => {
    await seedJob({ id: 'job-c2' });
    const [a, b] = await Promise.all([
      claimJob(executor, 'job-c2', NOW),
      claimJob(executor, 'job-c2', NOW),
    ]);
    const claims = [a, b];
    expect(claims.filter((c) => c.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((c) => c.kind === 'active_elsewhere')).toHaveLength(1);
    const row = await findJobById(executor, 'job-c2');
    expect(row?.attempts).toBe(1);
  });

  it('enforces the due boundary: not due is not claimable (retry pressure, not ack)', async () => {
    await seedJob({ id: 'job-c3', runAfter: NOW + 1 });
    expect(await claimJob(executor, 'job-c3', NOW)).toEqual({
      kind: 'not_due',
      runAfterMs: NOW + 1,
    });
    // Exactly due IS claimable.
    const claim = await claimJob(executor, 'job-c3', NOW + 1);
    expect(claim.kind).toBe('claimed');
  });

  it('honors the lease at −1 ms, exact expiry is stale, after expiry is stale', async () => {
    await seedJob({ id: 'job-c4', status: 'claimed', attempts: 2, leaseUntil: NOW + 60_000 });
    // One millisecond before expiry: ACTIVE, never stolen.
    expect(await claimJob(executor, 'job-c4', NOW + 59_999)).toEqual({ kind: 'active_elsewhere' });
    // Exact expiry boundary: stale (reclaimable).
    const atExpiry = await claimJob(executor, 'job-c4', NOW + 60_000);
    expect(atExpiry).toEqual({ kind: 'claimed', generation: 3, payloadJson: '{}' });
  });

  it('recovers a crash-after-claim via expiry reclaim without incrementing attempts twice', async () => {
    await seedJob({ id: 'job-c5', status: 'claimed', attempts: 1, leaseUntil: NOW + 1000 });
    const claim = await claimJob(executor, 'job-c5', NOW + 1000);
    expect(claim).toEqual({ kind: 'claimed', generation: 2, payloadJson: '{}' });
    const row = await findJobById(executor, 'job-c5');
    expect(row?.attempts).toBe(2);
  });

  it('rejects stale-owner terminal writes and never mutates the newer claim', async () => {
    await seedJob({ id: 'job-c6', status: 'claimed', attempts: 1, leaseUntil: NOW + 1000 });
    // Generation 1 owner lost its lease; generation 2 reclaimed.
    await claimJob(executor, 'job-c6', NOW + 1000);

    // Stale generation 1 attempts every owner-dependent mutation.
    expect(await completeJob(executor, 'job-c6', 1, NOW + 1500)).toBe(false);
    expect(
      await markJobRetryWait(
        executor,
        'job-c6',
        1,
        NOW + 9999,
        'job_handler_retryable_error',
        NOW + 1500,
      ),
    ).toBe(false);
    expect(await markJobDeadLetter(executor, 'job-c6', 1, 'job_exhausted', NOW + 1500)).toBe(false);

    const row = await findJobById(executor, 'job-c6');
    expect(row?.status).toBe('claimed');
    expect(row?.attempts).toBe(2);
    expect(row?.lease_until).toBe(NOW + 1000 + JOB_CLAIM_LEASE_MS);
    expect(row?.last_error ?? null).toBeNull();
  });

  it('persists fenced success, retry schedule, and dead-letter only for the owning generation', async () => {
    await seedJob({ id: 'job-c7' });
    expect((await claimJob(executor, 'job-c7', NOW)).kind).toBe('claimed');
    expect(await completeJob(executor, 'job-c7', 1, NOW + 10)).toBe(true);
    const done = await findJobById(executor, 'job-c7');
    expect(done?.status).toBe('succeeded');
    expect(done?.lease_until ?? null).toBeNull();

    // Terminal rows are never executable.
    expect(await claimJob(executor, 'job-c7', NOW + 100)).toEqual({ kind: 'duplicate_completed' });

    await seedJob({ id: 'job-c8' });
    await claimJob(executor, 'job-c8', NOW);
    expect(
      await markJobRetryWait(
        executor,
        'job-c8',
        1,
        NOW + 5000,
        'job_handler_retryable_error',
        NOW + 10,
      ),
    ).toBe(true);
    const waiting = await findJobById(executor, 'job-c8');
    expect(waiting?.status).toBe('retry_wait');
    expect(waiting?.run_after).toBe(NOW + 5000);
    expect(waiting?.last_error).toBe('job_handler_retryable_error');
    expect(waiting?.lease_until ?? null).toBeNull();
    // The rescheduled row is claimable again exactly when its schedule is due.
    expect(await claimJob(executor, 'job-c8', NOW + 4999)).toEqual({
      kind: 'not_due',
      runAfterMs: NOW + 5000,
    });
    expect((await claimJob(executor, 'job-c8', NOW + 5000)).kind).toBe('claimed');
  });

  it('dead-letters a spent-budget expired claim at the boundary without awarding a generation', async () => {
    // attempts = 3 = max: the third generation crashed before persisting an
    // outcome; the expired lease must NOT award a fourth execution.
    await seedJob({ id: 'job-c14', status: 'claimed', attempts: 3, leaseUntil: NOW - 1000 });
    const claim = await claimJob(executor, 'job-c14', NOW);
    expect(claim).toEqual({ kind: 'budget_exhausted' });
    const row = await findJobById(executor, 'job-c14');
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toBe('job_exhausted');
    expect(row?.dlq_delivered_at ?? null).toBeNull();
    // The terminal row is inert: a later delivery observes dead_lettered.
    expect(await claimJob(executor, 'job-c14', NOW + 1000)).toEqual({ kind: 'dead_lettered' });
  });

  it('never claims a dispatchable row whose attempt budget is spent', async () => {
    await seedJob({ id: 'job-c15', status: 'pending', attempts: 3 });
    const claim = await claimJob(executor, 'job-c15', NOW);
    expect(claim).toEqual({ kind: 'budget_exhausted' });
    const row = await findJobById(executor, 'job-c15');
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(3);
    // A budget-intact row is unaffected by the boundary.
    await seedJob({ id: 'job-c16', status: 'claimed', attempts: 2, leaseUntil: NOW - 1 });
    expect((await claimJob(executor, 'job-c16', NOW)).kind).toBe('claimed');
  });

  it('treats succeeded/dead_letter/cancelled/reserved rows as non-executable', async () => {
    await seedJob({ id: 'job-c9', status: 'succeeded', attempts: 1 });
    await seedJob({ id: 'job-c10', status: 'dead_letter', attempts: 3 });
    await seedJob({ id: 'job-c11', status: 'cancelled' });
    await seedJob({ id: 'job-c12', status: 'failed', attempts: 1 });
    expect(await claimJob(executor, 'job-c9', NOW)).toEqual({ kind: 'duplicate_completed' });
    expect(await claimJob(executor, 'job-c10', NOW)).toEqual({ kind: 'dead_lettered' });
    expect(await claimJob(executor, 'job-c11', NOW)).toEqual({ kind: 'cancelled' });
    expect(await claimJob(executor, 'job-c12', NOW)).toEqual({ kind: 'reserved_failed' });
  });

  it('dead-letters an unclaimed dispatchable poison row without burning a generation', async () => {
    await seedJob({ id: 'job-c13', type: 'future.not_implemented', status: 'queued' });
    expect(await markJobDeadLetter(executor, 'job-c13', null, 'job_type_unregistered', NOW)).toBe(
      true,
    );
    const row = await findJobById(executor, 'job-c13');
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBe('job_type_unregistered');
    expect(row?.dlq_delivered_at ?? null).toBeNull();
    // A second poison pass is a no-op (guarded by dispatchable statuses).
    expect(
      await markJobDeadLetter(executor, 'job-c13', null, 'job_type_unregistered', NOW + 1),
    ).toBe(false);
  });
});

describe('recovery scans (bounded, indexed)', () => {
  it('reclaims only expired claimed leases, in bounded order', async () => {
    await seedJob({ id: 'job-r1', status: 'claimed', attempts: 1, leaseUntil: NOW - 2000 });
    await seedJob({ id: 'job-r2', status: 'claimed', attempts: 1, leaseUntil: NOW - 1000 });
    await seedJob({ id: 'job-r3', status: 'claimed', attempts: 1, leaseUntil: NOW + 1000 });
    await seedJob({ id: 'job-r4', status: 'pending' });
    const reclaimed = await reclaimExpiredClaims(executor, NOW, 25);
    expect(reclaimed).toEqual({ reclaimed: 2, exhaustedToDeadLetter: 0 });
    expect((await findJobById(executor, 'job-r1'))?.status).toBe('queued');
    expect((await findJobById(executor, 'job-r2'))?.status).toBe('queued');
    expect((await findJobById(executor, 'job-r3'))?.status).toBe('claimed');
    expect((await findJobById(executor, 'job-r4'))?.status).toBe('pending');
    // Reclaimed rows keep their generation (attempts are execution counts).
    expect((await findJobById(executor, 'job-r1'))?.attempts).toBe(1);
  });

  it('dead-letters expired claims whose attempt budget is spent (never re-executed)', async () => {
    await seedJob({ id: 'job-r5', status: 'claimed', attempts: 3, leaseUntil: NOW - 1000 });
    await seedJob({ id: 'job-r6', status: 'claimed', attempts: 2, leaseUntil: NOW - 1000 });
    const result = await reclaimExpiredClaims(executor, NOW, 25);
    expect(result).toEqual({ reclaimed: 1, exhaustedToDeadLetter: 1 });
    const spent = await findJobById(executor, 'job-r5');
    expect(spent?.status).toBe('dead_letter');
    expect(spent?.attempts).toBe(3);
    expect(spent?.last_error).toBe('job_exhausted');
    expect(spent?.dlq_delivered_at ?? null).toBeNull();
    // The budget-intact row still recovers normally.
    const intact = await findJobById(executor, 'job-r6');
    expect(intact?.status).toBe('queued');
    expect(intact?.attempts).toBe(2);
  });

  it('scans due pending/retry_wait rows deterministically (run_after, priority DESC, id)', async () => {
    await seedJob({ id: 'job-d1', runAfter: NOW + 2, priority: 10 });
    await seedJob({ id: 'job-d2', runAfter: NOW + 1, priority: 90 });
    await seedJob({ id: 'job-d3', runAfter: NOW + 1, priority: 90 });
    await seedJob({ id: 'job-d4', runAfter: NOW + 9 });
    await seedJob({ id: 'job-d5', runAfter: NOW + 1, priority: 95 });
    const due = await scanDueJobs(executor, NOW + 1, 10);
    expect(due.map((row) => row.id)).toEqual(['job-d5', 'job-d2', 'job-d3']);
    const bounded = await scanDueJobs(executor, NOW + 9, 3);
    expect(bounded.map((row) => row.id)).toEqual(['job-d5', 'job-d2', 'job-d3']);
  });

  it('scans stranded queued rows past the grace cutoff only', async () => {
    await seedJob({ id: 'job-s1', status: 'queued', updatedAt: NOW - 61_000 });
    await seedJob({ id: 'job-s2', status: 'queued', updatedAt: NOW - 59_000 });
    const stranded = await scanStrandedQueuedJobs(executor, NOW - 60_000, 25);
    expect(stranded.map((row) => row.id)).toEqual(['job-s1']);
  });

  it('marks the queued dispatch marker only for dispatchable rows', async () => {
    await seedJob({ id: 'job-q1' });
    expect(await markJobQueued(executor, 'job-q1', NOW)).toBe(true);
    expect((await findJobById(executor, 'job-q1'))?.status).toBe('queued');
    await seedJob({ id: 'job-q2', status: 'succeeded', attempts: 1 });
    expect(await markJobQueued(executor, 'job-q2', NOW)).toBe(false);
  });

  it('reconciles DLQ deliveries exactly once per confirmed send', async () => {
    await seedJob({ id: 'job-l1', status: 'dead_letter', attempts: 3 });
    await seedJob({ id: 'job-l2', status: 'dead_letter', attempts: 3 });
    await seedJob({ id: 'job-l3', status: 'succeeded', attempts: 1 });
    const pending = await scanPendingDlqDeliveries(executor, 25);
    expect(pending.map((row) => row.id).sort()).toEqual(['job-l1', 'job-l2']);
    expect(await markDlqDelivered(executor, 'job-l1', NOW)).toBe(true);
    // Second confirmation is a no-op (at-least-once with bounded duplicates).
    expect(await markDlqDelivered(executor, 'job-l1', NOW + 1)).toBe(false);
    const after = await scanPendingDlqDeliveries(executor, 25);
    expect(after.map((row) => row.id)).toEqual(['job-l2']);
  });
});
