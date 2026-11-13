/**
 * Phase 8.1 — TEHRAN WINDOWS (blueprint §16 «Tehran windows»).
 *
 * A TOTAL, DETERMINISTIC, PURE classifier over the fixed Asia/Tehran
 * civil time. Iran has had NO daylight saving time since 2022, so the
 * civil offset is the FIXED UTC+03:30 — the same arithmetic basis as
 * the Phase 4 budget day (src/shared/time/tehran-day.ts). No Date
 * parsing, no Intl, no DST table: epoch-millisecond arithmetic only.
 *
 * THE PINNED SEGMENT TABLE (policy version `twp1`) — the day is
 * TOTALLY partitioned into exactly eleven named segments; the five
 * ACTIVE publishing windows, the QUIET window and the five named
 * neutral GAPS:
 *
 *   late_night_radar    active 23:00–00:45 (CROSSES midnight —
 *                       represented as [00:00,00:45) ∪ [23:00,24:00))
 *   gap_post_late_night gap    00:45–01:00
 *   quiet               quiet  01:00–08:30 («quiet for P2/P3» — the
 *                       GATE belongs to the priority classes and the
 *                       composition, never here)
 *   gap_morning_lead    gap    08:30–09:30
 *   morning_scan        active 09:30–11:30
 *   gap_morning_midday  gap    11:30–13:00
 *   midday              active 13:00–15:30
 *   gap_midday_evening  gap    15:30–17:00
 *   evening             active 17:00–19:30
 *   gap_evening_prime   gap    19:30–20:00
 *   prime               active 20:00–23:00
 *
 * BOUNDARY CONVENTION (pinned, tested): every segment is
 * [start, end) — a window ENDS the instant the next segment begins.
 * 23:00:00.000 belongs to late_night_radar, NOT prime; 11:30:00.000
 * belongs to gap_morning_midday, NOT morning_scan; 08:30:00.000
 * belongs to gap_morning_lead, NOT quiet.
 *
 * THE CLASSIFIER IS TOTAL: every finite non-negative integer epoch-ms
 * yields exactly one segment with its ABSOLUTE [startedAtMs,
 * endsAtMs) bounds (a cross-midnight occurrence reports the TRUE
 * absolute bounds — yesterday 23:00 through today 00:45, or today
 * 23:00 through tomorrow 00:45). Every input-contract violation
 * (NaN, ±Infinity, negative, non-integer) fails TYPED — never
 * clamped, never guessed.
 *
 * `nextActiveWindowStart` is the deferral target used by the
 * Phase 8.1 composition: the start of the next ACTIVE window
 * STRICTLY after the given instant (an instant INSIDE an active
 * window therefore yields the FOLLOWING window's start — the
 * composition never defers into a window already in progress). The
 * search is bounded at three Tehran days; by construction a hit
 * always exists inside two, so the miss branch is a defensive typed
 * failure, never a guess.
 *
 * BOUNDARY: pure — no I/O, no clock, no network, no Telegram types.
 * The SAME input ALWAYS yields the SAME answer (JSON-equal
 * determinism).
 */

import { TEHRAN_OFFSET_MINUTES } from '../../shared/time/tehran-day';

export const TEHRAN_WINDOWS_POLICY_VERSION = 'twp1' as const;

export type TehranWindowKind = 'active' | 'quiet' | 'gap';

export type TehranWindowName =
  | 'late_night_radar'
  | 'gap_post_late_night'
  | 'quiet'
  | 'gap_morning_lead'
  | 'morning_scan'
  | 'gap_morning_midday'
  | 'midday'
  | 'gap_midday_evening'
  | 'evening'
  | 'gap_evening_prime'
  | 'prime';

export interface TehranWindowPiece {
  /** Inclusive Tehran minute-of-day where the piece starts. */
  readonly startMinute: number;
  /** Exclusive Tehran minute-of-day where the piece ends (≤ 1440). */
  readonly endMinuteExclusive: number;
}

export interface TehranWindowSegment {
  readonly name: TehranWindowName;
  readonly kind: TehranWindowKind;
  /**
   * The minute pieces inside ONE Tehran civil day. Most segments have
   * exactly one; late_night_radar has two ([0,45) and [1380,1440))
   * because it crosses midnight.
   */
  readonly pieces: readonly TehranWindowPiece[];
}

/**
 * The pinned §16 segment table, in minute-of-day order, TOTALLY
 * covering [0, 1440) with no hole and no overlap (pinned by test).
 */
