/**
 * AI request-budget store (Phase 6 — ADR-0041 §4; typed D1 boundary per
 * ADR-0022).
 *
 * The EXISTING `budgets` table (migration 0001, unchanged) is the single
 * budget authority for AI too, under the DISTINCT scope 'ai' with
 * budget_key = provider ('workers-ai' | 'gemini') and the same explicit
 * Asia/Tehran day bucket (`bucket_date`). No migration, no DDL change, no
 * reuse of ingestion scope/source ids: provider accounting stays separate
 * from ingestion accounting by construction (PK scope+budget_key+day).
 *
 * Contract (round 1.10.6):
 * - EVERY potential provider attempt is charged through
 *   `authorizeAiRequestAttempt` BEFORE the call — a successful durable
 *   authorization is the ONLY thing that may start a provider request.
 * - The charge is ONE atomic D1 batch (guarded UPDATE + guarded
 *   INSERT..SELECT), race-safe against concurrent authorizations: the cap
 *   predicate is evaluated inside SQL against the CURRENT row.
 * - Units are app request ATTEMPTS (from AI_DAILY_REQUEST_ATTEMPT_CAPS).
 *   They are NOT Cloudflare Neurons and NOT a Google quota meter; provider
 *   reset boundaries are the providers' own — the app bucket is Tehran day
 *   by explicit policy, kept separate from both.
 * - No refunds: failed/timeout attempts stay charged (conservative), and a
 *   late finishing call that lost the deadline race is still charged.
 * - Storage failures propagate as mapped AppError — the CALLER classifies
 *   them as budget-store infrastructure errors (typed deferred
 *   budget_store_error), never as quota exhaustion.
 */
import type { DbExecutor } from './db-executor';
import { tehranBudgetDay } from '../../shared/time/tehran-day';
import type { AiProvider } from '../../domain/ai/types';

/** Distinct budgets scope for AI provider accounting. */
export const AI_BUDGET_SCOPE = 'ai';

/** Stable outcome of ONE per-attempt AI budget authorization. */
export type AiBudgetAuthorization =
  | { readonly kind: 'authorized'; readonly bucketDate: string }
  | { readonly kind: 'denied'; readonly bucketDate: string };

/**
 * Atomically consume EXACTLY ONE request attempt for `provider` on the
 * Tehran budget day resolved from the caller's `nowMs`. `cap` comes from
 * the versioned policy (AI_DAILY_REQUEST_ATTEMPT_CAPS) and is evaluated
 * inside SQL. A cap of 0 denies every attempt.
 */
export async function authorizeAiRequestAttempt(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    /** Positive app cap (attempts per Tehran day) from the versioned policy. */
    readonly cap: number;
    readonly nowMs: number;
  },
): Promise<AiBudgetAuthorization> {
  const bucketDate = tehranBudgetDay(input.nowMs);
  const nowMs = input.nowMs;
  const cap = Math.max(0, Math.floor(input.cap));

  const metas = await executor.batch([
    {
      // Existing row: guarded ONE-attempt consume under the cap.
      sql: `UPDATE budgets
              SET requests = requests + 1, updated_at = ?
            WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?
              AND requests + 1 <= ?`,
      params: [nowMs, input.provider, bucketDate, cap],
    },
    {
      // New day row: first charge INSERT..SELECT under the same cap with a
      // NOT EXISTS guard — new-day initialization and the first charge are
      // atomic; a concurrent duplicate insert fails THIS statement only
      // (PK conflict) after the UPDATE already lost, and the batch is
      // atomic so the pair reads consistently.
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            SELECT '${AI_BUDGET_SCOPE}', ?, ?, 1, 0, 0, 0, ?
             WHERE 1 <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM budgets
                  WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?
               )`,
      params: [input.provider, bucketDate, nowMs, cap, input.provider, bucketDate],
    },
  ]);

  const updateChanges = metas[0]?.changes ?? 0;
  const insertChanges = metas[1]?.changes ?? 0;
  if (updateChanges > 0 || insertChanges > 0) {
    return { kind: 'authorized', bucketDate };
  }
  return { kind: 'denied', bucketDate };
}

/**
 * Best-effort, NON-authoritative usage recording: increments the observed
 * input/output token columns when the provider actually reported them.
 * Never grants, refunds, or extends authority; absence or failure of this
 * recording never fails a successful call's result (the service logs a
 * sanitized warning and continues).
 */
export async function recordAiUsage(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    readonly bucketDate: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const inputTokens = Math.max(0, Math.floor(input.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(input.outputTokens ?? 0));
  if (inputTokens === 0 && outputTokens === 0) {
    return true;
  }
  const meta = await executor.run({
    sql: `UPDATE budgets
             SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
           WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?`,
    params: [inputTokens, outputTokens, input.nowMs, input.provider, input.bucketDate],
  });
  return meta.changes > 0;
}

/**
 * Charged-attempt readback for one provider's Tehran day: the count of
 * durably AUTHORIZED app request attempts — the conservative charging
 * metric, NOT an observed-provider-usage metric and NOT a remaining-free-
 * allowance proof.
 */
export async function readAiBudget(
  executor: DbExecutor,
  input: { readonly provider: AiProvider; readonly nowMs: number },
): Promise<number> {
  const row = await executor.first<{
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }>({
    sql: `SELECT requests, input_tokens, output_tokens FROM budgets
           WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?`,
    params: [input.provider, tehranBudgetDay(input.nowMs)],
  });
  return row === null ? 0 : row.requests;
}
