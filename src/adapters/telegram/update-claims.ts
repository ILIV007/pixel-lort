/**
 * Durable Telegram update claims on the `telegram_updates` table (Phase 2A,
 * lifecycle completed by ADR-0030/0031, FENCED by the final correction round
 * v1.2.3 — schema v2, migration 0002).
 *
 * update_id is the IDEMPOTENCY BOUNDARY: exactly one webhook delivery wins
 * the durable INSERT claim; every other delivery of the same update_id sees
 * the existing row.
 *
 * Claim boundary (ADR-0025, extended by ADR-0027, completed by ADR-0030/0031,
 * fenced by the final correction round):
 *
 *   (INSERT, first delivery)          -> claimed             [new claim, lease set, generation 1]
 *   existing row = processed          -> already_processed   [terminal — ack, never reprocessed]
 *   existing row = failed(permanent)  -> permanently_failed  [terminal — ack, never re-executed]
 *   existing row = failed(retryable)  -> RECLAIM             [reclaimed_retryable]
 *   existing row = claimed, lease ACTIVE (claim_expires_at > now)
 *                                     -> in_flight           [NOT a successful duplicate:
 *                                                             the caller answers safe 503]
 *   existing row = claimed, lease EXPIRED (claim_expires_at <= now)
 *                                     -> RECLAIM             [reclaimed_stale]
 *
 * WHY A LEASE (ADR-0030): a Worker can terminate after the durable claim but
 * before the terminal transition, `markTelegramUpdateFailed` itself can fail,
 * and the request can be interrupted after claiming. Without a lease the row
 * would remain `claimed` forever and every later delivery would observe it as
 * in-flight — the update would be unrecoverable. The lease makes an abandoned
 * claim distinguishable from a live one: an ACTIVE lease is honored
 * (in_flight), an EXPIRED lease is atomically reclaimable by a guarded
 * UPDATE. Exactly one concurrent stale-claim reclaim may win; losers observe
 * the winner's FRESH lease as in-flight. The lease duration is centralized
 * in TELEGRAM_UPDATE_CLAIM_LEASE_MS (conservative: far above the bounded
 * webhook processing time, far below any operational recovery horizon).
 *
 * WHY attempt_count IS THE FENCING GENERATION (final correction round
 * v1.2.3, ADR-0030): a lease bounds OWNERSHIP IN TIME, but a stale Worker
 * that resumes after its lease expired — and after a newer generation
 * reclaimed the row — must still be prevented from mutating the newer
 * owner's claim. `attempt_count` is therefore the claim GENERATION (fencing
 * token), not merely an audit counter:
 *   - every EXECUTION-OWNING claim outcome carries the generation it now
 *     owns (`claimed` = 1, every reclaim = the incremented count it won);
 *   - every RECLAIM is additionally guarded by the previously observed
 *     generation (`AND attempt_count = ?`), so exactly one generation
 *     transition may win and a lost race can never overwrite the winner;
 *   - every TERMINAL transition (`processed` / `failed`) requires the
 *     caller's `expectedAttemptCount` (`AND attempt_count = ?` in the
 *     UPDATE) — a stale owner always receives `false` and can never mark a
 *     newer claim processed or failed.
 * Terminal/no-ownership outcomes (already_processed, permanently_failed,
 * in_flight) carry no generation: they never own the execution.
 *
 * WHY failure_class PERSISTENCE (ADR-0031): both retryable and permanent
 * failures are stored as status='failed', but ONLY retryable failed rows are
 * reclaimable. A permanent failure (e.g. Telegram 400 bad_request) must never
 * execute its action again: every later delivery observes the terminal
 * `permanently_failed` outcome and is acknowledged (200) without execution.
 * Retryable failed rows keep the ADR-0027 redelivery semantics.
 *
 * Reclaim is a single guarded UPDATE — exactly one concurrent caller wins
 * (`changes > 0`); losers re-read the row and resolve against the winner's
 * new state. All statements are parameterized; no payload data is stored
 * (the schema stores only update_id, timestamps, status word, lease deadline,
 * failure class, and attempt counter — migration 0002; ADR-0025).
 *
 * Observability: failures are logged by callers with stable codes; this
 * module never logs SQL text, parameters, or rows (ADR-0022).
 */
import type { DbExecutor } from '../db/db-executor';
import { toDbAppError } from '../db/d1-errors';
import { isAppError } from '../../shared/errors/app-error';

export type TelegramUpdateRowStatus = 'claimed' | 'processed' | 'failed';

/**
 * Persisted failure classification (migration 0002 CHECK constraint;
 * ADR-0031). Retryable failed rows are reclaimable; permanent failed rows
 * are terminal.
 */
export type TelegramUpdateFailureClass = 'retryable' | 'permanent';

