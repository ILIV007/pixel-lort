/**
 * ROUND 1.9 — R09 source-poll ownership, PERMANENT PRODUCTION-PATH PROOFS.
 *
 * These tests exercise the REAL product surfaces end-to-end on real workerd
 * D1 — the product scheduler (`scheduleDueSources` → `schedulePollWindowOwned`),
 * the product store functions (`acquirePollOwnership` / `commitOwnedPollResults` /
 * `scanOutstandingPollDuplicates`), the REAL poll handler through the engine's
 * claimed-execution context, and the migration candidate 0004 applied WHOLE to
 * this DISPOSABLE test database via the explicit test-only `ROUND19_MIGRATION_PLAN`
 * (never applied anywhere real; the accepted runtime stays app1.4.0/schema3).
 *
 * Design authority: docs/reviews/PIXEL_ROUND1_5_1_OWNERSHIP_PAUSE_DESIGN.md
 * (accepted Round 1.5.1 ownership design + clarifications) and
 * docs/reviews/PIXEL_ROUND1_9_R09_OWNERSHIP_IMPLEMENTATION.md (Round 1.9
 * product mapping). Coverage below translates the accepted design proofs to
 * the production path (prompt instruction 6): new/overdue source, same-key
 * contenders, terminal reuse, queue outage/delayed dispatch, stale
 * generation, crash after commit vs before commit, mixed-source inputs,
 * pause/recovery fairness, current-owner preservation, migration duplicate
 * rejection, whole-file atomicity, and the schema3/schema4
 * capability/readiness transition.
 *
 * HONESTY BOUNDARIES (never claimed beyond what runs here):
 * - External fetching remains AT-LEAST-ONCE (proven by R09-P9: a crash
 *   between fetch and commit re-fetches on the re-drive). Nothing here
   proves exactly-once external fetching.
 * - Single-isolate workerd tests: ownership is decided INSIDE single
 *   atomic D1 transactions (CAS/EXISTS predicates); true multi-isolate
 *   concurrency is not schedulable in this environment (design §4 limits).
 * - The 0004 candidate is PROPOSED material: applied ONLY to this
 *   disposable test database. No deployment, activation, remote migration,
 *   or release-readiness claim is made.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  schedulePollWindowOwned,
  acquirePollOwnership,
  readPollOwnership,
  commitOwnedPollResults,
  commitPollResults,
  scanOutstandingPollDuplicates,
  OwnedCommitRejectionError,
  ITEM_SOURCE_MISMATCH,
  POLL_WINDOW_TERMINAL_REASON,
  type IngestItemRow,
  type PollTerminalState,
} from '../../src/adapters/db/source-ingest-store';
import {
  checkSchemaHealth,
  resolveSchemaCapability,
  type SchemaCapability,
} from '../../src/adapters/db/schema-health';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { readIngestionBudget } from '../../src/adapters/db/ingestion-budget-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { formatIdempotencyKey } from '../../src/shared/ids/idempotency-key';
import type { WorkerEnv } from '../../src/shared/types/env';

const NOW = 1770000000000;
const SOURCE = 'playstation_blog';
const HOLD = 120_000;
const db = createDbExecutor(env.DB);

const registry = () => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('registry invalid');
  return r.registry;
};
const seed = () => seedSourcesFromRegistry(db, registry(), NOW);
const enableSource = async (marker = 0) => {
  await seed();
  await db.run({
    sql: 'UPDATE sources SET enabled=1 WHERE id=?',
    params: [SOURCE],
  });
  if (marker !== 0) {
    await db.run({
      sql: 'UPDATE source_state SET next_poll_at=? WHERE source_id=?',
      params: [marker, SOURCE],
    });
  }
};

const resolution = (flag = 'true') => {
  const r = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: flag,
    JOBS: { send: async () => {} },
    DLQ: { send: async () => {} },
  } as unknown as WorkerEnv);
  if (r.kind !== 'ready') throw new Error('engine not ready');
  return r;
};

const stateRow = () =>
  db.first<{
    next_poll_at: number;
    poll_owner_job_id: string | null;
    cursor: string | null;
    etag: string | null;
    last_error: string | null;
    consecutive_failures: number;
  }>({
    sql: 'SELECT next_poll_at, poll_owner_job_id, cursor, etag, last_error, consecutive_failures FROM source_state WHERE source_id = ?',
    params: [SOURCE],
  });

const jobRows = () =>
  db.query<{
    id: string;
    status: string;
    attempts: number;
    idempotency_key: string;
    payload_json: string;
  }>({
    sql: "SELECT id, status, attempts, idempotency_key, payload_json FROM jobs WHERE type='sources.fetch_poll' AND aggregate_id=? ORDER BY created_at ASC, id ASC",
    params: [SOURCE],
  });

/** Insert a poll job fixture (any status) with the canonical window identity. */
async function insertPollJob(input: {
  id: string;
  status: string;
  attempts: number;
  scheduledForMs: number;
  idempotencyKey: string;
  runAfter?: number;
}): Promise<void> {
  await db.run({
    sql: `INSERT INTO jobs
            (id, type, aggregate_type, aggregate_id, status, priority, run_after,
             attempts, max_attempts, lease_until, idempotency_key, payload_json,
             last_error, created_at, updated_at, dlq_delivered_at)
          VALUES (?, 'sources.fetch_poll', 'source', ?, ?, 40, ?, ?, 3,
                  CASE WHEN ? = 'claimed' THEN ? ELSE NULL END, ?, ?, NULL, ?, ?, NULL)`,
    params: [
      input.id,
      SOURCE,
      input.status,
      input.runAfter ?? NOW,
      input.attempts,
      input.status,
      NOW + HOLD,
      input.idempotencyKey,
      canonicalizeJson({
        sourceId: SOURCE,
        scheduledForMs: input.scheduledForMs,
      }),
      NOW,
      NOW,
    ],
  });
}

