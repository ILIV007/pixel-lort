import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from '../../src/shared/time/clock';

describe('fixedClock', () => {
  it('returns a pinned time', () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it('advances by given amounts', () => {
    const clock = fixedClock(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.advance(500);
    expect(clock.now()).toBe(2_000);
  });

  it('jumps to absolute values', () => {
    const clock = fixedClock(1_000);
    clock.setTo(9_999);
    expect(clock.now()).toBe(9_999);
  });
});

describe('systemClock', () => {
  it('tracks the real wall clock within a tolerance window', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
