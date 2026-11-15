/**
 * ROUND 1.5 DESIGN LAB — recovery proofs on REAL workerd D1 (schema 4 =
 * migrations 0001–0003 + the PROPOSED 0004 on a DISPOSABLE lab database).
 *
 * Round 1.5 instruction 4: prove queue-outage recovery, concurrent
 * schedulers, stale workers, and crash-after-state-commit /
 * before-job-completion behavior — WITHOUT claiming exactly-once external
 * fetching. The design's honest guarantee is: at-most-one COMMITTED outcome
 * per ownership epoch, at-least-once fetching under lease recovery.
 *
 * What these proofs DO prove (design document §6/§8):
 *  - a queue outage leaves rows dispatchable and ownership untouched; the
 *    next successful pass delivers (fail-closed recovery, W1′ family);
 *  - overlapping schedulers on one window produce EXACTLY one owner and one
 *    job, with honest classifications for both contenders;
 *  - a crashed-then-recovered execution whose poll already COMMITTED skips
 *    the second fetch entirely (the ownership anchor says the window moved)
 *    and completes honestly;
 *  - a crash BETWEEN the external fetch and the commit re-fetches on the
 *    next generation (at-least-once fetching, DISCLOSED, never hidden) and
 *    still commits at most once;
 *  - a non-owner never reaches the network or the budget (binding of
 *    pre-network checks to ownership, Round 1.5 instruction 3);
 *  - the partial unique index imposes a BOUNDED stall (A.5 trade-off):
 *    a second window waits until the outstanding job resolves, then
 *    proceeds normally.
 *
 * What these proofs DO NOT prove: multi-isolate concurrency (single-isolate
 * workerd; concurrent-batch serialization is delegated to D1's implicit
 * batch transactions and the accepted rollback evidence), product behavior
 * (nothing under src/ changed), and migration execution authority.
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { claimJob, reclaimExpiredClaims } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { formatIdempotencyKey } from '../../src/shared/ids/idempotency-key';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import {
  consumeWithPolicy,
  createDesignPollHandler,
  dispatchPassWithPolicy,
} from '../design/round15-lab-pipeline';
import type { LabConnector } from '../design/round15-lab-pipeline';
import {
  acquirePollOwnership,
  LAB_MIGRATION_PLAN,
  schedulePollWindow,
  SOURCE_POLL_HOLD_MS,
} from '../design/round15-ownership';

const NOW = 1_771_000_000_000;
const INTERVAL = 3_600;
const SOURCE = 'playstation_blog';
const POLL_ON = { ingestionGateOn: true };
const db = createDbExecutor(env.DB);

let fetchCalls = 0;

function labConnector(options?: { fetchResolves?: boolean }): LabConnector {
  return {
    preflight: () => ({ ok: true }),
    plannedRequestCount: () => 1,
    fetch: async () => {
      fetchCalls += 1;
      if (options?.fetchResolves === false) {
        throw new Error('injected transport death');
      }
      return {
        status: 'changed',
        items: [
          {
            externalId: `ps-item-${fetchCalls}`,
            canonicalUrl: `https://blog.playstation.com/post-${fetchCalls}`,
            title: `Post ${fetchCalls}`,
            excerpt: null,
            author: null,
            publishedAtMs: NOW,
            contentHash: `hash-${fetchCalls}`,
            rawJson: {},
          },
        ],
        cursor: `c-${fetchCalls}`,
        etag: null,
        lastModified: null,
        retryAfterSeconds: null,
        requestCount: 1,
        malformedCount: 0,
        failureReason: null,
      };
    },
  };
}

function designHandlers(): ReturnType<typeof createJobHandlerRegistry> {
  const handler = createDesignPollHandler({
    executor: db,
    connector: labConnector(),
    idGenerator: cryptoIdGenerator,
    nowMs: () => NOW,
    secrets: () => undefined,
  });
  return createJobHandlerRegistry([handler as never]);
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

/** One scheduling contender (deterministic key + payload for the window). */
async function scheduleWindow(marker: number, now = NOW) {
  const idempotencyKey = await formatIdempotencyKey('sources.poll', [SOURCE, String(marker)]);
  const canonicalPayloadJson = canonicalizeJson({ sourceId: SOURCE, scheduledForMs: marker });
  return schedulePollWindow(
    db,
    {
      sourceId: SOURCE,
      scheduledForMs: marker,
      idempotencyKey,
      canonicalPayloadJson,
      jobId: cryptoIdGenerator.newId(),
      priority: 40,
      maxAttempts: 3,
      nowMs: now,
    },
    INTERVAL,
  );
}

