/**
 * Phase 8.1 — TEHRAN WINDOWS (the RED-first adversarial suite).
 *
 * Blueprint §16 «Tehran windows» as a TOTAL, DETERMINISTIC, PURE
 * classifier over the fixed Asia/Tehran civil time (UTC+03:30 — Iran
 * has had NO DST since 2022, the same basis as the Phase 4 budget day):
 *
 * - the five ACTIVE publishing windows: morning_scan 09:30–11:30,
 *   midday 13:00–15:30, evening 17:00–19:30, prime 20:00–23:00,
 *   late_night_radar 23:00–00:45 (the ONLY window that CROSSES
 *   midnight — pinned and tested);
 * - the QUIET window 01:00–08:30 — the blueprint names it «quiet for
 *   P2/P3» (the quiet GATE belongs to the priority classes, not here);
 * - the five named GAPS (00:45–01:00, 08:30–09:30, 11:30–13:00,
 *   15:30–17:00, 19:30–20:00) — the neutral stretches the blueprint
 *   does not assign;
 * - the boundary convention is PINNED [start, end): a window ends the
 *   instant the next segment begins (23:00:00.000 belongs to
 *   late_night_radar, NOT prime; 11:30:00.000 belongs to the gap, NOT
 *   morning_scan);
 * - every instant yields exactly ONE segment — the day is TOTALLY
 *   partitioned (the exhaustive per-minute sweep pins it);
 * - the SAME input ALWAYS yields the SAME classification
 *   (JSON-equal determinism); no Date parsing, no Intl, no DST table.
 */

import { describe, expect, it } from 'vitest';

import {
  TEHRAN_WINDOWS_POLICY_VERSION,
  TEHRAN_WINDOW_SEGMENTS,
  classifyTehranWindow,
  nextActiveWindowStart,
  type TehranWindowKind,
  type TehranWindowName,
} from '../../src/domain/publishing/tehran-windows';

/** Tehran is the FIXED UTC+03:30 (no DST since 2022). */
const OFFSET_MS = 210 * 60 * 1000;

/** UTC epoch for a Tehran wall-clock time on a fixed civil date. */
function tehranAt(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  // Tehran civil time = UTC + 03:30, so UTC = Tehran − 03:30.
  return Date.UTC(y, mo - 1, d, h, mi, s) - OFFSET_MS;
}

const DAY = 86_400_000;

/**
 * Classify ONCE and fail the cell LOUDLY on any typed rejection. The
 * boundary cells assert the ok:true side — a single call narrowed
 * through one variable (two independent calls in one expression can
 * never be narrowed by the compiler and would read the value off a
 * second classification — the cross-call bug this helper replaces).
 */
function mustClassify(epochMs: number): { name: TehranWindowName; kind: TehranWindowKind } {
  const result = classifyTehranWindow(epochMs);
  if (!result.ok) throw new Error(`unexpected invalid_instant for epoch ${epochMs}`);
  return result.value;
}

describe('tehran-windows policy identity', () => {
  it('the policy version is pinned twp1', () => {
    expect(TEHRAN_WINDOWS_POLICY_VERSION).toBe('twp1');
  });

  it('the pinned segment table matches the blueprint §16 windows exactly', () => {
    const names = TEHRAN_WINDOW_SEGMENTS.map((segment) => segment.name);
    expect(names).toEqual([
      'late_night_radar',
      'gap_post_late_night',
      'quiet',
      'gap_morning_lead',
      'morning_scan',
      'gap_morning_midday',
      'midday',
      'gap_midday_evening',
      'evening',
      'gap_evening_prime',
      'prime',
    ]);
    const kinds = TEHRAN_WINDOW_SEGMENTS.map((segment) => segment.kind);
    expect(kinds).toEqual([
      'active',
      'gap',
      'quiet',
      'gap',
      'active',
      'gap',
      'active',
      'gap',
      'active',
      'gap',
      'active',
    ] satisfies TehranWindowKind[]);
  });

  it('the segment table covers the whole Tehran day with NO hole and NO overlap (wrap-aware sorted chain)', () => {
    const pieces = TEHRAN_WINDOW_SEGMENTS.flatMap((segment) =>
      segment.pieces.map((piece) => ({ ...piece })),
    ).sort((a, b) => a.startMinute - b.startMinute);
    let cursor = 0;
    for (const piece of pieces) {
      expect(piece.startMinute).toBe(cursor);
      cursor = piece.endMinuteExclusive;
    }
    expect(cursor).toBe(1440);
  });
});

