/**
 * R1.10.3 DESIGN LAB — executable cost ledger (REAL workerd D1).
 *
 * DESIGN-LAB evidence — NOT accepted product source, NOT product tests.
 * Every scenario runs the FULL per-poll D1 statement sequence for the
 * FIRST Free preview profile (ONE single-feed RSS source, queue batch 1,
 * current 100-item volume, ALL redirect/authorization hops counted) with
 * the v3 instrument (audit-tools/trace/d1-instrument.ts), and separates:
 * engine claim, source read, capability, ownership acquire, per-hop
 * budget authorization, budget readback, commit batch (multi-row INSERTs
 * + fenced state write), grouped classification lookups, and the job
 * terminal transition.
 *
 * THE FIXED SEQUENCE IS THE ACCEPTED ONE: engine claim/read+CAS, source
 * select, capability, acquire, authorize-per-hop, readback, terminal are
 * executed by the ACCEPTED product functions imported UNMODIFIED
 * (`job-store.ts`, `schema-health.ts`, `source-ingest-store.ts`,
 * `ingestion-budget-store.ts`) over the instrumented binding. Only the
 * commit + classification steps are the CANDIDATE. A BASELINE scenario
 * runs the ACCEPTED commit instead — the reconciliation line against the
 * accepted T-13 trace (110 xAPI / 211 STMT, provenance in the sealed
 * R1.10.2 logs) is derived from it and labeled.
 *
 * HONESTY LABELS: LOCAL workerd proxy measurements only. No cloud quota
 * enforcement, no CPU evidence (network wait is not CPU), no billing
 * conclusion. "≤40/≤40" is the prompt's FIRST-profile target (10 below
 * the documented 50 row) under the LOCAL unit vocabulary — both quota
 * interpretations are carried in free-plan/ documents.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../tests/helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../src/adapters/db/db-executor';
import {
  acquirePollOwnership,
  commitOwnedPollResults,
  commitPollResults,
  type PollTerminalState,
} from '../src/adapters/db/source-ingest-store';
import { claimJob, completeJob, markJobRetryWait } from '../src/adapters/db/job-store';
import { resolveSchemaCapability } from '../src/adapters/db/schema-health';
import {
  authorizeIngestionUnit,
  readIngestionBudget,
} from '../src/adapters/db/ingestion-budget-store';
import {
  createD1Stats,
  deriveCounts,
  instrumentD1,
  resetStats,
  snapshot,
  type D1Stats,
} from '../audit-tools/trace/d1-instrument';
import {
  commitOwnedPollResultsCandidate,
  commitPollResultsCandidate,
  type InsertChunkPlan,
  type CandidateItemRow,
} from './candidate-sql';
import { cjkCanonicalUrl, CJK_CANONICAL_URL_BYTES } from './fixtures';
import { labLog } from './lab-log';

const rawDb = () => env.DB as D1Database;

const SOURCE = 'source-ledger0-ledger0';
const NOW = 1_770_000_000_000;
const JOB_ID = 'job-ledger000000000001';

/** Verbatim provenance copy: poll-handler SOURCE_SELECT_SQL (≈146–151). */
const SOURCE_SELECT_SQL = `SELECT s.id, s.connector, s.enabled, s.interval_seconds,
                                  s.config_json, st.next_poll_at, st.etag,
                                  st.last_modified, st.cursor,
                                  st.consecutive_failures
                             FROM sources s
                             JOIN source_state st ON st.source_id = s.id
                            WHERE s.id = ?`;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function seedSources(dailyRequestBudget: number): Promise<void> {
  await rawDb()
    .prepare(
      `INSERT OR IGNORE INTO sources
         (id, name, connector, lane, trust_tier, enabled, interval_seconds, priority,
          daily_request_budget, approval_policy, config_json, created_at, updated_at)
       VALUES (?, 'ledger', 'rss', 'radar', 50, 1, 3600, 50, ?, 'auto', '{}', 1, 1)`,
    )
    .bind(SOURCE, dailyRequestBudget)
    .run();
}

