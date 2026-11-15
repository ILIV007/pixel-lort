/**
 * Ingestion request-budget store (Phase 4 — ADR-0038 §6; typed D1
 * boundary per ADR-0022; per-hop authority reshaped by Round 1.8 R10).
 *
 * The `budgets` table (scope='ingestion', budget_key=<sourceId>,
 * bucket_date=<Asia/Tehran day>) is the SINGLE budget authority.
 *
 * Round 1.8 (R10): the PRODUCTION ingestion path charges through
 * `authorizeIngestionUnit` — an atomic guarded consume of EXACTLY ONE unit
 * executed BEFORE EVERY raw fetch attempt (hop 0, every redirect hop, every
 * later connector request). The legacy planned-reservation helpers below
 * (`reserveIngestionBudget` / `reconcileIngestionBudget`) are RETIRED from
 * production: they remain ONLY for the explicit legacy budget tests, with
 * truthful docs. No estimate grants authority; production has ONE charging
 * owner.
 */
import type { DbExecutor } from './db-executor';
import { tehranBudgetDay } from '../../shared/time/tehran-day';

export type BudgetReservation =
  | { readonly kind: 'reserved'; readonly bucketDate: string; readonly requests: number }
  | { readonly kind: 'exhausted'; readonly bucketDate: string }
  | { readonly kind: 'source_missing'; readonly bucketDate: string };

/**
 * LEGACY helper (NOT the production charging owner since Round 1.8 R10).
 * Atomically reserve `count` requests for a source on today's Tehran
 * budget day. Kept ONLY for the explicit legacy budget tests
 * (`tests/integration/ingestion-budget.test.ts`); the production ingestion
 * path charges per hop through `authorizeIngestionUnit` instead. Returns
 * the stable outcome; never throws for domain conditions (only for storage
 * failures, which propagate as AppError).
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
 * Stable outcome of ONE per-hop budget authorization (R10).
 */
export type BudgetUnitAuthorization =
  | { readonly kind: 'authorized'; readonly bucketDate: string }
  | { readonly kind: 'denied'; readonly bucketDate: string }
  | { readonly kind: 'source_missing'; readonly bucketDate: string };

/**
 * THE production charging owner (Round 1.8 R10): atomically consume
 * EXACTLY ONE request unit for a source on the Tehran budget day resolved
 * from the caller's `nowMs` — resolved at EACH authorization, never at job
 * start, so a hop after Tehran midnight charges the NEW day and a budget
 * change between hops is respected.
 *
 * Both statements run as ONE atomic D1 batch (race-safe: concurrent
 * workers can never exceed the cap because the cap predicate is evaluated
 * inside SQL against the CURRENT source budget):
 *
 *   1. guarded UPDATE (existing row): requests + 1 <= source cap;
 *   2. on 0 changes, one guarded INSERT..SELECT (new day row) with the
 *      same cap predicate and a NOT EXISTS guard — new-day initialization
 *      and the first charge are atomic.
 *
 * A quota of 0 denies every unit. There is no refund, no clamping, no
 * negative counts, and no use of planned estimates. Storage failures
 * propagate as AppError (the caller classifies them as infrastructure —
 * never as quota exhaustion).
 */
export async function authorizeIngestionUnit(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly nowMs: number;
  },
): Promise<BudgetUnitAuthorization> {
  const bucketDate = tehranBudgetDay(input.nowMs);
  const nowMs = input.nowMs;

  const metas = await executor.batch([
    {
      // Existing row: guarded ONE-unit consume under the cap.
      sql: `UPDATE budgets
              SET requests = requests + 1, updated_at = ?
            WHERE scope = 'ingestion' AND budget_key = ? AND bucket_date = ?
              AND requests + 1 <= (SELECT daily_request_budget FROM sources WHERE id = ?)`,
      params: [nowMs, input.sourceId, bucketDate, input.sourceId],
    },
    {
      // New day row: first charge INSERT..SELECT under the same cap
      // (PK + NOT EXISTS make a concurrent duplicate a no-change failure
      // of THIS statement only; the batch is atomic).
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            SELECT 'ingestion', ?, ?, 1, 0, 0, 0, ?
             WHERE 1 <= (SELECT daily_request_budget FROM sources WHERE id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM budgets
                  WHERE scope = 'ingestion' AND budget_key = ? AND bucket_date = ?
               )`,
      params: [input.sourceId, bucketDate, nowMs, input.sourceId, input.sourceId, bucketDate],
    },
  ]);

  const updateChanges = metas[0]?.changes ?? 0;
  const insertChanges = metas[1]?.changes ?? 0;
  if (updateChanges > 0 || insertChanges > 0) {
    return { kind: 'authorized', bucketDate };
  }
  // Distinguish exhaustion from a missing source with one cheap read.
  const source = await executor.first<{ daily_request_budget: number }>({
    sql: 'SELECT daily_request_budget FROM sources WHERE id = ?',
    params: [input.sourceId],
  });
  if (source === null) {
    return { kind: 'source_missing', bucketDate };
  }
  return { kind: 'denied', bucketDate };
}

/**
 * LEGACY helper (NOT the production charging owner since Round 1.8 R10):
 * reconcile OBSERVED extra requests after the fact. Kept ONLY for the
 * explicit legacy budget tests; the production path charges every hop up
 * front through `authorizeIngestionUnit`, so no post-fetch reconciliation
 * exists there (double charge and old-day attribution are impossible).
 * NOT cap-guarded by design: this retained UPDATE increments the charged
 * count UNCONDITIONALLY (even past the source's daily budget) when a row
 * exists — it is a legacy behavior snapshot, deliberately unchanged by
 * R10.1. It returns the requested extra count honestly when a row was
 * touched, and 0 when no budget row exists for the day.
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

/**
 * Charged-unit readback for a source's Tehran day (operator readback):
 * this is the count of durably AUTHORIZED units — the conservative
 * charging metric — NOT an exact observed-raw-request metric (a
 * charge-before-fetch window legitimately makes authorized units differ
 * from attempted requests; R10.1/B4 keeps the two concepts distinct).
 */
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
