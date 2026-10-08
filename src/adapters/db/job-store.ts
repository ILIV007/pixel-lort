/**
 * Durable job store on the `jobs` table (Phase 3 — ADR-0036).
 *
 * ALL job SQL lives in this adapter (ADR-0022 typed boundary). The store
 * implements the lifecycle fixed by ADR-0036 §1:
 *
 * - `createJob` is IDEMPOTENT under races: the UNIQUE `idempotency_key`
 *   admits exactly one row; a lost insert resolves the existing row and
 *   compares type + canonical payload — compatible requests observe the
 *   existing job, INCOMPATIBLE requests are a `conflict` (never silently
 *   overwritten).
 * - `claimJob` is ONE atomic compare-and-set per resolution pass: the claim
 *   precondition (dispatchable status, `run_after <= now`, lease expired or
 *   absent) plus the observed `attempts` guard means EXACTLY ONE concurrent
 *   caller wins; the winner's awarded execution generation is
 *   `attempts + 1` (the guard matched that exact row state atomically).
 *   A CLAIMED row whose lease has EXPIRED is atomically reclaimable by the
 *   next delivery (stale-owner recovery — mirrors ADR-0030), so a Worker
 *   that died after claiming is recovered without waiting for cron; an
 *   UNEXPIRED lease is never stolen (`active_elsewhere`). Losers re-read
 *   and resolve against the winner's state — ADR-0030's bounded-resolution
 *   pattern.
 * - Every owner-dependent mutation (complete / retry / dead-letter) is
 *   FENCED by the owned generation (`status='claimed' AND attempts=?`); a
 *   stale owner always receives `false` and can never mutate a newer
 *   owner's claim. Terminal rows are never executable; an UNEXPIRED lease is
 *   never stolen (`lease_until <= now` is the reclaim boundary — exact
 *   expiry is stale, mirroring ADR-0030).
 * - The ATTEMPT BUDGET is enforced AT the atomic claim/recovery boundary
 *   (ADR-0037): a row whose `attempts` already equal `max_attempts` is never
 *   granted another execution generation. The last granted generation may
 *   have crashed before persisting an outcome (the crash window) — the only
 *   safe transition is the terminal `dead_letter`, persisted by ONE guarded
 *   UPDATE before any acknowledgement, by both the delivery-time claim
 *   (`claimJob`) and the cron recovery pass (`reclaimExpiredClaims`).
 * - `poisonJob` dead-letters an UNCLAIMED dispatchable row (unregistered
 *   type / corrupt payload) guarded by the claimable statuses — fail-safe
 *   poison handling without burning a claim generation.
 * - DLQ reconciliation: `dlq_delivered_at IS NULL` scans (migration 0003)
 *   find dead-letter rows whose safe reference was never confirmed
 *   delivered; the guarded mark admits duplicate sends only within the
 *   crash window between send and mark (at-least-once, safe — ADR-0036 §4).
 *
 * Clock units: epoch milliseconds. Time is injected by callers (no
 * wall-clock reads here). Observability: this module never logs SQL text,
 * parameters, or rows (ADR-0022).
 */
import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';
import type { JobStatus } from '../../domain/jobs/job-types';

/** Full durable row shape (migration 0001 columns + 0003 dlq_delivered_at). */
export interface JobRow {
  readonly id: string;
  readonly type: string;
  readonly aggregate_type: string | null;
  readonly aggregate_id: string | null;
  readonly status: string;
  readonly priority: number;
  readonly run_after: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly lease_until: number | null;
  readonly idempotency_key: string;
  readonly payload_json: string;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly dlq_delivered_at: number | null;
}

const JOB_COLUMNS = `id, type, aggregate_type, aggregate_id, status, priority,
  run_after, attempts, max_attempts, lease_until, idempotency_key,
  payload_json, last_error, created_at, updated_at, dlq_delivered_at`;

/**
 * Bounded resolution loop for claim races (ADR-0030 pattern): a lost race
 * re-reads the winner's state; a healthy schema stabilizes after one
 * iteration. The bound exists so a pathological livelock fails loud instead
 * of hanging.
 */
