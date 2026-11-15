/**
 * Source ingestion store (Phase 4 — ADR-0038 §3/§5; typed D1 boundary per
 * ADR-0022). ALL SQL for scheduling and poll persistence lives here.
 *
 * Guarantees (ADR-0038):
 * - bounded, indexed due-source scan (idx_source_state_due seek + PK join);
 * - atomic poll reservation: guarded advance of the scanned due marker;
 * - atomic guarded commit: item inserts + fenced state write in ONE batch;
 * - honest post-commit classification (inserted / duplicate_external /
 *   duplicate_url) via bounded reads — never guessed;
 * - TWO TARGETED conflict clauses per item (R02 fix, verified on real
 *   workerd D1): `ON CONFLICT(source_id, external_id) DO NOTHING` and
 *   `ON CONFLICT(source_id, canonical_url) DO NOTHING` absorb exactly the
 *   two intended business-key duplicates and nothing else. Any unrelated
 *   integrity failure — a primary-key collision on `id`, a NOT NULL or a
 *   CHECK violation — RAISES inside the atomic batch and fails the WHOLE
 *   batch (items AND state rolled back; cursor/state unchanged). The old
 *   broad `INSERT OR IGNORE` (which silently swallowed those violations)
 *   is gone.
 */
import type { DbExecutor, DbStatement } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';

/** Bounded due-source scheduling batch (ADR-0038 §3). */
export const INGESTION_SCHEDULE_BATCH = 10;

/** Reservation hold: just above the 2-minute claim lease (ADR-0038 §3). */
export const SOURCE_POLL_HOLD_MS = 120_000;

/** One due source as read by the scheduling scan. */
export interface DueSourceRow {
  readonly id: string;
  readonly connector: string;
  readonly interval_seconds: number;
  readonly daily_request_budget: number;
  readonly config_json: string;
  readonly next_poll_at: number;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly cursor: string | null;
}

/** Bounded, indexed due-source scan (never a full-table scan). */
export async function scanDueSources(
  executor: DbExecutor,
  nowMs: number,
): Promise<readonly DueSourceRow[]> {
  const result = await executor.query<DueSourceRow>({
    sql: `SELECT s.id, s.connector, s.interval_seconds, s.daily_request_budget,
                 s.config_json, st.next_poll_at, st.etag, st.last_modified, st.cursor
            FROM source_state st
            JOIN sources s ON s.id = st.source_id
           WHERE s.enabled = 1
             AND st.next_poll_at <= ?
             AND (st.circuit_open_until IS NULL OR st.circuit_open_until <= ?)
           ORDER BY st.next_poll_at ASC, s.id ASC
           LIMIT ${INGESTION_SCHEDULE_BATCH}`,
    params: [nowMs, nowMs],
  });
  return result.rows;
}

export type PollReservation =
  { readonly kind: 'reserved'; readonly holdUntilMs: number } | { readonly kind: 'not_owner' };

/**
 * Atomically reserve the poll window: advance the scanned due marker
 * (`next_poll_at = scheduledForMs + hold`) guarded on its exact current
 * value. Exactly one overlapping scheduler wins; losers are told.
 */
export async function reserveSourcePoll(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly scheduledForMs: number;
    readonly nowMs: number;
  },
): Promise<PollReservation> {
  const holdUntilMs = input.scheduledForMs + SOURCE_POLL_HOLD_MS;
  const meta = await executor.run({
    sql: `UPDATE source_state
             SET next_poll_at = ?, updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`,
    params: [holdUntilMs, input.nowMs, input.sourceId, input.scheduledForMs],
  });
  return meta.changes > 0 ? { kind: 'reserved', holdUntilMs } : { kind: 'not_owner' };
}

/**
 * Advance the schedule past a BLOCKED source (watchlist empty, missing
 * credentials, unimplemented connector): one guarded write, stable
 * reason, no job, no network (ADR-0038 §3 step 1).
 */