/**
 * Claim outcomes. The six states make every delivery's decision explicit:
 * - `claimed`             — this call inserted the row (first delivery);
 *                           `attemptCount` is the owned generation (1).
 * - `reclaimed_retryable` — this call atomically re-claimed a failed
 *                           RETRYABLE row (Telegram redelivery won the race);
 *                           `attemptCount` is the incremented generation.
 * - `reclaimed_stale`     — this call atomically re-claimed a claimed row
 *                           whose lease had EXPIRED (abandoned-claim recovery;
 *                           exactly one concurrent winner); `attemptCount`
 *                           is the incremented generation.
 * - `already_processed`   — terminal success; ack WITHOUT reprocessing;
 * - `permanently_failed`  — terminal failure; ack WITHOUT re-executing the
 *                           action (ever);
 * - `in_flight`           — an ACTIVE unexpired lease is held by another
 *                           delivery. This is NOT a successful duplicate:
 *                           callers must answer safe retryable 503
 *                           semantics, otherwise Telegram could stop
 *                           redelivering before an abandoned claim becomes
 *                           stale (ADR-0030).
 *
 * The three EXECUTION-OWNING outcomes carry `attemptCount` — the claim
 * generation that MUST be passed back to every terminal transition
 * (`markTelegramUpdateProcessed` / `markTelegramUpdateFailed`) as the
 * fencing token. Terminal/no-ownership outcomes carry no generation.
 */
export type TelegramUpdateClaim =
  | { readonly kind: 'claimed'; readonly attemptCount: number }
  | { readonly kind: 'reclaimed_retryable'; readonly attemptCount: number }
  | { readonly kind: 'reclaimed_stale'; readonly attemptCount: number }
  | { readonly kind: 'already_processed' }
  | { readonly kind: 'permanently_failed' }
  | { readonly kind: 'in_flight' };

/**
 * Claim lease duration (ADR-0030) — centralized, documented, conservative.
 *
 * 5 minutes is far above the worst-case bounded webhook processing time
 * (Bot API calls are capped at 10 s each with a single attempt; the body cap
 * and response caps bound everything else), so a LIVE claim is never mistaken
 * for an abandoned one under normal operation. It is also far below any
 * operational recovery horizon: an abandoned claim becomes reclaimable at the
 * next delivery after 5 minutes instead of never. Telegram's own redelivery
 * backoff (seconds-scale at first) redelivers well within the lease for live
 * races — the in-flight 503 keeps Telegram redelivering until the lease
 * resolves.
 */
export const TELEGRAM_UPDATE_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Bounded resolution loop for lost races. A constraint violation or a lost
 * reclaim is re-resolved by reading the winner's state; a healthy schema
 * stabilizes after one iteration. The bound exists so a pathological
 * (impossible on a healthy schema) livelock fails loud instead of hanging.
 */
const CLAIM_RESOLUTION_MAX_ATTEMPTS = 4;

/**
 * Row shape read during claim resolution (migration 0002 columns included).
 * `attempt_count` is the generation observed at read time — the reclaim
 * UPDATEs are guarded by it so a concurrent generation change can never be
 * overwritten (final correction round v1.2.3).
 */
interface ClaimRow {
  readonly status: string;
  readonly claim_expires_at: number | null;
  readonly failure_class: string | null;
  readonly attempt_count: number;
}