const CLAIM_RESOLUTION_MAX_ATTEMPTS = 4;

/** Lease duration for claimed jobs (ADR-0036 §1): 2 minutes. */
export const JOB_CLAIM_LEASE_MS = 2 * 60 * 1000;

/** Outcome of an atomic claim attempt (ADR-0036 §4 decision table inputs). */
export type JobClaimOutcome =
  | { readonly kind: 'claimed'; readonly generation: number; readonly payloadJson: string }
  | { readonly kind: 'job_missing' }
  | { readonly kind: 'duplicate_completed' }
  | { readonly kind: 'dead_lettered' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'reserved_failed' }
  | { readonly kind: 'not_due'; readonly runAfterMs: number }
  | { readonly kind: 'active_elsewhere' }
  /**
   * The attempt budget was spent and the row transitioned to terminal
   * `dead_letter` AT the claim boundary (ADR-0037) — no execution was
   * awarded. The caller may acknowledge AFTER this durable write.
   */
  | { readonly kind: 'budget_exhausted' };

/** Input for idempotent creation (already validated by the engine). */
export interface CreateJobRowInput {
  readonly id: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly canonicalPayloadJson: string;
  readonly priority: number;
  readonly runAfterMs: number;
  readonly maxAttempts: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
}

export type CreateJobResult =
  | { readonly kind: 'created'; readonly jobId: string }
  | { readonly kind: 'existing'; readonly jobId: string }
  | { readonly kind: 'conflict'; readonly jobId: string };

/**
 * Idempotently insert a durable job. On unique-constraint loss the existing
 * row is resolved: same type AND same canonical payload → `existing`;
 * otherwise `conflict` (the existing job is authoritative — ADR-0036 §2).
 */
export async function createJob(
  executor: DbExecutor,
  input: CreateJobRowInput,
  nowMs: number,
): Promise<CreateJobResult> {
  try {
    await executor.run({
      sql: `INSERT INTO jobs
              (id, type, aggregate_type, aggregate_id, status, priority, run_after,
               attempts, max_attempts, lease_until, idempotency_key, payload_json,
               last_error, created_at, updated_at, dlq_delivered_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, NULL, ?, ?, NULL, ?, ?, NULL)`,
      params: [
        input.id,
        input.type,
        input.aggregateType ?? null,
        input.aggregateId ?? null,
        input.priority,
        input.runAfterMs,
        input.maxAttempts,
        input.idempotencyKey,
        input.canonicalPayloadJson,
        nowMs,
        nowMs,
      ],
    });
    return { kind: 'created', jobId: input.id };
  } catch (error) {
    if (!(isAppError(error) && error.code === 'db_constraint_violation')) {
      throw error;
    }
    const existing = await executor.first<Pick<JobRow, 'id' | 'type' | 'payload_json'>>({
      sql: `SELECT id, type, payload_json FROM jobs WHERE idempotency_key = ?`,
      params: [input.idempotencyKey],
    });
    if (existing === null) {
      // Unreachable on a healthy schema: the constraint implies the row
      // exists. Fail loud rather than inventing a state.
      throw error;
    }
    const compatible =
      existing.type === input.type && existing.payload_json === input.canonicalPayloadJson;
    return compatible
      ? { kind: 'existing', jobId: existing.id }
      : { kind: 'conflict', jobId: existing.id };
  }
}

