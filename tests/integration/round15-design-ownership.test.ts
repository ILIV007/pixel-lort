/**
 * ROUND 1.5 DESIGN LAB — ownership proofs on REAL workerd D1 (schema 4 =
 * migrations 0001–0003 + the PROPOSED 0004, applied to a DISPOSABLE lab
 * database via LAB_MIGRATION_PLAN; never applied to production).
 *
 * What these proofs DO prove (each is quoted in the design document §8):
 *  - the proposed SQL is valid on real workerd D1 and behaves exactly as
 *    specified: current-time hold (the R09 semantics), atomic
 *    create+reserve winner binding (A.3 corrected), terminal-window
 *    remediation (A.4), claim-time acquisition (A1), and the
 *    ownership-fenced commit (A.1 clause 7 shape);
 *  - losing CAS, idempotency conflicts, foreign payloads, and terminal
 *    existing jobs can NEVER acquire or overwrite ownership (Round 1.5
 *    instruction 1);
 *  - a stale worker (foreign owner, stale generation, superseded window)
 *    commits NOTHING — items roll back with the atomic batch;
 *  - the explicit hold/lease-expiry semantics (instruction 3);
 *  - ROUND 1.5.1 (B1): the commit boundary ENFORCES the authoritative
 *    source binding — a foreign-attributed item (lone or MIXED into an
 *    otherwise valid batch) rejects the WHOLE operation before anything
 *    runs (no items, no cursor/state advance, no ownership release, the
 *    window survives), and a valid commit attributes every row to the
 *    authoritative source only (P-O16…P-O18);
 *  - ROUND 1.5.1 (B2 compatibility): the policy-aware recovery and the
 *    owned commit work TOGETHER on the proposed schema 4 (P-O19) — an OFF
 *    gate leaves a claimed poll row dormant with its ownership anchor
 *    intact; ON resumes under ordinary attempt economics.
 *
 * What these proofs DO NOT prove:
 *  - multi-isolate concurrency (workerd tests are single-isolate; D1-side
 *    serialization of truly concurrent batches is delegated to the
 *    established atomic-batch evidence: the accepted R08/round13 rollback
 *    proofs and D1's implicit batch transactions);
 *  - product behavior (nothing under src/ changed; the four known
 *    failures R04/R09/R10/D01 remain untouched);
 *  - migration execution authority (the proposed 0004 is applied ONLY to
 *    this disposable lab database).
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { claimJob } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { formatIdempotencyKey } from '../../src/shared/ids/idempotency-key';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import {
  consumeWithPolicy,
  createDesignPollHandler,
  dispatchPassWithPolicy,
  type LabConnector,
} from '../design/round15-lab-pipeline';
import {
  acquirePollOwnership,
  commitOwnedPollResults,
  DESIGN_CODE_ITEM_SOURCE_MISMATCH,
  LAB_MIGRATION_PLAN,
  OwnedCommitRejectionError,
  POLL_WINDOW_TERMINAL_REASON,
  readPollOwnership,
  schedulePollWindow,
  SOURCE_POLL_HOLD_MS,
} from '../design/round15-ownership';

const NOW = 1_771_000_000_000;
const INTERVAL = 3_600;
const SOURCE = 'playstation_blog';
const db = createDbExecutor(env.DB);

let fetchCalls = 0;

/** STUB connector for the P-O19 combined flow (counts external fetches). */
function labConnector(): LabConnector {
  return {
    preflight: () => ({ ok: true }),
    plannedRequestCount: () => 1,
    fetch: async () => {
      fetchCalls += 1;
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

async function seedSource(sourceId = SOURCE, interval = INTERVAL): Promise<void> {
  await db.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled,
                                interval_seconds, priority, daily_request_budget,
                                approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'PS Blog', 'rss', 'official', 80, 1, ?, 50, 100, 'auto', '{}', ?, ?)`,
    params: [sourceId, interval, NOW, NOW],
  });
  await db.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                     requests_today, updated_at)
          VALUES (?, 0, 0, 0, ?)`,
    params: [sourceId, NOW],
  });
}