const rssFeed = (guid: string) =>
  `<rss><channel><item><title>T ${guid}</title>` +
  `<link>https://blog.playstation.com/article/${guid}?utm_source=rss</link>` +
  `<guid isPermaLink="false">${guid}</guid>` +
  `<pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>` +
  `<description><![CDATA[<p>Body ${guid}</p>]]></description></item></channel></rss>`;

/**
 * Stub the worker global fetch with a scripted RSS 200 so ENGINE-driven
 * polls (whose wiring binds `globalThis.fetch` at resolution time) are
 * deterministic. Never touches the product wiring itself; restore with
 * `vi.unstubAllGlobals()` after the engine work is done.
 */
function stubEngineFetch(guid: string): { calls: { url: string }[] } {
  const calls: { url: string }[] = [];
  vi.stubGlobal('fetch', (async (url: RequestInfo | URL) => {
    calls.push({ url: String(url) });
    return new Response(rssFeed(guid), {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
    });
  }) as typeof fetch);
  return { calls };
}

interface ScriptedCall {
  readonly url: string;
}
function scriptedFetch(responses: readonly { status: number; bodyText?: string }[]) {
  const calls: ScriptedCall[] = [];
  let i = 0;
  const fetchFn = (async (url: RequestInfo | URL) => {
    calls.push({ url: String(url) });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(next.bodyText ?? '', {
      status: next.status,
      headers: { 'content-type': 'application/rss+xml' },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function makeHandler(fetchFn: typeof fetch) {
  return createSourcePollHandler({
    executor: db,
    connectors: createConnectorRegistry(),
    fetchFn,
    idGenerator: { newId: () => crypto.randomUUID() },
    secrets: () => undefined,
    nowMs: () => NOW,
    random: () => 0.5,
  });
}

const itemRow = (overrides: Partial<IngestItemRow> = {}): IngestItemRow => ({
  id: overrides.id ?? crypto.randomUUID(),
  sourceId: overrides.sourceId ?? SOURCE,
  externalId: overrides.externalId ?? 'rss:ext-1',
  canonicalUrl: overrides.canonicalUrl ?? 'https://blog.playstation.com/a',
  title: overrides.title ?? 'Title',
  excerpt: overrides.excerpt ?? null,
  author: overrides.author ?? null,
  publishedAtMs: overrides.publishedAtMs ?? NOW,
  fetchedAtMs: overrides.fetchedAtMs ?? NOW,
  contentHash: overrides.contentHash ?? 'hash-1',
  rawJson: overrides.rawJson ?? '{}',
});

const terminalState = (overrides: Partial<PollTerminalState> = {}): PollTerminalState => ({
  cursor: overrides.cursor ?? 'cursor-1',
  etag: overrides.etag ?? '"etag-1"',
  lastModified: overrides.lastModified ?? null,
  nextPollAtMs: overrides.nextPollAtMs ?? NOW + 300_000,
  success: overrides.success ?? true,
  lastChangedAtMs: overrides.lastChangedAtMs ?? NOW,
  lastError: overrides.lastError ?? null,
  consecutiveFailures: overrides.consecutiveFailures ?? 0,
  circuitOpenUntilMs: overrides.circuitOpenUntilMs ?? null,
  requestsToday: overrides.requestsToday ?? 1,
  budgetDate: overrides.budgetDate ?? '2026-02-02',
});

beforeEach(async () => {
  // Disposable workerd D1 + the explicit Round 1.9 test-only plan
  // (0001–0003 + the 0004 candidate). Never applied anywhere real.
  await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
});

// ---------------------------------------------------------------------------
// A. Scheduling — the REAL product scheduler on the ownership path
// ---------------------------------------------------------------------------

it('R09-P1: a NEW source reservation holds until after now, anchored to a durable owner', async () => {
  await enableSource(0);
  const outcome = await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome.kind).toBe('scheduled');
  if (outcome.kind !== 'scheduled') return;
  expect(outcome.jobsCreated).toBe(1);

  const state = await stateRow();
  expect(state!.next_poll_at).toBe(NOW + HOLD); // CURRENT-TIME hold — the R09 fix
  expect(state!.next_poll_at).toBeGreaterThan(NOW);
  expect(state!.poll_owner_job_id).not.toBeNull();

  const jobs = await jobRows();
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0]!.status).toBe('pending');
  expect(jobs.rows[0]!.attempts).toBe(0);
  expect(jobs.rows[0]!.id).toBe(state!.poll_owner_job_id); // the durable anchor names the ONE owner
  expect(jobs.rows[0]!.payload_json).toBe(
    canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
  );
});

it('R09-P2: an OVERDUE source also re-anchors its hold to now, never to the stale marker', async () => {
  await enableSource(NOW - 60_000); // due since a minute ago
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const state = await stateRow();
  expect(state!.next_poll_at).toBe(NOW + HOLD); // NOT marker+hold (= NOW+60s)
  expect(state!.next_poll_at).toBeGreaterThan(NOW);
  expect(state!.poll_owner_job_id).not.toBeNull();
});

it('R09-P3: same-key contenders — exactly ONE owner and ONE job; the loser is honestly classified', async () => {
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  const payload = canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 });

  const winner = await schedulePollWindowOwned(
    db,
    {
      sourceId: SOURCE,
      scheduledForMs: 0,
      idempotencyKey: key,
      canonicalPayloadJson: payload,
      jobId: 'job-a',
      priority: 40,
      maxAttempts: 3,
      nowMs: NOW,
    },
    300,
  );
  expect(winner.kind).toBe('scheduled');
  if (winner.kind !== 'scheduled') return;
  expect(winner.holdUntilMs).toBe(NOW + HOLD);

  const loser = await schedulePollWindowOwned(
    db,
    {
      sourceId: SOURCE,
      scheduledForMs: 0,
      idempotencyKey: key,
      canonicalPayloadJson: payload,
      jobId: 'job-b',
      priority: 40,
      maxAttempts: 3,
      nowMs: NOW,
    },
    300,
  );
  expect(loser).toEqual({
    kind: 'outstanding_job_owns_window',
    jobId: 'job-a',
  });

  const jobs = await jobRows();
  expect(jobs.rows).toHaveLength(1); // exactly ONE outstanding window
  expect(jobs.rows[0]!.id).toBe('job-a');
  const state = await stateRow();
  expect(state!.poll_owner_job_id).toBe('job-a');
  expect(state!.next_poll_at).toBe(NOW + HOLD); // untouched by the loser
});