/** Fetch one durable job row (or null). */
export async function findJobById(executor: DbExecutor, jobId: string): Promise<JobRow | null> {
  return executor.first<JobRow>({
    sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`,
    params: [jobId],
  });
}

/**
 * Atomically claim a job (ADR-0036 §1). Exactly one concurrent caller wins;
 * the awarded generation is the incremented `attempts`. The CAS guard uses
 * the previously observed `attempts` so a lost race can never award a
 * generation it did not observe.
 */
export async function claimJob(
  executor: DbExecutor,
  jobId: string,
  nowMs: number,
  leaseMs: number = JOB_CLAIM_LEASE_MS,
): Promise<JobClaimOutcome> {
  for (let pass = 0; pass < CLAIM_RESOLUTION_MAX_ATTEMPTS; pass++) {
    const row = await executor.first<JobRow>({
      sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`,
      params: [jobId],
    });
    if (row === null) {
      return { kind: 'job_missing' };
    }
    if (row.status === 'succeeded') {
      return { kind: 'duplicate_completed' };
    }
    if (row.status === 'dead_letter') {
      return { kind: 'dead_lettered' };
    }
    if (row.status === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (row.status === 'failed') {
      // RESERVED status (ADR-0036 §1): never written by the Phase 3 engine;
      // non-executable, acknowledged without a hot loop.
      return { kind: 'reserved_failed' };
    }
    if (row.run_after > nowMs) {
      return { kind: 'not_due', runAfterMs: row.run_after };
    }
    if (row.status === 'claimed' && row.lease_until !== null && row.lease_until > nowMs) {
      // An UNEXPIRED lease is honored — never stolen (ADR-0036 §1).
      return { kind: 'active_elsewhere' };
    }
    // Attempt-budget enforcement AT the atomic claim boundary (ADR-0037):
    // the row is otherwise claimable here (dispatchable status, or claimed
    // with an expired/absent lease), but its budget is spent — the granted
    // generation died before persisting an outcome (crash window), or the
    // row was left dispatchable with a spent budget. NO further execution
    // may be awarded: the only safe transition is the terminal
    // `dead_letter`, persisted by ONE guarded UPDATE fenced by the exact
    // observed state. Its predicates are mutually exclusive with the claim
    // CAS below (`attempts >= max_attempts` vs `attempts < max_attempts`),
    // so no concurrent winner can flip between them. The caller may
    // acknowledge only AFTER this durable write (persist-before-ack).
    if (row.attempts >= row.max_attempts) {
      const deadLettered =
        row.status === 'claimed'
          ? await executor.run({
              sql: `UPDATE jobs
                    SET status = 'dead_letter', last_error = ?, lease_until = NULL,
                        dlq_delivered_at = NULL, updated_at = ?
                    WHERE id = ? AND status = 'claimed' AND attempts = ?
                      AND attempts >= max_attempts
                      AND (lease_until IS NULL OR lease_until <= ?)`,
              params: ['job_exhausted', nowMs, jobId, row.attempts, nowMs],
            })
          : await executor.run({
              sql: `UPDATE jobs
                    SET status = 'dead_letter', last_error = ?, lease_until = NULL,
                        dlq_delivered_at = NULL, updated_at = ?
                    WHERE id = ? AND status IN ('pending', 'queued', 'retry_wait')
                      AND attempts = ? AND attempts >= max_attempts`,
              params: ['job_exhausted', nowMs, jobId, row.attempts],
            });
      if (deadLettered.changes > 0) {
        return { kind: 'budget_exhausted' };
      }
      // Lost the guarded transition (a concurrent writer moved the row):
      // re-read and resolve against the winner's fresh state.
      continue;
    }
    // CAS claim (ADR-0036 §1; stale-reclaim mirrors ADR-0030): the winner
    // must observe due-ness, the observed generation, a REMAINING attempt
    // budget (redundant with the boundary check — the atomic statement
    // itself can never over-grant), AND either a dispatchable status or an
    // EXPIRED lease on a claimed row (a stale owner's claim is atomically
    // reclaimable by delivery — exactly one caller matches; an unexpired
    // lease can never be stolen).
    const won = await executor.run({
      sql: `UPDATE jobs
            SET status = 'claimed', lease_until = ?, attempts = attempts + 1, updated_at = ?
            WHERE id = ?
              AND run_after <= ?
              AND attempts = ?
              AND attempts < max_attempts
              AND (
                status IN ('pending', 'queued', 'retry_wait')
                OR (status = 'claimed' AND (lease_until IS NULL OR lease_until <= ?))
              )`,
      params: [nowMs + leaseMs, nowMs, jobId, nowMs, row.attempts, nowMs],
    });
    if (won.changes > 0) {
      return {
        kind: 'claimed',
        generation: row.attempts + 1,
        payloadJson: row.payload_json,
      };
    }
    // Lost the race: the winner's fresh state resolves on the next pass.
  }
  throw new Error('jobs claim state did not stabilize');
}

