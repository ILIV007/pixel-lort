import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_PIN_P0_ENABLED,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_ENABLED,
  FREE_GAME_RETENTION_DAYS,
  defaultRetentionRule,
  isPostExpired,
  isValidRetentionDays,
} from '../../src/domain/publishing/post-management';

/**
 * Slice 6 — the pure retention/expiry rules (DESIGN §10.7). A free-game
 * announcement expires after 7 days, a general post after 90; a disabled
 * rule expires nothing; the day bound is 1..365.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describe('post-management retention rules', () => {
  it('pins the defaults (retention ON, 90d general, 7d free-game, auto-pin OFF)', () => {
    expect(defaultRetentionRule()).toEqual({
      enabled: true,
      defaultDays: 90,
      freeGameDays: 7,
    });
    expect(DEFAULT_RETENTION_ENABLED).toBe(true);
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(FREE_GAME_RETENTION_DAYS).toBe(7);
    expect(DEFAULT_AUTO_PIN_P0_ENABLED).toBe(false);
  });

  it('a free-game announcement expires after 7 days', () => {
    const rule = defaultRetentionRule();
    const publishedAtMs = 1_000_000;
    expect(
      isPostExpired({
        rule,
        category: 'free_game',
        publishedAtMs,
        nowMs: publishedAtMs + 6 * DAY_MS,
      }),
    ).toBe(false);
    expect(
      isPostExpired({
        rule,
        category: 'free_game',
        publishedAtMs,
        nowMs: publishedAtMs + 7 * DAY_MS,
      }),
    ).toBe(true);
    expect(
      isPostExpired({
        rule,
        category: 'free_game',
        publishedAtMs,
        nowMs: publishedAtMs + 8 * DAY_MS,
      }),
    ).toBe(true);
  });

  it('a general post expires after 90 days, not 7', () => {
    const rule = defaultRetentionRule();
    const publishedAtMs = 1_000_000;
    expect(
      isPostExpired({ rule, category: 'news', publishedAtMs, nowMs: publishedAtMs + 7 * DAY_MS }),
    ).toBe(false);
    expect(
      isPostExpired({ rule, category: 'news', publishedAtMs, nowMs: publishedAtMs + 89 * DAY_MS }),
    ).toBe(false);
    expect(
      isPostExpired({ rule, category: 'news', publishedAtMs, nowMs: publishedAtMs + 90 * DAY_MS }),
    ).toBe(true);
  });

  it('an unknown category uses the default rule', () => {
    const rule = defaultRetentionRule();
    const publishedAtMs = 1_000_000;
    expect(
      isPostExpired({
        rule,
        category: 'something_new',
        publishedAtMs,
        nowMs: publishedAtMs + 90 * DAY_MS,
      }),
    ).toBe(true);
  });

  it('a disabled rule never expires anything', () => {
    const rule = { ...defaultRetentionRule(), enabled: false };
    expect(
      isPostExpired({ rule, category: 'free_game', publishedAtMs: 0, nowMs: 365 * DAY_MS }),
    ).toBe(false);
  });

  it('the retention-day bound is 1..365', () => {
    expect(isValidRetentionDays(1)).toBe(true);
    expect(isValidRetentionDays(365)).toBe(true);
    expect(isValidRetentionDays(0)).toBe(false);
    expect(isValidRetentionDays(366)).toBe(false);
    expect(isValidRetentionDays(1.5)).toBe(false);
    expect(isValidRetentionDays(Number.NaN)).toBe(false);
  });
});