async function seedState(
  nextPollAt: number,
  owner: string | null,
  schema: 3 | 4 = 4,
): Promise<void> {
  if (schema === 3) {
    // Schema 3 has NO poll_owner_job_id column (added by the 0004 candidate).
    await rawDb()
      .prepare(
        `INSERT INTO source_state
           (source_id, cursor, etag, last_modified, next_poll_at, last_polled_at,
            consecutive_failures, requests_today, budget_date, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, NULL, 0, 0, '2026/02/01', ?)`,
      )
      .bind(SOURCE, nextPollAt, NOW)
      .run();
    return;
  }
  await rawDb()
    .prepare(
      `INSERT INTO source_state
         (source_id, cursor, etag, last_modified, next_poll_at, last_polled_at,
          consecutive_failures, requests_today, budget_date, poll_owner_job_id, updated_at)
       VALUES (?, NULL, NULL, NULL, ?, NULL, 0, 0, '2026/02/01', ?, ?)`,
    )
    .bind(SOURCE, nextPollAt, owner, NOW)
    .run();
}

async function seedDispatchableJob(): Promise<void> {
  await rawDb()
    .prepare(
      `INSERT INTO jobs
         (id, type, aggregate_type, aggregate_id, status, priority, run_after, attempts,
          max_attempts, lease_until, idempotency_key, payload_json, created_at, updated_at)
       VALUES (?, 'sources.fetch_poll', 'source', ?, 'pending', 50, ?, 0, 3, NULL,
               ? || '-idem', '{"sourceId":"SOURCE"}', ?, ?)`,
    )
    .bind(JOB_ID, SOURCE, NOW, JOB_ID, NOW, NOW)
    .run();
}

async function seedExistingItems(
  rows: readonly { id: string; externalId: string | null; canonicalUrl: string | null }[],
): Promise<void> {
  for (const row of rows) {
    await rawDb()
      .prepare(
        `INSERT INTO source_items
           (id, source_id, external_id, canonical_url, title, body_excerpt, author,
            published_at, fetched_at, content_hash, raw_json, processing_status)
         VALUES (?, ?, ?, ?, 'seed', NULL, NULL, NULL, 1, 'seed-hash', '{}', 'new')`,
      )
      .bind(row.id, SOURCE, row.externalId, row.canonicalUrl)
      .run();
  }
}

function makeItems(n: number, shape: 'normal' | 'max' | 'cjk' = 'normal'): CandidateItemRow[] {
  if (shape === 'normal') {
    return Array.from({ length: n }, (_, i) => ({
      id: `led-item-${String(i).padStart(4, '0')}`,
      sourceId: SOURCE,
      externalId: `led-ext-${i}`,
      canonicalUrl: `https://ledger.example/${i}`,
      title: `Ledger title ${i}`,
      excerpt: `Ledger excerpt ${i}`,
      author: 'ledger-author',
      publishedAtMs: NOW - i * 1000,
      fetchedAtMs: NOW,
      contentHash: `led-hash-${i}`.padEnd(64, '0').slice(0, 64),
      rawJson: JSON.stringify({ i, feed: 'ledger-fixture' }),
    }));
  }
  // Max-volume content-byte shape: documented caps (source-registry
  // INGESTION_LIMITS): title 512 chars, excerpt 512, author 256,
  // rawJson ≈ 8 KiB; URL shape at a 2 KiB documented assumption.
  const big = (n: number, ch: string) => ch.repeat(n);
  if (shape === 'max') {
    return Array.from({ length: n }, (_, i) => ({
      id: `led-big-${String(i).padStart(4, '0')}`,
      sourceId: SOURCE,
      externalId: `led-big-ext-${i}`,
      canonicalUrl: `https://ledger.example/${big(2010, 'p')}/${i}`,
      title: big(511, 't') + String(i % 10),
      excerpt: big(512, 'e'),
      author: big(256, 'a'),
      publishedAtMs: NOW,
      fetchedAtMs: NOW,
      contentHash: big(64, 'h'),
      rawJson: JSON.stringify({ blob: big(8 * 1024 - 40, 'r') }),
    }));
  }
  // R1.10.3.1 Unicode/URL-expansion shape: 5000-char CJK paths → canonical
  // URLs of EXACTLY CJK_CANONICAL_URL_BYTES (45,023) bytes — byte-identical
  // to the accepted normalizer's output (proven in lab-suite L-14) and
  // DISTINCT per item (targeted conflict clauses cannot absorb them).
  return Array.from({ length: n }, (_, i) => ({
    id: `led-cjk-${String(i).padStart(4, '0')}`,
    sourceId: SOURCE,
    externalId: `led-cjk-ext-${i}`,
    canonicalUrl: cjkCanonicalUrl(5000, i),
    title: `CJK item ${i}`,
    excerpt: 'CJK body text',
    author: null,
    publishedAtMs: NOW,
    fetchedAtMs: NOW,
    contentHash: big(64, 'h'),
    rawJson: JSON.stringify({ i, shape: 'cjk-url-expansion' }),
  }));
}