const readState = async () =>
  (await db.first<{
    next_poll_at: number;
    poll_owner_job_id: string | null;
    cursor: string | null;
  }>({
    sql: 'SELECT next_poll_at, poll_owner_job_id, cursor FROM source_state WHERE source_id = ?',
    params: [SOURCE],
  }))!;

const readJob = async (id: string) =>
  (await db.first<{ status: string; attempts: number; lease_until: number | null }>({
    sql: 'SELECT status, attempts, lease_until FROM jobs WHERE id = ?',
    params: [id],
  }))!;

const itemCount = async () =>
  (await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM source_items' }))!.n;

const envelopeFor = (jobId: string, attempt = 1) => ({
  version: 1 as const,
  jobId,
  type: 'sources.fetch_poll',
  attempt,
  traceId: 'lab-recovery',
});

beforeEach(async () => {
  await applyMigrations(env.DB, LAB_MIGRATION_PLAN);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs']) {
    await db.run({ sql: `DELETE FROM ${table}` });
  }
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
  fetchCalls = 0;
});

it('P-R1: a queue outage leaves rows dispatchable and ownership untouched', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  // The queue is down: every send throws.
  const outage = await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: {
      send: async () => {
        throw new Error('queue unavailable');
      },
    },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_ON,
  });
  expect(outage.sendFailures).toBe(1);
  expect(outage.dispatched).toBe(0);
  const duringOutage = await readJob(scheduled.jobId);
  expect(duringOutage.status).toBe('pending'); // dispatchable, never queued
  const state = await readState();
  expect(state.poll_owner_job_id).toBe(scheduled.jobId); // ownership untouched
  expect(state.next_poll_at).toBe(NOW + SOURCE_POLL_HOLD_MS);
  // The outage ends: the very next pass delivers.
  const recovered = await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
  });
  expect(recovered.dispatched).toBe(1);
  const action = await consumeWithPolicy(
    { executor: db, handlers: designHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-1',
    envelopeFor(scheduled.jobId),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1);
  expect((await readJob(scheduled.jobId)).status).toBe('succeeded');
});

it('P-R2: W1′ — a crash after the scheduling batch but before the queue send recovers', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  // CRASH: nothing is sent. The durable state is consistent: job + marker.
  expect(await readJob(scheduled.jobId)).toEqual({
    status: 'pending',
    attempts: 0,
    lease_until: null,
  });
  expect((await readState()).poll_owner_job_id).toBe(scheduled.jobId);
  // A later cron pass dispatches normally; the poll executes under the
  // recorded ownership (A1 branch ii — the owner column names this job).
  await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: designHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-1',
    envelopeFor(scheduled.jobId),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1);
  expect((await readJob(scheduled.jobId)).status).toBe('succeeded');
});

it('P-R3: interleaved concurrent schedulers — exactly one owner, honest classifications', async () => {
  await seedSource();
  // Both passes scan the same due marker (0). Pass B's batch lands first.
  const outcomeB = await scheduleWindow(0);
  expect(outcomeB.kind).toBe('scheduled');
  const outcomeA = await scheduleWindow(0);
  expect(outcomeA).toEqual({
    kind: 'outstanding_job_owns_window',
    jobId: (outcomeB as { jobId: string }).jobId,
  });
  expect(await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM jobs' })).toEqual({
    n: 1,
  });
  expect((await readState()).poll_owner_job_id).toBe((outcomeB as { jobId: string }).jobId);
  // Reverse interleave: A wins, B is told honestly.
  await db.run({ sql: 'DELETE FROM jobs' });
  await db.run({ sql: 'UPDATE source_state SET next_poll_at = 0, poll_owner_job_id = NULL' });
  const outcomeA2 = await scheduleWindow(0);
  expect(outcomeA2.kind).toBe('scheduled');
  const outcomeB2 = await scheduleWindow(0);
  expect(outcomeB2).toEqual({
    kind: 'outstanding_job_owns_window',
    jobId: (outcomeA2 as { jobId: string }).jobId,
  });
});