export const TEHRAN_WINDOW_SEGMENTS: readonly TehranWindowSegment[] = [
  {
    name: 'late_night_radar',
    kind: 'active',
    pieces: [
      { startMinute: 0, endMinuteExclusive: 45 },
      { startMinute: 1380, endMinuteExclusive: 1440 },
    ],
  },
  {
    name: 'gap_post_late_night',
    kind: 'gap',
    pieces: [{ startMinute: 45, endMinuteExclusive: 60 }],
  },
  { name: 'quiet', kind: 'quiet', pieces: [{ startMinute: 60, endMinuteExclusive: 510 }] },
  {
    name: 'gap_morning_lead',
    kind: 'gap',
    pieces: [{ startMinute: 510, endMinuteExclusive: 570 }],
  },
  { name: 'morning_scan', kind: 'active', pieces: [{ startMinute: 570, endMinuteExclusive: 690 }] },
  {
    name: 'gap_morning_midday',
    kind: 'gap',
    pieces: [{ startMinute: 690, endMinuteExclusive: 780 }],
  },
  { name: 'midday', kind: 'active', pieces: [{ startMinute: 780, endMinuteExclusive: 930 }] },
  {
    name: 'gap_midday_evening',
    kind: 'gap',
    pieces: [{ startMinute: 930, endMinuteExclusive: 1020 }],
  },
  { name: 'evening', kind: 'active', pieces: [{ startMinute: 1020, endMinuteExclusive: 1170 }] },
  {
    name: 'gap_evening_prime',
    kind: 'gap',
    pieces: [{ startMinute: 1170, endMinuteExclusive: 1200 }],
  },
  { name: 'prime', kind: 'active', pieces: [{ startMinute: 1200, endMinuteExclusive: 1380 }] },
] as const;

const OFFSET_MS = TEHRAN_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 86_400_000;

export type TehranWindowResult =
  | {
      ok: true;
      value: {
        name: TehranWindowName;
        kind: TehranWindowKind;
        /** Absolute inclusive epoch-ms where THIS occurrence started. */
        startedAtMs: number;
        /** Absolute exclusive epoch-ms where THIS occurrence ends. */
        endsAtMs: number;
      };
    }
  | { ok: false; reason: 'invalid_instant' };

export type NextActiveWindowResult =
  | { ok: true; value: { atMs: number; windowName: TehranWindowName } }
  | { ok: false; reason: 'invalid_instant' | 'no_next_window' };

function isInvalidInstant(epochMs: number): boolean {
  return (
    typeof epochMs !== 'number' ||
    !Number.isFinite(epochMs) ||
    !Number.isInteger(epochMs) ||
    epochMs < 0
  );
}

interface ResolvedPiece {
  readonly name: TehranWindowName;
  readonly kind: TehranWindowKind;
  /** Absolute epoch-ms of the piece start (already offset-corrected). */
  readonly startAbsMs: number;
  /** Absolute epoch-ms of the piece end (already offset-corrected). */
  readonly endAbsMs: number;
}

/**
 * Total piece accessor over the PINNED table under
 * `noUncheckedIndexedAccess`: the twp1 table is a compile-time
 * constant whose piece structure is pinned by test (exactly one piece
 * per segment, exactly two for the cross-midnight late_night_radar),
 * so a missing piece is a TABLE-INVARIANT violation — failed LOUDLY,
 * never guessed around, never `!`-asserted away.
 */
function pinnedPiece(segment: TehranWindowSegment, index: number): TehranWindowPiece {
  const piece = segment.pieces[index];
  if (piece === undefined) {
    throw new TypeError(
      `twp1 table violation: segment ${segment.name} has no piece at index ${index}`,
    );
  }
  return piece;
}

/**
 * Resolve the SEGMENT OCCURRENCES overlapping ONE Tehran civil day
 * (the day whose midnight — in the shifted frame — is
 * `dayBaseShiftedMs`). A single-piece segment yields exactly one
 * occurrence inside the day. The cross-midnight late_night_radar
 * yields TWO occurrences: the evening start of THIS day
 * (23:00 → tomorrow 00:45) and the wrapped tail of YESTERDAY'S
 * occurrence (yesterday 23:00 → today 00:45). The occurrence bounds
 * are the TRUE segment bounds — never split at midnight.
 */