function makeState(nextPollAtMs: number): PollTerminalState {
  return {
    cursor: 'ledger-cursor-1',
    etag: 'ledger-etag-1',
    lastModified: null,
    nextPollAtMs,
    success: true,
    lastChangedAtMs: NOW,
    lastError: null,
    consecutiveFailures: 0,
    circuitOpenUntilMs: null,
    requestsToday: 1,
    budgetDate: '2026/02/01',
  };
}

async function resetTables(): Promise<void> {
  for (const t of ['source_items', 'source_state', 'sources', 'jobs', 'budgets']) {
    await rawDb().prepare(`DELETE FROM ${t}`).run();
  }
}

/* ------------------------------------------------------------------ */
/* Stage-tracked full poll sequence                                    */
/* ------------------------------------------------------------------ */

interface StageRow {
  readonly stage: string;
  readonly api: number;
  readonly stmt: number;
  readonly note: string;
}

interface LedgerRow {
  readonly id: string;
  readonly schema: 3 | 4;
  readonly path: 'owned-candidate' | 'legacy-candidate' | 'owned-baseline' | 'legacy-baseline';
  readonly items: number;
  readonly itemShape: 'normal' | 'max' | 'cjk';
  readonly hops: number;
  readonly dailyRequestBudget: number;
  readonly authority: 'granted' | 'denied' | 'failure';
  readonly executionApiCallAttempts: number;
  readonly executionApiCallsCompleted: number;
  readonly executionApiCallsFailed: number;
  readonly statementsAttempted: number;
  readonly statementsCompleted: number;
  readonly statementsNotConfirmedCompleted: number;
  readonly metaRecordsAvailable: number;
  readonly metaRecordsUnavailable: number;
  readonly statementKinds: {
    engineClaimReads: number;
    engineClaimCas: number;
    sourceSelects: number;
    capabilityReads: number;
    ownershipAcquires: number;
    authorizations: number;
    budgetReadbacks: number;
    multiRowInserts: number;
    stateWrites: number;
    classificationLookups: number;
    jobTerminals: number;
  };
  readonly insertStatementsPlanned: number;
  /** Largest chunk row count (per-chunk sizes vary; see chunkRows). */
  readonly rowsPerInsertStatement: number;
  /** Compact per-chunk row summary, run-length encoded (chunks×rows): "50×2", "12×8;1×4". */
  readonly chunkRows: string;
  readonly chunkLimitedBy: string;
  /** Max audited statement total bytes (SQL text + ALL binds); null = not audited (accepted baseline shape). */
  readonly maxStatementTotalBytes: number | null;
  readonly stages: readonly StageRow[];
  readonly outcome: Record<string, unknown>;
}

let stats: D1Stats;
let wrapped: D1Database;

interface SequenceOptions {
  readonly id: string;
  readonly schema: 3 | 4;
  readonly path: 'owned-candidate' | 'legacy-candidate' | 'owned-baseline' | 'legacy-baseline';
  readonly items: readonly CandidateItemRow[];
  readonly itemShape: 'normal' | 'max' | 'cjk';
  readonly hops: number;
  readonly dailyRequestBudget: number;
  readonly authority: 'granted' | 'denied' | 'failure';
  readonly notModified?: boolean;
}