export async function recordBlockedSourceSkip(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly scheduledForMs: number;
    readonly reason: string;
    readonly intervalSeconds: number;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE source_state
             SET next_poll_at = ?, last_error = ?, last_error_at = ?,
                 updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`,
    params: [
      input.nowMs + input.intervalSeconds * 1000,
      input.reason,
      input.nowMs,
      input.nowMs,
      input.sourceId,
      input.scheduledForMs,
    ],
  });
  return meta.changes > 0;
}

/** One normalized item bound for persistence. */
export interface IngestItemRow {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly excerpt: string | null;
  readonly author: string | null;
  readonly publishedAtMs: number | null;
  readonly fetchedAtMs: number;
  readonly contentHash: string;
  readonly rawJson: string;
}

export interface PollTerminalState {
  readonly cursor: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly nextPollAtMs: number;
  readonly success: boolean;
  readonly lastChangedAtMs: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly circuitOpenUntilMs: number | null;
  readonly requestsToday: number;
  readonly budgetDate: string;
}

export interface PollCommitResult {
  /** Bounded reads that classify every attempted item honestly. */
  readonly inserted: number;
  readonly duplicateExternal: number;
  readonly duplicateUrl: number;
  /** True when the fenced state write WON (we owned the poll window). */
  readonly stateWriteWon: boolean;
}

/**
 * Commit one poll's items + terminal state as ONE atomic batch
 * (ADR-0038 §5, R02 semantics):
 * - items: TWO targeted `ON CONFLICT … DO NOTHING` clauses — exactly the
 *   two business UNIQUE keys are absorbed (replay idempotent); a primary-
 *   key collision, NOT NULL or CHECK violation throws and aborts the WHOLE
 *   batch, leaving cursor/state unchanged (real workerd D1 semantics);
 * - state: fenced on `next_poll_at = holdUntilMs` — a stale worker (a
 *   newer poll has since reserved) writes 0 rows, visible in meta, and
 *   NEVER overwrites newer state;
 * - classification reads (after the batch): which rows exist for each
 *   attempted external id / canonical url.
 */
export async function commitPollResults(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly items: readonly IngestItemRow[];
    readonly state: PollTerminalState;
    readonly holdUntilMs: number;
    readonly nowMs: number;
  },
): Promise<PollCommitResult> {
  const state = input.state;
  const statements: DbStatement[] = [];

  for (const item of input.items) {
    statements.push({
      // TWO targeted conflict clauses (R02, verified on real workerd D1):
      // each absorbs ONLY its own business-key duplicate. Unlike the old
      // broad `INSERT OR IGNORE`, an unrelated primary-key collision or a
      // NOT NULL / CHECK violation raises here and aborts the whole batch
      // (D1 batches are implicit transactions: cursor/state stay put).
      sql: `INSERT INTO source_items
              (id, source_id, external_id, canonical_url, title, body_excerpt, author,
               published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
            ON CONFLICT (source_id, external_id) DO NOTHING
            ON CONFLICT (source_id, canonical_url) DO NOTHING`,
      params: [
        item.id,
        item.sourceId,
        item.externalId,
        item.canonicalUrl,
        item.title,
        item.excerpt,
        item.author,
        item.publishedAtMs,
        item.fetchedAtMs,
        item.contentHash,
        item.rawJson,
      ],
    });
  }

  statements.push({
    sql: `UPDATE source_state
             SET cursor = ?, etag = ?, last_modified = ?,
                 next_poll_at = ?, last_polled_at = ?,
                 last_changed_at = COALESCE(?, last_changed_at),
                 last_success_at = COALESCE(?, last_success_at),
                 last_error_at = ?, last_error = ?,
                 consecutive_failures = ?, circuit_open_until = ?,
                 requests_today = ?, budget_date = ?, updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`,
    params: [
      state.cursor,
      state.etag,
      state.lastModified,
      state.nextPollAtMs,
      input.nowMs,
      state.lastChangedAtMs,
      state.success ? input.nowMs : null,
      state.success ? null : input.nowMs,
      state.lastError,
      state.consecutiveFailures,
      state.circuitOpenUntilMs,
      state.requestsToday,
      state.budgetDate,
      input.nowMs,
      input.sourceId,
      input.holdUntilMs,
    ],
  });

  // ONE atomic batch: all-or-nothing (D1 implicit transaction).
  const metas = await executor.batch(statements);
  const stateMeta = metas[metas.length - 1];
  const stateWriteWon = (stateMeta?.changes ?? 0) > 0;

  // Honest classification (bounded reads, 2 per attempted item).
  let inserted = 0;
  let duplicateExternal = 0;
  let duplicateUrl = 0;
  for (const item of input.items) {
    const own = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE id = ? AND source_id = ?',
      params: [item.id, item.sourceId],
    });
    if (own !== null) {
      inserted += 1;
      continue;
    }
    const byExternal = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE source_id = ? AND external_id = ?',
      params: [item.sourceId, item.externalId],
    });
    if (byExternal !== null) {
      duplicateExternal += 1;
      continue;
    }
    const byUrl =
      item.canonicalUrl === null
        ? null
        : await executor.first<{ id: string }>({
            sql: 'SELECT id FROM source_items WHERE source_id = ? AND canonical_url = ?',
            params: [item.sourceId, item.canonicalUrl],
          });
    if (byUrl !== null) {
      duplicateUrl += 1;
    }
    // Neither row found: unreachable through the two targeted conflict
    // clauses + fresh UUID PKs (only the two business UNIQUE keys can
    // suppress a row without raising); the attempt is still counted as
    // suppressed-by-external for conservative honesty.
    else if (item.canonicalUrl !== null) {
      duplicateExternal += 1;
    }
  }

  return { inserted, duplicateExternal, duplicateUrl, stateWriteWon };
}

/**
 * Initialize the schedule for a NEWLY seeded source_state row
 * (idempotent insert-only; never touches existing rows).
 */
export async function ensureSourceStateRow(
  executor: DbExecutor,
  input: { readonly sourceId: string; readonly nowMs: number },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                    requests_today, updated_at)
          VALUES (?, 0, 0, 0, ?)
          ON CONFLICT (source_id) DO NOTHING`,
    params: [input.sourceId, input.nowMs],
  });
}