/**
 * Attempt to durably claim an update by update_id.
 *
 * A new claim writes a FULL lease state: `status = 'claimed'`,
 * `claim_expires_at = now + TELEGRAM_UPDATE_CLAIM_LEASE_MS`,
 * `failure_class = NULL`, `attempt_count = 1` (generation 1).
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
      sql: `INSERT INTO telegram_updates
              (update_id, received_at, status, claim_expires_at, failure_class, attempt_count)
            VALUES (?, ?, 'claimed', ?, NULL, 1)`,
      params: [updateId, receivedAtMs, receivedAtMs + TELEGRAM_UPDATE_CLAIM_LEASE_MS],
    });
    return { kind: 'claimed', attemptCount: 1 };
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
    const row = await executor.first<ClaimRow>({
      sql: `SELECT status, claim_expires_at, failure_class, attempt_count
            FROM telegram_updates WHERE update_id = ?`,
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

    if (row.status === 'failed') {
      if (row.failure_class === 'permanent') {
        // TERMINAL (ADR-0031): a permanent failure must never execute its
        // action again. Every later delivery observes this outcome and
        // acknowledges (200) without execution.
        return { kind: 'permanently_failed' };
      }
      // Retryable — or a hypothetical unmigrated row with no class (only
      // possible outside the migration contract); both fail safe toward
      // redelivery (ADR-0027/0031). Atomic reclaim — the guarded UPDATE
      // admits EXACTLY ONE winner; a concurrent loser observes changes === 0
      // and re-reads the row (the winner's fresh `claimed` lease resolves as
      // in_flight on the next pass). The previously observed generation is
      // part of the guard: if another caller changed the generation between
      // this read and this write, the fenced UPDATE matches zero rows.
      const reclaimFailed = await executor.run({
        sql: `UPDATE telegram_updates
              SET status = 'claimed', received_at = ?, processed_at = NULL,
                  claim_expires_at = ?, failure_class = NULL, attempt_count = attempt_count + 1
              WHERE update_id = ?
                AND status = 'failed'
                AND attempt_count = ?
                AND (failure_class = 'retryable' OR failure_class IS NULL)`,
        params: [
          receivedAtMs,
          receivedAtMs + TELEGRAM_UPDATE_CLAIM_LEASE_MS,
          updateId,
          row.attempt_count,
        ],
      });
      if (reclaimFailed.changes > 0) {
        // Exactly one generation transition won: this call now owns the
        // incremented generation.
        return { kind: 'reclaimed_retryable', attemptCount: row.attempt_count + 1 };
      }
      continue;
    }

    // row.status === 'claimed': honor the lease (ADR-0030).
    // An ACTIVE unexpired lease means another delivery owns the update right
    // now — explicitly NOT a successful duplicate (callers answer 503).
    // An EXPIRED lease (or a NULL lease, i.e. an abandoned claim written
    // before migration 0002) is recoverable: the guarded UPDATE admits
    // EXACTLY ONE stale-claim reclaim winner, fenced by the observed
    // generation.
    if (row.claim_expires_at !== null && row.claim_expires_at > receivedAtMs) {
      return { kind: 'in_flight' };
    }
    const reclaimStale = await executor.run({
      sql: `UPDATE telegram_updates
            SET status = 'claimed', received_at = ?, processed_at = NULL,
                claim_expires_at = ?, failure_class = NULL, attempt_count = attempt_count + 1
            WHERE update_id = ?
              AND status = 'claimed'
              AND attempt_count = ?
              AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      params: [
        receivedAtMs,
        receivedAtMs + TELEGRAM_UPDATE_CLAIM_LEASE_MS,
        updateId,
        row.attempt_count,
        receivedAtMs,
      ],
    });
    if (reclaimStale.changes > 0) {
      // Exactly one generation transition won: this call now owns the
      // incremented generation.
      return { kind: 'reclaimed_stale', attemptCount: row.attempt_count + 1 };
    }
    // Lost the stale-claim race: the winner now holds a FRESH lease and the
    // NEXT generation; the next read pass observes it as in_flight.
  }
  throw toDbAppError(new Error('telegram_updates claim state did not stabilize'));
}

/**
 * Transition a claimed update to `processed` — TERMINAL, FENCED by the
 * claim generation. `expectedAttemptCount` is the generation returned by the
 * execution-owning claim outcome; the UPDATE matches only the row this
 * generation actually owns:
 *
 *   WHERE update_id = ? AND status = 'claimed' AND attempt_count = ?
 *
 * A STALE owner (its lease expired and a newer generation reclaimed the row)
 * always receives `false` and can never mutate the newer owner's claim.
 * The lease and any failure class are cleared on success: a processed row
 * carries no recoverable state. Returns true when this call performed the
 * transition, false when the row is missing, no longer `claimed`, or owned
 * by a newer generation (never overwrites a terminal state).
 */
export async function markTelegramUpdateProcessed(
  executor: DbExecutor,
  updateId: number,
  expectedAttemptCount: number,
  processedAtMs: number,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE telegram_updates
          SET status = 'processed', processed_at = ?, claim_expires_at = NULL, failure_class = NULL
          WHERE update_id = ? AND status = 'claimed' AND attempt_count = ?`,
    params: [processedAtMs, updateId, expectedAttemptCount],
  });
  return result.changes > 0;
}

/**
 * Transition a claimed update to `failed`, persisting the failure class
 * (ADR-0031) and CLEARING the claim lease — FENCED by the claim generation
 * (`expectedAttemptCount`; see markTelegramUpdateProcessed):
 * - `retryable`  — the row remains reclaimable by a later redelivery
 *                  (reclaimed_retryable; ADR-0027); the caller propagates
 *                  HTTP 503 semantics so Telegram redelivers.
 * - `permanent`  — the row is TERMINAL: reclaim is impossible (the guarded
 *                  reclaim only matches retryable rows); every later delivery
 *                  observes `permanently_failed` and acknowledges without
 *                  executing (ADR-0031); the caller answers 200 to avoid an
 *                  infinite retry loop.
 * A stale owner always receives `false` and can never mark a newer
 * generation's claim failed. A transient internal failure is therefore never
 * falsely marked processed: failed is recorded only after the processing
 * attempt actually threw. If THIS marking itself fails, the row stays
 * `claimed` with a lease — after lease expiry a later delivery reclaims it
 * (`reclaimed_stale`), so the update is still recoverable (ADR-0030).
 */
export async function markTelegramUpdateFailed(
  executor: DbExecutor,
  updateId: number,
  expectedAttemptCount: number,
  failedAtMs: number,
  failureClass: TelegramUpdateFailureClass,
): Promise<boolean> {
  const result = await executor.run({
    sql: `UPDATE telegram_updates
          SET status = 'failed', processed_at = ?, failure_class = ?, claim_expires_at = NULL
          WHERE update_id = ? AND status = 'claimed' AND attempt_count = ?`,
    params: [failedAtMs, failureClass, updateId, expectedAttemptCount],
  });
  return result.changes > 0;
}

function isRowStatus(value: string): value is TelegramUpdateRowStatus {
  return value === 'claimed' || value === 'processed' || value === 'failed';
}