/** One scheduling contender for one window (deterministic key + payload). */
async function scheduleWindow(
  marker: number,
  opts?: { sourceId?: string; now?: number; interval?: number },
) {
  const sourceId = opts?.sourceId ?? SOURCE;
  const now = opts?.now ?? NOW;
  const idempotencyKey = await formatIdempotencyKey('sources.poll', [sourceId, String(marker)]);
  const canonicalPayloadJson = canonicalizeJson({ sourceId, scheduledForMs: marker });
  return schedulePollWindow(
    db,
    {
      sourceId,
      scheduledForMs: marker,
      idempotencyKey,
      canonicalPayloadJson,
      jobId: cryptoIdGenerator.newId(),
      priority: 40,
      maxAttempts: 3,
      nowMs: now,
    },
    opts?.interval ?? INTERVAL,
  );
}

async function windowKey(marker: number, sourceId = SOURCE): Promise<string> {
  return formatIdempotencyKey('sources.poll', [sourceId, String(marker)]);
}

async function insertManualJob(input: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payloadJson: string;
  status: string;
}): Promise<string> {
  const id = cryptoIdGenerator.newId();
  await db.run({
    sql: `INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority,
                             run_after, attempts, max_attempts, lease_until,
                             idempotency_key, payload_json, last_error, created_at,
                             updated_at, dlq_delivered_at)
          VALUES (?, ?, ?, ?, ?, 40, ?, 0, 3, NULL, ?, ?, NULL, ?, ?, NULL)`,
    params: [
      id,
      input.type,
      input.aggregateType,
      input.aggregateId,
      input.status,
      NOW,
      input.idempotencyKey,
      input.payloadJson,
      NOW,
      NOW,
    ],
  });
  return id;
}

interface StateRow {
  next_poll_at: number;
  poll_owner_job_id: string | null;
  last_error: string | null;
}

const readState = async (sourceId = SOURCE): Promise<StateRow> =>
  (await db.first<StateRow>({
    sql: 'SELECT next_poll_at, poll_owner_job_id, last_error FROM source_state WHERE source_id = ?',
    params: [sourceId],
  }))!;

const jobCount = async (sourceId = SOURCE): Promise<number> =>
  (await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM jobs WHERE type='sources.fetch_poll' AND aggregate_id = ?",
    params: [sourceId],
  }))!.n;

beforeEach(async () => {
  await applyMigrations(env.DB, LAB_MIGRATION_PLAN);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs']) {
    await db.run({ sql: `DELETE FROM ${table}` });
  }
});

it('P-O1: scheduling writes a CURRENT-TIME hold bound to the winner (R09 semantics)', async () => {
  await seedSource();
  const outcome = await scheduleWindow(0);
  expect(outcome.kind).toBe('scheduled');
  if (outcome.kind !== 'scheduled') return;
  expect(outcome.holdUntilMs).toBe(NOW + SOURCE_POLL_HOLD_MS);
  const state = await readState();
  // The hold is anchored at the CURRENT injected time — strictly after NOW,
  // never a 1970-era value derived from the stale due marker.
  expect(state.next_poll_at).toBe(NOW + SOURCE_POLL_HOLD_MS);
  expect(state.next_poll_at).toBeGreaterThan(NOW);
  // The hold is DURABLE WINNER-OWNED data: the row names the owning job.
  expect(state.poll_owner_job_id).toBe(outcome.jobId);
  const job = await db.first<{
    status: string;
    aggregate_type: string;
    aggregate_id: string;
    payload_json: string;
  }>({
    sql: 'SELECT status, aggregate_type, aggregate_id, payload_json FROM jobs WHERE id = ?',
    params: [outcome.jobId],
  });
  expect(job!.status).toBe('pending');
  expect(job!.aggregate_type).toBe('source');
  expect(job!.aggregate_id).toBe(SOURCE);
  expect(job!.payload_json).toBe(canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }));
});

it('P-O2: overlapping schedulers on the same window — exactly one owner, one job', async () => {
  await seedSource();
  const first = await scheduleWindow(0);
  expect(first.kind).toBe('scheduled');
  const second = await scheduleWindow(0);
  expect(second).toEqual({
    kind: 'outstanding_job_owns_window',
    jobId: (first as { jobId: string }).jobId,
  });
  expect(await jobCount()).toBe(1);
  const state = await readState();
  expect(state.poll_owner_job_id).toBe((first as { jobId: string }).jobId);
  expect(state.next_poll_at).toBe(NOW + SOURCE_POLL_HOLD_MS);
});

