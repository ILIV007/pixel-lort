import { describe, expect, it } from 'vitest';
import {
  anchorDueWithin,
  isAnchorSlotInActiveWindow,
  nextAnchorOccurrence,
  WEEKLY_ANCHORS,
  weeklyAnchorSchedule,
} from '../../src/domain/publishing/weekly-anchors';

/**
 * Slice 5 — Tier V gaming anchors (DESIGN §9.4): three fixed, recognizable
 * weekly slots with gaming content (never generic fun slots):
 * trailers Saturday 18:00, free games Thursday 20:00 (after the Epic
 * Thursday swap), most-played Sunday 11:00 (after the 10:00 snapshot).
 * All times are Tehran (UTC+03:30, no DST).
 */

// 2026-11-22 is a Sunday. 2026-11-22T06:30:00Z == 10:00 Tehran.
const SUNDAY_10_00_TEHRAN = Date.UTC(2026, 10, 22, 6, 30, 0);

describe('weekly anchors — the three fixed slots', () => {
  it('defines exactly the three gaming anchors with their Tehran slots', () => {
    expect(WEEKLY_ANCHORS).toHaveLength(3);
    expect(WEEKLY_ANCHORS.map((anchor) => anchor.id)).toEqual([
      'trailers_of_the_week',
      'free_games_of_the_week',
      'most_played_of_the_week',
    ]);
    const byId = new Map(WEEKLY_ANCHORS.map((anchor) => [anchor.id, anchor]));
    expect(byId.get('trailers_of_the_week')).toMatchObject({
      weekday: 6,
      minuteOfDay: 18 * 60,
      category: 'release_trailer_patch_dlc',
      sourceKind: 'youtube_official',
    });
    expect(byId.get('free_games_of_the_week')).toMatchObject({
      weekday: 4,
      minuteOfDay: 20 * 60,
      category: 'free_discount_indie',
      sourceKind: 'epic_free_games',
    });
    expect(byId.get('most_played_of_the_week')).toMatchObject({
      weekday: 0,
      minuteOfDay: 11 * 60,
      category: 'mainstream_industry',
      sourceKind: 'steam_most_played',
    });
  });

  it('computes the next occurrence after a given instant (same-day when still ahead)', () => {
    // Sunday 10:00 Tehran: most-played is due today at 11:00 Tehran.
    const mostPlayed = WEEKLY_ANCHORS.find((anchor) => anchor.id === 'most_played_of_the_week')!;
    expect(nextAnchorOccurrence(mostPlayed, SUNDAY_10_00_TEHRAN)).toBe(
      Date.UTC(2026, 10, 22, 7, 30, 0),
    );
    // Trailers (Saturday 18:00 Tehran) from Sunday 10:00: next Saturday.
    const trailers = WEEKLY_ANCHORS.find((anchor) => anchor.id === 'trailers_of_the_week')!;
    expect(nextAnchorOccurrence(trailers, SUNDAY_10_00_TEHRAN)).toBe(
      Date.UTC(2026, 10, 28, 14, 30, 0),
    );
    // Free games (Thursday 20:00 Tehran) from Sunday 10:00: next Thursday.
    const freeGames = WEEKLY_ANCHORS.find((anchor) => anchor.id === 'free_games_of_the_week')!;
    expect(nextAnchorOccurrence(freeGames, SUNDAY_10_00_TEHRAN)).toBe(
      Date.UTC(2026, 10, 26, 16, 30, 0),
    );
  });

  it('rolls to next week when the slot already passed today', () => {
    // Sunday 12:00 Tehran: most-played (11:00) already passed -> next Sunday.
    const sundayNoon = Date.UTC(2026, 10, 22, 8, 30, 0);
    const mostPlayed = WEEKLY_ANCHORS.find((anchor) => anchor.id === 'most_played_of_the_week')!;
    expect(nextAnchorOccurrence(mostPlayed, sundayNoon)).toBe(Date.UTC(2026, 10, 29, 7, 30, 0));
  });

  it('lists all three next occurrences soonest-first', () => {
    const schedule = weeklyAnchorSchedule(SUNDAY_10_00_TEHRAN);
    expect(schedule.map((entry) => entry.anchor.id)).toEqual([
      'most_played_of_the_week',
      'free_games_of_the_week',
      'trailers_of_the_week',
    ]);
    for (let index = 1; index < schedule.length; index += 1) {
      expect(schedule[index]!.dueAtMs).toBeGreaterThan(schedule[index - 1]!.dueAtMs);
    }
  });

  it('finds the anchor due within a window, and none when the window is empty', () => {
    // 30 minutes before the Sunday 11:00 slot: most-played is due within 1h.
    const thirtyMinBefore = Date.UTC(2026, 10, 22, 7, 0, 0);
    const due = anchorDueWithin(thirtyMinBefore, 60 * 60 * 1000);
    expect(due?.anchor.id).toBe('most_played_of_the_week');
    // From Sunday 10:00 with a 30-minute window: nothing is due.
    expect(anchorDueWithin(SUNDAY_10_00_TEHRAN, 30 * 60 * 1000)).toBeNull();
  });

  it('keeps every anchor slot inside an ACTIVE Tehran window (never quiet hours)', () => {
    for (const anchor of WEEKLY_ANCHORS) {
      const due = nextAnchorOccurrence(anchor, SUNDAY_10_00_TEHRAN);
      expect(isAnchorSlotInActiveWindow(due)).toBe(true);
    }
    // 03:00 Tehran is quiet — an anchor must never land there.
    expect(isAnchorSlotInActiveWindow(Date.UTC(2026, 10, 21, 23, 30, 0))).toBe(false);
  });
});