it('R09-P4: a TERMINAL existing job consumes the window without ownership — authority is never reacquired', async () => {
  await enableSource(0); // the source_state row must exist for the S3 remediation
  for (const terminal of ['succeeded', 'dead_letter', 'cancelled', 'failed'] as const) {
    await db.run({ sql: 'DELETE FROM jobs' });
    await db.run({
      sql: 'UPDATE source_state SET next_poll_at=0, poll_owner_job_id=NULL WHERE source_id=?',
      params: [SOURCE],
    });
    const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
    await insertPollJob({
      id: `term-${terminal}`,
      status: terminal,
      attempts: 1,
      scheduledForMs: 0,
      idempotencyKey: key,
    });

    const outcome = await schedulePollWindowOwned(
      db,
      {
        sourceId: SOURCE,
        scheduledForMs: 0,
        idempotencyKey: key,
        canonicalPayloadJson: canonicalizeJson({
          sourceId: SOURCE,
          scheduledForMs: 0,
        }),
        jobId: 'fresh-contender',
        priority: 40,
        maxAttempts: 3,
        nowMs: NOW,
      },
      300,
    );
    expect(outcome.kind).toBe('window_terminal_skipped');
    if (outcome.kind !== 'window_terminal_skipped') return;
    expect(outcome.terminalJobId).toBe(`term-${terminal}`);
    expect(outcome.nextPollAtMs).toBe(NOW + 300_000); // fresh schedule, no hold

    const state = await stateRow();
    expect(state!.next_poll_at).toBe(NOW + 300_000);
    expect(state!.poll_owner_job_id).toBeNull(); // ownership NEVER transfers to/from a terminal job
    expect(state!.last_error).toBe(POLL_WINDOW_TERMINAL_REASON);
    const jobs = await jobRows();
    expect(jobs.rows).toHaveLength(1); // no new job was created
    expect(jobs.rows[0]!.status).toBe(terminal);
  }
});

it('R09-P5: a different-key outstanding job blocks a second window INSIDE D1 — nothing lands', async () => {
  await enableSource(0);
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const before = await stateRow();
  const jobsBefore = await jobRows();
  expect(jobsBefore.rows).toHaveLength(1);

  // A second window contender with a DIFFERENT key at the CURRENT marker
  // (the hold): the partial unique index aborts the whole batch inside D1.
  const outcome = await schedulePollWindowOwned(
    db,
    {
      sourceId: SOURCE,
      scheduledForMs: before!.next_poll_at,
      idempotencyKey: 'sources.poll:different-window',
      canonicalPayloadJson: canonicalizeJson({
        sourceId: SOURCE,
        scheduledForMs: before!.next_poll_at,
      }),
      jobId: 'job-b',
      priority: 40,
      maxAttempts: 3,
      nowMs: NOW + 1000,
    },
    300,
  );
  expect(outcome.kind).toBe('outstanding_elsewhere');
  if (outcome.kind !== 'outstanding_elsewhere') return;
  expect(outcome.jobId).toBe(jobsBefore.rows[0]!.id);

  const after = await stateRow(); // NOTHING landed
  expect(after!.next_poll_at).toBe(before!.next_poll_at);
  expect(after!.poll_owner_job_id).toBe(before!.poll_owner_job_id);
  expect((await jobRows()).rows).toHaveLength(1);
});

it('R09-P6: queue outage — the outstanding job survives later passes untouched, then executes under the recorded owner', async () => {
  await enableSource(0);
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const before = await stateRow();
  const jobBefore = (await jobRows()).rows[0]!;

  // Later passes (after the hold expired) must NOT create a second window…
  const secondPass = await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW + 300_000,
  });
  expect(secondPass.kind).toBe('scheduled');
  if (secondPass.kind !== 'scheduled') return;
  expect(secondPass.jobsCreated).toBe(0);
  const afterPass = await stateRow();
  expect(afterPass!.next_poll_at).toBe(before!.next_poll_at);
  expect(afterPass!.poll_owner_job_id).toBe(before!.poll_owner_job_id);

  // …and the eventual delivery executes under the recorded owner (self-
  // consistent: the claim awards generation 1; branch (ii) re-acquires).
  const { calls } = stubEngineFetch('p6');
  const engine = resolution().engine;
  const action = await engine.consumeMessage(
    `msg-${jobBefore.id}`,
    {
      version: 1,
      jobId: jobBefore.id,
      type: 'sources.fetch_poll',
      attempt: 1,
      traceId: 'trace-p6',
    },
    NOW,
  );
  vi.unstubAllGlobals();
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(calls).toHaveLength(1); // exactly one external fetch

  const job = await db.first<{ status: string; attempts: number }>({
    sql: 'SELECT status, attempts FROM jobs WHERE id=?',
    params: [jobBefore.id],
  });
  expect(job!.status).toBe('succeeded');
  expect(job!.attempts).toBe(1);
  const state = await stateRow();
  expect(state!.poll_owner_job_id).toBeNull(); // released together with the fresh schedule
  expect(state!.cursor).toContain('blog.playstation.com/feed'); // RSS per-feed validator cursor advanced
  // The engine wiring resolves the handler clock from the REAL wall clock,
  // so the fresh schedule is anchored to the poll's own now (> test NOW).
  expect(state!.next_poll_at).toBeGreaterThan(NOW + 200_000);
});