// ---------------------------------------------------------------------------
// Round 1.9 — R09 source-poll ownership (REAL product path).
//
// Ported VERBATIM from the independently reviewed, accepted Round 1.5.1
// design lab (`tests/design/round15-ownership.ts`; design authority
// docs/reviews/PIXEL_ROUND1_5_1_OWNERSHIP_PAUSE_DESIGN.md §1–§4/§10; proofs
// P-O1…P-O19, P-R1…P-R7 on real workerd D1). The SQL statements are the
// reviewed verbatim shapes; the ownership capability is feature-detected
// (schema 4 — `resolveOwnershipCapability`) and these functions run ONLY on
// a schema-4 database. Under the APPLIED schema 3 the product keeps the
// accepted legacy paths (the R09 defect stays honestly visible there; it is
// a schema-4 capability by design — the schema-3 schema has no column able
// to carry a per-source job-owner binding).
//
// Model (migration CANDIDATE 0004 — disposable test databases only):
// - `source_state.poll_owner_job_id` names the ONE job that owns the poll
//   window; `source_state.next_poll_at` is the CURRENT-TIME hold
//   (`now + SOURCE_POLL_HOLD_MS`) written by the winner. Both are durable
//   winner-owned data; NULL owner = unowned window.
// - The scheduler's job creation and the source reservation are ONE atomic
//   D1 batch (S1/S2/S3): either all decisions land together or nothing
//   lands. The same batch carries the A.4 terminal-window remediation.
// - The payload and the idempotency key derive ONLY from
//   `(sourceId, scheduledForMs)` — the hold value NEVER enters either, so
//   overlapping schedulers on one window derive the SAME key AND payload.
// ---------------------------------------------------------------------------

/** Stable source_state.last_error reason for the A.4 terminal-window skip. */
export const POLL_WINDOW_TERMINAL_REASON = 'poll_window_terminal';

/** One contender's scheduling identity for one poll window. */
export interface PollWindowSchedulingInput {
  readonly sourceId: string;
  /** The scanned due marker this pass observed (`source_state.next_poll_at`). */
  readonly scheduledForMs: number;
  /** Deterministic window key: `sources.poll:<sha256(sourceId ‖ marker)>`. */
  readonly idempotencyKey: string;
  /** Canonical payload JSON (identical for every contender on this window). */
  readonly canonicalPayloadJson: string;
  /** THIS contender's fresh job id (a new UUID per contender). */
  readonly jobId: string;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly nowMs: number;
}

/**
 * Honest outcome of one owned scheduling batch. Every kind is observable
 * only through change counts and bounded reads — never guessed.
 */
export type SchedulePollWindowOutcome =
  /** This contender's insert AND reservation both landed (the winner). */
  | {
      readonly kind: 'scheduled';
      readonly jobId: string;
      readonly holdUntilMs: number;
    }
  /**
   * A TERMINAL job already exists for this window (A.4): the batch advanced
   * the stale marker DIRECTLY to a fresh schedule. No hold, no ownership,
   * no new job — authority is never reacquired via a terminal job.
   */
  | {
      readonly kind: 'window_terminal_skipped';
      readonly terminalJobId: string;
      readonly nextPollAtMs: number;
    }
  /** A non-terminal job already owns this window — leave alone. */
  | { readonly kind: 'outstanding_job_owns_window'; readonly jobId: string }
  /**
   * The partial unique index aborted the batch: a DIFFERENT-key outstanding
   * poll job exists for this source. Nothing landed (D1 batch atomicity);
   * the outstanding job owns the source and will advance the marker.
   */
  | { readonly kind: 'outstanding_elsewhere'; readonly jobId: string }
  /**
   * The insert landed but the marker CAS lost (the marker moved between the
   * scan and the batch — a superseded window). The job is pending and
   * harmless: claim-time acquisition will refuse ownership and it completes
   * without polling. Explicitly DISCLOSED (accepted design: not equivalent
   * to all-or-nothing job+reservation; the recovery/liveness cost is stated).
   */
  | { readonly kind: 'inserted_unreserved'; readonly jobId: string }
  /**
   * The marker moved and the same-key row is terminal — no write needed.
   */
  | { readonly kind: 'marker_moved' }
  /**
   * A same-key row exists whose durable identity does not match this
   * window (R19-02: type OR aggregate_type OR aggregate_id OR canonical
   * payload — the COMPLETE durable identity must match). Ownership is
   * NEVER acquired or overwritten; no auto-cancel/delete/transfer; the
   * window is left alone for operator action; the anomaly is reported.
   */
  | { kind: 'foreign_window_job'; readonly foreignJobId: string };

