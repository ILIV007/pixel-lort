/**
 * ROUND 1.5 DESIGN LAB — disabled-by-policy pause (PROPOSED DESIGN,
 * executable proof material). NOT part of the shipped worker: nothing under
 * `src/` imports this module. It exists so the §B pause policy can be PROVEN
 * on real workerd D1 (tests/integration/round15-design-pause.test.ts).
 *
 * Design authority: `review/design/PIXEL_ROUND1_5_OWNERSHIP_PAUSE_DESIGN.md`
 * §5, which finalizes §B of the Round 1.2 corrected design. The pause design
 * is DDL-INDEPENDENT: it requires NO schema change and works on the CURRENT
 * schema 3 (proven by the lab, which runs these proofs on migrations
 * 0001–0003 only).
 *
 * Failure-class taxonomy (instruction 5 of the Round 1.5 letter):
 *   unknown type        — no payload schema, no handler: poison →
 *                         `dead_letter` / `job_type_unregistered` (accepted
 *                         shipped behavior, UNCHANGED, fail loud).
 *   misconfiguration    — schema-known, handler missing in THIS deployment,
 *                         and NOT paused by policy: a wiring/packaging bug —
 *                         pre-claim poison → `dead_letter` /
 *                         `handler_misconfigured` (DISTINCT code, visible,
 *                         alerting; never a silent pause).
 *   disabled-by-policy  — listed in the explicit enablement registry AND its
 *                         gate is off: EXPECTED operation. Pre-claim pause:
 *                         dispatch-side the type is EXCLUDED from the
 *                         candidate scans IN SQL (no send, no status write,
 *                         zero scan-slot cost — dispatch fairness); consume-
 *                         side a delivered message is acknowledged
 *                         `paused_by_policy` BEFORE the claim (no attempt
 *                         burn, no poison, no DLQ, no rewind). The durable
 *                         row simply stays pending; when the gate returns
 *                         ON, the very next dispatch pass resumes it
 *                         (bounded resumption ≤ 1 cron interval).
 *   cancellation        — an explicit owner action (guarded `cancelled`
 *                         transition). Consumers ack `cancelled`; the DLQ
 *                         reconciliation scan selects ONLY
 *                         `status='dead_letter'`, so a cancelled job is
 *                         NEVER silently dead-lettered (instruction 5).
 *
 * Attempt economics: the pause happens BEFORE the atomic claim, so
 * `attempts` never moves while a gate is off; a near-exhausted row
 * (`attempts = max_attempts - 1`) can NEVER be dead-lettered by pauses.
 */
import type { DbExecutor } from '../../src/adapters/db/db-executor';
import { PAYLOAD_SCHEMAS } from '../../src/domain/jobs/payloads';
import type { JobHandlerRegistry } from '../../src/domain/jobs/handler';

/**
 * Explicit enablement registry (code-defined, reviewed) — §B.1 of the
 * Round 1.2 corrected design. `PAYLOAD_SCHEMAS` membership alone confers
 * NOTHING: a type is disabled-by-policy ONLY if it is listed here AND its
 * gate is off.
 */
export type PolicyGateName = 'ingestion_gate';

export interface PolicyGateState {
  /** The Phase 4 `SOURCE_INGESTION_ENABLED` flag (validated upstream). */
  readonly ingestionGateOn: boolean;
}

export interface JobEnablementEntry {
  readonly gate: PolicyGateName;
  /** Stable safe reason persisted nowhere by the pause itself (design note). */
  readonly pausedOutcome: 'paused_by_policy';
}

export const JOB_ENABLEMENT_POLICY: ReadonlyMap<string, JobEnablementEntry> = new Map([
  ['sources.fetch_poll', { gate: 'ingestion_gate', pausedOutcome: 'paused_by_policy' }],
]);

/**
 * Proposed NEW stable error code for the misconfiguration class (design
 * material; extending `JOB_ERROR_CODES` is part of the later authorized
 * implementation round). Matches `JOB_ERROR_CODE_PATTERN`.
 */
export const DESIGN_CODE_HANDLER_MISCONFIGURED = 'handler_misconfigured';

/** Proposed stable code persisted by the C.3 remediation cancellation. */
export const DESIGN_CODE_JOB_CANCELLED_SUPERSEDED = 'job_cancelled_superseded';

/** Disabled-by-policy test: listed in the registry AND its gate is off. */
export function isPausedByPolicy(jobType: string, gates: PolicyGateState): boolean {
  const entry = JOB_ENABLEMENT_POLICY.get(jobType);
  if (entry === undefined) {
    return false;
  }
  return entry.gate === 'ingestion_gate' && !gates.ingestionGateOn;
}

/**
 * Misconfiguration test: the payload schema is registered, the handler is
 * NOT, and the type is not currently paused by policy. Policy precedence:
 * the pause decision comes FIRST (a paused type with a missing handler is
 * expected gate-off operation, never an alert).
 */