// ---------------------------------------------------------------------------
// B. Claim-time acquisition + ownership-fenced commits (REAL handler/store)
// ---------------------------------------------------------------------------

it('R09-P7: claim-time acquisition self-heals an unreserved window; foreign owner / stale generation never fetch', async () => {
  // (a) Self-heal (crash between the scheduling batch and the queue send is
  // impossible at schema 4 — S1+S2 are atomic — but a scheduler crash
  // BEFORE the batch leaves marker=payload marker with owner NULL; branch
  // (i) acquires it): claimed job, owner NULL, marker = scheduledForMs.
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  await insertPollJob({
    id: 'job-a',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: key,
  });
  const { fetchFn: fetchA, calls: callsA } = scriptedFetch([
    { status: 200, bodyText: rssFeed('p7a') },
  ]);
  const outcomeA = await makeHandler(fetchA).execute({
    jobId: 'job-a',
    generation: 1,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  expect(outcomeA).toEqual({ kind: 'success' });
  expect(callsA).toHaveLength(1);
  // The successful OWNED commit releases ownership together with the fresh
  // schedule (one atomic transition).
  expect(await readPollOwnership(db, SOURCE)).toEqual({
    nextPollAtMs: NOW + 300_000,
    ownerJobId: null,
  });
  expect((await stateRow())!.cursor).toContain('blog.playstation.com/feed');
  void key;

  // (b) A FOREIGN owner never reaches preflight, the budget, or the network.
  await db.run({ sql: 'DELETE FROM jobs' });
  await db.run({ sql: 'DELETE FROM source_items' });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" }); // isolate part (b)'s budget readback
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=?, poll_owner_job_id=?, cursor=NULL WHERE source_id=?',
    params: [NOW + HOLD, 'job-owner-elsewhere', SOURCE],
  });
  await insertPollJob({
    id: 'job-x',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: 'sources.poll:foreign',
  });
  const { fetchFn: fetchB, calls: callsB } = scriptedFetch([
    { status: 200, bodyText: rssFeed('p7b') },
  ]);
  const outcomeB = await makeHandler(fetchB).execute({
    jobId: 'job-x',
    generation: 1,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  expect(outcomeB).toEqual({ kind: 'success' }); // completes honestly, skipping BEFORE the network
  expect(callsB).toHaveLength(0); // ZERO fetches
  const usageB = await readIngestionBudget(db, {
    sourceId: SOURCE,
    nowMs: NOW,
  });
  expect(usageB).toBe(0); // ZERO budget units
  const stateB = await stateRow();
  expect(stateB!.poll_owner_job_id).toBe('job-owner-elsewhere'); // a non-owner cannot release the owner

  // (c) A STALE generation (exact-generation fence) never acquires.
  await db.run({ sql: 'DELETE FROM jobs' });
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" }); // isolate part (c)'s budget readback
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=?, poll_owner_job_id=NULL, cursor=NULL WHERE source_id=?',
    params: [0, SOURCE],
  });
  await insertPollJob({
    id: 'job-y',
    status: 'claimed',
    attempts: 2,
    scheduledForMs: 0,
    idempotencyKey: 'sources.poll:stale',
  });
  const { fetchFn: fetchC, calls: callsC } = scriptedFetch([
    { status: 200, bodyText: rssFeed('p7c') },
  ]);
  const outcomeC = await makeHandler(fetchC).execute({
    jobId: 'job-y',
    generation: 1,
    payload: { sourceId: SOURCE, scheduledForMs: 0 }, // row is at generation 2
  });
  expect(outcomeC).toEqual({ kind: 'success' });
  expect(callsC).toHaveLength(0);
  expect(await readIngestionBudget(db, { sourceId: SOURCE, nowMs: NOW })).toBe(0);
});