/**
 * S1 — idempotent durable job insert. A fresh UUID primary key means the
 * ONLY possible conflict is `idempotency_key`; a lost insert is a no-op,
 * never an error. Column list byte-identical to the accepted `createJob`.
 */
const S1_INSERT_JOB = `INSERT INTO jobs
          (id, type, aggregate_type, aggregate_id, status, priority, run_after,
           attempts, max_attempts, lease_until, idempotency_key, payload_json,
           last_error, created_at, updated_at, dlq_delivered_at)
        VALUES (?, 'sources.fetch_poll', 'source', ?, 'pending', ?, ?, 0, ?, NULL,
                ?, ?, NULL, ?, ?, NULL)
        ON CONFLICT (idempotency_key) DO NOTHING`;

/**
 * S2 — ownership-bound CURRENT-TIME reservation (THE R09 FIX). The hold is
 * anchored to NOW (never to the scanned marker) and written TOGETHER with
 * the durable owner in the same atomic batch. The UPDATE may only move the
 * marker when ALL of the following hold atomically:
 *   (a) the marker still equals the scanned value (the CAS — a losing CAS
 *       changes 0 rows);
 *   (b) the contender's OWN freshly inserted row exists with the exact
 *       window identity — type, aggregate, canonical payload — and is
 *       non-terminal (an idempotency-conflict loser, a foreign payload, and
 *       a terminal existing job all fail this EXISTS and change 0 rows).
 * Exactly one contender satisfies both: the insert winner.
 */
const S2_RESERVE = `UPDATE source_state
           SET next_poll_at = ?, poll_owner_job_id = ?, updated_at = ?
         WHERE source_id = ?
           AND next_poll_at = ?
           AND EXISTS (
                 SELECT 1 FROM jobs j
                  WHERE j.id = ?
                    AND j.idempotency_key = ?
                    AND j.type = 'sources.fetch_poll'
                    AND j.aggregate_type = 'source'
                    AND j.aggregate_id = ?
                    AND j.payload_json = ?
                    AND j.status IN ('pending', 'queued', 'retry_wait', 'claimed')
               )`;

/**
 * S3 — A.4 terminal-window remediation. Mutually exclusive with S2 by
 * construction (S2 requires THIS contender's fresh non-terminal row; S3
 * requires a TERMINAL matching row). Advances a consumed window's stale
 * marker DIRECTLY to a fresh schedule: no hold, no ownership transfer, no
 * new job. `poll_owner_job_id IS NULL` is defense in depth — through the
 * design's own writes, owner set + marker at the old value is unreachable.
 */
const S3_TERMINAL_SKIP = `UPDATE source_state
           SET next_poll_at = ?, last_error = ?, last_error_at = ?, updated_at = ?
         WHERE source_id = ?
           AND next_poll_at = ?
           AND poll_owner_job_id IS NULL
           AND EXISTS (
                 SELECT 1 FROM jobs j
                  WHERE j.idempotency_key = ?
                    AND j.type = 'sources.fetch_poll'
                    AND j.aggregate_type = 'source'
                    AND j.aggregate_id = ?
                    AND j.payload_json = ?
                    AND j.status IN ('succeeded', 'dead_letter', 'cancelled', 'failed')
               )`;

/** The most recent non-terminal poll job for a source (bounded, indexed seek). */
async function findOutstandingPollJob(
  executor: DbExecutor,
  sourceId: string,
): Promise<{ id: string; idempotency_key: string } | null> {
  return executor.first<{ id: string; idempotency_key: string }>({
    sql: `SELECT id, idempotency_key FROM jobs
           WHERE type = 'sources.fetch_poll' AND aggregate_type = 'source'
             AND aggregate_id = ?
             AND status IN ('pending', 'queued', 'claimed', 'retry_wait')
           ORDER BY created_at DESC, id ASC
           LIMIT 1`,
    params: [sourceId],
  });
}

