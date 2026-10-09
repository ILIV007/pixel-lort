/**
 * Ingestion request-budget store (Phase 4 — ADR-0038 §6; typed D1
 * boundary per ADR-0022).
 *
 * The `budgets` table (scope='ingestion', budget_key=<sourceId>,
 * bucket_date=<Asia/Tehran day>) is the SINGLE budget authority. The
 * reservation is ATOMIC and happens BEFORE any network call:
 *
 *   1. guarded UPDATE (existing row): requests + n <= source cap;
 *   2. on 0 changes, one guarded INSERT..SELECT (new day row) with the
 *      same cap predicate.
 *
 * Both statements run as ONE atomic D1 batch; the per-statement change
 * counts decide the outcome. Day rollover is implicit via the primary
 * key (no reset write, no double-reset race). Over-cap requests are
 * impossible through this boundary.
 */
import type { DbExecutor } from './db-executor';
import { tehranBudgetDay } from '../../shared/time/tehran-day';

export type BudgetReservation =
  | { readonly kind: 'reserved'; readonly bucketDate: string; readonly requests: number }
  | { readonly kind: 'exhausted'; readonly bucketDate: string }
  | { readonly kind: 'source_missing'; readonly bucketDate: string };

/**
 * Atomically reserve `count` requests for a source on today's Tehran
 * budget day. Returns the stable outcome; never throws for domain
 * conditions (only for storage failures, which propagate as AppError).
 */
export async function reserveIngestionBudget(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly count: number;
    readonly nowMs: number;
  },
): Promise<BudgetReservation> {
  const bucketDate = tehranBudgetDay(input.nowMs);
  const count = Math.max(1, Math.floor(input.count));
  const nowMs = input.nowMs;

  const metas = await executor.batch([
    {
      // Existing row: guarded increment under the cap.
      sql: `UPDATE budgets
              SET requests = requests + ?, updated_at = ?
            WHERE scope = 'ingestion' AND budget_key = ? AND bucket_date = ?
              AND requests + ? <= (SELECT daily_request_budget FROM sources WHERE id = ?)`,
      params: [count, nowMs, input.sourceId, bucketDate, count, input.sourceId],
    },
    {
      // New day row: INSERT..SELECT under the same cap (race-safe: the
      // PK conflict makes a concurrent duplicate insert a no-change
      // failure of THIS statement only after the UPDATE already lost —
      // the batch is atomic so the pair reads consistently).
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            SELECT 'ingestion', ?, ?, ?, 0, 0, 0, ?
             WHERE ? <= (SELECT daily_request_budget FROM sources WHERE id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM budgets
                  WHERE scope = 'ingestion' AND budget_key = ? AND bucket_date = ?
               )`,
      params: [
        input.sourceId,
        bucketDate,
        count,
        nowMs,
        count,
        input.sourceId,
        input.sourceId,
        bucketDate,
      ],
    },
  ]);

  const updateChanges = metas[0]?.changes ?? 0;
  const insertChanges = metas[1]?.changes ?? 0;
  if (updateChanges > 0 || insertChanges > 0) {
    return { kind: 'reserved', bucketDate, requests: count };
  }
  // Distinguish exhaustion from a missing source with one cheap read.
  const source = await executor.first<{ daily_request_budget: number }>({
    sql: 'SELECT daily_request_budget FROM sources WHERE id = ?',
    params: [input.sourceId],
  });
  if (source === null) {
    return { kind: 'source_missing', bucketDate };
  }
  return { kind: 'exhausted', bucketDate };
}

/**
 * Reconcile OBSERVED extra requests (validated redirect hops, additional
 * API calls) into the budget after the fact. Best-effort by design: an
 * over-cap reconciliation is a no-op (the planned cap still governs the
 * next poll); the observed count is returned honestly.
 */
export async function reconcileIngestionBudget(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly extraCount: number;
    readonly nowMs: number;
  },
): Promise<number> {
  if (input.extraCount <= 0) {
    return 0;
  }
  const bucketDate = tehranBudgetDay(input.nowMs);
  const meta = await executor.run({
    sql: `UPDATE budgets
             SET requests = requests + ?, updated_at = ?
           WHERE scope = 'ingestion' AND budget_key = ? AND bucket_date = ?`,
    params: [Math.floor(input.extraCount), input.nowMs, input.sourceId, bucketDate],
  });
  return meta.changes > 0 ? Math.floor(input.extraCount) : 0;
}

/** Observed request count for a source's Tehran day (operator readback). */
export async function readIngestionBudget(
  executor: DbExecutor,
  input: { readonly sourceId: string; readonly nowMs: number },
): Promise<number> {
  const row = await executor.first<{ requests: number }>({
    sql: `SELECT requests FROM budgets
           WHERE scope = 'ingestion' AND budget_key = ? AND bucket_date = ?`,
    params: [input.sourceId, tehranBudgetDay(input.nowMs)],
  });
  return row === null ? 0 : row.requests;
}