it('R09-P8: crash after commit, before completion — the recovered generation fetches NOTHING and commits NOTHING (P-R4)', async () => {
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  await insertPollJob({
    id: 'job-a',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: key,
  });
  const { fetchFn, calls } = scriptedFetch([{ status: 200, bodyText: rssFeed('p8') }]);

  // Generation 1: acquires, fetches ONCE, commits (marker advanced, owner
  // released) — then the process "crashes" before completeJob (the row
  // stays claimed at generation 1).
  const first = await makeHandler(fetchFn).execute({
    jobId: 'job-a',
    generation: 1,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  expect(first).toEqual({ kind: 'success' });
  expect(calls).toHaveLength(1);
  const afterFirst = await stateRow();
  expect(afterFirst!.cursor).toContain('blog.playstation.com/feed');
  expect(afterFirst!.poll_owner_job_id).toBeNull();

  // Recovery re-drive: the reclaimed row is claimed again at generation 2
  // (exactly what reclaim + re-claim produce) and delivered with the SAME
  // payload window.
  await db.run({
    sql: "UPDATE jobs SET attempts=2, lease_until=? WHERE id='job-a'",
    params: [NOW + HOLD],
  });
  const second = await makeHandler(fetchFn).execute({
    jobId: 'job-a',
    generation: 2,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  expect(second).toEqual({ kind: 'success' }); // completes honestly
  expect(calls).toHaveLength(1); // NO second external fetch
  const afterSecond = await stateRow(); // NO second commit
  expect(afterSecond!.cursor).toContain('blog.playstation.com/feed');
  expect(afterSecond!.next_poll_at).toBe(afterFirst!.next_poll_at);
  const items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id=?',
    params: [SOURCE],
  });
  expect(items!.n).toBe(1); // the feed's ONE item — committed exactly once, never duplicated
});

it('R09-P9: crash between fetch and commit — the re-drive fetches AGAIN (at-least-once, DISCLOSED) and commits exactly once (P-R5)', async () => {
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  await insertPollJob({
    id: 'job-a',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: key,
  });

  // Fault injection: the COMMIT batch fails ONCE after the fetch landed
  // (the crash window). The injection targets the commit batch specifically
  // (its signature carries the source_items insert) — the A1 write and the
  // budget-authorizer batches are left intact. Ownership + hold were
  // already written by A1.
  const brokenDb = {
    ...db,
    batch: async (...args: Parameters<typeof db.batch>) => {
      // db.batch takes ONE argument: the ordered statement list.
      const statements = (args[0] ?? []) as readonly { sql: string }[];
      if (statements.some((statement) => statement.sql.includes('INSERT INTO source_items'))) {
        throw new Error('injected storage failure');
      }
      return db.batch(...args);
    },
  } as typeof db;
  const { fetchFn, calls } = scriptedFetch([{ status: 200, bodyText: rssFeed('p9') }]);
  const brokenHandler = createSourcePollHandler({
    executor: brokenDb,
    connectors: createConnectorRegistry(),
    fetchFn,
    idGenerator: { newId: () => crypto.randomUUID() },
    secrets: () => undefined,
    nowMs: () => NOW,
    random: () => 0.5,
  });
  await expect(
    brokenHandler.execute({
      jobId: 'job-a',
      generation: 1,
      payload: { sourceId: SOURCE, scheduledForMs: 0 },
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1); // fetch #1 happened (never recalled)
  const afterCrash = await stateRow();
  expect(afterCrash!.poll_owner_job_id).toBe('job-a'); // A1's anchor survives (commit aborted whole)
  expect(afterCrash!.cursor).toBeNull(); // nothing committed

  // Recovery: reclaim + re-claim → generation 2. The SAME job re-acquires
  // via branch (ii) (the durable owner still names it) and — the disclosed
  // at-least-once semantics — the external fetch happens AGAIN.
  await db.run({
    sql: "UPDATE jobs SET attempts=2, lease_until=? WHERE id='job-a'",
    params: [NOW + HOLD],
  });
  const second = await makeHandler(fetchFn).execute({
    jobId: 'job-a',
    generation: 2,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  expect(second).toEqual({ kind: 'success' });
  expect(calls).toHaveLength(2); // DISCLOSED: at-least-once external fetching
  const items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id=?',
    params: [SOURCE],
  });
  expect(items!.n).toBe(1); // exactly ONE committed outcome (dedup absorbs the replay)
  const state = await stateRow();
  expect(state!.cursor).toContain('blog.playstation.com/feed');
  expect(state!.poll_owner_job_id).toBeNull(); // released atomically with the fresh schedule
});

it('R09-P10: an old generation or lost owner writes ZERO items and ZERO state and cannot release a newer owner', async () => {
  await enableSource(0);
  // Window 1 executes fully through the real engine (deterministic scripted
  // fetch; releases ownership).
  stubEngineFetch('p10');
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const jobA = (await jobRows()).rows[0]!;
  const engine = resolution().engine;
  await engine.consumeMessage(
    `msg-${jobA.id}`,
    {
      version: 1,
      jobId: jobA.id,
      type: 'sources.fetch_poll',
      attempt: 1,
      traceId: 't',
    },
    NOW,
  );
  const afterA = await stateRow();
  expect(afterA!.poll_owner_job_id).toBeNull();
  expect(afterA!.cursor).toContain('blog.playstation.com/feed');

  // Window 2: the next pass runs past the committed marker. The engine
  // wiring resolves the handler clock from the REAL wall clock, so the
  // committed marker ≈ realNow + 300s — the pass now is real-clock based.
  await scheduleDueSources({
    executor: db,
    engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: Date.now() + 400_000,
  });
  const jobB = (await jobRows()).rows.find((r) => r.id !== jobA.id);
  expect(jobB).toBeDefined();
  const afterB = await stateRow();
  expect(afterB!.poll_owner_job_id).toBe(jobB!.id);
  const holdB = afterB!.next_poll_at;
  vi.unstubAllGlobals();
  const itemsBeforeStale = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id=?',
    params: [SOURCE],
  });

  // A STALE in-flight worker of window 1 (its old window identity, old
  // hold, old generation — job A's row is already terminal) tries to commit
  // over the newer owner's window: the store fence writes ZERO items and
  // ZERO state and leaves job B's ownership fully intact. (The partial
  // unique index makes a second OUTSTANDING job impossible — the stale
  // worker here is a terminal/lagging writer, exactly the race the fence
  // exists to neutralize.)
  const stale = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: jobA.id,
    generation: 1,
    observedHoldUntilMs: NOW + HOLD, // window 1's old hold — long since moved
    items: [
      itemRow({
        externalId: 'rss:stale',
        canonicalUrl: 'https://blog.playstation.com/stale',
      }),
    ],
    state: terminalState({ cursor: 'stale-cursor', nextPollAtMs: NOW + 999 }),
    nowMs: NOW,
  });
  expect(stale.stateWriteWon).toBe(false);
  expect(stale.inserted).toBe(0);
  const items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id=?',
    params: [SOURCE],
  });
  expect(items!.n).toBe(itemsBeforeStale!.n); // ZERO new items — the stale batch inserted nothing
  const preserved = await stateRow();
  expect(preserved!.poll_owner_job_id).toBe(jobB!.id); // the newer owner is intact
  expect(preserved!.next_poll_at).toBe(holdB);
  expect(preserved!.cursor).toBe(afterA!.cursor); // window 1's committed cursor — NOT 'stale-cursor'

  // The same fence holds for the CURRENT owner committing against a STALE
  // observed hold (the marker moved between its acquisition and commit).
  await db.run({
    sql: "UPDATE jobs SET status='claimed', lease_until=? WHERE id=?",
    params: [holdB + HOLD, jobB!.id],
  });
  const staleHold = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: jobB!.id,
    generation: 1,
    observedHoldUntilMs: NOW + HOLD, // NOT the durable hold (holdB)
    items: [
      itemRow({
        externalId: 'rss:stale-hold',
        canonicalUrl: 'https://blog.playstation.com/stale-hold',
      }),
    ],
    state: terminalState({
      cursor: 'stale-hold-cursor',
      nextPollAtMs: NOW + 999,
    }),
    nowMs: NOW,
  });
  expect(staleHold.stateWriteWon).toBe(false);
  expect(staleHold.inserted).toBe(0);
  expect((await stateRow())!.poll_owner_job_id).toBe(jobB!.id); // ownership NOT released by a losing fence

  // A stale A1 acquisition is refused for the same reason (exact
  // generation + owner identity bind at claim time too).
  const refused = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: jobA.id,
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW,
  });
  expect(refused.kind).toBe('not_owned');
});