/**
 * The ONE atomic owned scheduling batch (design §2.1). All three statements
 * run as a single `executor.batch` — an implicit D1 transaction: either all
 * decisions land together or nothing lands. The classification below reads
 * only per-statement change counts and (when needed) bounded row reads; it
 * never retroactively conditions a write (all conditioning is IN the SQL).
 */
export async function schedulePollWindowOwned(
  executor: DbExecutor,
  input: PollWindowSchedulingInput,
  intervalSeconds: number,
): Promise<SchedulePollWindowOutcome> {
  const holdUntilMs = input.nowMs + SOURCE_POLL_HOLD_MS;
  const freshScheduleMs = input.nowMs + intervalSeconds * 1000;
  const identity = [input.idempotencyKey, input.sourceId, input.canonicalPayloadJson] as const;

  let metas: readonly { changes: number }[];
  try {
    metas = await executor.batch([
      {
        sql: S1_INSERT_JOB,
        params: [
          input.jobId,
          input.sourceId,
          input.priority,
          input.nowMs,
          input.maxAttempts,
          input.idempotencyKey,
          input.canonicalPayloadJson,
          input.nowMs,
          input.nowMs,
        ],
      },
      {
        sql: S2_RESERVE,
        params: [
          holdUntilMs,
          input.jobId,
          input.nowMs,
          input.sourceId,
          input.scheduledForMs,
          input.jobId,
          ...identity,
        ],
      },
      {
        sql: S3_TERMINAL_SKIP,
        params: [
          freshScheduleMs,
          POLL_WINDOW_TERMINAL_REASON,
          input.nowMs,
          input.nowMs,
          input.sourceId,
          input.scheduledForMs,
          ...identity,
        ],
      },
    ]);
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      // The partial unique index (or another integrity rule) aborted the
      // batch INSIDE D1 — nothing landed. The one designed cause: a
      // different-key outstanding poll job already exists for this source.
      const outstanding = await findOutstandingPollJob(executor, input.sourceId);
      if (outstanding !== null && outstanding.idempotency_key !== input.idempotencyKey) {
        return { kind: 'outstanding_elsewhere', jobId: outstanding.id };
      }
      // A same-key row would NOT have raised (S1 absorbs it). Any other
      // constraint violation is unexpected: fail loud (fail-safe honesty).
      throw error;
    }
    throw error;
  }

  const insertChanges = metas[0]?.changes ?? 0;
  const reserveChanges = metas[1]?.changes ?? 0;
  const skipChanges = metas[2]?.changes ?? 0;

  // Winner: insert + reservation landed together (S2's EXISTS makes
  // reserving for another contender's row impossible).
  if (reserveChanges > 0) {
    return { kind: 'scheduled', jobId: input.jobId, holdUntilMs };
  }
  // A.4 remediation fired: a terminal matching job consumed this window.
  if (skipChanges > 0) {
    const terminal = await executor.first<{ id: string }>({
      sql: `SELECT id FROM jobs WHERE idempotency_key = ? AND type = 'sources.fetch_poll'
             AND aggregate_type = 'source' AND aggregate_id = ? AND payload_json = ?
             AND status IN ('succeeded', 'dead_letter', 'cancelled', 'failed')
            ORDER BY created_at DESC, id ASC LIMIT 1`,
      params: [...identity],
    });
    if (terminal === null) {
      // Unreachable on a healthy schema (S3's EXISTS implies the row).
      throw new Error('poll window terminal-skip state did not stabilize');
    }
    return {
      kind: 'window_terminal_skipped',
      terminalJobId: terminal.id,
      nextPollAtMs: freshScheduleMs,
    };
  }
  // Insert landed but the marker had already moved: superseded window.
  if (insertChanges > 0) {
    return { kind: 'inserted_unreserved', jobId: input.jobId };
  }
  // Everything absorbed: classify by bounded reads. R19-02: the
  // classification read carries the COMPLETE durable identity — id, type,
  // aggregate_type, aggregate_id, canonical payload and status — so a
  // same-key row with a foreign aggregate is classified as a foreign
  // window job BEFORE any terminal/nonterminal classification (it used to
  // be reported as `outstanding_job_owns_window` / `marker_moved` when only
  // type+payload were compared — CE5).
  const existing = await executor.first<{
    id: string;
    type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload_json: string;
    status: string;
  }>({
    sql: `SELECT id, type, aggregate_type, aggregate_id, payload_json, status
            FROM jobs WHERE idempotency_key = ?`,
    params: [input.idempotencyKey],
  });
  if (existing === null) {
    // Unreachable on a healthy schema: S1 changes=0 implies a conflict,
    // which implies the row exists. Fail loud rather than invent a state.
    throw new Error('poll window scheduling state did not stabilize');
  }
  if (
    existing.type !== 'sources.fetch_poll' ||
    existing.aggregate_type !== 'source' ||
    existing.aggregate_id !== input.sourceId ||
    existing.payload_json !== input.canonicalPayloadJson
  ) {
    return { kind: 'foreign_window_job', foreignJobId: existing.id };
  }
  if (
    existing.status === 'pending' ||
    existing.status === 'queued' ||
    existing.status === 'claimed' ||
    existing.status === 'retry_wait'
  ) {
    return { kind: 'outstanding_job_owns_window', jobId: existing.id };
  }
  // Terminal same-key row but S3 changed 0 rows: the marker moved between
  // the scan and the batch (the remediation already happened elsewhere, or
  // another writer advanced the window). Nothing to do.
  return { kind: 'marker_moved' };
}

