/**
 * Clock abstraction for deterministic time in tests.
 * The Worker runtime is event-driven; all time reads should go through the
 * clock so tests can pin or advance time without real sleeps.
 */
export interface Clock {
  /** Current time in epoch milliseconds (UTC). */
  now(): number;
}

/** Production clock backed by the runtime's wall clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface MutableClock extends Clock {
  /** Move the clock forward by the given number of milliseconds. */
  advance(milliseconds: number): void;
  /** Jump the clock to an absolute epoch-milliseconds value. */
  setTo(epochMs: number): void;
}

/** Deterministic clock for tests; starts at a fixed epoch value. */
export function fixedClock(startMs: number = 1_700_000_000_000): MutableClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    setTo: (epochMs: number) => {
      current = epochMs;
    },
  };
}