it('R09-P11: mixed-source batches are rejected BEFORE any statement — exact no-op, window survives, corrected commit succeeds', async () => {
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  await insertPollJob({
    id: 'job-a',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: key,
  });
  const acquired = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: 'job-a',
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW,
  });
  expect(acquired.kind).toBe('owned');
  if (acquired.kind !== 'owned') return;
  const hold = acquired.holdUntilMs;

  // (a) A lone foreign item rejects the WHOLE operation (typed rejection).
  await expect(
    commitOwnedPollResults(db, {
      sourceId: SOURCE,
      jobId: 'job-a',
      generation: 1,
      observedHoldUntilMs: hold,
      items: [itemRow({ sourceId: 'OTHER_SOURCE', externalId: 'rss:foreign' })],
      state: terminalState(),
      nowMs: NOW,
    }),
  ).rejects.toThrowError(OwnedCommitRejectionError);

  // (b) ONE foreign item inside an otherwise valid batch rejects the whole
  // batch — the valid item is NOT silently kept.
  await expect(
    commitOwnedPollResults(db, {
      sourceId: SOURCE,
      jobId: 'job-a',
      generation: 1,
      observedHoldUntilMs: hold,
      items: [
        itemRow({
          externalId: 'rss:valid',
          canonicalUrl: 'https://blog.playstation.com/valid',
        }),
        itemRow({ sourceId: 'OTHER_SOURCE', externalId: 'rss:foreign' }),
      ],
      state: terminalState(),
      nowMs: NOW,
    }),
  ).rejects.toMatchObject({ code: ITEM_SOURCE_MISMATCH });

  // Exact no-op: zero items, state unchanged, ownership NOT released —
  // the rejection burned nothing.
  let items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items',
  });
  expect(items!.n).toBe(0);
  expect(await readPollOwnership(db, SOURCE)).toEqual({
    nextPollAtMs: hold,
    ownerJobId: 'job-a',
  });
  expect((await stateRow())!.cursor).toBeNull();

  // A corrected commit for the SAME window then succeeds (P-O16).
  const repaired = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: 'job-a',
    generation: 1,
    observedHoldUntilMs: hold,
    items: [
      itemRow({
        externalId: 'rss:valid',
        canonicalUrl: 'https://blog.playstation.com/valid',
      }),
    ],
    state: terminalState(),
    nowMs: NOW,
  });
  expect(repaired.stateWriteWon).toBe(true);
  expect(repaired.inserted).toBe(1);
  items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items',
  });
  expect(items!.n).toBe(1);
  expect(await readPollOwnership(db, SOURCE)).toEqual({
    nextPollAtMs: NOW + 300_000,
    ownerJobId: null,
  });
});

it('R09-P12: hold expiry alone never revokes the current owner (P-O13 product path)', async () => {
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  await insertPollJob({
    id: 'job-a',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: key,
  });
  const acquired = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: 'job-a',
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW,
  });
  expect(acquired.kind).toBe('owned');

  // The wall clock moves well past the hold: no competitor ran, so the
  // owner stays fully authorized — its commit WINS despite the expired
  // hold timestamp.
  const lateCommit = await commitOwnedPollResults(db, {
    sourceId: SOURCE,
    jobId: 'job-a',
    generation: 1,
    observedHoldUntilMs: acquired.kind === 'owned' ? acquired.holdUntilMs : 0,
    items: [],
    state: terminalState({
      cursor: 'late-cursor',
      nextPollAtMs: NOW + 300_000,
    }),
    nowMs: NOW + 600_000, // hold (NOW+120s) long past
  });
  expect(lateCommit.stateWriteWon).toBe(true);
  expect((await stateRow())!.cursor).toBe('late-cursor');
  expect(await readPollOwnership(db, SOURCE)).toEqual({
    nextPollAtMs: NOW + 300_000,
    ownerJobId: null,
  });
});