it('P-O3: a losing CAS (marker moved) never acquires or overwrites ownership', async () => {
  await seedSource();
  // Another writer advances the marker between the scan and the batch.
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at = ? WHERE source_id = ?',
    params: [NOW + INTERVAL * 1000, SOURCE],
  });
  const outcome = await scheduleWindow(0);
  expect(outcome.kind).toBe('inserted_unreserved');
  if (outcome.kind !== 'inserted_unreserved') return;
  const state = await readState();
  expect(state.next_poll_at).toBe(NOW + INTERVAL * 1000); // untouched by the loser
  expect(state.poll_owner_job_id).toBeNull(); // no ownership acquired
  expect(await jobCount()).toBe(1); // the unreserved job exists (harmless)
  // The unreserved job is harmless: at claim time it cannot acquire.
  const claimed = await claimJob(db, outcome.jobId, NOW + INTERVAL * 1000);
  expect(claimed.kind).toBe('claimed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: outcome.jobId,
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW + INTERVAL * 1000,
  });
  expect(acquisition).toEqual({ kind: 'not_owned', reason: 'window_superseded' });
  const after = await readState();
  expect(after.poll_owner_job_id).toBeNull();
});

it('P-O4: a foreign payload with the same key never acquires ownership', async () => {
  await seedSource();
  const key = await windowKey(0);
  // A foreign writer used OUR deterministic key for a different payload.
  await insertManualJob({
    type: 'sources.fetch_poll',
    aggregateType: 'source',
    aggregateId: 'foreign_source',
    idempotencyKey: key,
    payloadJson: canonicalizeJson({ sourceId: 'foreign_source', scheduledForMs: 0 }),
    status: 'pending',
  });
  const outcome = await scheduleWindow(0);
  expect(outcome).toEqual({ kind: 'foreign_window_job', foreignJobId: expect.any(String) });
  const state = await readState();
  expect(state.next_poll_at).toBe(0); // marker untouched
  expect(state.poll_owner_job_id).toBeNull(); // ownership untouched
  expect(await jobCount(SOURCE)).toBe(0); // no job created for our source
  expect(await jobCount('foreign_source')).toBe(1);
  // Same anomaly for a same-key row with a foreign TYPE.
  const outcome2 = await scheduleWindow(0);
  expect(outcome2.kind).toBe('foreign_window_job');
  const state2 = await readState();
  expect(state2.poll_owner_job_id).toBeNull();
});

it.each(['succeeded', 'dead_letter', 'cancelled', 'failed'] as const)(
  'P-O5: a terminal existing job (%s) consumes the window without re-acquiring it',
  async (status) => {
    await seedSource();
    const key = await windowKey(0);
    const terminalId = await insertManualJob({
      type: 'sources.fetch_poll',
      aggregateType: 'source',
      aggregateId: SOURCE,
      idempotencyKey: key,
      payloadJson: canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
      status,
    });
    const outcome = await scheduleWindow(0);
    expect(outcome).toEqual({
      kind: 'window_terminal_skipped',
      terminalJobId: terminalId,
      nextPollAtMs: NOW + INTERVAL * 1000,
    });
    const state = await readState();
    // A.4 rule 2: the stale marker advances DIRECTLY to a fresh schedule —
    // no hold, no ownership, no new job.
    expect(state.next_poll_at).toBe(NOW + INTERVAL * 1000);
    expect(state.last_error).toBe(POLL_WINDOW_TERMINAL_REASON);
    expect(state.poll_owner_job_id).toBeNull();
    expect(await jobCount()).toBe(1);
  },
);

it('P-O6: the partial unique index blocks a second outstanding window for one source', async () => {
  await seedSource();
  const first = await scheduleWindow(0);
  expect(first.kind).toBe('scheduled');
  // A second window for the SAME source while the first job is outstanding:
  // the proposed index aborts the whole batch inside D1 — nothing lands.
  const second = await scheduleWindow(NOW + SOURCE_POLL_HOLD_MS);
  expect(second).toEqual({
    kind: 'outstanding_elsewhere',
    jobId: (first as { jobId: string }).jobId,
  });
  expect(await jobCount()).toBe(1);
  const state = await readState();
  expect(state.next_poll_at).toBe(NOW + SOURCE_POLL_HOLD_MS); // unchanged
  expect(state.poll_owner_job_id).toBe((first as { jobId: string }).jobId);
});

