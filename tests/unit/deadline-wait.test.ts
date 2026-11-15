import { describe, expect, it } from 'vitest';
import { awaitWithDeadline } from '../../src/shared/time/deadline-wait';

// ---------------------------------------------------------------------------
// Round 1.10.6.1 hotfix — the EXPIRED-deadline path of the deadline-wait
// primitive (reproduced and reported by Posidon before closing the round).
//
// Contract: when the deadline has ALREADY expired at call time
// (remainingMs <= 0), the primitive must return `timed_out` AND still
// attach settlement handlers to the work promise for its whole lifetime —
// exactly as the live-race path does. On the buggy version the expired
// path returned without ever touching the work promise, so:
//   - a work promise that was already rejected at call time (or one that
//     rejects later) surfaced as an unhandled rejection; and
//   - a later settlement had no observer to absorb it.
// In workerd/vitest an unhandled rejection fails the whole test run — that
// is the red signal this file produces against the buggy version. Each
// case therefore flushes real turn boundaries after the settlement and
// asserts the decided result stayed `timed_out` (no resurrection, no new
// work started by the primitive — the absorbed work promise is never
// consumed into a new outcome).
// ---------------------------------------------------------------------------

const NOW = 1_000;
const EXPIRED_DEADLINE_SAME_INSTANT = 1_000; // remainingMs === 0
const EXPIRED_DEADLINE_IN_PAST = 500; // remainingMs < 0

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain microtasks and cross a real macrotask boundary so the runtime has
 * the full opportunity to deliver (or NOT deliver) any unhandled rejection.
 */
async function flushTurns(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('awaitWithDeadline — expired-deadline path (R1.10.6.1 hotfix)', () => {
  it('X1: already-expired deadline + work already rejected — timed_out, no unhandled rejection', async () => {
    const result = await awaitWithDeadline(
      Promise.reject(new Error('rejected before the call')),
      EXPIRED_DEADLINE_SAME_INSTANT,
      NOW,
    );

    expect(result).toEqual({ kind: 'timed_out' });
    await flushTurns();
    // Reaching this line proves the rejection was absorbed: with the buggy
    // version the already-rejected work promise has no handler attached and
    // the runtime fails the whole run with an unhandled rejection. The
    // decided result stays decided.
    expect(result).toEqual({ kind: 'timed_out' });
  });

  it('X2: already-expired deadline + work rejecting LATER — timed_out, no unhandled rejection', async () => {
    const work = createDeferred<never>();
    const result = await awaitWithDeadline(work.promise, EXPIRED_DEADLINE_IN_PAST, NOW);

    expect(result).toEqual({ kind: 'timed_out' });

    work.reject(new Error('late rejection after the expired deadline'));
    await flushTurns();

    // No resurrection, no new work: the decided result is unchanged, and
    // the late rejection was absorbed by the primitive (an unhandled
    // rejection would have failed the run during the flush above).
    expect(result).toEqual({ kind: 'timed_out' });
  });

  it('X3: already-expired deadline + work resolving LATER — timed_out, decided result never changes', async () => {
    const work = createDeferred<string>();
    const pending = awaitWithDeadline(work.promise, EXPIRED_DEADLINE_SAME_INSTANT, NOW);

    const result = await pending;
    expect(result).toEqual({ kind: 'timed_out' });

    work.resolve('late value'); // must NOT resurrect the timed_out decision
    await flushTurns();

    expect(await pending).toEqual({ kind: 'timed_out' });
  });
});