/** Result of the claim-time ownership acquisition (A1). */
export type PollOwnershipAcquisition =
  | { readonly kind: 'owned'; readonly holdUntilMs: number }
  | {
      readonly kind: 'not_owned';
      readonly reason: 'window_superseded' | 'owner_foreign';
    };

/**
 * A1 — claim-time ownership acquisition (design §2.2; runs AFTER the
 * engine's atomic claim, BEFORE any network activity). Two mutually
 * exclusive branches:
 *   (i)  fresh window at MY marker, unowned (self-heal);
 *   (ii) MY job already owns the window (a NEWER generation of the same
 *        job re-acquiring after lease recycling — the durable winner-owned
 *        data names THIS job).
 * Both branches write the CURRENT-TIME hold. The EXISTS clause binds the
 * job row identity (type/aggregate), the claimed status and the EXACT
 * generation — a stale generation, a foreign job, or a moved window can
 * never acquire. A cancelled job (status no longer `claimed`) cannot
 * acquire — cancellation is honored mid-flight, pre-network.
 */
const A1_ACQUIRE = `UPDATE source_state
           SET next_poll_at = ?, poll_owner_job_id = ?, updated_at = ?
         WHERE source_id = ?
           AND (
                 (poll_owner_job_id IS NULL AND next_poll_at = ?)
              OR (poll_owner_job_id = ?)
               )
           AND EXISTS (
                 SELECT 1 FROM jobs j
                  WHERE j.id = ?
                    AND j.type = 'sources.fetch_poll'
                    AND j.aggregate_type = 'source'
                    AND j.aggregate_id = ?
                    AND j.status = 'claimed'
                    AND j.attempts = ?
               )`;

/** Verify durable ownership exactly as the handler reads it (P-O15 shape). */
export async function readPollOwnership(
  executor: DbExecutor,
  sourceId: string,
): Promise<{ nextPollAtMs: number; ownerJobId: string | null } | null> {
  const row = await executor.first<{
    next_poll_at: number;
    poll_owner_job_id: string | null;
  }>({
    sql: `SELECT next_poll_at, poll_owner_job_id FROM source_state WHERE source_id = ?`,
    params: [sourceId],
  });
  return row === null
    ? null
    : { nextPollAtMs: row.next_poll_at, ownerJobId: row.poll_owner_job_id };
}

export async function acquirePollOwnership(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly jobId: string;
    readonly scheduledForMs: number;
    readonly generation: number;
    readonly nowMs: number;
  },
): Promise<PollOwnershipAcquisition> {
  const holdUntilMs = input.nowMs + SOURCE_POLL_HOLD_MS;
  const result = await executor.run({
    sql: A1_ACQUIRE,
    params: [
      holdUntilMs,
      input.jobId,
      input.nowMs,
      input.sourceId,
      input.scheduledForMs,
      input.jobId,
      input.jobId,
      input.sourceId,
      input.generation,
    ],
  });
  if (result.changes > 0) {
    return { kind: 'owned', holdUntilMs };
  }
  const state = await readPollOwnership(executor, input.sourceId);
  if (state === null) {
    return { kind: 'not_owned', reason: 'window_superseded' };
  }
  return state.ownerJobId !== null && state.ownerJobId !== input.jobId
    ? { kind: 'not_owned', reason: 'owner_foreign' }
    : { kind: 'not_owned', reason: 'window_superseded' };
}

/** Identical classification shape to the accepted `PollCommitResult`. */
export interface OwnedPollCommitResult {
  readonly inserted: number;
  readonly duplicateExternal: number;
  readonly duplicateUrl: number;
  /** True when the ownership-fenced state write WON. */
  readonly stateWriteWon: boolean;
}

