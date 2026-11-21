/**
 * AI circuit breaker (ai-policy-v2.2 follow-up — owner-ordered guard).
 *
 * Workers are stateless, so the breaker lives in the EXISTING D1
 * `settings` table (migration 0001, unchanged) under key
 * `ai.circuit_breaker` — no migration: the key is just one more
 * settings row, exactly like the `soul.current_version` pointer
 * (src/adapters/db/soul-store.ts). value_json holds
 * `{ state, consecutive_failures, opened_at_ms, updated_at_ms }`;
 * the `updated_at` column carries the same timestamp.
 *
 * Behavior:
 * - CLOSED: provider calls proceed; each consecutive provider failure
 *   (transient / model_unavailable / deadline_exceeded — the failure
 *   classes the draft/rewriter services observe) increments the
 *   counter. At AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD (5) the breaker
 *   OPENS. Quota denials, auth failures, safety refusals and invalid
 *   output are NOT provider failures and never move the counter; a
 *   provider answer (success) resets it.
 * - OPEN: the draft/rewriter services skip provider calls AND skip
 *   charging, returning the typed deferred `circuit_open` (retryable
 *   later — the prepare-draft handler maps it onto its bounded retry,
 *   never terminal, never a negative-cache write).
 * - After AI_CIRCUIT_BREAKER_COOLDOWN_MS (15 min) the breaker goes
 *   HALF-OPEN and admits a single probe attempt: probe success closes
 *   it, probe failure re-opens it with a fresh cooldown.
 *
 * Honest limitations (best-effort, by design):
 * - State transitions are read-modify-write on one settings row: two
 *   concurrent invocations can read the same counter and lose one
 *   increment (opening is delayed by at most one failure), and two
 *   concurrent invocations can both observe half-open and both probe.
 *   The blast radius stays bounded — a failed probe re-opens
 *   immediately — but exactly-once probing is NOT claimed.
 * - Every function here THROWS on a D1 error. Callers treat a failed
 *   CHECK as fail-open (closed: the provider path still has its own
 *   budget/deadline guards) and swallow failed RECORDS with a warn —
 *   breaker bookkeeping must never fail a run.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';

/** Settings-table key carrying the breaker state. */
export const AI_CIRCUIT_BREAKER_SETTINGS_KEY = 'ai.circuit_breaker';

/** Consecutive provider failures that OPEN the breaker. */
export const AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

/** Cooldown before an open breaker admits a half-open probe. */
export const AI_CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

export type AiCircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface AiCircuitBreakerSnapshot {
  readonly state: AiCircuitBreakerState;
  readonly consecutiveFailures: number;
  /** ms epoch when the breaker OPENED (null unless open/half-open). */
  readonly openedAtMs: number | null;
  readonly updatedAtMs: number;
}

export interface AiCircuitBreakerCheck {
  /** False only while OPEN inside its cooldown (skip calls + charges). */
  readonly allow: boolean;
  /** True when the allowed call is the half-open probe. */
  readonly probe: boolean;
  readonly snapshot: AiCircuitBreakerSnapshot;
}

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function closedSnapshot(nowMs: number): AiCircuitBreakerSnapshot {
  return { state: 'closed', consecutiveFailures: 0, openedAtMs: null, updatedAtMs: nowMs };
}

/**
 * Parse a stored value_json into a snapshot. A missing row, malformed
 * JSON, or any shape violation resolves to CLOSED (fail-open): a corrupt
 * breaker row must never block the provider path — the next record
 * overwrites it with a valid snapshot.
 */
function parseSnapshot(valueJson: string, nowMs: number): AiCircuitBreakerSnapshot {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return closedSnapshot(nowMs);
    }
    const record = parsed as Record<string, unknown>;
    const state = record['state'];
    if (state !== 'closed' && state !== 'open' && state !== 'half_open') {
      return closedSnapshot(nowMs);
    }
    if (!isValidCount(record['consecutive_failures'])) {
      return closedSnapshot(nowMs);
    }
    const openedAtMs = record['opened_at_ms'];
    if (openedAtMs !== null && !isValidTimestamp(openedAtMs)) {
      return closedSnapshot(nowMs);
    }
    if ((state === 'open' || state === 'half_open') && openedAtMs === null) {
      return closedSnapshot(nowMs);
    }
    if (!isValidTimestamp(record['updated_at_ms'])) {
      return closedSnapshot(nowMs);
    }
    return {
      state,
      consecutiveFailures: record['consecutive_failures'],
      openedAtMs: openedAtMs as number | null,
      updatedAtMs: record['updated_at_ms'] as number,
    };
  } catch {
    return closedSnapshot(nowMs);
  }
}