describe('classifyTehranWindow — the exhaustive per-minute sweep', () => {
  // The SPEC table (minute-of-day → segment), independent of the
  // implementation: written straight from the blueprint §16 list.
  const spec: ReadonlyArray<readonly [TehranWindowName, TehranWindowKind, number, number]> = [
    ['late_night_radar', 'active', 0, 45],
    ['gap_post_late_night', 'gap', 45, 60],
    ['quiet', 'quiet', 60, 510],
    ['gap_morning_lead', 'gap', 510, 570],
    ['morning_scan', 'active', 570, 690],
    ['gap_morning_midday', 'gap', 690, 780],
    ['midday', 'active', 780, 930],
    ['gap_midday_evening', 'gap', 930, 1020],
    ['evening', 'active', 1020, 1170],
    ['gap_evening_prime', 'gap', 1170, 1200],
    ['prime', 'active', 1200, 1380],
    ['late_night_radar', 'active', 1380, 1440],
  ];

  function expectedFor(minuteOfDay: number): { name: TehranWindowName; kind: TehranWindowKind } {
    for (const [name, kind, start, end] of spec) {
      if (minuteOfDay >= start && minuteOfDay < end) return { name, kind };
    }
    throw new Error(`spec hole at minute ${minuteOfDay}`);
  }

  it('every minute of THREE Tehran days classifies into exactly the blueprint segment', () => {
    // Three consecutive civil days, including a midnight crossing.
    const start = tehranAt(2026, 11, 10, 0, 0);
    for (let minute = 0; minute < 3 * 1440; minute++) {
      const atMs = start + minute * 60_000;
      const result = classifyTehranWindow(atMs);
      if (!result.ok) throw new Error(`minute ${minute} failed: ${result.reason}`);
      const minuteOfDay = Math.floor((atMs + OFFSET_MS) % DAY) / 60_000;
      const expected = expectedFor(Math.floor(minuteOfDay));
      expect(result.value.name).toBe(expected.name);
      expect(result.value.kind).toBe(expected.kind);
    }
  });

  it('sub-minute precision keeps the same segment as its minute', () => {
    const at = tehranAt(2026, 11, 11, 21, 43, 37) + 512; // inside prime
    const result = classifyTehranWindow(at);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.name).toBe('prime');
    expect(result.value.kind).toBe('active');
  });
});

describe('classifyTehranWindow — pinned boundaries ([start, end))', () => {
  it('09:29:59.999 is the morning lead gap; 09:30:00.000 is morning_scan', () => {
    const before = classifyTehranWindow(tehranAt(2026, 11, 11, 9, 30) - 1);
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 9, 30));
    expect(before.ok && before.value.name).toBe('gap_morning_lead');
    expect(at.ok && at.value.name).toBe('morning_scan');
  });

  it('11:29:59.999 is morning_scan; 11:30:00.000 is the gap — the window END is exclusive', () => {
    const before = classifyTehranWindow(tehranAt(2026, 11, 11, 11, 30) - 1);
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 11, 30));
    expect(before.ok && before.value.name).toBe('morning_scan');
    expect(at.ok && at.value.name).toBe('gap_morning_midday');
  });

  it('22:59:59.999 is prime; 23:00:00.000 is late_night_radar (NOT prime)', () => {
    const before = classifyTehranWindow(tehranAt(2026, 11, 11, 23, 0) - 1);
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 23, 0));
    expect(before.ok && before.value.name).toBe('prime');
    expect(at.ok && at.value.name).toBe('late_night_radar');
  });

  it('00:44:59.999 is late_night_radar; 00:45:00.000 is the post-late-night gap', () => {
    const before = classifyTehranWindow(tehranAt(2026, 11, 11, 0, 45) - 1);
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 0, 45));
    expect(before.ok && before.value.name).toBe('late_night_radar');
    expect(at.ok && at.value.name).toBe('gap_post_late_night');
  });

  it('00:59:59.999 is the gap; 01:00:00.000 is quiet; 08:29:59.999 is quiet; 08:30:00.000 is the lead gap', () => {
    expect(mustClassify(tehranAt(2026, 11, 11, 1, 0) - 1).name).toBe('gap_post_late_night');
    expect(mustClassify(tehranAt(2026, 11, 11, 1, 0)).name).toBe('quiet');
    expect(mustClassify(tehranAt(2026, 11, 11, 8, 30) - 1).name).toBe('quiet');
    expect(mustClassify(tehranAt(2026, 11, 11, 8, 30)).name).toBe('gap_morning_lead');
  });

  it('13:00:00.000 starts midday; 15:30:00.000 starts the gap; 17:00:00.000 starts evening; 19:30:00.000 starts the gap; 20:00:00.000 starts prime', () => {
    expect(mustClassify(tehranAt(2026, 11, 11, 13, 0)).name).toBe('midday');
    expect(mustClassify(tehranAt(2026, 11, 11, 15, 30)).name).toBe('gap_midday_evening');
    expect(mustClassify(tehranAt(2026, 11, 11, 17, 0)).name).toBe('evening');
    expect(mustClassify(tehranAt(2026, 11, 11, 19, 30)).name).toBe('gap_evening_prime');
    expect(mustClassify(tehranAt(2026, 11, 11, 20, 0)).name).toBe('prime');
  });
});