/**
 * C-last — the OWNERSHIP-FENCED terminal state write (design §2.3). The
 * final statement of the same atomic batch that carries every item insert,
 * so a losing fence rolls back the WHOLE batch: no items, no state.
 *
 * Fence (all in one WHERE):
 *   - the observed durable hold (`next_poll_at = :hold`) — the current-time
 *     anchor the winner wrote;
 *   - durable ownership (`poll_owner_job_id = :jobId`);
 *   - job-row identity: type, aggregate, claimed status, EXACT generation.
 * On success ownership is RELEASED (`poll_owner_job_id = NULL`) together
 * with the fresh schedule — one atomic transition. An old generation or a
 * lost owner writes ZERO items and ZERO state and can never release a
 * newer owner.
 */
const C_OWNED_STATE_WRITE = `UPDATE source_state
           SET cursor = ?, etag = ?, last_modified = ?,
               next_poll_at = ?, last_polled_at = ?,
               last_changed_at = COALESCE(?, last_changed_at),
               last_success_at = COALESCE(?, last_success_at),
               last_error_at = ?, last_error = ?,
               consecutive_failures = ?, circuit_open_until = ?,
               requests_today = ?, budget_date = ?,
               poll_owner_job_id = NULL, updated_at = ?
         WHERE source_id = ?
           AND next_poll_at = ?
           AND poll_owner_job_id = ?
           AND EXISTS (
                 SELECT 1 FROM jobs j
                  WHERE j.id = ?
                    AND j.type = 'sources.fetch_poll'
                    AND j.aggregate_type = 'source'
                    AND j.aggregate_id = ?
                    AND j.status = 'claimed'
                    AND j.attempts = ?
               )`;

/**
 * Item insert carrying the SAME ownership predicate P as the terminal
 * state write (`INSERT..SELECT … WHERE P ON CONFLICT … DO NOTHING` — the
 * exact shape the accepted design demanded be exercised on real workerd
 * D1). EVERY item mutation is therefore bound to the job and its ownership
 * IN THE STATEMENT — a stale worker's losing fence inserts NOTHING (0 rows,
 * no error) instead of leaking items outside the fence. The two targeted
 * conflict clauses are byte-identical to the accepted store (R02
 * semantics); an unrelated integrity failure still RAISES and aborts the
 * whole batch.
 *
 * ROUND 1.5.1 (B1) — AUTHORITATIVE SOURCE BINDING (defense in depth): the
 * statement additionally carries `? = ?` binding `item.sourceId` to the
 * authoritative `input.sourceId`, so a foreign-attributed row can never be
 * persisted even by a caller that bypassed the whole-operation validation
 * below (0 rows, no error, no silent re-attribution).
 */
const ITEM_OWNED_INSERT = `INSERT INTO source_items
              (id, source_id, external_id, canonical_url, title, body_excerpt, author,
               published_at, fetched_at, content_hash, raw_json, processing_status)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
             WHERE EXISTS (
                   SELECT 1 FROM source_state st
                    WHERE st.source_id = ?
                      AND st.next_poll_at = ?
                      AND st.poll_owner_job_id = ?
                   )
               AND EXISTS (
                   SELECT 1 FROM jobs j
                    WHERE j.id = ?
                      AND j.type = 'sources.fetch_poll'
                      AND j.aggregate_type = 'source'
                      AND j.aggregate_id = ?
                      AND j.status = 'claimed'
                      AND j.attempts = ?
                   )
               AND ? = ?
            ON CONFLICT (source_id, external_id) DO NOTHING
            ON CONFLICT (source_id, canonical_url) DO NOTHING`;

/**
 * ROUND 1.5.1 (B1) — the typed rejection raised by `commitOwnedPollResults`
 * when ANY item's attribution does not match the authoritative source.
 * Raised BEFORE any statement of the commit batch executes, so the
 * rejection is a whole-operation no-op: no items, no cursor/state advance,
 * no ownership release (a corrected commit for the SAME window can still
 * succeed afterwards). Mixed-source batches are rejected BEFORE executing
 * statements.
 */
export class OwnedCommitRejectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OwnedCommitRejectionError';
    this.code = code;
  }
}

/** Stable code persisted nowhere by the rejection itself. */
export const ITEM_SOURCE_MISMATCH = 'item_source_mismatch';

/**
 * Commit one owned poll's items + terminal state as ONE atomic batch
 * (design §2.3). Every statement carries the ownership predicate P; the
 * classification reads are identical in shape to the accepted
 * `commitPollResults`.
 *
 * `observedHoldUntilMs` is the OBSERVED durable hold (the winner-owned
 * anchor as acquired at claim time), NEVER a payload-derived value.
 */
