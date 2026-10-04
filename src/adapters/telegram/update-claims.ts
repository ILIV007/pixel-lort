/**
 * Durable Telegram update claims on the `telegram_updates` table (Phase 2A).
 *
 * update_id is the IDEMPOTENCY BOUNDARY: exactly one webhook delivery wins
 * the durable INSERT claim; every other delivery of the same update_id sees
 * the existing row.
 *
 * Claim boundary (ADR-0025, extended by ADR-0027 — retryable reclaim):
 *
 *   (INSERT, first delivery)   -> claimed            [new claim]
 *   existing row = processed   -> already_processed  [terminal — ack, never reprocessed]
 *   existing row = claimed     -> in_flight          [another delivery owns it — ack]
 *   existing row = failed      -> RECLAIM            [atomic failed -> claimed;
 *                               exactly one concurrent caller wins]
 *
 * Why reclaim: a RETRYABLE processing failure (transient D1 outage, Telegram
 * timeout/429/5xx, missing outbound client) marks the row `failed` and the
 * webhook answers 503, so Telegram redelivers. On redelivery the failed row
 * must be atomically reclaimable — otherwise a temporary failure would
 * permanently lose the update (duplicate redeliveries would be acked
 * forever). `processed` remains TERMINAL: it is never reclaimable, so a
 * processed update can never execute twice. Failed redeliveries that fail
 * again simply return to `failed` (each retry is one bounded attempt).
 *
 * Concurrency: concurrent claims serialize on the D1 primary key — exactly
 * one INSERT succeeds; losers read back the winner's status. Concurrent
 * RECLAIMS of the same failed row serialize on the guarded UPDATE
 * (`WHERE status = 'failed'`) — exactly one caller wins the transition,
 * losers re-read the (now `claimed`) row and acknowledge as in-flight.
 * All statements are parameterized; no payload data is stored (the schema
 * stores only update_id, timestamps, and the status word — ADR-0025).
 *
 * Observability: failures are logged by callers with stable codes; this
 * module never logs SQL text, parameters, or rows (ADR-0022).
 */
import type { DbExecutor } from '../db/db-executor';
import { toDbAppError } from '../db/d1-errors';
import { isAppError } from '../../shared/errors/app-error';

export type TelegramUpdateRowStatus = 'claimed' | 'processed' | 'failed';

export type TelegramUpdateClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'reclaimed' }
  | { readonly kind: 'already_processed' }
  | { readonly kind: 'in_flight' };

/**
 * Bounded resolution loop for lost races. A constraint violation or a lost
 * reclaim is re-resolved by reading the winner's status; a healthy schema
 * stabilizes after one iteration. The bound exists so a pathological
 * (impossible on a healthy schema) livelock fails loud instead of hanging.
 */
const CLAIM_RESOLUTION_MAX_ATTEMPTS = 4;

/**
 * Attempt to durably claim an update by update_id.
 *
 * Returns:
 * - `claimed`           — this call inserted the row (new delivery);
 * - `reclaimed`         — this call atomically transitioned a `failed` row
 *                         back to `claimed` (retry delivery won the race);
 * - `already_processed` — the update finished successfully before; ack
 *                         WITHOUT reprocessing (terminal);
 * - `in_flight`         — another delivery currently owns the row; ack as a
 *                         duplicate.
 *
 * Throws a mapped AppError on transient database failures (the caller must
 * NOT mark the update processed in that case — the row may not exist yet
 * and Telegram's redelivery will retry).
 */
export async function claimTelegramUpdate(
  executor: DbExecutor,
  updateId: number,
  receivedAtMs: number,
): Promise<TelegramUpdateClaim> {
  try {
    await executor.run({
      sql: 'INSERT INTO telegram_updates (update_id, received_at, status) VALUES (?, ?, ?)',
      params: [updateId, receivedAtMs, 'claimed'],
    });
    return { kind: 'claimed' };
  } catch (error) {
    // The DbExecutor maps driver errors to stable AppError codes; the
    // primary-key conflict IS the duplicate-delivery signal.
    if (!(isAppError(error) && error.code === 'db_constraint_violation')) {
      throw error;
    }
    // Lost the insert race: resolve the winner's current state.
    return resolveExistingClaim(executor, updateId, receivedAtMs);
  }
}

async function resolveExistingClaim(
  executor: DbExecutor,
  updateId: number,
  receivedAtMs: number,
): Promise<TelegramUpdateClaim> {
  for (let attempt = 0; attempt < CLAIM_RESOLUTION_MAX_ATTEMPTS; attempt++) {
    const row = await executor.first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
      params: [updateId],
    });
    if (row === null || !isRowStatus(row.status)) {
      // Unreachable on a healthy schema: a constraint violation implies the
      // row exists. Fail loud rather than inventing a status.
      throw toDbAppError(new Error('telegram_updates claim row missing after conflict'));
    }
    if (row.status === 'processed') {
      return { kind: 'already_processed' };
    }
    if (row.status === 'claimed') {
      return { kind: 'in_flight' };
    }
    // row.status === 'failed': a retryable failure from an earlier delivery.
    // Atomic reclaim — the guarded UPDATE admits EXACTLY ONE winner; a
    // concurrent loser observes changes === 0 and re-reads the row (the
    // winner's `claimed` status resolves as in_flight on the next pass).
    const reclaim = await executor.run({
      sql: `UPDATE telegram_updates
            SET status = 'claimed', received_at = ?, processed_at = NULL
            WHERE update_id = ? AND status = 'failed'`,
      params: [receivedAtMs, updateId],
    });
    if (reclaim.changes > 0) {
      return { kind: 'reclaimed' };
    }
  }
  throw toDbAppError(new Error('telegram_updates claim state did not stabilize'));
}

/**
 * Transition a claimed update to `processed`.
 * Returns true when this call performed the transition, false when the row
 * is missing or no longer in the `claimed` state (never overwrites a
 * terminal state).
 */
export async function markTelegramUpdateProcessed(
  executor: DbExecutor,
  updateId: number,
  processedAtMs: number,
): Promise<boolean> {
  return transitionToTerminal(executor, updateId, 'processed', processedAtMs);
}

/**
 * Transition a claimed update to `failed`.
 * Returns true when this call performed the transition. A transient internal
 * failure is therefore never falsely marked processed: failed is recorded
 * only after the processing attempt actually threw. A `failed` row stays
 * reclaimable by a later redelivery (ADR-0027).
 */
export async function markTelegramUpdateFailed(
  executor: DbExecutor,
  updateId: number,
  processedAtMs: number,
): Promise<boolean> {
  return transitionToTerminal(executor, updateId, 'failed', processedAtMs);
}

async function transitionToTerminal(
  executor: DbExecutor,
  updateId: number,
  status: Exclude<TelegramUpdateRowStatus, 'claimed'>,
  processedAtMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: 'UPDATE telegram_updates SET status = ?, processed_at = ? WHERE update_id = ? AND status = ?',
    params: [status, processedAtMs, updateId, 'claimed'],
  });
  return result.changes > 0;
}

function isRowStatus(value: string): value is TelegramUpdateRowStatus {
  return value === 'claimed' || value === 'processed' || value === 'failed';
}
