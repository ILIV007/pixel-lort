/**
 * Retry policy and backoff (Phase 3 — ADR-0036 §4; blueprint §7 "Retry
 * policy"). Pure functions: clock and randomness are injected so tests are
 * deterministic. Workers NEVER sleep — backoff is materialized as a durable
 * `run_after` schedule in D1, not as a delay loop.
 */
import type { JobErrorCode } from './job-types';

/** Full-jitter exponential backoff parameters (ADR-0036 §4). */
export interface BackoffParams {
  /** Base delay for attempt 1 (epoch ms). Default 2s. */
  readonly baseMs: number;
  /** Hard delay cap. Default 1h. */
  readonly capMs: number;
  /**
   * Provider-provided minimum delay (e.g. a Telegram `retry_after` for the
   * future publication phase). When present, the computed delay is raised
   * to this floor BEFORE capping — the floor never exceeds the cap.
   */
  readonly retryAfterFloorMs?: number;
}

export const DEFAULT_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_BACKOFF_CAP_MS = 3_600_000;

/**
 * Deterministic full-jitter backoff: `delay = randint(0, exp)` where
 * `exp = min(cap, base × 2^(attempt−1))`, then raised to the optional
 * `retry_after` floor (bounded by the same cap). Injected `random` returns
 * [0,1); a fixed random yields a fully deterministic schedule for tests.
 */
export function computeBackoffDelayMs(
  attempt: number,
  params: BackoffParams,
  random: () => number,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(params.capMs, params.baseMs * 2 ** Math.min(safeAttempt - 1, 20));
  const floor = Math.min(params.capMs, Math.max(0, params.retryAfterFloorMs ?? 0));
  // Full jitter over [0, exponential]; clamped defensively so an
  // out-of-range random() can never exceed the exponential bound.
  const jittered = Math.min(exponential, Math.floor(random() * (exponential + 1)));
  return Math.min(params.capMs, Math.max(jittered, floor));
}

/** Classification of a handler-reported failure. */
export type HandlerFailureKind = 'retryable' | 'permanent';

/**
 * Retry decision for a failed attempt. `permanent` failures dead-letter
 * immediately (never blindly retried — blueprint §7: auth errors, Telegram
 * 400 semantic errors); `retryable` failures reschedule with backoff until
 * `max_attempts` is exhausted.
 */
export type RetryDecision =
  { readonly kind: 'reschedule'; readonly delayMs: number } | { readonly kind: 'exhausted' };

export function decideRetry(
  kind: HandlerFailureKind,
  errorCode: JobErrorCode,
  ownedGeneration: number,
  maxAttempts: number,
  params: BackoffParams,
  random: () => number,
): RetryDecision {
  if (kind === 'permanent') {
    return { kind: 'exhausted' };
  }
  if (ownedGeneration >= maxAttempts) {
    return { kind: 'exhausted' };
  }
  return {
    kind: 'reschedule',
    delayMs: computeBackoffDelayMs(ownedGeneration, params, random),
  };
}