function occurrencesForTehranDay(dayBaseShiftedMs: number): ResolvedPiece[] {
  const resolved: ResolvedPiece[] = [];
  const dayBaseEpochMs = dayBaseShiftedMs - OFFSET_MS;
  for (const segment of TEHRAN_WINDOW_SEGMENTS) {
    if (segment.name === 'late_night_radar') {
      const startMinute = pinnedPiece(segment, 1).startMinute; // 1380 — the evening start
      resolved.push({
        name: segment.name,
        kind: segment.kind,
        startAbsMs: dayBaseShiftedMs + startMinute * 60_000 - OFFSET_MS,
        endAbsMs:
          dayBaseShiftedMs +
          DAY_MS +
          pinnedPiece(segment, 0).endMinuteExclusive * 60_000 -
          OFFSET_MS,
      });
      resolved.push({
        name: segment.name,
        kind: segment.kind,
        startAbsMs: dayBaseShiftedMs - DAY_MS + startMinute * 60_000 - OFFSET_MS,
        endAbsMs: dayBaseEpochMs + pinnedPiece(segment, 0).endMinuteExclusive * 60_000,
      });
      continue;
    }
    const piece = pinnedPiece(segment, 0);
    resolved.push({
      name: segment.name,
      kind: segment.kind,
      startAbsMs: dayBaseShiftedMs + piece.startMinute * 60_000 - OFFSET_MS,
      endAbsMs: dayBaseShiftedMs + piece.endMinuteExclusive * 60_000 - OFFSET_MS,
    });
  }
  return resolved;
}

function classifyResolved(epochMs: number, pieces: readonly ResolvedPiece[]): ResolvedPiece | null {
  for (const piece of pieces) {
    if (epochMs >= piece.startAbsMs && epochMs < piece.endAbsMs) return piece;
  }
  return null;
}

function activeWindowStartsForDay(
  baseShiftedMs: number,
): { atMs: number; windowName: TehranWindowName }[] {
  const candidates: { atMs: number; windowName: TehranWindowName }[] = [];
  for (const segment of TEHRAN_WINDOW_SEGMENTS) {
    if (segment.kind !== 'active') continue;
    for (const piece of segment.pieces) {
      // The [0,45) piece of late_night_radar is the CONTINUATION of
      // the previous day's window — never a new START.
      if (segment.name === 'late_night_radar' && piece.startMinute === 0) continue;
      candidates.push({
        atMs: baseShiftedMs + piece.startMinute * 60_000 - OFFSET_MS,
        windowName: segment.name,
      });
    }
  }
  return candidates;
}

/**
 * Classify one instant into its Tehran §16 segment. TOTAL over all
 * finite non-negative integer instants; every violation fails typed.
 */
export function classifyTehranWindow(epochMs: number): TehranWindowResult {
  if (isInvalidInstant(epochMs)) return { ok: false, reason: 'invalid_instant' };
  const shifted = epochMs + OFFSET_MS;
  const dayBaseShiftedMs = Math.floor(shifted / DAY_MS) * DAY_MS;
  const todayOccurrences = occurrencesForTehranDay(dayBaseShiftedMs);
  const hit = classifyResolved(epochMs, todayOccurrences);
  if (hit) {
    return {
      ok: true,
      value: {
        name: hit.name,
        kind: hit.kind,
        startedAtMs: hit.startAbsMs,
        endsAtMs: hit.endAbsMs,
      },
    };
  }
  // Defensive completeness: the previous day's occurrences cover the
  // wrapped late-night tail. A miss here is impossible by
  // construction — reported typed, never guessed.
  const yesterdayOccurrences = occurrencesForTehranDay(dayBaseShiftedMs - DAY_MS);
  const hitYesterday = classifyResolved(epochMs, yesterdayOccurrences);
  if (hitYesterday) {
    return {
      ok: true,
      value: {
        name: hitYesterday.name,
        kind: hitYesterday.kind,
        startedAtMs: hitYesterday.startAbsMs,
        endsAtMs: hitYesterday.endAbsMs,
      },
    };
  }
  return { ok: false, reason: 'invalid_instant' };
}

/**
 * The start of the next ACTIVE window STRICTLY after `epochMs`. An
 * instant inside an active window yields the FOLLOWING window's
 * start. Bounded three-day search; the miss branch is defensive.
 */
export function nextActiveWindowStart(epochMs: number): NextActiveWindowResult {
  if (isInvalidInstant(epochMs)) return { ok: false, reason: 'invalid_instant' };
  const shifted = epochMs + OFFSET_MS;
  const dayBaseShiftedMs = Math.floor(shifted / DAY_MS) * DAY_MS;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const candidates = activeWindowStartsForDay(dayBaseShiftedMs + dayOffset * DAY_MS).filter(
      (candidate) => candidate.atMs > epochMs,
    );
    candidates.sort((a, b) => a.atMs - b.atMs);
    const earliest = candidates[0];
    if (earliest !== undefined) return { ok: true, value: earliest };
  }
  return { ok: false, reason: 'no_next_window' };
}