/**
 * Fenced terminal transition to `succeeded`. Returns false when the row is
 * missing, no longer claimed, or owned by a newer generation (the caller
 * must NOT acknowledge success in that case).
 */
export async function completeJob(
  executor: DbExecutor,
  jobId: string,
  expectedGeneration: number,
  nowMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE jobs
          SET status = 'succeeded', lease_until = NULL, last_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND attempts = ?`,
    params: [nowMs, jobId, expectedGeneration],
  });
  return result.changes > 0;
}

/**
 * Fenced transition to `retry_wait` with a durable `run_after` schedule
 * (D1 is the single scheduling authority — ADR-0036 §4). Returns false when
 * the fence was lost; the caller must not ack a schedule that was not
 * persisted.
 */
export async function markJobRetryWait(
  executor: DbExecutor,
  jobId: string,
  expectedGeneration: number,
  runAfterMs: number,
  errorCode: string,
  nowMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE jobs
          SET status = 'retry_wait', run_after = ?, last_error = ?, lease_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND attempts = ?`,
    params: [runAfterMs, errorCode, nowMs, jobId, expectedGeneration],
  });
  return result.changes > 0;
}

/**
 * Fenced transition to terminal `dead_letter`, resetting `dlq_delivered_at`
 * so the reconciliation scan delivers the safe reference. When
 * `expectedGeneration` is null the transition targets an UNCLAIMED
 * dispatchable row (poison handling — ADR-0036 §4) and is guarded by the
 * claimable statuses instead of the generation fence.
 */
export async function markJobDeadLetter(
  executor: DbExecutor,
  jobId: string,
  expectedGeneration: number | null,
  errorCode: string,
  nowMs: number,
): Promise<boolean> {
  if (expectedGeneration !== null) {
    const result = await executor.run({
      sql: `UPDATE jobs
            SET status = 'dead_letter', last_error = ?, lease_until = NULL,
                dlq_delivered_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'claimed' AND attempts = ?`,
      params: [errorCode, nowMs, jobId, expectedGeneration],
    });
    return result.changes > 0;
  }
  const poison = await executor.run({
    sql: `UPDATE jobs
          SET status = 'dead_letter', last_error = ?, lease_until = NULL,
              dlq_delivered_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('pending', 'queued', 'retry_wait')`,
    params: [errorCode, nowMs, jobId],
  });
  return poison.changes > 0;
}

/**
 * Dispatch marker after the queue ACCEPTED a reference. Guarded by the
 * dispatchable statuses: a concurrent claim/terminal transition makes the
 * marker a no-op (the marker is never authoritative — ADR-0036 §3).
 */