it('P-R4: crash after the state commit, before job completion — NO second fetch', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  // Generation 1: claim, acquire, execute the poll — the commit lands
  // (items + fresh schedule + released ownership) — then the isolate DIES
  // before completeJob. Every step used the design's own functions.
  const claim1 = await claimJob(db, scheduled.jobId, NOW);
  if (claim1.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim1.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const handler = createDesignPollHandler({
    executor: db,
    connector: labConnector(),
    idGenerator: cryptoIdGenerator,
    nowMs: () => NOW,
    secrets: () => undefined,
  });
  const outcome = await handler.execute({
    jobId: scheduled.jobId,
    generation: claim1.generation,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  expect(outcome).toEqual({ kind: 'success' });
  expect(fetchCalls).toBe(1);
  const committedState = await readState();
  expect(committedState.next_poll_at).toBe(NOW + INTERVAL * 1000); // fresh schedule
  expect(committedState.poll_owner_job_id).toBeNull(); // released with the window
  expect(await itemCount()).toBe(1);

  // RECOVERY: the lease expires; the reclaim re-queues; a new generation
  // runs. The ownership anchor says the window already moved: the handler
  // skips BEFORE the network — no second fetch, no second commit.
  await db.run({
    sql: 'UPDATE jobs SET lease_until = ? WHERE id = ?',
    params: [NOW - 1_000, scheduled.jobId],
  });
  const reclaim = await reclaimExpiredClaims(db, NOW, 25);
  expect(reclaim.reclaimed).toBe(1);
  await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
    dispatchGraceMs: 0,
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: designHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-2',
    envelopeFor(scheduled.jobId, 2),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1); // UNCHANGED: the re-run fetched nothing
  expect(await itemCount()).toBe(1); // no duplicate items
  const row = await readJob(scheduled.jobId);
  expect(row.status).toBe('succeeded');
  expect(row.attempts).toBe(2);
});

it('P-R5: crash between the fetch and the commit — the re-drive fetches AGAIN (at-least-once, disclosed)', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  // Generation 1: claim + acquire + the external fetch happened — then the
  // isolate DIED before any commit. The durable state: claimed job, owner
  // recorded, hold set, NO items, NO terminal state.
  const claim1 = await claimJob(db, scheduled.jobId, NOW);
  if (claim1.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim1.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  fetchCalls = 1; // the external fetch was issued; nothing was persisted
  expect(await itemCount()).toBe(0);

  // RECOVERY: lease expiry → reclaim → re-dispatch → a NEW generation
  // re-acquires ITS OWN window (branch ii: the owner column names this job)
  // and polls again. External requests already issued cannot be recalled —
  // the design guarantees at-most-one-COMMITTED-outcome, NOT exactly-once
  // fetching (A.5, stated honestly).
  await db.run({
    sql: 'UPDATE jobs SET lease_until = ? WHERE id = ?',
    params: [NOW - 1_000, scheduled.jobId],
  });
  const reclaim = await reclaimExpiredClaims(db, NOW, 25);
  expect(reclaim.reclaimed).toBe(1);
  await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: POLL_ON,
    dispatchGraceMs: 0,
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: designHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-2',
    envelopeFor(scheduled.jobId, 2),
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(2); // DISCLOSED duplicate fetch under recovery
  expect(await itemCount()).toBe(1); // exactly one committed outcome
  const row = await readJob(scheduled.jobId);
  expect(row.status).toBe('succeeded');
  expect((await readState()).poll_owner_job_id).toBeNull();
});

it('P-R6: a non-owner never reaches the network or the budget (pre-network binding)', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  // A FOREIGN job (different aggregate) whose payload points at THIS source:
  // it may claim itself, but the ownership acquisition refuses before any
  // network activity and before any budget spend.
  const foreignJobId = cryptoIdGenerator.newId();
  await db.run({
    sql: `INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority,
                             run_after, attempts, max_attempts, lease_until,
                             idempotency_key, payload_json, last_error, created_at,
                             updated_at, dlq_delivered_at)
          VALUES (?, 'sources.fetch_poll', 'source', 'other_source', 'pending', 40, ?,
                  0, 3, NULL, 'foreign-key', ?, NULL, ?, ?, NULL)`,
    params: [
      foreignJobId,
      NOW,
      canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
      NOW,
      NOW,
    ],
  });
  const claim = await claimJob(db, foreignJobId, NOW + SOURCE_POLL_HOLD_MS + 1_000);
  expect(claim.kind).toBe('claimed');
  const handler = createDesignPollHandler({
    executor: db,
    connector: labConnector(),
    idGenerator: cryptoIdGenerator,
    nowMs: () => NOW + SOURCE_POLL_HOLD_MS + 1_000,
    secrets: () => undefined,
  });
  const outcome = await handler.execute({
    jobId: foreignJobId,
    generation: 1,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  // Skipped BEFORE preflight, BEFORE the budget reservation, BEFORE fetch.
  expect(outcome).toEqual({ kind: 'success' });
  expect(fetchCalls).toBe(0);
  const budget = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM budgets WHERE scope='ingestion'",
  });
  expect(budget!.n).toBe(0);
  // The legitimate owner's durable anchor is untouched.
  expect((await readState()).poll_owner_job_id).toBe(scheduled.jobId);
});

