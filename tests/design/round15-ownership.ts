/**
 * ROUND 1.5 DESIGN LAB — source poll ownership (PROPOSED DESIGN, executable
 * proof material). NOT part of the shipped worker: nothing under `src/`
 * imports this module; it exists so the proposed SQL can be PROVEN on real
 * workerd D1 inside the disposable design lab
 * (`tests/integration/round15-design-*.test.ts`).
 *
 * Design authority: `review/design/PIXEL_ROUND1_5_OWNERSHIP_PAUSE_DESIGN.md`
 * (Round 1.5), which finalizes A.1–A.6 and the R09 family of the Round 1.2
 * corrected design. Every statement in this module is quoted verbatim in
 * that document. Product implementation is a SEPARATE, later, authorized
 * round — this module must never be wired into `src/`.
 *
 * Model (schema 4 = migrations 0001–0003 + PROPOSED 0004):
 * - `source_state.poll_owner_job_id` names the ONE job that owns the poll
 *   window; `source_state.next_poll_at` is the CURRENT-TIME hold
 *   (`now + INGESTION_POLL_HOLD_MS`) written by the winner. Both are durable
 *   winner-owned data (instruction 2 of the Round 1.5 letter). NULL owner =
 *   unowned window.
 * - The scheduler's job creation and the source reservation are ONE atomic
 *   D1 batch (statements S1/S2/S3 below). Ownership is tied to the ACTUAL
 *   winner by an EXISTS predicate on the contender's OWN freshly inserted
 *   row: a losing CAS, an idempotency conflict, a foreign payload, and a
 *   terminal existing job can never acquire or overwrite ownership
 *   (instruction 1). The same batch carries the A.4 terminal-window
 *   remediation (S3) — the three statements have mutually exclusive
 *   predicates, so at most one of them moves the marker.
 * - The payload and the idempotency key derive ONLY from
 *   `(sourceId, scheduledForMs)`. The hold value NEVER enters the payload
 *   or the key, so overlapping schedulers on the same window derive the
 *   same key AND the same payload — the same-key/different-payload conflict
 *   class is structurally absent (instruction 2).
 * - The handler acquires ownership at claim time (A1) and re-verifies it
 *   pre-network; every item/state mutation is batch-atomic with an
 *   ownership-fenced state write that ALSO binds the job row identity
 *   (type/aggregate), the execution status and the generation (instruction
 *   3). A stale worker commits NOTHING (items roll back with the batch).
 *
 * ROUND 1.5.1 (B1 correction): the commit boundary now ENFORCES the
 * authoritative source binding it advertises — any item attributed to a
 * source other than the authorized one rejects the WHOLE operation
 * (`OwnedCommitRejectionError`, raised before anything runs), and each
 * item INSERT carries the binding guard as defense in depth. See
 * `commitOwnedPollResults` and `ITEM_OWNED_INSERT`.
 *
 * Clock units: epoch milliseconds; time is injected. No wall-clock reads.
 * Observability: no SQL text, parameters, or rows are ever logged (ADR-0022).
 */
import type { DbExecutor, DbStatement } from '../../src/adapters/db/db-executor';
import { isAppError } from '../../src/shared/errors/app-error';
import { INGESTION_POLL_HOLD_MS } from '../../src/shared/config/phase4';
import proposedMigration0004 from '../fixtures/proposed-0004-source-poll-ownership.sql?raw';
import { MIGRATIONS, type MigrationDescriptor } from '../helpers/migrations';

/** The hold duration is the ACCEPTED Phase 4 constant (unchanged design). */
export { INGESTION_POLL_HOLD_MS as SOURCE_POLL_HOLD_MS };

/** Proposed target schema version after the proposed migration lands. */
export const PROPOSED_SCHEMA_VERSION = 4;

/** Synthetic descriptor for the DISPOSABLE design lab only. */
export const PROPOSED_MIGRATION_0004: MigrationDescriptor = {
  id: '0004_source_poll_ownership',
  version: 4,
  sql: proposedMigration0004,
};