export function isHandlerMisconfigured(
  jobType: string,
  handlers: JobHandlerRegistry,
  gates: PolicyGateState,
): boolean {
  if (!PAYLOAD_SCHEMAS.has(jobType)) {
    return false; // unknown type — the poison class owns it
  }
  if (isPausedByPolicy(jobType, gates)) {
    return false; // disabled-by-policy — expected operation
  }
  return handlers.get(jobType) === undefined;
}

/** The types currently excluded from dispatch scans (bounded, code-defined). */
export function policyExcludedTypes(gates: PolicyGateState): readonly string[] {
  const excluded: string[] = [];
  for (const [type, entry] of JOB_ENABLEMENT_POLICY.entries()) {
    if (entry.gate === 'ingestion_gate' && !gates.ingestionGateOn) {
      excluded.push(type);
    }
  }
  return excluded;
}

/**
 * DISPATCH-SIDE PAUSE (design): the due scan EXCLUDES policy-paused types
 * IN SQL, so paused rows consume ZERO scan slots (dispatch fairness — a
 * page full of paused rows can never starve other types) and are never
 * sent to the queue. Same ordering/bounds as the accepted `scanDueJobs`.
 */
export async function scanDueJobsPolicyFiltered(
  executor: DbExecutor,
  nowMs: number,
  limit: number,
  excludedTypes: readonly string[],
): Promise<readonly { id: string; type: string; attempts: number }[]> {
  if (excludedTypes.length === 0) {
    const result = await executor.query<{ id: string; type: string; attempts: number }>({
      sql: `SELECT id, type, attempts FROM jobs
             WHERE status IN ('pending', 'retry_wait') AND run_after <= ?
             ORDER BY run_after ASC, priority DESC, id ASC
             LIMIT ?`,
      params: [nowMs, limit],
    });
    return result.rows;
  }
  const placeholders = excludedTypes.map(() => '?').join(', ');
  const result = await executor.query<{ id: string; type: string; attempts: number }>({
    sql: `SELECT id, type, attempts FROM jobs
           WHERE status IN ('pending', 'retry_wait') AND run_after <= ?
             AND type NOT IN (${placeholders})
           ORDER BY run_after ASC, priority DESC, id ASC
           LIMIT ?`,
    params: [nowMs, ...excludedTypes, limit],
  });
  return result.rows;
}

/**
 * DISPATCH-SIDE PAUSE for stranded `queued` rows: same SQL exclusion, same
 * grace-window semantics as the accepted `scanStrandedQueuedJobs`.
 */
export async function scanStrandedQueuedJobsPolicyFiltered(
  executor: DbExecutor,
  graceCutoffMs: number,
  limit: number,
  excludedTypes: readonly string[],
): Promise<readonly { id: string; type: string; attempts: number }[]> {
  if (excludedTypes.length === 0) {
    const result = await executor.query<{ id: string; type: string; attempts: number }>({
      sql: `SELECT id, type, attempts FROM jobs
             WHERE status = 'queued' AND updated_at <= ?
             ORDER BY run_after ASC, priority DESC, id ASC
             LIMIT ?`,
      params: [graceCutoffMs, limit],
    });
    return result.rows;
  }
  const placeholders = excludedTypes.map(() => '?').join(', ');
  const result = await executor.query<{ id: string; type: string; attempts: number }>({
    sql: `SELECT id, type, attempts FROM jobs
           WHERE status = 'queued' AND updated_at <= ?
             AND type NOT IN (${placeholders})
           ORDER BY run_after ASC, priority DESC, id ASC
           LIMIT ?`,
    params: [graceCutoffMs, ...excludedTypes, limit],
  });
  return result.rows;
}

/**
 * Bounded observability counter for the dispatch summary: how many
 * policy-paused rows are currently due (never dispatched, never modified).
 */
export async function countPolicyPausedDue(
  executor: DbExecutor,
  nowMs: number,
  excludedTypes: readonly string[],
): Promise<number> {
  if (excludedTypes.length === 0) {
    return 0;
  }
  const placeholders = excludedTypes.map(() => '?').join(', ');
  const row = await executor.first<{ n: number }>({
    sql: `SELECT COUNT(*) AS n FROM jobs
           WHERE status IN ('pending', 'retry_wait') AND run_after <= ?
             AND type IN (${placeholders})`,
    params: [nowMs, ...excludedTypes],
  });
  return row?.n ?? 0;
}