it('P-R7: the partial unique index imposes a BOUNDED stall, then normal flow resumes', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim1 = await claimJob(db, scheduled.jobId, NOW);
  if (claim1.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim1.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const handler = createDesignPollHandler({
    executor: db,
    connector: labConnector(),
    idGenerator: cryptoIdGenerator,
    nowMs: () => NOW,
    secrets: () => undefined,
  });
  await handler.execute({
    jobId: scheduled.jobId,
    generation: claim1.generation,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  const committedMarker = (await readState()).next_poll_at;
  expect(committedMarker).toBe(NOW + INTERVAL * 1000);

  // The source is due again, but the outstanding (claimed) job blocks the
  // second window: A.5's disclosed trade-off — a bounded stall, never a
  // duplicate outstanding poll.
  const blocked = await scheduleWindow(committedMarker, NOW + INTERVAL * 1000 + 1);
  expect(blocked).toEqual({ kind: 'outstanding_elsewhere', jobId: scheduled.jobId });

  // The outstanding job resolves (lease expiry → reclaim → re-dispatch →
  // the ownership anchor says "not your window" → honest skip → succeeded).
  await db.run({
    sql: 'UPDATE jobs SET lease_until = ? WHERE id = ?',
    params: [NOW - 1_000, scheduled.jobId],
  });
  await reclaimExpiredClaims(db, NOW + INTERVAL * 1000, 25);
  await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + INTERVAL * 1000,
    gates: POLL_ON,
    dispatchGraceMs: 0,
  });
  const action = await consumeWithPolicy(
    { executor: db, handlers: designHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-1',
    envelopeFor(scheduled.jobId, 2),
    NOW + INTERVAL * 1000 + 1_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1); // still exactly one fetch across both generations
  expect((await readJob(scheduled.jobId)).status).toBe('succeeded');

  // The stall ends: the new window schedules and polls normally.
  const next = await scheduleWindow(committedMarker, NOW + INTERVAL * 1000 + 2_000);
  expect(next.kind).toBe('scheduled');
  await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + INTERVAL * 1000 + 3_000,
    gates: POLL_ON,
  });
  const nextAction = await consumeWithPolicy(
    { executor: db, handlers: designHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-2',
    envelopeFor((next as { jobId: string }).jobId),
    NOW + INTERVAL * 1000 + 4_000,
  );
  expect(nextAction).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(2);
  expect(await itemCount()).toBe(2);
});
