/**
 * Small deadline-wait primitive (round 1.10.6.1).
 *
 * Bounds ONE pending promise by an ABSOLUTE wall deadline without
 * frameworks, sleeps, or promise semantics beyond a single race:
 *
 * - `completed` — the work settled in time; its value/rejection is the
 *   outcome and the caller handles it.
 * - `timed_out` — the deadline fired first; the caller must NOT start any
 *   new work from the (still pending) work promise.
 *
 * Rejection contract: handlers are attached to the work promise for its
 * WHOLE lifetime — including the already-expired early-return path, where
 * settlement handlers are attached before the `timed_out` result is
 * returned. A rejection arriving after the race settled (deadline won, or
 * the deadline was already expired at call time) is observed and absorbed
 * by this primitive — it can never surface as an unhandled rejection and
 * can never resurrect an already-decided outcome. A rejection arriving
 * while the race is live propagates to the caller unchanged (e.g.
 * budget-store infrastructure failure).
 *
 * Clock contract (round 1.10.6.1): the caller's INJECTED clock owns
 * `nowMs`; production callers pass the same system wall clock the
 * scheduler uses. The injected scheduler decides when the deadline
 * callback actually fires (real setTimeout/clearTimeout by default);
 * deterministic tests inject a manual scheduler and fire it themselves.
 *
 * Documented limitation: if the remaining time exceeds the 32-bit timer
 * range (2_147_483_647 ms), no timer is scheduled and the wait is
 * effectively unbounded. Production callers pass the versioned
 * `AI_BOUNDS.totalWallDeadlineMs` (15 s), far below that range.
 */

/** Schedules the deadline callback; returns a canceller. Injectable for deterministic tests. */
export type DeadlineTimeoutScheduler = (callback: () => void, delayMs: number) => () => void;

/** Production scheduler backed by the runtime's real timers. */
export const realTimeoutScheduler: DeadlineTimeoutScheduler = (callback, delayMs) => {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
};

export type DeadlineWaitResult<T> =
  { readonly kind: 'completed'; readonly value: T } | { readonly kind: 'timed_out' };

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function awaitWithDeadline<T>(
  work: Promise<T>,
  deadlineAtMs: number,
  nowMs: number,
  options: { readonly scheduleTimeout?: DeadlineTimeoutScheduler } = {},
): Promise<DeadlineWaitResult<T>> {
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs <= 0) {
    // Already expired: the result is `timed_out` and the caller must not
    // start new work from the work promise. The rejection contract still
    // holds in this path: settlement handlers are attached HERE (covering
    // the already-settled case too) so an immediate or later rejection is
    // observed and absorbed — never unhandled, never resurrecting the
    // decided outcome.
    void work.then(
      () => undefined,
      () => undefined,
    );
    return Promise.resolve({ kind: 'timed_out' as const });
  }
  const schedule = options.scheduleTimeout ?? realTimeoutScheduler;
  return new Promise<DeadlineWaitResult<T>>((resolve, reject) => {
    let settled = false;
    let cancelTimeout: (() => void) | undefined;
    const finish = (settle: () => void): void => {
      if (settled) {
        // The race already decided: late settlements of the work promise
        // are observed (handlers stay attached) and absorbed — no unhandled
        // rejection, no resurrection.
        return;
      }
      settled = true;
      if (cancelTimeout !== undefined) {
        cancelTimeout();
      }
      settle();
    };
    if (remainingMs < MAX_TIMER_DELAY_MS) {
      cancelTimeout = schedule(() => finish(() => resolve({ kind: 'timed_out' })), remainingMs);
    }
    void work.then(
      (value) => finish(() => resolve({ kind: 'completed', value })),
      (reason) => finish(() => reject(reason)),
    );
  });
}