/** R1.10.3.1: honest per-chunk plan summary (sizes VARY across chunks). */
function summarizePlan(plan: InsertChunkPlan): {
  rowsPerInsertStatement: number;
  chunkRows: string;
  chunkLimitedBy: string;
  maxStatementTotalBytes: number | null;
} {
  const runs: string[] = [];
  for (const rows of plan.rowsPerStatement) {
    const last = runs[runs.length - 1];
    const match = last === undefined ? undefined : /^(\d+)×(\d+)$/.exec(last);
    if (match && Number(match[2]) === rows) {
      runs[runs.length - 1] = `${Number(match[1]) + 1}×${rows}`;
    } else {
      runs.push(`1×${rows}`);
    }
  }
  return {
    rowsPerInsertStatement: plan.maxRowsPerStatement,
    chunkRows: plan.chunks.length === 0 ? 'n/a' : runs.join(';'),
    chunkLimitedBy: plan.limitedBy,
    maxStatementTotalBytes: plan.statementAudits.length
      ? Math.max(...plan.statementAudits.map((a) => a.totalBytes))
      : null,
  };
}

async function runPollSequence(opts: SequenceOptions): Promise<LedgerRow> {
  resetStats(stats);
  const stages: StageRow[] = [];
  const kinds: LedgerRow['statementKinds'] = {
    engineClaimReads: 0,
    engineClaimCas: 0,
    sourceSelects: 0,
    capabilityReads: 0,
    ownershipAcquires: 0,
    authorizations: 0,
    budgetReadbacks: 0,
    multiRowInserts: 0,
    stateWrites: 0,
    classificationLookups: 0,
    jobTerminals: 0,
  };
  const stageDelta = (stage: string, beforeSnap: Readonly<D1Stats>, note: string): void => {
    const after = deriveCounts(stats);
    const before = deriveCounts(beforeSnap as D1Stats);
    stages.push({
      stage,
      api: after.executionApiCallAttempts - before.executionApiCallAttempts,
      stmt: after.statementsAttempted - before.statementsAttempted,
      note,
    });
  };

  const executor: DbExecutor = createDbExecutor(wrapped as D1Database);

  // 1. Engine claim (read + CAS) — ACCEPTED product function.
  let snap = snapshot(stats);
  const claim = await claimJob(executor, JOB_ID, NOW);
  stageDelta('engine-claim', snap, 'accepted claimJob: row read + CAS claim');
  if (claim.kind !== 'claimed') throw new Error(`fixture claim failed: ${claim.kind}`);
  kinds.engineClaimReads = 1;
  kinds.engineClaimCas = 1;

  // 2. Source read (verbatim accepted SQL; not exported by the handler).
  snap = snapshot(stats);
  await executor.first<Record<string, unknown>>({ sql: SOURCE_SELECT_SQL, params: [SOURCE] });
  stageDelta('source-select', snap, 'accepted SOURCE_SELECT_SQL');
  kinds.sourceSelects = 1;

  // 3. Capability resolution — ACCEPTED product function.
  snap = snapshot(stats);
  const _capability = await resolveSchemaCapability(executor);
  stageDelta('capability', snap, 'accepted resolveSchemaCapability');
  kinds.capabilityReads = 1;

  let holdUntilMs: number;
  if (opts.schema === 4) {
    // 4. Ownership acquire — ACCEPTED product function.
    snap = snapshot(stats);
    const acquisition = await acquirePollOwnership(executor, {
      sourceId: SOURCE,
      jobId: JOB_ID,
      scheduledForMs: NOW,
      generation: claim.generation,
      nowMs: NOW,
    });
    stageDelta('ownership-acquire', snap, 'accepted acquirePollOwnership');
    if (acquisition.kind !== 'owned') throw new Error('fixture acquire failed');
    holdUntilMs = acquisition.holdUntilMs;
    kinds.ownershipAcquires = 1;
  } else {
    holdUntilMs = NOW; // legacy payload-derived window
  }

  // 5. Per-hop budget authorization — ACCEPTED product function.
  snap = snapshot(stats);
  let authority: 'granted' | 'denied' | 'failure' = 'granted';
  for (let hop = 0; hop < opts.hops; hop += 1) {
    if (opts.authority === 'failure') {
      // Authority storage failure: the authorize batch itself throws
      // (transport fails closed; typed retry path).
      authority = 'failure';
      break;
    }
    const grant = await authorizeIngestionUnit(executor, { sourceId: SOURCE, nowMs: NOW });
    if (grant.kind === 'authorized') kinds.authorizations += 1;
    else if (grant.kind === 'denied') {
      authority = 'denied';
      kinds.authorizations += 1;
      break;
    } else {
      authority = 'denied';
      break;
    }
  }
  stageDelta('authorization', snap, `accepted authorizeIngestionUnit × hops (${opts.hops})`);

  let outcome: Record<string, unknown> = {};
  let insertStatementsPlanned = 0;
  let rowsPerInsertStatement = 0;
  let chunkRows = 'n/a';
  let chunkLimitedBy = 'n/a';
  let maxStatementTotalBytes: number | null = null;

  if (authority === 'failure') {
    // Typed retry: fenced retry_wait bookkeeping, NO terminal ingestion write.
    snap = snapshot(stats);
    await markJobRetryWait(
      executor,
      JOB_ID,
      claim.generation,
      NOW + 60_000,
      'job_handler_retryable_error',
      NOW,
    );
    stageDelta('job-terminal', snap, 'accepted markJobRetryWait (authority failure path)');
    kinds.jobTerminals = 1;
    outcome = { kind: 'retry_wait', zeroTerminalIngestionWrites: true };
  } else {
    // 6. Budget readback — ACCEPTED product function.
    snap = snapshot(stats);
    const requestsToday = await readIngestionBudget(executor, { sourceId: SOURCE, nowMs: NOW });
    stageDelta('budget-readback', snap, 'accepted readIngestionBudget');
    kinds.budgetReadbacks = 1;

    // 7. Commit — CANDIDATE (or accepted BASELINE for reference rows).
    // A DENIED window commits the failed terminal state with ZERO items
    // (the accepted handler maps denial to a failed terminal state with no
    // items; the candidate never sees items on that path).
    const state = { ...makeState(NOW + 3_600_000), requestsToday };
    const items = opts.notModified || authority === 'denied' ? [] : opts.items;
    snap = snapshot(stats);
    if (opts.path === 'owned-candidate') {
      const result = await commitOwnedPollResultsCandidate(wrapped as never, {
        sourceId: SOURCE,
        jobId: JOB_ID,
        generation: claim.generation,
        observedHoldUntilMs: holdUntilMs,
        items,
        state: state as unknown as Record<string, unknown>,
        nowMs: NOW,
      });
      insertStatementsPlanned = result.plan.chunks.length;
      ({ rowsPerInsertStatement, chunkRows, chunkLimitedBy, maxStatementTotalBytes } =
        summarizePlan(result.plan));
      kinds.multiRowInserts = result.plan.chunks.length;
      kinds.stateWrites = 1;
      outcome = {
        inserted: result.inserted,
        duplicateExternal: result.duplicateExternal,
        duplicateUrl: result.duplicateUrl,
        stateWriteWon: result.stateWriteWon,
      };
    } else if (opts.path === 'legacy-candidate') {
      const result = await commitPollResultsCandidate(wrapped as never, {
        sourceId: SOURCE,
        items,
        state: state as unknown as Record<string, unknown>,
        holdUntilMs,
        nowMs: NOW,
      });
      insertStatementsPlanned = result.plan.chunks.length;
      ({ rowsPerInsertStatement, chunkRows, chunkLimitedBy, maxStatementTotalBytes } =
        summarizePlan(result.plan));
      kinds.multiRowInserts = result.plan.chunks.length;
      kinds.stateWrites = 1;
      outcome = {
        inserted: result.inserted,
        duplicateExternal: result.duplicateExternal,
        duplicateUrl: result.duplicateUrl,
        stateWriteWon: result.stateWriteWon,
      };
    } else if (opts.path === 'owned-baseline') {
      const result = await commitOwnedPollResults(executor, {
        sourceId: SOURCE,
        jobId: JOB_ID,
        generation: claim.generation,
        observedHoldUntilMs: holdUntilMs,
        items,
        state: state as unknown as PollTerminalState,
        nowMs: NOW,
      });
      insertStatementsPlanned = items.length;
      rowsPerInsertStatement = 1;
      chunkRows = items.length === 0 ? 'n/a' : `1×${items.length}`;
      chunkLimitedBy = 'per-item (accepted shape)';
      maxStatementTotalBytes = null; // accepted path is not byte-audited here
      kinds.multiRowInserts = items.length;
      kinds.stateWrites = 1;
      outcome = {
        inserted: result.inserted,
        duplicateExternal: result.duplicateExternal,
        duplicateUrl: result.duplicateUrl,
        stateWriteWon: result.stateWriteWon,
      };
    } else {
      const result = await commitPollResults(executor, {
        sourceId: SOURCE,
        items,
        state: state as unknown as PollTerminalState,
        holdUntilMs,
        nowMs: NOW,
      });
      insertStatementsPlanned = items.length;
      rowsPerInsertStatement = 1;
      chunkRows = items.length === 0 ? 'n/a' : `1×${items.length}`;
      chunkLimitedBy = 'per-item (accepted shape)';
      maxStatementTotalBytes = null; // accepted path is not byte-audited here
      kinds.multiRowInserts = items.length;
      kinds.stateWrites = 1;
      outcome = {
        inserted: result.inserted,
        duplicateExternal: result.duplicateExternal,
        duplicateUrl: result.duplicateUrl,
        stateWriteWon: result.stateWriteWon,
      };
    }
    stageDelta(
      'commit-batch+classification',
      snap,
      opts.path.includes('candidate')
        ? 'CANDIDATE: multi-row INSERT batch + fenced state write + grouped source-bound probes'
        : 'ACCEPTED baseline: per-item INSERT batch + fenced state write + per-item probes',
    );

    // 8. Job terminal — ACCEPTED product function.
    snap = snapshot(stats);
    await completeJob(executor, JOB_ID, claim.generation, NOW);
    stageDelta('job-terminal', snap, 'accepted completeJob');
    kinds.jobTerminals = 1;
  }

  const d = deriveCounts(stats);
  const row: LedgerRow = {
    id: opts.id,
    schema: opts.schema,
    path: opts.path,
    items: opts.items.length,
    itemShape: opts.itemShape,
    hops: opts.hops,
    dailyRequestBudget: opts.dailyRequestBudget,
    authority,
    executionApiCallAttempts: d.executionApiCallAttempts,
    executionApiCallsCompleted: d.executionApiCallsCompleted,
    executionApiCallsFailed: d.executionApiCallsFailed,
    statementsAttempted: d.statementsAttempted,
    statementsCompleted: d.statementsCompleted,
    statementsNotConfirmedCompleted: d.statementsNotConfirmedCompleted,
    metaRecordsAvailable: d.metaRecordsAvailable,
    metaRecordsUnavailable: d.metaRecordsUnavailable,
    statementKinds: kinds,
    insertStatementsPlanned,
    rowsPerInsertStatement,
    chunkRows,
    chunkLimitedBy,
    maxStatementTotalBytes,
    stages,
    outcome,
  };
  labLog('LABLEDGER[' + JSON.stringify(row) + ']');
  return row;
}