/**
 * ROUND 1.5.1 (B2) — POLICY-AWARE EXPIRED-CLAIM RECOVERY.
 *
 * The accepted `reclaimExpiredClaims` (src/adapters/db/job-store.ts) selects
 * expired claimed rows with NO type filter and then mutates each one — so
 * during a gate-OFF cycle a paused type's expired claim was (a) DEAD-LETTERED
 * when its attempt budget was spent (counterexample CE2: the policy did not
 * precede exhaustion handling in the recovery path) and (b) consuming the
 * bounded recovery page ahead of enabled work (counterexample CE3:
 * head-of-line delay). This design function resolves the policy BEFORE
 * selecting or mutating any recovery candidate:
 *
 *   - ACTIVE PAGE: expired claimed rows whose type is NOT policy-excluded,
 *     selected IN SQL with `type NOT IN (...)` — a paused row can NEVER
 *     consume an active recovery scan slot, exactly mirroring the
 *     dispatch-side fairness rule (`scanDueJobsPolicyFiltered`). Ordering and
 *     limit match the accepted scan (`lease_until ASC, id ASC`, bounded).
 *   - PAUSED OBSERVABILITY: one bounded aggregate COUNT of expired claimed
 *     paused-type rows — reported, never mutated, never part of the active
 *     page (zero paused-slot recovery budget, honestly observable).
 *   - MUTATIONS: per-row guarded transitions byte-identical in shape to the
 *     accepted ones (ADR-0037): budget spent → `dead_letter` /
 *     `job_exhausted`; budget intact → `queued`. Every UPDATE re-checks
 *     `status='claimed' AND lease_until IS NOT NULL AND lease_until <= now`
 *     plus the attempts guard, so a concurrent claim or a terminal
 *     transition between SELECT and UPDATE can never corrupt a row.
 *
 * Attempt economics (unchanged from the accepted semantics, proven anew):
 *   - recovery NEVER writes `attempts` (they count execution generations,
 *     not recoveries); an exhausted state is preserved, never reset;
 *   - paused rows are LEFT EXACTLY AS THEY ARE during OFF — claimed with an
 *     expired lease (dormant). Their attempts and last_error stay intact.
 *     No terminal row is ever touched (guarded WHERE), so nothing is
 *     resurrected;
 *   - when the gate returns ON the paused rows stop being excluded and the
 *     ordinary recovery economics apply: budget-intact rows requeue and
 *     resume; a genuinely exhausted row (attempts >= max, all spent BEFORE
 *     or while the gate was on) dead-letters AT the recovery boundary
 *     exactly once — the crashed generation is never re-executed.
 *   - unknown / misconfigured types are NOT policy-excluded (the registry
 *     cannot pause what it does not map; misconfiguration is visible by
 *     definition), so they flow through the ordinary recovery transitions
 *     and the ordinary dispatch-side poison classes — never silently
 *     deferred by the pause.
 */
export interface DesignReclaimResult {
  /** Budget-intact expired claims moved back to `queued` (active page). */
  readonly reclaimed: number;
  /** Budget-spent expired claims dead-lettered AT the boundary (active page). */
  readonly exhaustedToDeadLetter: number;
  /**
   * Expired claimed rows of PAUSED types observed by the bounded aggregate —
   * deliberately NOT selected, NOT mutated, NOT counted against the active
   * page. Observability only.
   */
  readonly pausedExpiredObserved: number;
}

export async function reclaimExpiredClaimsPolicyAware(
  executor: DbExecutor,
  nowMs: number,
  limit: number,
  excludedTypes: readonly string[],
): Promise<DesignReclaimResult> {
  const placeholders = excludedTypes.map(() => '?').join(', ');

  // 1. OBSERVABILITY FIRST: count paused-type expired claims (bounded
  //    aggregate, no mutation, not part of the active page). The policy is
  //    therefore resolved BEFORE any recovery candidate is selected.
  let pausedExpiredObserved = 0;
  if (excludedTypes.length > 0) {
    const paused = await executor.first<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM jobs
             WHERE status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?
               AND type IN (${placeholders})`,
      params: [nowMs, ...excludedTypes],
    });
    pausedExpiredObserved = paused?.n ?? 0;
  }

  // 2. ACTIVE PAGE: eligible rows only — paused types CANNOT consume slots.
  const expired =
    excludedTypes.length === 0
      ? await executor.query<Pick<DesignJobRow, 'id' | 'attempts' | 'max_attempts'>>({
          sql: `SELECT id, attempts, max_attempts FROM jobs
              WHERE status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?
              ORDER BY lease_until ASC, id ASC
              LIMIT ?`,
          params: [nowMs, limit],
        })
      : await executor.query<Pick<DesignJobRow, 'id' | 'attempts' | 'max_attempts'>>({
          sql: `SELECT id, attempts, max_attempts FROM jobs
              WHERE status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?
                AND type NOT IN (${placeholders})
              ORDER BY lease_until ASC, id ASC
              LIMIT ?`,
          params: [nowMs, ...excludedTypes, limit],
        });

  // 3. GUARDED MUTATIONS — same two mutually exclusive transitions as the
  //    accepted recovery (ADR-0037), byte-identical guard shape. Attempts
  //    are never written; terminal rows are unreachable (status guard).
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
  return { reclaimed, exhaustedToDeadLetter, pausedExpiredObserved };
}

/** Minimal row shape used by the design recovery selection. */
interface DesignJobRow {
  id: string;
  attempts: number;
  max_attempts: number;
}