export async function markJobQueued(
  executor: DbExecutor,
  jobId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE jobs SET status = 'queued', updated_at = ?
          WHERE id = ? AND status IN ('pending', 'retry_wait', 'queued')`,
    params: [nowMs, jobId],
  });
  return result.changes > 0;
}

/** Due dispatchable rows (`run_after <= now`), deterministic order, bounded. */
export async function scanDueJobs(
  executor: DbExecutor,
  nowMs: number,
  limit: number,
): Promise<readonly JobRow[]> {
  const result = await executor.query<JobRow>({
    sql: `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE status IN ('pending', 'retry_wait') AND run_after <= ?
          ORDER BY run_after ASC, priority DESC, id ASC
          LIMIT ?`,
    params: [nowMs, limit],
  });
  return result.rows;
}

/**
 * Stranded `queued` rows whose dispatch never settled within the grace
 * window (ADR-0036 §3: a queued marker alone cannot strand work).
 */
export async function scanStrandedQueuedJobs(
  executor: DbExecutor,
  graceCutoffMs: number,
  limit: number,
): Promise<readonly JobRow[]> {
  const result = await executor.query<JobRow>({
    sql: `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE status = 'queued' AND updated_at <= ?
          ORDER BY run_after ASC, priority DESC, id ASC
          LIMIT ?`,
    params: [graceCutoffMs, limit],
  });
  return result.rows;
}

/** Result of one bounded expired-lease recovery pass. */
export interface ReclaimExpiredResult {
  /** Rows moved back to `queued` for re-dispatch (attempt budget intact). */
  readonly reclaimed: number;
  /**
   * Rows whose attempt budget was spent and which transitioned to terminal
   * `dead_letter` AT the recovery boundary (ADR-0037) — the crashed
   * generation is never re-executed.
   */
  readonly exhaustedToDeadLetter: number;
}

/**
 * Reclaim expired claimed leases (bounded). Each row takes exactly one of
 * two MUTUALLY EXCLUSIVE guarded transitions (ADR-0037):
 * - budget spent (`attempts >= max_attempts`): the crashed generation can
 *   never be re-executed — the row dead-letters AT the recovery boundary;
 * - budget intact: the row moves back to `queued` for the bounded dispatch
 *   scan. Attempts are NOT incremented (they count execution generations,
 *   not recoveries).
 */
export async function reclaimExpiredClaims(
  executor: DbExecutor,
  nowMs: number,
  limit: number,
): Promise<ReclaimExpiredResult> {
  const expired = await executor.query<Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>>({
    sql: `SELECT id, attempts, max_attempts FROM jobs
          WHERE status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?
          ORDER BY lease_until ASC, id ASC
          LIMIT ?`,
    params: [nowMs, limit],
  });
  let reclaimed = 0;
  let exhaustedToDeadLetter = 0;
  for (const row of expired.rows) {
    if (row.attempts >= row.max_attempts) {
      const deadLettered = await executor.run({
        sql: `UPDATE jobs
              SET status = 'dead_letter', last_error = ?, lease_until = NULL,
                  dlq_delivered_at = NULL, updated_at = ?
              WHERE id = ? AND status = 'claimed'
                AND lease_until IS NOT NULL AND lease_until <= ?
                AND attempts >= max_attempts`,
        params: ['job_exhausted', nowMs, row.id, nowMs],
      });
      if (deadLettered.changes > 0) {
        exhaustedToDeadLetter += 1;
      }
      continue;
    }
    const result = await executor.run({
      sql: `UPDATE jobs SET status = 'queued', lease_until = NULL, updated_at = ?
            WHERE id = ? AND status = 'claimed'
              AND lease_until IS NOT NULL AND lease_until <= ?
              AND attempts < max_attempts`,
      params: [nowMs, row.id, nowMs],
    });
    reclaimed += result.changes > 0 ? 1 : 0;
  }
  return { reclaimed, exhaustedToDeadLetter };
}

/** Dead-letter rows whose safe DLQ reference was never confirmed delivered. */
export async function scanPendingDlqDeliveries(
  executor: DbExecutor,
  limit: number,
): Promise<readonly JobRow[]> {
  const result = await executor.query<JobRow>({
    sql: `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE status = 'dead_letter' AND dlq_delivered_at IS NULL
          ORDER BY updated_at ASC, id ASC
          LIMIT ?`,
    params: [limit],
  });
  return result.rows;
}

/**
 * Mark a dead-letter row's DLQ reference as delivered. Guarded by
 * `status='dead_letter' AND dlq_delivered_at IS NULL`: exactly one
 * reconciliation pass confirms a given delivery; a crash between the DLQ
 * send and this mark produces one duplicate reference later (at-least-once,
 * safe — ADR-0036 §4).
 */
export async function markDlqDelivered(
  executor: DbExecutor,
  jobId: string,
  deliveredAtMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE jobs SET dlq_delivered_at = ?
          WHERE id = ? AND status = 'dead_letter' AND dlq_delivered_at IS NULL`,
    params: [deliveredAtMs, jobId],
  });
  return result.changes > 0;
}

/** Statuses the dispatch scan may observe (diagnostics/tests only). */
export function isDispatchableStatus(
  status: string,
): status is 'pending' | 'queued' | 'retry_wait' {
  return status === 'pending' || status === 'queued' || status === 'retry_wait';
}

export type { JobStatus };