/**
 * Lab migration plan: the accepted append-only set 0001–0003 plus the
 * PROPOSED 0004. Plan validation (strict continuity 1..4) applies unchanged.
 * NEVER registered as a product default — the product `MIGRATIONS` list
 * stays 0001–0003 until a migration is explicitly authorized.
 */
export const LAB_MIGRATION_PLAN: readonly MigrationDescriptor[] = [
  ...MIGRATIONS,
  PROPOSED_MIGRATION_0004,
];

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
 * Honest outcome of one scheduling batch. Every kind is observable only
 * through change counts and bounded reads — never guessed.
 */
export type SchedulePollWindowOutcome =
  /** This contender's insert AND reservation both landed (the winner). */
  | { readonly kind: 'scheduled'; readonly jobId: string; readonly holdUntilMs: number }
  /**
   * A TERMINAL job already exists for this window (A.4 rule 2): the batch
   * advanced the stale marker DIRECTLY to a fresh schedule. No hold, no
   * ownership, no new job.
   */
  | {
      readonly kind: 'window_terminal_skipped';
      readonly terminalJobId: string;
      readonly nextPollAtMs: number;
    }
  /** A non-terminal job already owns this window (A.4 rule 4) — leave alone. */
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
   * without polling.
   */
  | { readonly kind: 'inserted_unreserved'; readonly jobId: string }
  /** The marker moved and the same-key row is terminal — no write needed. */
  | { readonly kind: 'marker_moved' }
  /**
   * A same-key row exists whose type or payload does not match this window
   * (a foreign writer). Ownership is NEVER acquired or overwritten; the
   * window is left alone for operator action; the anomaly is reported.
   */
  | { kind: 'foreign_window_job'; readonly foreignJobId: string };

/**
 * S1 — idempotent durable job insert. A fresh UUID primary key means the
 * ONLY possible conflict is `idempotency_key`; a lost insert is a no-op,
 * never an error.
 */
const S1_INSERT_JOB = `INSERT INTO jobs
          (id, type, aggregate_type, aggregate_id, status, priority, run_after,
           attempts, max_attempts, lease_until, idempotency_key, payload_json,
           last_error, created_at, updated_at, dlq_delivered_at)
        VALUES (?, 'sources.fetch_poll', 'source', ?, 'pending', ?, ?, 0, ?, NULL,
                ?, ?, NULL, ?, ?, NULL)
        ON CONFLICT (idempotency_key) DO NOTHING`;

/**
 * S2 — ownership-bound CURRENT-TIME reservation. The UPDATE may only move
 * the marker when ALL of the following hold atomically:
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
 * The ONE atomic scheduling batch (instruction 1). All three statements run
 * as a single `executor.batch` — an implicit D1 transaction: either all
 * decisions land together or nothing lands. The classification below reads
 * only per-statement change counts and (when needed) bounded row reads; it
 * never retroactively conditions a write (all conditioning is IN the SQL).
 */