describe('classifyTehranWindow — cross-midnight segment bounds', () => {
  it('at 23:30 the segment started TODAY 23:00 and ends TOMORROW 00:45', () => {
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 23, 30));
    if (!at.ok) throw new Error(at.reason);
    expect(at.value.name).toBe('late_night_radar');
    expect(at.value.startedAtMs).toBe(tehranAt(2026, 11, 11, 23, 0));
    expect(at.value.endsAtMs).toBe(tehranAt(2026, 11, 12, 0, 45));
  });

  it('at 00:15 the segment started YESTERDAY 23:00 and ends TODAY 00:45', () => {
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 0, 15));
    if (!at.ok) throw new Error(at.reason);
    expect(at.value.name).toBe('late_night_radar');
    expect(at.value.startedAtMs).toBe(tehranAt(2026, 11, 10, 23, 0));
    expect(at.value.endsAtMs).toBe(tehranAt(2026, 11, 11, 0, 45));
  });

  it('a plain window reports its own civil bounds (midday 13:00–15:30)', () => {
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 14, 0));
    if (!at.ok) throw new Error(at.reason);
    expect(at.value.startedAtMs).toBe(tehranAt(2026, 11, 11, 13, 0));
    expect(at.value.endsAtMs).toBe(tehranAt(2026, 11, 11, 15, 30));
  });

  it('the reported bounds are self-consistent: start classifies to the same segment, end does not', () => {
    const at = classifyTehranWindow(tehranAt(2026, 11, 11, 10, 0));
    if (!at.ok) throw new Error(at.reason);
    const atStart = classifyTehranWindow(at.value.startedAtMs);
    const atEnd = classifyTehranWindow(at.value.endsAtMs);
    expect(atStart.ok && atStart.value.name).toBe(at.value.name);
    expect(atEnd.ok && atEnd.value.name).not.toBe(at.value.name);
  });
});

describe('nextActiveWindowStart', () => {
  it('from quiet (03:00) the next active start is 09:30 the SAME Tehran day (morning_scan)', () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 3, 0));
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.atMs).toBe(tehranAt(2026, 11, 11, 9, 30));
    expect(result.value.windowName).toBe('morning_scan');
  });

  it('from gap_evening_prime (19:45) the next active start is prime 20:00', () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 19, 45));
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.atMs).toBe(tehranAt(2026, 11, 11, 20, 0));
    expect(result.value.windowName).toBe('prime');
  });

  it("from INSIDE an active window (21:00 prime) the next start is the same evening's late_night 23:00 (strictly after now)", () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 21, 0));
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.atMs).toBe(tehranAt(2026, 11, 11, 23, 0));
    expect(result.value.windowName).toBe('late_night_radar');
  });

  it('from late_night_radar (23:30) the next active start is tomorrow 09:30 — late_night does NOT restart', () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 23, 30));
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.atMs).toBe(tehranAt(2026, 11, 12, 9, 30));
  });

  it('from the post-late-night gap (00:50) the next active start is the SAME day 09:30', () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 0, 50));
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.atMs).toBe(tehranAt(2026, 11, 11, 9, 30));
  });

  it('from exactly a window START the next start is the FOLLOWING window sequence (strictly after)', () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 9, 30));
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.atMs).toBe(tehranAt(2026, 11, 11, 13, 0));
    expect(result.value.windowName).toBe('midday');
  });

  it('the returned start classifies as its named ACTIVE window', () => {
    const result = nextActiveWindowStart(tehranAt(2026, 11, 11, 16, 0));
    if (!result.ok) throw new Error(result.reason);
    const at = classifyTehranWindow(result.value.atMs);
    expect(at.ok && at.value.name).toBe(result.value.windowName);
    expect(at.ok && at.value.kind).toBe('active');
  });
});

describe('input contract — typed failures, never a guess', () => {
  it('NaN, ±Infinity, negative and non-integer instants fail invalid_instant', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5]) {
      const result = classifyTehranWindow(bad);
      expect(result).toEqual({ ok: false, reason: 'invalid_instant' });
      expect(nextActiveWindowStart(bad)).toEqual({ ok: false, reason: 'invalid_instant' });
    }
  });
});

describe('determinism', () => {
  it('the same input yields a JSON-equal classification and next-window answer', () => {
    const at = tehranAt(2026, 11, 11, 20, 15, 7);
    const a = classifyTehranWindow(at);
    const b = classifyTehranWindow(at);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const na = nextActiveWindowStart(at);
    const nb = nextActiveWindowStart(at);
    expect(JSON.stringify(na)).toBe(JSON.stringify(nb));
  });
});
