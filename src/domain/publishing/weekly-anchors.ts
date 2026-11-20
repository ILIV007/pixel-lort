/**
 * Tier V gaming anchors (slice 5; DESIGN §9.4).
 *
 * Fredy's shape is kept — one or two fixed, recognizable points in the
 * week — but the CONTENT is gaming, never generic fun slots (DESIGN §4
 * forbids non-gaming fun slots in v1):
 *   - trailers of the week  — Saturday 18:00 Tehran
 *   - free games of the week — Thursday 20:00 Tehran (Epic swaps Thu
 *     ~16:00 UTC = 19:30 Tehran, so the 20:00 poll catches the new week)
 *   - most-played of the week — Sunday 11:00 Tehran (built from the
 *     Sunday 10:00 Steam chart snapshot, live-watchlists §3.1)
 *
 * Anchors are SCHEDULED SLOTS with gaming content: they name WHEN a
 * roundup is due and WHICH mix category + data source feeds it. They do
 * not fetch, post, or bypass the daily cap — the roundup candidate flows
 * through the same queue, windows, and cap as any other post.
 *
 * Pure module: Tehran is UTC+03:30 with no DST since 2022 (see
 * src/shared/time/tehran-day.ts), so weekday/time math is arithmetic.
 */
import type { MixCategory } from './anti-robot';
import { classifyTehranWindow } from './tehran-windows';

export type WeeklyAnchorId =
  'trailers_of_the_week' | 'free_games_of_the_week' | 'most_played_of_the_week';

export interface WeeklyAnchor {
  readonly id: WeeklyAnchorId;
  /** Persian display name (the recognizable slot name). */
  readonly titleFa: string;
  /** Tehran weekday: 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  /** Tehran minute-of-day the slot is due (18:00 = 1080). */
  readonly minuteOfDay: number;
  readonly category: MixCategory;
  /** The live data source that feeds this anchor. */
  readonly sourceKind: 'youtube_official' | 'epic_free_games' | 'steam_most_played';
}

export const WEEKLY_ANCHORS: readonly WeeklyAnchor[] = [
  {
    id: 'trailers_of_the_week',
    titleFa: 'تریلرهای هفته',
    weekday: 6,
    minuteOfDay: 18 * 60,
    category: 'release_trailer_patch_dlc',
    sourceKind: 'youtube_official',
  },
  {
    id: 'free_games_of_the_week',
    titleFa: 'بازی‌های رایگان هفته',
    weekday: 4,
    minuteOfDay: 20 * 60,
    category: 'free_discount_indie',
    sourceKind: 'epic_free_games',
  },
  {
    id: 'most_played_of_the_week',
    titleFa: 'پرطرفدارترین بازی‌های هفته',
    weekday: 0,
    minuteOfDay: 11 * 60,
    category: 'mainstream_industry',
    sourceKind: 'steam_most_played',
  },
];

const TEHRAN_OFFSET_MS = (3 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The next due instant (epoch ms) of one anchor strictly after `nowMs`. */
export function nextAnchorOccurrence(anchor: WeeklyAnchor, nowMs: number): number {
  const tehranNow = new Date(nowMs + TEHRAN_OFFSET_MS);
  const todayWeekday = tehranNow.getUTCDay();
  const todayMinute = tehranNow.getUTCHours() * 60 + tehranNow.getUTCMinutes();
  let daysAhead = (anchor.weekday - todayWeekday + 7) % 7;
  if (daysAhead === 0 && todayMinute >= anchor.minuteOfDay) {
    daysAhead = 7;
  }
  const tehranYear = tehranNow.getUTCFullYear();
  const tehranMonth = tehranNow.getUTCMonth();
  const tehranDate = tehranNow.getUTCDate();
  const targetTehranMs = Date.UTC(
    tehranYear,
    tehranMonth,
    tehranDate + daysAhead,
    Math.floor(anchor.minuteOfDay / 60),
    anchor.minuteOfDay % 60,
    0,
    0,
  );
  return targetTehranMs - TEHRAN_OFFSET_MS;
}

/** Every anchor's next occurrence after `nowMs`, soonest first. */
export function weeklyAnchorSchedule(nowMs: number): readonly {
  readonly anchor: WeeklyAnchor;
  readonly dueAtMs: number;
}[] {
  return WEEKLY_ANCHORS.map((anchor) => ({
    anchor,
    dueAtMs: nextAnchorOccurrence(anchor, nowMs),
  })).sort((a, b) => a.dueAtMs - b.dueAtMs);
}

/** The anchor due within `windowMs` after `nowMs`, if any (at most one). */
export function anchorDueWithin(
  nowMs: number,
  windowMs: number,
): { readonly anchor: WeeklyAnchor; readonly dueAtMs: number } | null {
  for (const entry of weeklyAnchorSchedule(nowMs)) {
    if (entry.dueAtMs - nowMs <= windowMs) {
      return entry;
    }
  }
  return null;
}

/** Is `dueAtMs` inside an ACTIVE Tehran window? (Anchors never post in quiet hours.) */
export function isAnchorSlotInActiveWindow(dueAtMs: number): boolean {
  // The pinned window table (twp1) is the single source of truth — never
  // duplicated here: a gap/quiet slot defers to the next active window
  // through the publication scheduler, it never posts in place.
  const classified = classifyTehranWindow(dueAtMs);
  return classified.ok && classified.value.kind === 'active';
}

export { DAY_MS };