it('P-O7: claim-time acquisition self-heals a scheduler that crashed before reserving', async () => {
  await seedSource();
  // The job exists (scheduler inserted it) but the reservation never landed:
  // the window is unowned at the payload's own marker.
  const key = await windowKey(0);
  const jobId = await insertManualJob({
    type: 'sources.fetch_poll',
    aggregateType: 'source',
    aggregateId: SOURCE,
    idempotencyKey: key,
    payloadJson: canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
    status: 'pending',
  });
  const claim = await claimJob(db, jobId, NOW);
  expect(claim.kind).toBe('claimed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId,
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW,
  });
  expect(acquisition).toEqual({ kind: 'owned', holdUntilMs: NOW + SOURCE_POLL_HOLD_MS });
  const state = await readState();
  expect(state.poll_owner_job_id).toBe(jobId);
  expect(state.next_poll_at).toBe(NOW + SOURCE_POLL_HOLD_MS); // current-time hold
});

it('P-O8: a newer generation of the SAME job re-acquires its own window', async () => {
  await seedSource();
  const key = await windowKey(0);
  const jobId = await insertManualJob({
    type: 'sources.fetch_poll',
    aggregateType: 'source',
    aggregateId: SOURCE,
    idempotencyKey: key,
    payloadJson: canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
    status: 'pending',
  });
  await claimJob(db, jobId, NOW);
  const first = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId,
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW,
  });
  expect(first.kind).toBe('owned');
  // Lease recycled: the row now shows attempts = 2 (a newer generation).
  await db.run({ sql: 'UPDATE jobs SET attempts = 2 WHERE id = ?', params: [jobId] });
  const later = NOW + 60_000;
  const second = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId,
    scheduledForMs: 0,
    generation: 2,
    nowMs: later,
  });
  expect(second).toEqual({ kind: 'owned', holdUntilMs: later + SOURCE_POLL_HOLD_MS });
  const state = await readState();
  expect(state.poll_owner_job_id).toBe(jobId);
  expect(state.next_poll_at).toBe(later + SOURCE_POLL_HOLD_MS);
});

it('P-O9: acquisition refuses a foreign owner, a superseded window, and a stale generation', async () => {
  await seedSource();
  const winner = await scheduleWindow(0);
  expect(winner.kind).toBe('scheduled');
  const winnerJobId = (winner as { jobId: string }).jobId;

  // (a0) The index itself: a second OUTSTANDING poll job for the same source
  //      cannot even be created (manually or otherwise) while the winner's
  //      job is non-terminal.
  const key = await windowKey(0);
  await expect(
    insertManualJob({
      type: 'sources.fetch_poll',
      aggregateType: 'source',
      aggregateId: SOURCE,
      idempotencyKey: `${key}:foreign`,
      payloadJson: canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
      status: 'pending',
    }),
  ).rejects.toThrow();
  expect(await jobCount()).toBe(1);

  // (a) FOREIGN-OWNER refusal (defense in depth — through the design's own
  //     writes an owned window changes hands only by overwrite, so this
  //     state is simulated exactly as a competing reservation would leave it).
  const foreignJob = await insertManualJob({
    type: 'sources.fetch_poll',
    aggregateType: 'source',
    aggregateId: 'other_source',
    idempotencyKey: `${key}:other-source`,
    payloadJson: canonicalizeJson({ sourceId: 'other_source', scheduledForMs: 0 }),
    status: 'pending',
  });
  await claimJob(db, foreignJob, NOW + SOURCE_POLL_HOLD_MS + 1);
  const foreign = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: foreignJob,
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW + SOURCE_POLL_HOLD_MS + 1,
  });
  // The foreign job's payload points at a DIFFERENT source: its acquisition
  // attempt on THIS source cannot match its own payload marker and the owner
  // is the winner — refused on both branches.
  expect(foreign).toEqual({ kind: 'not_owned', reason: 'owner_foreign' });
  expect((await readState()).poll_owner_job_id).toBe(winnerJobId);

  // (b) A stale generation of the WINNER (attempts moved on) cannot acquire.
  await db.run({ sql: 'UPDATE jobs SET attempts = 2 WHERE id = ?', params: [winnerJobId] });
  const staleGeneration = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: winnerJobId,
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW + SOURCE_POLL_HOLD_MS + 1,
  });
  expect(staleGeneration).toEqual({ kind: 'not_owned', reason: 'window_superseded' });

  // (c) A superseded window (marker moved, owner cleared) cannot be re-claimed.
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at = ?, poll_owner_job_id = NULL WHERE source_id = ?',
    params: [NOW + INTERVAL * 1000, SOURCE],
  });
  const superseded = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: winnerJobId,
    scheduledForMs: 0,
    generation: 2,
    nowMs: NOW + INTERVAL * 1000,
  });
  expect(superseded).toEqual({ kind: 'not_owned', reason: 'window_superseded' });
});

