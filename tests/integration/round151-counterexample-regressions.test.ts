/**
 * ROUND 1.5.1 — IN-SUITE REGRESSIONS FOR THE INDEPENDENT COUNTEREXAMPLES.
 *
 * The independent review supplied `posidon-round15-counterexamples.test.ts`
 * (preserved BYTE-IDENTICAL at review/evidence/ in this package — it is not
 * part of the source tree because its console-log evidence style trips the
 * accepted `no-console` lint rule on the accepted eslint config, which must
 * stay byte-identical). This file re-states the SAME desired contracts as
 * lint-clean in-suite regressions, so `npm test` itself proves the
 * corrections answer all three counterexamples plus the control. It is
 * ADDITIVE: nothing about the supplied file is changed, weakened, skipped
 * or relabeled; the exact pre-fix (3 failed / 1 passed) and post-fix (4/4)
 * runs of the ORIGINAL file are recorded in review/logs.
 *
 *  - CE1 (B1): authority for source A must never authorize a source B
 *    insert — the owned commit rejects the WHOLE operation.
 *  - CE2 (B2): gate OFF must precede expired-claim exhaustion — no paused
 *    row enters the DLQ during OFF.
 *  - CE3 (B2): paused expired claims must not consume the enabled-type
 *    recovery scan budget.
 *  - CONTROL: without paused rows the enabled expired heartbeat is
 *    recovered immediately (recovery to QUEUED — the stranded-queue grace
 *    still applies, unchanged).
 *
 * Runs on schema 3 (DDL-independence), same as the pause proofs.
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { claimJob } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import {
  acquirePollOwnership,
  commitOwnedPollResults,
  LAB_MIGRATION_PLAN,
  OwnedCommitRejectionError,
  schedulePollWindow,
} from '../design/round15-ownership';
import { dispatchPassWithPolicy } from '../design/round15-lab-pipeline';

const NOW = 1_771_000_000_000;
const db = createDbExecutor(env.DB);

async function seed(id: string): Promise<void> {
  await db.run({
    sql: `INSERT INTO sources(id,name,connector,lane,trust_tier,enabled,interval_seconds,priority,daily_request_budget,approval_policy,config_json,created_at,updated_at) VALUES(?,?,'rss','official',80,1,3600,50,100,'auto','{}',?,?)`,
    params: [id, id, NOW, NOW],
  });
  await db.run({
    sql: `INSERT INTO source_state(source_id,next_poll_at,consecutive_failures,requests_today,updated_at) VALUES(?,0,0,0,?)`,
    params: [id, NOW],
  });
}

beforeEach(async () => {
  await applyMigrations(env.DB, LAB_MIGRATION_PLAN);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs']) {
    await db.run({ sql: `DELETE FROM ${t}` });
  }
});

it('CE1-R: an owner of source A must not commit an item attributed to source B', async () => {
  await seed('source_a');
  await seed('source_b');
  const jobId = cryptoIdGenerator.newId();
  const scheduled = await schedulePollWindow(
    db,
    {
      sourceId: 'source_a',
      scheduledForMs: 0,
      idempotencyKey: 'ce:source_a:0',
      canonicalPayloadJson: canonicalizeJson({ sourceId: 'source_a', scheduledForMs: 0 }),
      jobId,
      priority: 40,
      maxAttempts: 3,
      nowMs: NOW,
    },
    3600,
  );
  expect(scheduled.kind).toBe('scheduled');
  const claim = await claimJob(db, jobId, NOW);
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('fixture claim failed');
  await acquirePollOwnership(db, {
    sourceId: 'source_a',
    jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  const own = await db.first<{ next_poll_at: number }>({
    sql: 'SELECT next_poll_at FROM source_state WHERE source_id=?',
    params: ['source_a'],
  });
  // The whole operation is REJECTED with the B1 typed error — nothing runs.
  await expect(
    commitOwnedPollResults(db, {
      sourceId: 'source_a',
      jobId,
      generation: claim.generation,
      observedHoldUntilMs: own!.next_poll_at,
      items: [
        {
          id: cryptoIdGenerator.newId(),
          sourceId: 'source_b',
          externalId: 'foreign-item',
          canonicalUrl: 'https://example.com/foreign',
          title: 'not owned',
          excerpt: null,
          author: null,
          publishedAtMs: null,
          fetchedAtMs: NOW,
          contentHash: 'foreign-hash',
          rawJson: '{}',
        },
      ],
      state: {
        cursor: 'advanced',
        etag: null,
        lastModified: null,
        nextPollAtMs: NOW + 3600000,
        success: true,
        lastChangedAtMs: NOW,
        lastError: null,
        consecutiveFailures: 0,
        circuitOpenUntilMs: null,
        requestsToday: 0,
        budgetDate: '2026-02-13',
      },
      nowMs: NOW,
    }),
  ).rejects.toBeInstanceOf(OwnedCommitRejectionError);
  const foreign = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id=?',
    params: ['source_b'],
  });
  expect(foreign!.n, 'authority for source A must never authorize a source B insert').toBe(0);
});

it('CE2-R: gate OFF must precede expired-claim exhaustion; no paused row enters DLQ', async () => {
  const id = cryptoIdGenerator.newId();
  await db.run({
    sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,last_error,created_at,updated_at,dlq_delivered_at) VALUES(?,'sources.fetch_poll','source','source_a','claimed',40,?,3,3,?, ?,?,NULL,?,?,NULL)`,
    params: [
      id,
      NOW - 20000,
      NOW - 1,
      'ce:expired',
      canonicalizeJson({ sourceId: 'source_a', scheduledForMs: 0 }),
      NOW - 20000,
      NOW - 1000,
    ],
  });
  const handlers = createJobHandlerRegistry([]);
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers,
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: { ingestionGateOn: false },
  });
  const row = await db.first<{ status: string; attempts: number; last_error: string | null }>({
    sql: 'SELECT status,attempts,last_error FROM jobs WHERE id=?',
    params: [id],
  });
  expect(row!.status, 'paused expired claim must not be dead-lettered during OFF').not.toBe(
    'dead_letter',
  );
  expect(row!.status).toBe('claimed'); // dormant, exactly as it was
  expect(row!.attempts).toBe(3); // exhausted state information preserved
  expect(summary.reclaimedExhausted).toBe(0);
  expect(summary.pausedExpiredObserved).toBe(1);
});

it('CE3-R: paused expired claims must not consume the enabled-type recovery scan budget', async () => {
  for (let i = 0; i < 26; i++) {
    const paused = i < 25;
    const id = `recovery-${i}`;
    await db.run({
      sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,last_error,created_at,updated_at,dlq_delivered_at) VALUES(?,?,NULL,NULL,'claimed',40,?,1,3,?,?,?,NULL,?,?,NULL)`,
      params: [
        id,
        paused ? 'sources.fetch_poll' : 'jobs.maintenance_heartbeat',
        NOW - 100000,
        NOW - 1000 + i,
        `ce:${id}`,
        paused
          ? canonicalizeJson({ sourceId: 'source_a', scheduledForMs: 0 })
          : canonicalizeJson({ note: 'enabled recovery control' }),
        NOW - 20000,
        NOW - 10000,
      ],
    });
  }
  const handlers = createJobHandlerRegistry([
    { type: 'jobs.maintenance_heartbeat', execute: async () => ({ kind: 'success' }) } as never,
  ]);
  let sends = 0;
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers,
    producer: {
      send: async () => {
        sends++;
      },
    },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: { ingestionGateOn: false },
    reclaimBatch: 25,
    dispatchBatch: 25,
  });
  const active = await db.first<{ status: string }>({
    sql: 'SELECT status FROM jobs WHERE id=?',
    params: ['recovery-25'],
  });
  expect(
    active!.status,
    'enabled expired work must be reached in the first recovery page',
  ).not.toBe('claimed');
  expect(active!.status).toBe('queued'); // recovered to queued (grace still applies)
  expect(sends).toBe(0); // no same-pass send — the queue grace is unchanged
  expect(summary.reclaimedLeases).toBe(1);
  expect(summary.pausedExpiredObserved).toBe(25);
});

it('CONTROL-R: without paused rows the enabled expired heartbeat is recovered immediately', async () => {
  for (let i = 0; i < 1; i++) {
    const id = `recovery-${i}`;
    await db.run({
      sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,last_error,created_at,updated_at,dlq_delivered_at) VALUES(?,?,NULL,NULL,'claimed',40,?,1,3,?,?,?,NULL,?,?,NULL)`,
      params: [
        id,
        'jobs.maintenance_heartbeat',
        NOW - 100000,
        NOW - 1000 + i,
        `ce:${id}`,
        canonicalizeJson({ note: 'enabled recovery control' }),
        NOW - 20000,
        NOW - 10000,
      ],
    });
  }
  const handlers = createJobHandlerRegistry([
    { type: 'jobs.maintenance_heartbeat', execute: async () => ({ kind: 'success' }) } as never,
  ]);
  let sends = 0;
  const summary = await dispatchPassWithPolicy({
    executor: db,
    handlers,
    producer: {
      send: async () => {
        sends++;
      },
    },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: { ingestionGateOn: false },
    reclaimBatch: 25,
    dispatchBatch: 25,
  });
  const active = await db.first<{ status: string }>({
    sql: 'SELECT status FROM jobs WHERE id=?',
    params: ['recovery-0'],
  });
  expect(
    active!.status,
    'enabled expired work must be reached in the first recovery page',
  ).not.toBe('claimed');
  expect(active!.status).toBe('queued');
  expect(sends).toBe(0);
  expect(summary.reclaimedLeases).toBe(1);
  expect(summary.pausedExpiredObserved).toBe(0);
});
