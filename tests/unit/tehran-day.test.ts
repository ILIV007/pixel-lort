import { describe, expect, it } from 'vitest';
import { tehranBudgetDay, TEHRAN_OFFSET_MINUTES } from '../../src/shared/time/tehran-day';

/**
 * Budget-day helper (Phase 4 — ADR-0038 §6): Asia/Tehran fixed UTC+03:30
 * (no DST since 2022), day-boundary correctness.
 */

describe('tehranBudgetDay', () => {
  it('maps UTC times to the Tehran calendar date', () => {
    // 2025-10-06T12:00:00Z → Tehran 15:30 same day.
    expect(tehranBudgetDay(Date.UTC(2025, 9, 6, 12, 0, 0))).toBe('2025-10-06');
    // 2025-10-06T20:29:00Z → Tehran 23:59 same day.
    expect(tehranBudgetDay(Date.UTC(2025, 9, 6, 20, 29, 0))).toBe('2025-10-06');
    // 2025-10-06T20:30:00Z → Tehran 00:00 NEXT day (midnight boundary).
    expect(tehranBudgetDay(Date.UTC(2025, 9, 6, 20, 30, 0))).toBe('2025-10-07');
    // 2025-10-06T20:31:00Z → Tehran 00:01 next day.
    expect(tehranBudgetDay(Date.UTC(2025, 9, 6, 20, 31, 0))).toBe('2025-10-07');
  });

  it('rolls across month and year boundaries', () => {
    expect(tehranBudgetDay(Date.UTC(2025, 2, 31, 21, 0, 0))).toBe('2025-04-01');
    expect(tehranBudgetDay(Date.UTC(2024, 11, 31, 21, 0, 0))).toBe('2025-01-01');
    expect(tehranBudgetDay(Date.UTC(2025, 0, 1, 0, 0, 0))).toBe('2025-01-01');
  });

  it('uses the fixed offset with no DST shift', () => {
    expect(TEHRAN_OFFSET_MINUTES).toBe(210);
    // Summer and winter dates share the same offset (Iran abolished DST):
    // 20:29 UTC + 3:30 = 23:59 SAME calendar day, in both seasons.
    expect(tehranBudgetDay(Date.UTC(2025, 5, 15, 20, 29, 0))).toBe('2025-06-15');
    expect(tehranBudgetDay(Date.UTC(2025, 11, 15, 20, 29, 0))).toBe('2025-12-15');
    // And 20:30 UTC + 3:30 crosses Tehran midnight in both seasons.
    expect(tehranBudgetDay(Date.UTC(2025, 5, 15, 20, 30, 0))).toBe('2025-06-16');
    expect(tehranBudgetDay(Date.UTC(2025, 11, 15, 20, 30, 0))).toBe('2025-12-16');
  });

  it('produces zero-epoch as 1970-01-01 (03:30 Tehran)', () => {
    expect(tehranBudgetDay(0)).toBe('1970-01-01');
  });
});