it('P-O10: an owned commit lands items, advances the schedule, and releases ownership', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');

  const commitAt = NOW + 5_000;
  const result = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    generation: claim.generation,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [
      {
        id: cryptoIdGenerator.newId(),
        sourceId: SOURCE,
        externalId: 'ps-blog-1',
        canonicalUrl: 'https://blog.playstation.com/post-1',
        title: 'Post 1',
        excerpt: null,
        author: null,
        publishedAtMs: NOW,
        fetchedAtMs: commitAt,
        contentHash: 'hash-1',
        rawJson: '{}',
      },
    ],
    state: {
      cursor: '{"v":1}',
      etag: 'etag-1',
      lastModified: null,
      nextPollAtMs: commitAt + INTERVAL * 1000,
      success: true,
      lastChangedAtMs: commitAt,
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntilMs: null,
      requestsToday: 1,
      budgetDate: '2026-02-13',
    },
    nowMs: commitAt,
  });
  expect(result.stateWriteWon).toBe(true);
  expect(result.inserted).toBe(1);
  const state = await readState();
  expect(state.next_poll_at).toBe(commitAt + INTERVAL * 1000);
  expect(state.poll_owner_job_id).toBeNull(); // ownership released with the window
  const item = await db.first<{ processing_status: string }>({
    sql: 'SELECT processing_status FROM source_items WHERE external_id = ?',
    params: ['ps-blog-1'],
  });
  expect(item!.processing_status).toBe('new');
});

it('P-O11: a stale worker whose ownership was superseded commits NOTHING', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');

  // A newer window takes over the source while the stale worker runs.
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at = ?, poll_owner_job_id = ? WHERE source_id = ?',
    params: [NOW + 9_000 + SOURCE_POLL_HOLD_MS, 'job-newer-window', SOURCE],
  });

  const result = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    generation: claim.generation,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [
      {
        id: cryptoIdGenerator.newId(),
        sourceId: SOURCE,
        externalId: 'stale-item',
        canonicalUrl: null,
        title: 'Stale',
        excerpt: null,
        author: null,
        publishedAtMs: NOW,
        fetchedAtMs: NOW,
        contentHash: 'hash-stale',
        rawJson: '{}',
      },
    ],
    state: {
      cursor: 'stale',
      etag: null,
      lastModified: null,
      nextPollAtMs: NOW + 1,
      success: true,
      lastChangedAtMs: NOW,
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntilMs: null,
      requestsToday: 0,
      budgetDate: '2026-02-13',
    },
    nowMs: NOW,
  });
  // The fence loses: the WHOLE batch rolls back — zero items, zero state.
  expect(result.stateWriteWon).toBe(false);
  expect(result.inserted).toBe(0);
  const itemCount = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items',
  });
  expect(itemCount!.n).toBe(0);
  const state = await readState();
  expect(state.poll_owner_job_id).toBe('job-newer-window'); // untouched
  expect(state.next_poll_at).toBe(NOW + 9_000 + SOURCE_POLL_HOLD_MS);
});