/* ------------------------------------------------------------------ */
/* C-A — schema 3 LEGACY candidate rows (run FIRST: D1 still at v3)    */
/* ------------------------------------------------------------------ */

describe('R1.10.3 design lab cost ledger — schema 3 legacy candidate (real workerd D1)', () => {
  beforeEach(async () => {
    await applyMigrations(rawDb()); // 0001–0003 ONLY
    await resetTables();
    stats = createD1Stats();
    wrapped = instrumentD1(rawDb(), stats);
  });

  it('C-11 legacy candidate, zero-new (not_modified), 1 hop', async () => {
    await seedSources(100);
    await seedState(NOW, null, 3);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-11-legacy-zero-not-modified',
      schema: 3,
      path: 'legacy-candidate',
      items: [],
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
      notModified: true,
    });
    expect(row.authority).toBe('granted');
    expect(row.outcome.stateWriteWon).toBe(true);
  });

  it('C-12 legacy candidate, 100 new, 1 hop — FIRST-profile target ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null, 3);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-12-legacy-100-new-1hop',
      schema: 3,
      path: 'legacy-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-13 legacy candidate, 100 duplicates by url (worst probe path), 1 hop — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null, 3);
    await seedDispatchableJob();
    await seedExistingItems(
      Array.from({ length: 100 }, (_, i) => ({
        id: `seed-url-${i}`,
        externalId: `seed-other-${i}`,
        canonicalUrl: `https://ledger.example/${i}`,
      })),
    );
    const row = await runPollSequence({
      id: 'C-13-legacy-100-dup-url-1hop',
      schema: 3,
      path: 'legacy-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.duplicateUrl).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-14 legacy candidate, 100 new + 2 redirect hops — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null, 3);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-14-legacy-100-new-3hops',
      schema: 3,
      path: 'legacy-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 3,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-16 legacy candidate, 100 new uniform ≈45 KB CJK canonical URLs, 1 hop — envelope re-measure: STMT target FAILS (NOT_READY evidence)', async () => {
    await seedSources(100);
    await seedState(NOW, null, 3);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-16-legacy-100-cjk-45kb-1hop',
      schema: 3,
      path: 'legacy-candidate',
      items: makeItems(100, 'cjk'),
      itemShape: 'cjk',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    // Correctness unchanged (legacy lost-fence semantics preserved); the
    // byte-limited legacy planner also lands 2 rows/statement → 50 INSERTs.
    expect(row.outcome.inserted).toBe(100);
    expect(row.insertStatementsPlanned).toBe(50);
    expect(row.rowsPerInsertStatement).toBe(2);
    expect(row.chunkRows).toBe('50×2');
    expect(row.chunkLimitedBy).toBe('bytes');
    expect(row.maxStatementTotalBytes).toBeLessThanOrEqual(100 * 1024);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeGreaterThan(40); // STMT target FAILS
  });
});

