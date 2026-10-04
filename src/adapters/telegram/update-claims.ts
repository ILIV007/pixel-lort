/**
 * Durable Telegram update claims on the `telegram_updates` table (Phase 2A).
 *
 * update_id is the IDEMPOTENCY BOUNDARY: exactly one webhook delivery wins
 * the durable INSERT claim; every other delivery of the same update_id sees
 * the existing row and is acknowledged as a duplicate without reprocessing.
 *
 * State machine (ADR-0025):
 *
 *   (INSERT, first delivery)  -> claimed
 *   claimed -> processed      (guarded by WHERE status = 'claimed')
 *   claimed -> failed         (guarded by WHERE status = 'failed'-safe guard:
 *                              WHERE status = 'claimed')
 *   processed / failed        are terminal in Phase 2A: duplicate
 *                             redeliveries are acknowledged without
 *                             reprocessing. Failed updates stay observable
 *                             (stable status + fail-safe log codes) and are
 *                             recoverable through operator tooling in a
 *                             later phase.
 *
 * Concurrency: concurrent claims of the same update_id serialize on the D1
 * primary key — exactly one INSERT succeeds; losers observe the constraint
 * violation and read back the winner's status. All statements are
 * parameterized; no payload data is stored (the schema stores only
 * update_id, timestamps, and the status word — ADR-0025).
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
  | { readonly kind: 'duplicate'; readonly existingStatus: TelegramUpdateRowStatus };

/**
 * Attempt to durably claim an update by update_id.
 * Returns `claimed` when this call inserted the row, or `duplicate` with the
 * existing status when the update was already claimed before.
 * Throws a mapped AppError on transient database failures (the caller must
 * NOT mark the update processed in that case — the row simply does not exist
 * yet and Telegram's redelivery will retry).
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
    // Lost the insert race: read back the winner's status.
    const row = await executor.first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
      params: [updateId],
    });
    if (row === null || !isRowStatus(row.status)) {
      // Unreachable on a healthy schema: a constraint violation implies the
      // row exists. Fail loud rather than inventing a status.
      throw toDbAppError(new Error('telegram_updates claim row missing after conflict'));
    }
    return { kind: 'duplicate', existingStatus: row.status };
  }
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
 * only after the processing attempt actually threw.
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