it('P-O12: the commit binds the exact generation and claimed status', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const baseCommit = {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [],
    state: {
      cursor: null,
      etag: null,
      lastModified: null,
      nextPollAtMs: NOW + INTERVAL * 1000,
      success: true,
      lastChangedAtMs: NOW,
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntilMs: null,
      requestsToday: 0,
      budgetDate: '2026-02-13',
    },
    nowMs: NOW,
  };
  // (a) Wrong generation: the EXISTS clause fails, nothing lands.
  const wrongGeneration = await commitOwnedPollResults(db, {
    ...baseCommit,
    generation: claim.generation + 1,
  });
  expect(wrongGeneration.stateWriteWon).toBe(false);
  // (b) Job no longer claimed (moved to succeeded by a stale completion):
  //     the fence fails.
  await db.run({
    sql: "UPDATE jobs SET status = 'succeeded' WHERE id = ?",
    params: [scheduled.jobId],
  });
  const notClaimed = await commitOwnedPollResults(db, {
    ...baseCommit,
    generation: claim.generation,
  });
  expect(notClaimed.stateWriteWon).toBe(false);
  const state = await readState();
  expect(state.poll_owner_job_id).toBe(scheduled.jobId); // untouched by both
  expect(state.next_poll_at).toBe(acquisition.holdUntilMs);
});

it('P-O13: hold-expiry semantics — expiry alone never revokes ownership', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  // The delivery is delayed past the hold. NOBODY re-reserved (the owner is
  // still the winner): the commit still wins — the hold is a SCHEDULING
  // lease; only a competing reservation (possible only after expiry) can
  // revoke ownership, and it does so by overwriting the owner column.
  const late = NOW + SOURCE_POLL_HOLD_MS + 60_000;
  const result = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    generation: claim.generation,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [],
    state: {
      cursor: null,
      etag: null,
      lastModified: null,
      nextPollAtMs: late + INTERVAL * 1000,
      success: true,
      lastChangedAtMs: late,
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntilMs: null,
      requestsToday: 0,
      budgetDate: '2026-02-13',
    },
    nowMs: late,
  });
  expect(result.stateWriteWon).toBe(true);
});

it('P-O14: ownership revocation — the index blocks mid-flight takeover, the fence absorbs overwrites', async () => {
  await seedSource();
  const first = await scheduleWindow(0);
  if (first.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, first.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: first.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const expiredMarker = acquisition.holdUntilMs;
  const late = expiredMarker + 60_000;

  // (a) EXCLUSIVITY: while the first job is outstanding (claimed), a second
  //     window CANNOT be scheduled at all — the partial unique index aborts
  //     the batch (A.5 trade-off: at most one outstanding poll per source).
  const blocked = await scheduleWindow(expiredMarker, { now: late });
  expect(blocked).toEqual({ kind: 'outstanding_elsewhere', jobId: first.jobId });
  expect(await jobCount()).toBe(1);

  // (b) FENCE (last line of defense — reachable on schema 3, after manual
  //     intervention, or in any deployment without the index): when the
  //     owner column has been overwritten by a competing reservation, the
  //     old owner's commit changes NOTHING (items carry the same predicate).
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at = ?, poll_owner_job_id = ? WHERE source_id = ?',
    params: [late + SOURCE_POLL_HOLD_MS, 'job-newer-window', SOURCE],
  });
  const result = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: first.jobId,
    generation: claim.generation,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [
      {
        id: cryptoIdGenerator.newId(),
        sourceId: SOURCE,
        externalId: 'old-window-item',
        canonicalUrl: null,
        title: 'Old',
        excerpt: null,
        author: null,
        publishedAtMs: NOW,
        fetchedAtMs: late,
        contentHash: 'hash-old',
        rawJson: '{}',
      },
    ],
    state: {
      cursor: 'old',
      etag: null,
      lastModified: null,
      nextPollAtMs: late + INTERVAL * 1000,
      success: true,
      lastChangedAtMs: late,
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntilMs: null,
      requestsToday: 0,
      budgetDate: '2026-02-13',
    },
    nowMs: late,
  });
  expect(result.stateWriteWon).toBe(false);
  expect(result.inserted).toBe(0);
  const itemCount = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items',
  });
  expect(itemCount!.n).toBe(0);
  const state = await readState();
  expect(state.poll_owner_job_id).toBe('job-newer-window');
});