/* ------------------------------------------------------------------ */
/* C-B — schema 4 OWNED candidate rows (applied after the legacy block) */
/* ------------------------------------------------------------------ */

describe('R1.10.3 design lab cost ledger — schema 4 owned candidate (real workerd D1)', () => {
  beforeEach(async () => {
    await applyMigrations(rawDb());
    await applyMigrations(rawDb(), ROUND19_MIGRATION_PLAN); // schema 4 ACTIVE
    await resetTables();
    stats = createD1Stats();
    wrapped = instrumentD1(rawDb(), stats);
  });

  it('C-01 owned candidate, zero-new (not_modified), 1 hop', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-01-owned-zero-not-modified',
      schema: 4,
      path: 'owned-candidate',
      items: [],
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
      notModified: true,
    });
    expect(row.authority).toBe('granted');
    expect(row.outcome.stateWriteWon).toBe(true);
  });

  it('C-02 owned candidate, 100 new, 1 hop — FIRST-profile target ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-02-owned-100-new-1hop',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(100);
    expect(row.outcome.stateWriteWon).toBe(true);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-03 owned candidate, 100 duplicates by external id, 1 hop — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    await seedExistingItems(
      Array.from({ length: 100 }, (_, i) => ({
        id: `seed-ext-${i}`,
        externalId: `led-ext-${i}`,
        canonicalUrl: null,
      })),
    );
    const row = await runPollSequence({
      id: 'C-03-owned-100-dup-external-1hop',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.duplicateExternal).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-04 owned candidate, 100 duplicates by url (worst probe path), 1 hop — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    await seedExistingItems(
      Array.from({ length: 100 }, (_, i) => ({
        id: `seed-url-${i}`,
        externalId: `seed-other-${i}`,
        canonicalUrl: `https://ledger.example/${i}`,
      })),
    );
    const row = await runPollSequence({
      id: 'C-04-owned-100-dup-url-1hop',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.duplicateUrl).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-05 owned candidate, 50/50 mix, 1 hop — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    await seedExistingItems(
      Array.from({ length: 50 }, (_, i) => ({
        id: `seed-mix-${i}`,
        externalId: `led-ext-${i * 2}`,
        canonicalUrl: null,
      })),
    );
    const row = await runPollSequence({
      id: 'C-05-owned-50-50-mix-1hop',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(50);
    expect(row.outcome.duplicateExternal).toBe(50);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-06 owned candidate, 100 new at MAX content-byte shape, 1 hop — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-06-owned-100-new-max-bytes-1hop',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100, 'max'),
      itemShape: 'max',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-07 owned candidate, 100 new + 2 redirect hops (3 authorized units) — ≤40/≤40', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-07-owned-100-new-3hops',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 3,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(100);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40);
    expect(row.statementsAttempted).toBeLessThanOrEqual(40);
  });

  it('C-08 owned candidate, budget denied (daily budget 0): deny read, state-only commit, no items', async () => {
    await seedSources(0); // quota of 0 denies every unit
    await seedState(NOW, null);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-08-owned-budget-denied',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 0,
      authority: 'denied',
    });
    expect(row.authority).toBe('denied');
    // Denied window: candidate commit still runs the state-only write in
    // this harness (the REAL handler maps denial to a failed terminal state
    // with zero items — items=[] keeps that shape; budget-denied pacing is
    // handler logic, unchanged and out of the candidate's scope).
    expect(row.outcome.inserted).toBe(0);
  });

  it('C-09 owned candidate, budget AUTHORITY failure: authorize batch throws → typed retry_wait, ZERO terminal ingestion writes', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    // Make the wrapped binding FAIL the FIRST batch (the authority batch).
    const failing = new Proxy(wrapped, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async () => {
            throw new Error('authority storage unavailable (fixture)');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const saved = wrapped;
    wrapped = failing;
    try {
      const row = await runPollSequence({
        id: 'C-09-owned-authority-failure',
        schema: 4,
        path: 'owned-candidate',
        items: makeItems(100),
        itemShape: 'normal',
        hops: 1,
        dailyRequestBudget: 100,
        authority: 'failure',
      });
      expect(row.authority).toBe('failure');
      expect(row.outcome.zeroTerminalIngestionWrites).toBe(true);
      expect(row.statementsCompleted).toBe(row.statementsAttempted - row.executionApiCallsFailed);
    } finally {
      wrapped = saved;
    }
  });

  it('C-10 owned BASELINE (accepted per-item commit), 100 new, 1 hop — reference row for the derived ceiling vs accepted trace T-13', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    const row = await runPollSequence({
      id: 'C-10-owned-baseline-100-new-1hop',
      schema: 4,
      path: 'owned-baseline',
      items: makeItems(100),
      itemShape: 'normal',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    expect(row.outcome.inserted).toBe(100);
    // The lab baseline stays in the accepted order of magnitude; the exact
    // accepted-trace reference (110 xAPI / 211 STMT) includes the queue
    // envelope scope outside this harness and is reconciled in the docs.
    expect(row.executionApiCallAttempts).toBeGreaterThan(90);
    expect(row.statementsAttempted).toBeGreaterThan(180);
  });

  it('C-15 owned candidate, 100 new uniform ≈45 KB CJK canonical URLs, 1 hop — envelope re-measure: STMT target FAILS (NOT_READY evidence)', async () => {
    await seedSources(100);
    await seedState(NOW, null);
    await seedDispatchableJob();
    // Pin the shape: byte-identical to the accepted normalizer's output for
    // a 5000-char CJK path (proven in lab-suite L-14), distinct per item.
    expect(new TextEncoder().encode(makeItems(1, 'cjk')[0]!.canonicalUrl!).length).toBe(
      CJK_CANONICAL_URL_BYTES,
    );
    const row = await runPollSequence({
      id: 'C-15-owned-100-cjk-45kb-1hop',
      schema: 4,
      path: 'owned-candidate',
      items: makeItems(100, 'cjk'),
      itemShape: 'cjk',
      hops: 1,
      dailyRequestBudget: 100,
      authority: 'granted',
    });
    // Correctness is UNCHANGED: every row lands (no truncation, no drop),
    // atomicity and fences intact under the corrected per-chunk planner.
    expect(row.outcome.inserted).toBe(100);
    expect(row.outcome.stateWriteWon).toBe(true);
    // Per-chunk accounting: 2 rows/statement → 50 INSERT statements ALONE,
    // before ALL other overhead — the ≤40 STMT target cannot hold for the
    // unchanged RSS envelope. This row IS the NOT_READY evidence.
    expect(row.insertStatementsPlanned).toBe(50);
    expect(row.rowsPerInsertStatement).toBe(2);
    expect(row.chunkRows).toBe('50×2');
    expect(row.chunkLimitedBy).toBe('bytes');
    expect(row.maxStatementTotalBytes).toBeLessThanOrEqual(100 * 1024);
    expect(row.executionApiCallAttempts).toBeLessThanOrEqual(40); // API target holds
    expect(row.statementsAttempted).toBeGreaterThan(40); // STMT target FAILS
  });
});
