/**
 * ROUND 1.5.1 DESIGN LAB — policy-aware expired-claim recovery proofs on
 * REAL workerd D1 (counterexamples CE2/CE3 corrected + the full OFF/ON
 * recovery register the independent review required).
 *
 * These proofs run on the CURRENT schema 3 (default migrations 0001–0003)
 * — the pause/recovery design is DDL-INDEPENDENT, and this file is itself
 * part of the proof of that claim (combined ownership-lab compatibility on
 * the proposed schema 4 is proven separately in
 * round15-design-ownership.test.ts P-O19).
 *
 * What these proofs DO prove (design document §5.4/§8, Round 1.5.1):
 *  - OFF precedes exhaustion in the RECOVERY path: an expired claim of a
 *    paused type is NEVER dead-lettered or requeued while the gate is off
 *    (CE2 corrected, P-N1), regardless of its attempt budget;
 *  - paused expired claims consume ZERO active recovery scan slots: enabled
 *    expired work is reached in the FIRST page even behind 25 paused rows
 *    (CE3 corrected, P-N5), and page fairness holds across passes (P-N7);
 *  - attempts are preserved EXACTLY: recovery never writes `attempts`
 *    (P-N1/P-N2/P-N4/P-N10); an exhausted paused row keeps its exhausted
 *    state information (last_error/attempts) through any number of OFF
 *    cycles (P-N10) — nothing is reset, nothing is resurrected;
 *  - ON recovery applies the ORDINARY attempt economics: budget-intact
 *    paused rows requeue and resume to completion (P-N4, P-N10); genuinely
 *    exhausted rows dead-letter AT the recovery boundary EXACTLY ONCE with
 *    `job_exhausted` (P-N3, P-N10) — the crashed generation is never
 *    re-executed;
 *  - unknown and misconfigured types are NOT policy-excluded: they flow
 *    through the ordinary recovery transitions and the ordinary dispatch
 *    poison classes — never silently deferred by the pause (P-N6, with the
 *    actual grace/stranded timing documented, not an unqualified
 *    next-pass claim);
 *  - already-terminal rows are never resurrected (P-N9);
 *  - with NO paused types the design recovery is EQUIVALENT to the accepted
 *    `reclaimExpiredClaims` on an identical dataset (P-N8).
 *
 * What these proofs DO NOT prove: product behavior (nothing under `src/`
 * changed; the shipped D01 failure remains exactly as accepted — RED);
 * multi-isolate concurrency; and an unbounded-scan guarantee for the
 * paused-observability aggregate (it is a bounded COUNT like the existing
 * dispatch counters, not a paging guarantee).
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { reclaimExpiredClaims, scanPendingDlqDeliveries } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import { consumeWithPolicy, dispatchPassWithPolicy } from '../design/round15-lab-pipeline';
import { reclaimExpiredClaimsPolicyAware } from '../design/round15-pause';

const NOW = 1_771_000_000_000;
const db = createDbExecutor(env.DB);

const POLL_OFF = { ingestionGateOn: false };
const POLL_ON = { ingestionGateOn: true };

interface SeededJobRow {
  status: string;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  last_error: string | null;
  updated_at: number;
  dlq_delivered_at: number | null;
}

async function insertExpiredClaim(input: {
  id: string;
  type: string;
  attempts: number;
  maxAttempts?: number;
  leaseUntilMs?: number;
  lastError?: string | null;
}): Promise<string> {
  await db.run({
    sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,
                            attempts,max_attempts,lease_until,idempotency_key,payload_json,
                            last_error,created_at,updated_at,dlq_delivered_at)
          VALUES (?, ?, NULL, NULL, 'claimed', 40, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      input.id,
      input.type,
      NOW - 200_000,
      input.attempts,
      input.maxAttempts ?? 3,
      input.leaseUntilMs ?? NOW - 1_000,
      `rn151:${input.id}`,
      input.type === 'sources.fetch_poll'
        ? canonicalizeJson({ sourceId: 'source_a', scheduledForMs: 0 })
        : canonicalizeJson({ note: 'rn151 recovery row' }),
      input.lastError ?? null,
      NOW - 300_000,
      NOW - 300_000,
    ],
  });
  return input.id;
}

async function readJob(id: string): Promise<SeededJobRow> {
  return (await db.first<SeededJobRow>({
    sql: `SELECT status, attempts, max_attempts, lease_until, last_error, updated_at,
                 dlq_delivered_at
            FROM jobs WHERE id = ?`,
    params: [id],
  }))!;
}

const heartbeatHandlers = () =>
  createJobHandlerRegistry([
    { type: 'jobs.maintenance_heartbeat', execute: async () => ({ kind: 'success' }) } as never,
  ]);

const emptyRegistry = () => createJobHandlerRegistry([]);

const noopProducer = { send: async () => {} };

const envelopeFor = (jobId: string, type: string, attempt = 1) => ({
  version: 1 as const,
  jobId,
  type,
  attempt,
  traceId: 'rn151-trace',
});

async function offPass(overrides: Record<string, unknown> = {}) {
  return dispatchPassWithPolicy({
    executor: db,
    handlers: heartbeatHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW,
    gates: POLL_OFF,
    ...overrides,
  });
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs']) {
    await db.run({ sql: `DELETE FROM ${table}` });
  }
  await db.run({ sql: "DELETE FROM budgets WHERE scope='ingestion'" });
});

it('P-N1 (CE2 corrected): an expired FINAL claim of a paused type is not dead-lettered during OFF', async () => {
  await insertExpiredClaim({ id: 'pn1-exhausted', type: 'sources.fetch_poll', attempts: 3 });
  const before = await readJob('pn1-exhausted');
  const summary = await offPass();
  expect(summary.reclaimedLeases).toBe(0);
  expect(summary.reclaimedExhausted).toBe(0); // the policy PRECEDES exhaustion handling
  expect(summary.pausedExpiredObserved).toBe(1);
  expect(summary.dispatched).toBe(0);
  const after = await readJob('pn1-exhausted');
  expect(after.status).toBe('claimed'); // dormant — NOT dead_letter, NOT queued
  expect(after.attempts).toBe(3); // exhausted state information preserved
  expect(after.last_error).toBe(before.last_error); // nothing overwritten
  expect(after.updated_at).toBe(before.updated_at); // the pass wrote NOTHING
  expect(after.dlq_delivered_at).toBeNull();
  // A second OFF pass is equally inert (OFF cycles are write-free).
  const summary2 = await offPass({ nowMs: NOW + 60_000 });
  expect(summary2.reclaimedExhausted).toBe(0);
  expect(summary2.pausedExpiredObserved).toBe(1);
  expect((await readJob('pn1-exhausted')).updated_at).toBe(before.updated_at);
});

it('P-N2: an expired NEAR-FINAL claim of a paused type stays claimed during OFF', async () => {
  await insertExpiredClaim({ id: 'pn2-near', type: 'sources.fetch_poll', attempts: 2 });
  const before = await readJob('pn2-near');
  const summary = await offPass();
  expect(summary.reclaimedLeases).toBe(0);
  expect(summary.reclaimedExhausted).toBe(0);
  expect(summary.pausedExpiredObserved).toBe(1);
  const after = await readJob('pn2-near');
  expect(after.status).toBe('claimed');
  expect(after.attempts).toBe(2); // never moved by the pause
  expect(after.updated_at).toBe(before.updated_at);
});

it('P-N3: ON recovery of the expired FINAL paused claim dead-letters EXACTLY ONCE at the boundary', async () => {
  await insertExpiredClaim({ id: 'pn3-exhausted', type: 'sources.fetch_poll', attempts: 3 });
  // While OFF: untouched.
  await offPass();
  expect((await readJob('pn3-exhausted')).status).toBe('claimed');
  // Gate ON: the ordinary recovery economics apply — the attempt budget was
  // genuinely spent, so the row dead-letters AT the recovery boundary (the
  // crashed generation is never re-executed).
  const onSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: heartbeatHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 60_000,
    gates: POLL_ON,
  });
  expect(onSummary.reclaimedLeases).toBe(0);
  expect(onSummary.reclaimedExhausted).toBe(1);
  expect(onSummary.pausedExpiredObserved).toBe(0);
  const dead = await readJob('pn3-exhausted');
  expect(dead.status).toBe('dead_letter');
  expect(dead.last_error).toBe('job_exhausted');
  expect(dead.attempts).toBe(3); // NOT reset, NOT incremented
  expect(dead.lease_until).toBeNull();
  expect(dead.dlq_delivered_at).toBeNull();
  const dlq = await scanPendingDlqDeliveries(db, 25);
  expect(dlq.map((r) => r.id)).toEqual(['pn3-exhausted']);
  // A second ON pass makes NO further transition (terminal rows untouched).
  const again = await dispatchPassWithPolicy({
    executor: db,
    handlers: heartbeatHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 120_000,
    gates: POLL_ON,
  });
  expect(again.reclaimedLeases).toBe(0);
  expect(again.reclaimedExhausted).toBe(0);
  const stable = await readJob('pn3-exhausted');
  expect(stable.status).toBe('dead_letter');
  expect(stable.updated_at).toBe(dead.updated_at);
});

it('P-N4: ON recovery of the expired NEAR-FINAL paused claim resumes to completion with attempts intact', async () => {
  await insertExpiredClaim({ id: 'pn4-near', type: 'sources.fetch_poll', attempts: 2 });
  await offPass();
  expect((await readJob('pn4-near')).status).toBe('claimed');
  let executions = 0;
  const execHandlers = () =>
    createJobHandlerRegistry([
      {
        type: 'sources.fetch_poll',
        execute: async () => {
          executions += 1;
          return { kind: 'success' };
        },
      } as never,
    ]);
  // ON: budget intact → queued (recovery NEVER writes attempts), then the
  // stranded-queue grace applies (the requeued row is NOT sent same-pass);
  // with grace 0 it is dispatched, and the FINAL attempt executes normally.
  const onSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: execHandlers(), // the poll type is FULLY wired in this deployment
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 60_000,
    gates: POLL_ON,
    dispatchGraceMs: 0,
  });
  expect(onSummary.reclaimedLeases).toBe(1);
  expect(onSummary.reclaimedExhausted).toBe(0);
  expect(onSummary.dispatched).toBe(1);
  const requeued = await readJob('pn4-near');
  expect(requeued.status).toBe('queued');
  expect(requeued.attempts).toBe(2); // preserved through the whole cycle
  const action = await consumeWithPolicy(
    { executor: db, handlers: execHandlers(), idGenerator: cryptoIdGenerator, gates: POLL_ON },
    'msg-pn4',
    envelopeFor('pn4-near', 'sources.fetch_poll', 3),
    NOW + 120_000,
  );
  expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });
  expect(executions).toBe(1);
  const done = await readJob('pn4-near');
  expect(done.status).toBe('succeeded');
  expect(done.attempts).toBe(3); // the ONE genuine final execution
});

it('P-N5 (CE3 corrected): 25 paused expired rows cannot delay the enabled expired heartbeat', async () => {
  for (let i = 0; i < 25; i++) {
    await insertExpiredClaim({
      id: `pn5-paused-${i}`,
      type: 'sources.fetch_poll',
      attempts: 1,
      leaseUntilMs: NOW - 1_000 + i, // ordered BEFORE the heartbeat
    });
  }
  await insertExpiredClaim({
    id: 'pn5-heartbeat',
    type: 'jobs.maintenance_heartbeat',
    attempts: 1,
    leaseUntilMs: NOW - 975, // the LAST expired lease
  });
  const summary = await offPass({ reclaimBatch: 25, dispatchBatch: 25 });
  // The ACTIVE page is filled with ELIGIBLE rows only — the paused rows
  // consumed ZERO slots, so the enabled heartbeat is reached FIRST PASS.
  expect(summary.reclaimedLeases).toBe(1);
  expect(summary.pausedExpiredObserved).toBe(25);
  const hb = await readJob('pn5-heartbeat');
  expect(hb.status).toBe('queued'); // recovered to queued (grace still applies)
  expect(hb.attempts).toBe(1); // attempts count generations, not recoveries
  for (let i = 0; i < 25; i++) {
    const paused = await readJob(`pn5-paused-${i}`);
    expect(paused.status).toBe('claimed'); // untouched
    expect(paused.updated_at).toBe(NOW - 300_000);
  }
  // Documented timing, not an unqualified next-pass claim: the requeued
  // heartbeat is dispatched only AFTER the stranded-queue grace expires
  // (same pass would violate ADR-0036 §3), then it is sent and marked.
  const later = await dispatchPassWithPolicy({
    executor: db,
    handlers: heartbeatHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 60_000,
    gates: POLL_OFF, // the heartbeat is NOT policy-paused — it flows normally
    dispatchGraceMs: 0,
  });
  expect(later.dispatched).toBe(1);
  expect(later.markedQueued).toBe(1);
  expect((await readJob('pn5-heartbeat')).status).toBe('queued');
});

it('P-N6: unknown and misconfigured expired claims are recovered, NOT deferred by the pause', async () => {
  await insertExpiredClaim({ id: 'pn6-paused', type: 'sources.fetch_poll', attempts: 1 });
  await insertExpiredClaim({ id: 'pn6-unknown', type: 'unknown.type', attempts: 1 });
  // Schema-known, NOT policy-paused, but NO handler in this deployment:
  // a visible misconfiguration — NOT a policy pause.
  await insertExpiredClaim({ id: 'pn6-misconf', type: 'jobs.maintenance_heartbeat', attempts: 1 });
  // Pass 1 (OFF): the pause policy excludes ONLY the paused type — the
  // unknown and misconfigured rows are ordinary recovery candidates and are
  // requeued (NOT silently deferred by the gate).
  const summary = await offPass({ reclaimBatch: 25 });
  expect(summary.reclaimedLeases).toBe(2); // unknown + misconfigured
  expect(summary.pausedExpiredObserved).toBe(1); // the paused row only observed
  expect((await readJob('pn6-paused')).status).toBe('claimed');
  expect((await readJob('pn6-unknown')).status).toBe('queued');
  expect((await readJob('pn6-misconf')).status).toBe('queued');
  // Timing honesty: requeued rows are fresh-queued, so the SAME pass cannot
  // dispatch them (stranded grace). After the grace they enter the stranded
  // scan and each takes its ORDINARY class — the unknown poisons, the
  // misconfigured poisons with the DISTINCT code (this deployment has NO
  // heartbeat handler, which is exactly what the class means).
  let sends = 0;
  const later = await dispatchPassWithPolicy({
    executor: db,
    handlers: emptyRegistry(), // BOTH non-paused rows are undeliverable here
    producer: {
      send: async () => {
        sends += 1;
      },
    },
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 60_000,
    gates: POLL_OFF,
    dispatchGraceMs: 0,
  });
  expect(later.poisonedUnregistered).toBe(1); // unknown.type → visible poison
  expect(later.misconfiguredPoisoned).toBe(1); // DISTINCT misconfiguration code
  expect(sends).toBe(0);
  expect((await readJob('pn6-unknown')).status).toBe('dead_letter');
  expect((await readJob('pn6-unknown')).last_error).toBe('job_type_unregistered');
  expect((await readJob('pn6-misconf')).status).toBe('dead_letter');
  expect((await readJob('pn6-misconf')).last_error).toBe('handler_misconfigured');
  expect((await readJob('pn6-paused')).status).toBe('claimed'); // still dormant
});

it('P-N7: recovery page fairness — eligible rows fill every page; paused rows never consume slots', async () => {
  for (let i = 0; i < 25; i++) {
    await insertExpiredClaim({
      id: `pn7-paused-${i}`,
      type: 'sources.fetch_poll',
      attempts: 1,
      leaseUntilMs: NOW - 100_000 + i,
    });
  }
  for (let i = 0; i < 30; i++) {
    await insertExpiredClaim({
      id: `pn7-heartbeat-${String(i).padStart(2, '0')}`,
      type: 'jobs.maintenance_heartbeat',
      attempts: 1,
      leaseUntilMs: NOW - 200_000 + i, // interleaved EARLIER than the paused rows
    });
  }
  const pass1 = await offPass({ reclaimBatch: 25 });
  expect(pass1.reclaimedLeases).toBe(25); // 25 EARLIEST ELIGIBLE — not one slot lost
  expect(pass1.pausedExpiredObserved).toBe(25);
  const pass2 = await offPass({ reclaimBatch: 25, nowMs: NOW + 1_000 });
  expect(pass2.reclaimedLeases).toBe(5); // the remaining eligible rows
  expect(pass2.pausedExpiredObserved).toBe(25);
  for (let i = 0; i < 30; i++) {
    expect((await readJob(`pn7-heartbeat-${String(i).padStart(2, '0')}`)).status).toBe('queued');
  }
  for (let i = 0; i < 25; i++) {
    const paused = await readJob(`pn7-paused-${i}`);
    expect(paused.status).toBe('claimed');
    expect(paused.updated_at).toBe(NOW - 300_000);
  }
});

it('P-N8: with no paused types the design recovery is EQUIVALENT to the accepted recovery', async () => {
  const seedDataset = async (prefix: string) => {
    await insertExpiredClaim({
      id: `${prefix}-a`,
      type: 'jobs.maintenance_heartbeat',
      attempts: 3,
    });
    await insertExpiredClaim({
      id: `${prefix}-b`,
      type: 'jobs.maintenance_heartbeat',
      attempts: 2,
    });
    await insertExpiredClaim({
      id: `${prefix}-c`,
      type: 'jobs.maintenance_heartbeat',
      attempts: 1,
      leaseUntilMs: NOW + 60_000, // NOT expired — untouched by both
    });
    await insertExpiredClaim({ id: `${prefix}-d`, type: 'unknown.type', attempts: 3 });
    await db.run({
      sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,
                              attempts,max_attempts,lease_until,idempotency_key,payload_json,
                              last_error,created_at,updated_at,dlq_delivered_at)
            VALUES (?,'jobs.maintenance_heartbeat',NULL,NULL,'pending',40,?,0,3,NULL,?,?,NULL,?,?,NULL)`,
      params: [
        `${prefix}-e`,
        NOW - 200_000,
        `rn151:${prefix}-e`,
        '{}',
        NOW - 300_000,
        NOW - 300_000,
      ],
    });
  };
  // Run A — the ACCEPTED recovery.
  await seedDataset('rn8');
  const accepted = await reclaimExpiredClaims(db, NOW, 25);
  const snapAccepted = new Map<string, SeededJobRow>();
  for (const id of ['rn8-a', 'rn8-b', 'rn8-c', 'rn8-d', 'rn8-e']) {
    snapAccepted.set(id, await readJob(id));
  }
  // Reset and re-seed the IDENTICAL dataset; run B — the DESIGN recovery.
  await db.run({ sql: 'DELETE FROM jobs' });
  await seedDataset('rn8');
  const design = await reclaimExpiredClaimsPolicyAware(db, NOW, 25, []);
  const snapDesign = new Map<string, SeededJobRow>();
  for (const id of ['rn8-a', 'rn8-b', 'rn8-c', 'rn8-d', 'rn8-e']) {
    snapDesign.set(id, await readJob(id));
  }
  expect(design.reclaimed).toBe(accepted.reclaimed);
  expect(design.exhaustedToDeadLetter).toBe(accepted.exhaustedToDeadLetter);
  expect(design.pausedExpiredObserved).toBe(0);
  for (const id of ['rn8-a', 'rn8-b', 'rn8-c', 'rn8-d', 'rn8-e']) {
    expect(snapDesign.get(id)).toEqual(snapAccepted.get(id)); // byte-equal transitions
  }
  expect(snapAccepted.get('rn8-a')!.status).toBe('dead_letter');
  expect(snapAccepted.get('rn8-b')!.status).toBe('queued');
  expect(snapAccepted.get('rn8-c')!.status).toBe('claimed'); // lease still valid
  expect(snapAccepted.get('rn8-d')!.status).toBe('dead_letter');
  expect(snapAccepted.get('rn8-e')!.status).toBe('pending');
});

it('P-N9: already-terminal rows are never resurrected — OFF or ON', async () => {
  const terminals: { id: string; status: string }[] = [
    { id: 'pn9-dead', status: 'dead_letter' },
    { id: 'pn9-cancelled', status: 'cancelled' },
    { id: 'pn9-succeeded', status: 'succeeded' },
    { id: 'pn9-failed', status: 'failed' },
  ];
  for (const t of terminals) {
    await db.run({
      sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,
                              attempts,max_attempts,lease_until,idempotency_key,payload_json,
                              last_error,created_at,updated_at,dlq_delivered_at)
            VALUES (?, 'sources.fetch_poll', 'source', 'source_a', ?, 40, ?, 3, 3, ?, ?, ?, NULL, ?, ?, NULL)`,
      params: [
        t.id,
        t.status,
        NOW - 200_000,
        NOW - 1_000, // expired lease where one is even readable
        `rn151:${t.id}`,
        canonicalizeJson({ sourceId: 'source_a', scheduledForMs: 0 }),
        NOW - 300_000,
        NOW - 300_000,
      ],
    });
  }
  const off = await offPass();
  expect(off.reclaimedLeases).toBe(0);
  expect(off.reclaimedExhausted).toBe(0);
  expect(off.pausedExpiredObserved).toBe(0); // terminal rows are not CLAIMED rows
  const on = await dispatchPassWithPolicy({
    executor: db,
    handlers: heartbeatHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 60_000,
    gates: POLL_ON,
  });
  expect(on.reclaimedLeases).toBe(0);
  expect(on.reclaimedExhausted).toBe(0);
  for (const t of terminals) {
    const row = await readJob(t.id);
    expect(row.status).toBe(t.status); // every terminal state preserved
    expect(row.updated_at).toBe(NOW - 300_000); // byte-untouched
  }
});

it('P-N10: repeated OFF cycles preserve exhausted state; ON applies genuine attempt economics exactly once', async () => {
  await insertExpiredClaim({
    id: 'pn10-exhausted',
    type: 'sources.fetch_poll',
    attempts: 3,
    lastError: 'job_internal_error',
  });
  await insertExpiredClaim({ id: 'pn10-near', type: 'sources.fetch_poll', attempts: 2 });
  await insertExpiredClaim({
    id: 'pn10-heartbeat',
    type: 'jobs.maintenance_heartbeat',
    attempts: 1,
    leaseUntilMs: NOW - 2_000,
  });
  const exhaustedBefore = await readJob('pn10-exhausted');
  const nearBefore = await readJob('pn10-near');
  // THREE full OFF cycles: the paused rows are byte-untouched in every one;
  // the enabled heartbeat recovers on the FIRST cycle.
  for (let cycle = 1; cycle <= 3; cycle++) {
    const summary = await offPass({ nowMs: NOW + cycle * 60_000 });
    expect(summary.reclaimedLeases).toBe(cycle === 1 ? 1 : 0);
    expect(summary.reclaimedExhausted).toBe(0);
    expect(summary.pausedExpiredObserved).toBe(2);
    expect((await readJob('pn10-exhausted')).updated_at).toBe(exhaustedBefore.updated_at);
    expect((await readJob('pn10-near')).updated_at).toBe(nearBefore.updated_at);
    expect((await readJob('pn10-exhausted')).attempts).toBe(3); // never reset
    expect((await readJob('pn10-near')).attempts).toBe(2);
    expect((await readJob('pn10-exhausted')).last_error).toBe('job_internal_error');
  }
  // The recovered heartbeat flows to completion independently of the paused
  // rows (stranded grace, then send; consume completes it).
  const hbAction = await consumeWithPolicy(
    {
      executor: db,
      handlers: heartbeatHandlers(),
      idGenerator: cryptoIdGenerator,
      gates: POLL_OFF,
    },
    'msg-pn10-hb',
    envelopeFor('pn10-heartbeat', 'jobs.maintenance_heartbeat', 2),
    NOW + 240_000,
  );
  expect(hbAction).toEqual({ action: 'ack', outcome: 'job_completed' });
  // ON: BOTH paused rows leave dormancy under the ORDINARY economics in ONE
  // pass — the near-final row requeues (and would resume), the genuinely
  // exhausted row dead-letters EXACTLY ONCE with its history intact. The
  // pass uses the DEFAULT stranded grace and a FULLY WIRED registry, so the
  // freshly requeued row is not re-dispatched inside the same pass
  // (documented timing) and the queued row's later re-kick is a SEND, not a
  // misconfiguration poison.
  const fullHandlers = () =>
    createJobHandlerRegistry([
      { type: 'sources.fetch_poll', execute: async () => ({ kind: 'success' }) } as never,
      { type: 'jobs.maintenance_heartbeat', execute: async () => ({ kind: 'success' }) } as never,
    ]);
  const onSummary = await dispatchPassWithPolicy({
    executor: db,
    handlers: fullHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 300_000,
    gates: POLL_ON,
  });
  expect(onSummary.reclaimedLeases).toBe(1); // pn10-near → queued
  expect(onSummary.reclaimedExhausted).toBe(1); // pn10-exhausted → dead_letter
  expect(onSummary.pausedExpiredObserved).toBe(0);
  const exhaustedAfter = await readJob('pn10-exhausted');
  expect(exhaustedAfter.status).toBe('dead_letter');
  expect(exhaustedAfter.last_error).toBe('job_exhausted'); // the boundary reason
  expect(exhaustedAfter.attempts).toBe(3);
  expect((await readJob('pn10-near')).status).toBe('queued');
  expect((await readJob('pn10-near')).attempts).toBe(2);
  // A further ON pass makes NO further RECOVERY transition in either
  // direction (terminal rows untouched). The queued row, now past the
  // stranded grace, takes the ordinary bounded re-kick (sent again —
  // dispatch-side resumption, NOT a recovery transition).
  const again = await dispatchPassWithPolicy({
    executor: db,
    handlers: fullHandlers(),
    producer: noopProducer,
    idGenerator: cryptoIdGenerator,
    nowMs: NOW + 360_000,
    gates: POLL_ON,
  });
  expect(again.reclaimedLeases).toBe(0);
  expect(again.reclaimedExhausted).toBe(0);
  expect(again.pausedExpiredObserved).toBe(0);
  expect(again.dispatched).toBe(1); // the queued row's ordinary stranded re-kick
  expect(again.poisonedUnregistered).toBe(0);
  expect(again.misconfiguredPoisoned).toBe(0);
  expect((await readJob('pn10-exhausted')).status).toBe('dead_letter');
  expect((await readJob('pn10-near')).status).toBe('queued');
});