it('P-O15: readPollOwnership exposes the durable winner-owned anchor', async () => {
  await seedSource();
  expect(await readPollOwnership(db, SOURCE)).toEqual({ nextPollAtMs: 0, ownerJobId: null });
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  expect(await readPollOwnership(db, SOURCE)).toEqual({
    nextPollAtMs: NOW + SOURCE_POLL_HOLD_MS,
    ownerJobId: scheduled.jobId,
  });
  expect(await readPollOwnership(db, 'missing_source')).toBeNull();
});

/* ========================================================================
 * ROUND 1.5.1 (B1) — AUTHORITATIVE SOURCE BINDING (counterexample CE1
 * corrected). The owned commit boundary must itself enforce the
 * source-binding invariant it advertises: authority for source A never
 * authorizes a source B insert, a mixed batch is rejected WHOLE, and the
 * durable window survives the rejection untouched.
 * ======================================================================== */

/** State snapshot used by the B1 rejection proofs. */
async function snapshotForB1(sourceId = SOURCE) {
  const state = await readState(sourceId);
  const items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items',
  });
  return { state, itemCount: items!.n };
}

const foreignItem = (id: string, sourceId: string, externalId: string) => ({
  id,
  sourceId,
  externalId,
  canonicalUrl: `https://example.com/${externalId}`,
  title: 'not owned',
  excerpt: null,
  author: null,
  publishedAtMs: NOW,
  fetchedAtMs: NOW + 5_000,
  contentHash: `hash-${externalId}`,
  rawJson: '{}',
});

const validItem = (id: string, externalId: string) => ({
  id,
  sourceId: SOURCE,
  externalId,
  canonicalUrl: `https://blog.playstation.com/${externalId}`,
  title: 'Owned',
  excerpt: null,
  author: null,
  publishedAtMs: NOW,
  fetchedAtMs: NOW + 5_000,
  contentHash: `hash-${externalId}`,
  rawJson: '{}',
});

const b1State = {
  cursor: 'advanced',
  etag: null,
  lastModified: null,
  nextPollAtMs: NOW + 5_000 + INTERVAL * 1000,
  success: true,
  lastChangedAtMs: NOW + 5_000,
  lastError: null,
  consecutiveFailures: 0,
  circuitOpenUntilMs: null,
  requestsToday: 0,
  budgetDate: '2026-02-13',
} as const;

it('P-O16 (CE1 corrected): a foreign-source item rejects the WHOLE commit — nothing written, window intact', async () => {
  await seedSource();
  await seedSource('source_b');
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const before = await snapshotForB1();

  let rejection: unknown;
  try {
    await commitOwnedPollResults(db, {
      sourceId: SOURCE,
      jobId: scheduled.jobId,
      generation: claim.generation,
      observedHoldUntilMs: acquisition.holdUntilMs,
      items: [foreignItem(cryptoIdGenerator.newId(), 'source_b', 'foreign-item')],
      state: { ...b1State },
      nowMs: NOW + 5_000,
    });
  } catch (e) {
    rejection = e;
  }
  expect(rejection).toBeInstanceOf(OwnedCommitRejectionError);
  expect((rejection as OwnedCommitRejectionError).code).toBe(DESIGN_CODE_ITEM_SOURCE_MISMATCH);
  // EXACT no-op: no foreign item, no local item, no state/cursor advance,
  // ownership NOT released, hold NOT moved.
  const after = await snapshotForB1();
  expect(after.itemCount).toBe(0);
  expect(after.itemCount).toBe(before.itemCount);
  expect(after.state).toEqual(before.state);
  const owned = await readPollOwnership(db, SOURCE);
  expect(owned).toEqual({
    nextPollAtMs: acquisition.holdUntilMs,
    ownerJobId: scheduled.jobId,
  });
  // The rejection burns NOTHING: a corrected commit for the SAME window
  // still succeeds.
  const repaired = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    generation: claim.generation,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [validItem(cryptoIdGenerator.newId(), 'ps-blog-1')],
    state: { ...b1State },
    nowMs: NOW + 6_000,
  });
  expect(repaired.stateWriteWon).toBe(true);
  expect(repaired.inserted).toBe(1);
  expect((await readPollOwnership(db, SOURCE))!.ownerJobId).toBeNull(); // released
});