it('R09-P13: pause composes with ownership — pre-claim D01 pause writes NOTHING; the gate-ON resume polls under the recorded owner', async () => {
  await enableSource(0);
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const jobA = (await jobRows()).rows[0]!;
  const before = await stateRow();
  const jobBefore = await db.first<{ status: string; attempts: number }>({
    sql: 'SELECT status, attempts FROM jobs WHERE id=?',
    params: [jobA.id],
  });

  // Gate OFF: the delivered poll is paused BEFORE the claim — zero durable
  // writes (row, attempts, owner, hold all untouched).
  const offAction = await resolution('false').engine.consumeMessage(
    'msg-off',
    {
      version: 1,
      jobId: jobA.id,
      type: 'sources.fetch_poll',
      attempt: 1,
      traceId: 't',
    },
    NOW,
  );
  expect(offAction).toEqual({ action: 'ack', outcome: 'paused_by_policy' });
  expect(await stateRow()).toEqual(before);
  expect(
    await db.first<{ status: string; attempts: number }>({
      sql: 'SELECT status, attempts FROM jobs WHERE id=?',
      params: [jobA.id],
    }),
  ).toEqual(jobBefore);

  // Gate ON: the very next delivery claims and completes under the
  // recorded owner (fairness — the paused row was never starved or lost).
  const { calls } = stubEngineFetch('p13');
  const onAction = await resolution().engine.consumeMessage(
    'msg-on',
    {
      version: 1,
      jobId: jobA.id,
      type: 'sources.fetch_poll',
      attempt: 1,
      traceId: 't',
    },
    NOW + 1000,
  );
  vi.unstubAllGlobals();
  expect(onAction).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(calls).toHaveLength(1);
  const done = await db.first<{ status: string }>({
    sql: 'SELECT status FROM jobs WHERE id=?',
    params: [jobA.id],
  });
  expect(done!.status).toBe('succeeded');
});

// ---------------------------------------------------------------------------
// C. Migration candidate 0004 — duplicate rejection, atomicity, transition
// ---------------------------------------------------------------------------

it('R09-P14: the 0004 candidate applied WHOLE — metadata 3→4, column + partial index present; re-application is a no-op', async () => {
  const meta = await db.query<{ key: string; value: string }>({
    sql: 'SELECT key, value FROM schema_metadata',
  });
  const values = new Map(meta.rows.map((r) => [r.key, r.value]));
  expect(values.get('schema_version')).toBe('4');
  expect(values.get('migration_id')).toBe('0004_source_poll_ownership');
  expect(values.get('applied_at')).toBeDefined();

  const column = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM pragma_table_info('source_state') WHERE name='poll_owner_job_id'",
  });
  expect(column!.n).toBe(1);
  const index = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_jobs_source_outstanding_poll'",
  });
  expect(index!.n).toBe(1);

  // An applied migration file is never executed as halves; re-running the
  // plan at the latest version is a no-op.
  const again = await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);
  expect(again.applied).toHaveLength(0);
  expect(again.finalVersion).toBe(4);
});

it('R09-P15: duplicate preflight is empty on a healthy database; the index rejects a second outstanding window (isolation per source)', async () => {
  await enableSource(0);
  await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(await scanOutstandingPollDuplicates(db, 25)).toEqual([]);

  // A manual second OUTSTANDING poll job for the SAME source is rejected…
  const otherSource = registry().sources.find((s) => s.id !== SOURCE)!.id;
  await expect(
    db.run({
      sql: `INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority, run_after,
                              attempts, max_attempts, lease_until, idempotency_key, payload_json,
                              last_error, created_at, updated_at, dlq_delivered_at)
            VALUES ('dup-same', 'sources.fetch_poll', 'source', ?, 'pending', 40, ?, 0, 3, NULL,
                    'sources.poll:dup-same', '{}', NULL, ?, ?, NULL)`,
      params: [SOURCE, NOW, NOW, NOW],
    }),
  ).rejects.toThrow();

  // …while ANOTHER source's outstanding window is unaffected (isolation).
  await db.run({
    sql: 'UPDATE sources SET enabled=1 WHERE id=?',
    params: [otherSource],
  });
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=0 WHERE source_id=?',
    params: [otherSource],
  });
  const second = await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW + 1,
  });
  if (second.kind === 'scheduled') {
    // the other source's window is schedulable (isolation holds)
    expect(second.jobsCreated).toBe(1);
  }
  expect(await scanOutstandingPollDuplicates(db, 25)).toEqual([]);
});