export async function commitOwnedPollResults(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly jobId: string;
    readonly generation: number;
    readonly observedHoldUntilMs: number;
    readonly items: readonly IngestItemRow[];
    readonly state: PollTerminalState;
    readonly nowMs: number;
  },
): Promise<OwnedPollCommitResult> {
  // B1 — authoritative source binding: validate EVERY item BEFORE anything
  // runs. First mismatch wins the diagnostic (deterministic, bounded).
  // The validation is a pure function of the in-memory arguments, so it is
  // race-free by construction; durable-state races remain fenced by the
  // per-statement predicates P.
  for (const item of input.items) {
    if (item.sourceId !== input.sourceId) {
      throw new OwnedCommitRejectionError(
        ITEM_SOURCE_MISMATCH,
        `item "${item.id}" is attributed to source "${item.sourceId}", but authority for this commit is source "${input.sourceId}" — the whole operation is rejected`,
      );
    }
  }

  const state = input.state;
  const statements: DbStatement[] = [];

  for (const item of input.items) {
    statements.push({
      sql: ITEM_OWNED_INSERT,
      params: [
        item.id,
        item.sourceId,
        item.externalId,
        item.canonicalUrl,
        item.title,
        item.excerpt,
        item.author,
        item.publishedAtMs,
        item.fetchedAtMs,
        item.contentHash,
        item.rawJson,
        input.sourceId,
        input.observedHoldUntilMs,
        input.jobId,
        input.jobId,
        input.sourceId,
        input.generation,
        // B1 defense in depth: bind the row's attribution to the
        // authoritative source INSIDE the statement.
        item.sourceId,
        input.sourceId,
      ],
    });
  }

  statements.push({
    sql: C_OWNED_STATE_WRITE,
    params: [
      state.cursor,
      state.etag,
      state.lastModified,
      state.nextPollAtMs,
      input.nowMs,
      state.lastChangedAtMs,
      state.success ? input.nowMs : null,
      state.success ? null : input.nowMs,
      state.lastError,
      state.consecutiveFailures,
      state.circuitOpenUntilMs,
      state.requestsToday,
      state.budgetDate,
      input.nowMs,
      input.sourceId,
      input.observedHoldUntilMs,
      input.jobId,
      input.jobId,
      input.sourceId,
      input.generation,
    ],
  });

  const metas = await executor.batch(statements);
  const stateMeta = metas[metas.length - 1];
  const stateWriteWon = (stateMeta?.changes ?? 0) > 0;

  // Honest classification (bounded reads) — same shape as the accepted store.
  let inserted = 0;
  let duplicateExternal = 0;
  let duplicateUrl = 0;
  for (const item of input.items) {
    const own = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE id = ? AND source_id = ?',
      params: [item.id, item.sourceId],
    });
    if (own !== null) {
      inserted += 1;
      continue;
    }
    const byExternal = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE source_id = ? AND external_id = ?',
      params: [item.sourceId, item.externalId],
    });
    if (byExternal !== null) {
      duplicateExternal += 1;
      continue;
    }
    const byUrl =
      item.canonicalUrl === null
        ? null
        : await executor.first<{ id: string }>({
            sql: 'SELECT id FROM source_items WHERE source_id = ? AND canonical_url = ?',
            params: [item.sourceId, item.canonicalUrl],
          });
    if (byUrl !== null) {
      duplicateUrl += 1;
    } else if (item.canonicalUrl !== null) {
      duplicateExternal += 1;
    }
  }

  return { inserted, duplicateExternal, duplicateUrl, stateWriteWon };
}

/**
 * C.3 duplicate preflight — bounded read-only scan for outstanding poll
 * jobs grouped per source. Runs on the CURRENT applied schema (3 or 4; no
 * DDL required) and MUST be empty before the 0004 candidate index can ever
 * be created on a real database. Remediation itself is an explicit OWNER
 * decision (drain-and-retry, or owner-approved guarded cancellation of the
 * NON-authoritative duplicates only) — never automatic, never destructive,
 * never silently performed by this product (no silent cancellation or
 * deduplication; see the Round 1.9 transition document).
 */
export async function scanOutstandingPollDuplicates(
  executor: DbExecutor,
  limit: number,
): Promise<
  readonly {
    aggregate_type: string | null;
    aggregate_id: string | null;
    n: number;
  }[]
> {
  const result = await executor.query<{
    aggregate_type: string | null;
    aggregate_id: string | null;
    n: number;
  }>({
    sql: `SELECT aggregate_type, aggregate_id, COUNT(*) AS n FROM jobs
           WHERE type = 'sources.fetch_poll'
             AND status IN ('pending', 'queued', 'claimed', 'retry_wait')
           GROUP BY aggregate_type, aggregate_id
          HAVING n > 1
           LIMIT ?`,
    params: [limit],
  });
  return result.rows;
}