export async function schedulePollWindow(
  executor: DbExecutor,
  input: PollWindowSchedulingInput,
  intervalSeconds: number,
): Promise<SchedulePollWindowOutcome> {
  const holdUntilMs = input.nowMs + INGESTION_POLL_HOLD_MS;
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
  // Everything absorbed: classify by bounded reads.
  const existing = await executor.first<{
    id: string;
    type: string;
    payload_json: string;
    status: string;
  }>({
    sql: `SELECT id, type, payload_json, status FROM jobs WHERE idempotency_key = ?`,
    params: [input.idempotencyKey],
  });
  if (existing === null) {
    // Unreachable on a healthy schema: S1 changes=0 implies a conflict,
    // which implies the row exists. Fail loud rather than invent a state.
    throw new Error('poll window scheduling state did not stabilize');
  }
  if (
    existing.type !== 'sources.fetch_poll' ||
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
  | { readonly kind: 'not_owned'; readonly reason: 'window_superseded' | 'owner_foreign' };

/**
 * A1 — claim-time ownership acquisition (runs AFTER the engine's atomic
 * claim, BEFORE any network activity). Two mutually exclusive branches:
 *   (i)  fresh window at MY marker, unowned (the scheduler crashed between
 *        the batch and the queue send — self-heal);
 *   (ii) MY job already owns the window (a NEWER generation of the same job
 *        re-acquiring after lease recycling — the durable winner-owned data
 *        names THIS job).
 * Both branches write the CURRENT-TIME hold. The EXISTS clause binds the
 * job row identity (type/aggregate), the claimed status and the EXACT
 * generation — a stale generation, a foreign job, or a moved window can
 * never acquire (instruction 3).
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

/** Verify durable ownership exactly as the handler must, pre-network. */
export async function readPollOwnership(
  executor: DbExecutor,
  sourceId: string,
): Promise<{ nextPollAtMs: number; ownerJobId: string | null } | null> {
  const row = await executor.first<{ next_poll_at: number; poll_owner_job_id: string | null }>({
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
  const holdUntilMs = input.nowMs + INGESTION_POLL_HOLD_MS;
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

/** Identical to the accepted `PollCommitResult` classification shape. */
export interface OwnedPollCommitResult {
  readonly inserted: number;
  readonly duplicateExternal: number;
  readonly duplicateUrl: number;
  /** True when the ownership-fenced state write WON. */
  readonly stateWriteWon: boolean;
}

/** One item bound for persistence (identical shape to the accepted store). */
export interface OwnedIngestItemRow {
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

/** Terminal state payload (identical shape to the accepted store). */
export interface OwnedPollTerminalState {
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

/**
 * C-last — the OWNERSHIP-FENCED terminal state write. The final statement
 * of the same atomic batch that carries every item insert, so a losing
 * fence rolls back the WHOLE batch: no items, no state (instruction 3 —
 * EVERY item/state mutation is bound to the job and its ownership).
 *
 * Fence (all in one WHERE):
 *   - the observed durable hold (`next_poll_at = :hold`) — the current-time
 *     anchor the winner wrote;
 *   - durable ownership (`poll_owner_job_id = :jobId`);
 *   - job-row identity: type, aggregate, claimed status, EXACT generation
 *     (A.1 clauses — a stale generation or foreign job commits nothing).
 * On success ownership is RELEASED (`poll_owner_job_id = NULL`) together
 * with the fresh schedule — one atomic transition.
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
 * state write (A.1 clause shape: `INSERT..SELECT … WHERE P ON CONFLICT …
 * DO NOTHING`). EVERY item mutation is therefore bound to the job and its
 * ownership IN THE STATEMENT — a stale worker's losing fence inserts
 * NOTHING (0 rows, no error) instead of leaking items outside the fence.
 * The two targeted conflict clauses are byte-identical to the accepted
 * store (R02 semantics): only the two business-key duplicates are absorbed;
 * an unrelated integrity failure still RAISES and aborts the whole batch.
 *
 * ROUND 1.5.1 (B1) — AUTHORITATIVE SOURCE BINDING (defense in depth):
 * the statement additionally carries `? = ?` binding `item.sourceId` to the
 * authoritative `input.sourceId`. Even if a caller bypassed the function's
 * whole-operation validation below, THIS statement could never persist a
 * row whose `source_id` differs from the authorized source (0 rows, no
 * error, no silent re-attribution — the row is not rewritten to look
 * authoritative; it is simply never written). The PRIMARY enforcement is
 * the function-level rejection, which rejects the WHOLE operation (see
 * `commitOwnedPollResults`); this in-statement guard is the last line.
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
 * This is a DESIRED-CONTRACT rejection (counterexample CE1), not an
 * infrastructure fault: authority for source A must never authorize a
 * source B insert, and a boundary claiming full ownership isolation must
 * itself enforce the invariant. The error is raised BEFORE any statement of
 * the commit batch executes, so the rejection is a whole-operation no-op:
 * no items, no cursor/state advance, no ownership release.
 */
export class OwnedCommitRejectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OwnedCommitRejectionError';
    this.code = code;
  }
}

/** Stable design code persisted nowhere by the rejection itself. */
export const DESIGN_CODE_ITEM_SOURCE_MISMATCH = 'item_source_mismatch';

/**
 * Commit one owned poll's items + terminal state as ONE atomic batch.
 * Every statement carries the ownership predicate P; the classification
 * reads are identical in shape to the accepted store.
 *
 * ROUND 1.5.1 (B1) — AUTHORITATIVE SOURCE BINDING (PRIMARY ENFORCEMENT).
 * The boundary itself enforces the source-binding invariant it advertises:
 * BEFORE any statement is built or executed, EVERY item's attribution is
 * validated against the authorized source. Any `item.sourceId !==
 * input.sourceId` — a lone foreign item or ONE foreign item inside an
 * otherwise valid batch — rejects the WHOLE operation by raising
 * `OwnedCommitRejectionError('item_source_mismatch')`:
 *   - NO item is inserted (not even the valid ones — no partial
 *     acceptance, no silent re-attribution of the foreign rows);
 *   - the cursor/state is NOT advanced and ownership is NOT released
 *     (zero statements have run, so the no-op is exact);
 *   - the durable window stays intact: a corrected commit for the SAME
 *     window can still succeed afterwards (the rejection burns nothing —
 *     no attempt, no hold change, no owner change).
 * The validation is a pure function of the in-memory arguments (the item
 * rows cannot change between the check and the batch), so the rejection is
 * race-free by construction; the durable-state races remain fenced by the
 * per-statement predicates P. Defense in depth: each INSERT statement also
 * carries the `? = ?` binding guard (see ITEM_OWNED_INSERT), so a foreign-
 * attributed row can never be persisted even by a caller that bypasses
 * this validation.
 */
export async function commitOwnedPollResults(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly jobId: string;
    readonly generation: number;
    /** The observed durable hold (winner-owned data), NOT payload-derived. */
    readonly observedHoldUntilMs: number;
    readonly items: readonly OwnedIngestItemRow[];
    readonly state: OwnedPollTerminalState;
    readonly nowMs: number;
  },
): Promise<OwnedPollCommitResult> {
  // B1 — authoritative source binding: validate EVERY item BEFORE anything
  // runs. First mismatch wins the diagnostic (deterministic, bounded).
  for (const item of input.items) {
    if (item.sourceId !== input.sourceId) {
      throw new OwnedCommitRejectionError(
        DESIGN_CODE_ITEM_SOURCE_MISMATCH,
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
 * C.3 preflight — bounded read-only duplicate scan (outstanding poll jobs
 * grouped per source). Runs on the CURRENT schema 3 (no DDL required) and
 * MUST be empty before the proposed 0004 index can be created.
 */
export async function scanOutstandingPollDuplicates(
  executor: DbExecutor,
  limit: number,
): Promise<readonly { aggregate_type: string | null; aggregate_id: string | null; n: number }[]> {
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

/**
 * C.3 remediation primitive — guarded `cancelled` transition for a
 * NON-authoritative duplicate (owner-approved operation; never automatic).
 * Cancellation is NOT dead-lettering: the row never enters the DLQ
 * reconciliation scan (`status='dead_letter'` only) and keeps its terminal
 * `cancelled` semantics. `dlq_delivered_at` is deliberately untouched.
 */
export async function cancelSupersededPollJob(
  executor: DbExecutor,
  jobId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE jobs
             SET status = 'cancelled', lease_until = NULL, last_error = ?,
                 updated_at = ?
           WHERE id = ? AND status IN ('pending', 'queued', 'retry_wait')`,
    params: ['job_cancelled_superseded', nowMs, jobId],
  });
  return result.changes > 0;
}