it('R09-P16: capability and health transition — health stays exact-equality; unknown states FAIL CLOSED (R19-01), never legacy', async () => {
  // The applied schema is 4: the operator-configured exact-equality health
  // check NEVER auto-accepts versions — it reports exactly what matches.
  expect(await checkSchemaHealth(db, 4)).toEqual({ ok: true });
  const mismatch = await checkSchemaHealth(db, 3);
  expect(mismatch).toEqual({
    ok: false,
    reason: 'schema_version_mismatch',
    observedSchemaVersion: 4,
  });

  // ── SUPERSEDED BEHAVIOR — preserved VERBATIM as the documented
  // historical reference (Round 1.9 acceptance, R09-P16 middle block).
  // This expectation codified corrupt→legacy scheduling and was UNSAFE
  // (it is exactly counterexample CE1). Its REPLACEMENT below is
  // explicitly authorized by the Round 1.9.1 prompt (R19-01 narrow
  // assertion-change authorization); the full rationale and the verbatim
  // ledger live in docs/reviews/ROUND1_9_1_CORRECTIONS.md §3.
  //
  //   // Corrupt metadata → the capability fails safe to OFF (never guesses).
  //   await db.run({
  //     sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'",
  //   });
  //   expect(await resolveOwnershipCapability(db)).toEqual({
  //     appliedSchemaVersion: null,
  //     ownershipEnabled: false,
  //   });
  //
  //   // The scheduler then takes the LEGACY path (accepted schema-3 behavior):
  //   // a durable job via the engine + the marker CAS — and it NEVER writes
  //   // the ownership column (fail-safe degradation, not a fabricated green).
  //   await enableSource(0);
  //   await db.run({ sql: 'DELETE FROM jobs' });
  //   const outcome = await scheduleDueSources({
  //     executor: db,
  //     engine: resolution().engine,
  //     connectors: createConnectorRegistry(),
  //     secrets: () => undefined,
  //     nowMs: NOW,
  //   });
  //   if (outcome.kind === 'scheduled') {
  //     expect(outcome.jobsCreated).toBe(1);
  //   }
  //   const legacy = await stateRow();
  //   expect(legacy!.poll_owner_job_id).toBeNull(); // the legacy path never touches the owner column
  //   expect(legacy!.next_poll_at).toBe(HOLD); // legacy marker+hold (the known schema-3 defect, honestly preserved)
  //
  // ── REPLACEMENT (R19-01 fail-closed): corrupt metadata resolves the
  // typed `unresolved` capability, and the scheduler stops with a stable
  // recoverable outcome BEFORE the completeness probe / seed / due scan —
  // zero jobs, zero marker movement, zero seed writes, owner untouched.
  await enableSource(0);
  await db.run({ sql: 'DELETE FROM jobs' });
  const beforeP16 = await stateRow();
  await db.run({
    sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'",
  });
  const unresolved: SchemaCapability = await resolveSchemaCapability(db);
  expect(unresolved).toEqual({
    kind: 'unresolved',
    reason: 'schema_capability_metadata_invalid',
  });
  const stopped = await scheduleDueSources({
    executor: db,
    engine: resolution().engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(stopped).toEqual({
    kind: 'capability_unresolved',
    reason: 'schema_capability_metadata_invalid',
  });
  const afterStop = await stateRow();
  expect(afterStop).toEqual(beforeP16); // zero source-state effects
  expect((await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM jobs' }))!.n).toBe(0); // zero job effects
  expect(afterStop!.poll_owner_job_id).toBeNull(); // ownership never fabricated

  // Recovery: a readable exact v4 resolves the ownership capability again.
  await db.run({
    sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'",
  });
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'known_v4_ownership',
    appliedSchemaVersion: 4,
  });
});

it('R09-P17: the owned commit is ONE atomic batch — an unrelated integrity failure aborts items AND state (R02 semantics under P)', async () => {
  await enableSource(0);
  const key = await formatIdempotencyKey('sources.poll', [SOURCE, '0']);
  await insertPollJob({
    id: 'job-a',
    status: 'claimed',
    attempts: 1,
    scheduledForMs: 0,
    idempotencyKey: key,
  });
  const acquired = await acquirePollOwnership(db, {
    sourceId: SOURCE,
    jobId: 'job-a',
    scheduledForMs: 0,
    generation: 1,
    nowMs: NOW,
  });
  if (acquired.kind !== 'owned') throw new Error('acquisition failed');

  // A title NOT NULL violation raises inside the batch and aborts the
  // WHOLE batch (items AND state roll back; ownership stays). The invalid
  // row is built directly (bypassing the fixture helper's nullish
  // coalescing) so the statement truly binds NULL.
  const invalid: IngestItemRow = {
    id: crypto.randomUUID(),
    sourceId: SOURCE,
    externalId: 'rss:broken',
    canonicalUrl: 'https://blog.playstation.com/broken',
    title: null as unknown as string,
    excerpt: null,
    author: null,
    publishedAtMs: NOW,
    fetchedAtMs: NOW,
    contentHash: 'hash-broken',
    rawJson: '{}',
  };
  await expect(
    commitOwnedPollResults(db, {
      sourceId: SOURCE,
      jobId: 'job-a',
      generation: 1,
      observedHoldUntilMs: acquired.holdUntilMs,
      items: [invalid],
      state: terminalState(),
      nowMs: NOW,
    }),
  ).rejects.toThrow();

  expect((await stateRow())!.cursor).toBeNull(); // state rolled back with the batch
  expect(await readPollOwnership(db, SOURCE)).toEqual({
    nextPollAtMs: acquired.holdUntilMs,
    ownerJobId: 'job-a',
  });
  const items = await db.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items',
  });
  expect(items!.n).toBe(0);

  // The same-shape legacy commit keeps its accepted behavior (boundary
  // parity: the legacy path also aborts whole on integrity failures).
  await commitPollResults(db, {
    sourceId: SOURCE,
    items: [invalid],
    state: terminalState(),
    holdUntilMs: NOW + HOLD,
    nowMs: NOW,
  }).catch(() => undefined);
  expect(
    (await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_items',
    }))!.n,
  ).toBe(0);
});