async function writeSnapshot(
  executor: DbExecutor,
  snapshot: AiCircuitBreakerSnapshot,
  nowMs: number,
): Promise<void> {
  const valueJson = JSON.stringify({
    state: snapshot.state,
    consecutive_failures: snapshot.consecutiveFailures,
    opened_at_ms: snapshot.openedAtMs,
    updated_at_ms: nowMs,
  });
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES (?, ?, 1, NULL, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    params: [AI_CIRCUIT_BREAKER_SETTINGS_KEY, valueJson, nowMs],
  });
}

/**
 * Read the current breaker snapshot. Throws on a D1 error (the caller
 * decides the fail-open policy); a missing/malformed row is CLOSED.
 */
export async function readAiCircuitBreaker(
  executor: DbExecutor,
  nowMs: number,
): Promise<AiCircuitBreakerSnapshot> {
  const row = await executor.first<{ value_json: string }>({
    sql: 'SELECT value_json FROM settings WHERE key = ?',
    params: [AI_CIRCUIT_BREAKER_SETTINGS_KEY],
  });
  if (row === null) {
    return closedSnapshot(nowMs);
  }
  return parseSnapshot(row.value_json, nowMs);
}

/**
 * Decide whether a provider call may start. An OPEN breaker past its
 * cooldown transitions to HALF-OPEN (one durable write) and admits the
 * probe; an OPEN breaker inside its cooldown denies. Throws on a D1
 * error — callers fail open (allow) so a settings outage never blocks
 * the provider path by itself.
 */
export async function checkAiCircuitBreaker(
  executor: DbExecutor,
  nowMs: number,
): Promise<AiCircuitBreakerCheck> {
  const snapshot = await readAiCircuitBreaker(executor, nowMs);
  if (snapshot.state === 'closed') {
    return { allow: true, probe: false, snapshot };
  }
  if (snapshot.state === 'half_open') {
    return { allow: true, probe: true, snapshot };
  }
  if (
    snapshot.openedAtMs !== null &&
    nowMs - snapshot.openedAtMs >= AI_CIRCUIT_BREAKER_COOLDOWN_MS
  ) {
    const halfOpen: AiCircuitBreakerSnapshot = {
      state: 'half_open',
      consecutiveFailures: snapshot.consecutiveFailures,
      openedAtMs: snapshot.openedAtMs,
      updatedAtMs: nowMs,
    };
    await writeSnapshot(executor, halfOpen, nowMs);
    return { allow: true, probe: true, snapshot: halfOpen };
  }
  return { allow: false, probe: false, snapshot };
}

/**
 * Record ONE consecutive provider failure. A half-open probe failure
 * re-opens immediately with a fresh cooldown; otherwise the counter
 * grows and opens the breaker at the threshold. Throws on a D1 error —
 * callers swallow it (best-effort bookkeeping).
 */
export async function recordAiCircuitBreakerFailure(
  executor: DbExecutor,
  nowMs: number,
): Promise<AiCircuitBreakerSnapshot> {
  const current = await readAiCircuitBreaker(executor, nowMs);
  const failures = current.consecutiveFailures + 1;
  const next: AiCircuitBreakerSnapshot =
    current.state === 'half_open' || failures >= AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD
      ? { state: 'open', consecutiveFailures: failures, openedAtMs: nowMs, updatedAtMs: nowMs }
      : {
          state: 'closed',
          consecutiveFailures: failures,
          openedAtMs: null,
          updatedAtMs: nowMs,
        };
  await writeSnapshot(executor, next, nowMs);
  return next;
}

/**
 * Record a provider answer (success): the counter resets and a
 * half-open probe closes the breaker. A closed breaker with a zero
 * counter writes NOTHING (the common path stays a single read).
 * Throws on a D1 error — callers swallow it (best-effort).
 */
export async function recordAiCircuitBreakerSuccess(
  executor: DbExecutor,
  nowMs: number,
): Promise<AiCircuitBreakerSnapshot> {
  const current = await readAiCircuitBreaker(executor, nowMs);
  if (current.state === 'closed' && current.consecutiveFailures === 0) {
    return current;
  }
  const next: AiCircuitBreakerSnapshot = {
    state: 'closed',
    consecutiveFailures: 0,
    openedAtMs: null,
    updatedAtMs: nowMs,
  };
  await writeSnapshot(executor, next, nowMs);
  return next;
}