it('P-O17: a MIXED valid+foreign batch is rejected whole — the valid item is not silently kept', async () => {
  await seedSource();
  await seedSource('source_b');
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const before = await snapshotForB1();

  await expect(
    commitOwnedPollResults(db, {
      sourceId: SOURCE,
      jobId: scheduled.jobId,
      generation: claim.generation,
      observedHoldUntilMs: acquisition.holdUntilMs,
      items: [
        validItem(cryptoIdGenerator.newId(), 'ps-blog-1'),
        foreignItem(cryptoIdGenerator.newId(), 'source_b', 'foreign-item'),
      ],
      state: { ...b1State },
      nowMs: NOW + 5_000,
    }),
  ).rejects.toBeInstanceOf(OwnedCommitRejectionError);
  // NO partial acceptance: the valid item was NOT inserted either.
  const after = await snapshotForB1();
  expect(after.itemCount).toBe(0);
  expect(after.itemCount).toBe(before.itemCount);
  expect(after.state).toEqual(before.state);
  // Classification/reads bind the authoritative source: source B has no
  // rows anywhere (items OR state advance).
  const foreign = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: ['source_b'],
  });
  expect(foreign!.n).toBe(0);
});

it('P-O18: a valid commit attributes every row to the AUTHORITATIVE source only (classification binding)', async () => {
  await seedSource();
  await seedSource('source_b');
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  const result = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    generation: claim.generation,
    observedHoldUntilMs: acquisition.holdUntilMs,
    items: [
      validItem(cryptoIdGenerator.newId(), 'ps-blog-1'),
      validItem(cryptoIdGenerator.newId(), 'ps-blog-2'),
    ],
    state: { ...b1State },
    nowMs: NOW + 5_000,
  });
  expect(result.inserted).toBe(2);
  expect(result.stateWriteWon).toBe(true);
  const owned = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: [SOURCE],
  });
  expect(owned!.n).toBe(2);
  const foreign = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: ['source_b'],
  });
  expect(foreign!.n).toBe(0);
  expect((await readState('source_b')).next_poll_at).toBe(0); // untouched
});

it('P-O19 (schema-4 combined compatibility): policy-aware recovery + owned commit work together', async () => {
  await seedSource();
  const scheduled = await scheduleWindow(0);
  if (scheduled.kind !== 'scheduled') throw new Error('scheduling failed');
  const claim = await claimJob(db, scheduled.jobId, NOW);
  if (claim.kind !== 'claimed') throw new Error('claim failed');
  const acquisition = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: scheduled.jobId,
    scheduledForMs: 0,
    generation: claim.generation,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('acquisition failed');
  // The worker died mid-execution; the gate then went OFF: the policy-aware
  // recovery (dispatch pass) must leave the claimed poll row DORMANT — and
  // the ownership anchor must survive untouched.
  await db.run({
    sql: 'UPDATE jobs SET lease_until = ? WHERE id = ?',
    params: [NOW - 1_000, scheduled.jobId],
  });
  const offSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: createJobHandlerRegistry([]),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: { ingestionGateOn: false },
  });
  expect(offSummary.reclaimedLeases).toBe(0);
  expect(offSummary.reclaimedExhausted).toBe(0);
  expect(offSummary.pausedExpiredObserved).toBe(1);
  expect((await readPollOwnership(db, SOURCE))!.ownerJobId).toBe(scheduled.jobId);
  // Gate ON: the ordinary recovery requeues the row (budget intact), the
  // design handler re-acquires ITS OWN window (branch ii) and the owned
  // commit lands — the B1 binding guard does not disturb a valid batch.
  await dispatchPassWithPolicy({
    executor: db,
    handlers: designHandlers(),
    producer: { send: async () => {} },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 1_000,
    gates: { ingestionGateOn: true },
    dispatchGraceMs: 0,
  });
  const action = await consumeWithPolicy(
    {
      executor: db,
      handlers: designHandlers(),
      idGenerator: cryptoIdGenerator,
      gates: { ingestionGateOn: true },
    },
    'msg-po19',
    {
      version: 1 as const,
      jobId: scheduled.jobId,
      type: 'sources.fetch_poll',
      attempt: 2,
      traceId: 'po19-trace',
    },
    NOW + 2_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(fetchCalls).toBe(1); // exactly ONE external fetch across both generations
  const state = await readState();
  expect(state.poll_owner_job_id).toBeNull(); // released with the window
});
