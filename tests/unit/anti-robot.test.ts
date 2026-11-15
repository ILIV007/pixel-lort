/**
 * Phase 8.1 — ANTI-ROBOT RULES (the RED-first adversarial suite).
 *
 * Blueprint §16 «Anti-robot rules» as TOTAL, DETERMINISTIC, PURE
 * policy functions under the pinned policy version `arp1`:
 *
 * - the send-gap bands: 25–45 minutes normal, 8–15 minutes P1, and
 *   the unrelated-P0 bypass with a SMALL anti-flood gap — the
 *   blueprint leaves «small» unquantified, so `arp1` PINS it honestly
 *   as 2–4 minutes (recorded in the module header, the ADR and here);
 *   the gap jitter is ALWAYS a caller-supplied deterministic input
 *   validated against the selected band — the domain NEVER generates
 *   randomness;
 * - the same-game cooldown: 90 minutes UNLESS the story layer asserts
 *   a meaningful update (an explicit input flag — never an inference);
 * - the layout run cap: at most three consecutive posts with the same
 *   opaque layout label — the trailing run is counted from the END of
 *   the chronological history (oldest first, pinned order);
 * - the category share cap: a candidate category may not exceed 40% of
 *   the rolling six most recent posts unless the story layer marks the
 *   publication event-driven — pinned with EXACT integer math
 *   ((count+1)×10 ≤ 6×4), never floating-point shares;
 * - the weekly content mix: the ten blueprint categories with their
 *   exact per-mille targets over a ROLLING 168-hour window — the
 *   comparison is integer-exact (count×1000 vs total×target), the
 *   status vocabulary is under_target/on_target/over_target (no_data
 *   for an empty window), and NO floating-point percentage is ever
 *   produced;
 * - every input-contract violation fails TYPED — never clamped, never
 *   guessed; the same input ALWAYS yields the same answer.
 */

import { describe, expect, it } from 'vitest';

import {
  ANTI_FLOOD_GAP_MAX_MS,
  ANTI_FLOOD_GAP_MIN_MS,
  ANTI_ROBOT_POLICY_VERSION,
  CATEGORY_MAX_ALLOWED_COUNT,
  CATEGORY_ROLLING_WINDOW,
  MAX_CONSECUTIVE_SAME_LAYOUT,
  MIX_CATEGORIES,
  MIX_TARGET_PER_MILLE,
  NORMAL_GAP_MAX_MS,
  NORMAL_GAP_MIN_MS,
  P1_GAP_MAX_MS,
  P1_GAP_MIN_MS,
  SAME_GAME_COOLDOWN_MS,
  WEEKLY_MIX_WINDOW_MS,
  assessWeeklyMix,
  enforceCategoryShare,
  enforceLayoutRunCap,
  enforceSameGameCooldown,
  resolveSendGapMs,
} from '../../src/domain/publishing/anti-robot';
import type { PublicationPriorityClass } from '../../src/domain/publishing/priority-classes';

const MIN = 60_000;

function prev(atMs: number, related = true, priorityClass: PublicationPriorityClass = 'P2') {
  return { atMs, related, priorityClass };
}

describe('anti-robot policy identity and pinned constants', () => {
  it('the policy version is pinned arp1', () => {
    expect(ANTI_ROBOT_POLICY_VERSION).toBe('arp1');
  });

  it('the pinned bands match the blueprint §16 numbers exactly', () => {
    expect(NORMAL_GAP_MIN_MS).toBe(25 * MIN);
    expect(NORMAL_GAP_MAX_MS).toBe(45 * MIN);
    expect(P1_GAP_MIN_MS).toBe(8 * MIN);
    expect(P1_GAP_MAX_MS).toBe(15 * MIN);
    expect(SAME_GAME_COOLDOWN_MS).toBe(90 * MIN);
    expect(MAX_CONSECUTIVE_SAME_LAYOUT).toBe(3);
    expect(CATEGORY_ROLLING_WINDOW).toBe(6);
    expect(CATEGORY_MAX_ALLOWED_COUNT).toBe(2);
    expect(WEEKLY_MIX_WINDOW_MS).toBe(7 * 24 * 60 * MIN);
  });

  it('the arp1 anti-flood pin is 2–4 minutes (the documented «small» pin)', () => {
    expect(ANTI_FLOOD_GAP_MIN_MS).toBe(2 * MIN);
    expect(ANTI_FLOOD_GAP_MAX_MS).toBe(4 * MIN);
  });

  it('the ten blueprint mix targets sum to exactly 1000 per-mille', () => {
    const sum = Object.values(MIX_TARGET_PER_MILLE).reduce((a, b) => a + b, 0);
    expect(sum).toBe(1000);
    expect(MIX_CATEGORIES).toHaveLength(10);
    expect(MIX_CATEGORIES.every((name) => MIX_TARGET_PER_MILLE[name] !== undefined)).toBe(true);
  });
});

describe('resolveSendGapMs — band selection', () => {
  it('no previous send ⇒ no gap rule at all (gapMs 0, bounds null)', () => {
    const result = resolveSendGapMs({
      candidateClass: 'P2',
      jitterMs: 0,
      previousSend: null,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ gapMs: 0, rule: 'no_previous_send', boundsMs: null });
  });

  it('an UNRELATED P0 bypass uses the pinned anti-flood band (2–4 min)', () => {
    const result = resolveSendGapMs({
      candidateClass: 'P0',
      jitterMs: 3 * MIN,
      previousSend: prev(Date.now(), false, 'P1'),
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.rule).toBe('anti_flood_bypass');
    expect(result.value.boundsMs).toEqual({ minMs: 2 * MIN, maxMs: 4 * MIN });
    expect(result.value.gapMs).toBe(3 * MIN);
  });

  it('a RELATED P0 does NOT bypass — the conservative normal gap applies (the arp1 pin)', () => {
    const result = resolveSendGapMs({
      candidateClass: 'P0',
      jitterMs: 30 * MIN,
      previousSend: prev(Date.now(), true, 'P2'),
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.rule).toBe('normal_gap');
    expect(result.value.boundsMs).toEqual({ minMs: NORMAL_GAP_MIN_MS, maxMs: NORMAL_GAP_MAX_MS });
  });

  it('a P1 candidate uses the P1 band (8–15 min) regardless of the previous class', () => {
    const result = resolveSendGapMs({
      candidateClass: 'P1',
      jitterMs: 10 * MIN,
      previousSend: prev(Date.now(), true, 'P0'),
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.rule).toBe('p1_gap');
    expect(result.value.boundsMs).toEqual({ minMs: P1_GAP_MIN_MS, maxMs: P1_GAP_MAX_MS });
  });

  it('P2 and P3 candidates use the normal band (25–45 min)', () => {
    for (const candidateClass of ['P2', 'P3'] as const) {
      const result = resolveSendGapMs({
        candidateClass,
        jitterMs: 35 * MIN,
        previousSend: prev(Date.now(), true, 'P0'),
      });
      if (!result.ok) throw new Error(result.reason);
      expect(result.value.rule).toBe('normal_gap');
    }
  });
});

describe('resolveSendGapMs — the jitter is validated against the SELECTED band', () => {
  it('the anti-flood band accepts exactly 2..4 minutes', () => {
    const base = { candidateClass: 'P0' as const, previousSend: prev(1, false, 'P1') };
    expect(resolveSendGapMs({ ...base, jitterMs: 2 * MIN }).ok).toBe(true);
    expect(resolveSendGapMs({ ...base, jitterMs: 4 * MIN }).ok).toBe(true);
    expect(resolveSendGapMs({ ...base, jitterMs: 2 * MIN - 1 })).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
    expect(resolveSendGapMs({ ...base, jitterMs: 4 * MIN + 1 })).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
  });

  it('the normal band accepts exactly 25..45 minutes (P2 candidate)', () => {
    const base = { candidateClass: 'P2' as const, previousSend: prev(1, true, 'P2') };
    expect(resolveSendGapMs({ ...base, jitterMs: 25 * MIN }).ok).toBe(true);
    expect(resolveSendGapMs({ ...base, jitterMs: 45 * MIN }).ok).toBe(true);
    expect(resolveSendGapMs({ ...base, jitterMs: 25 * MIN - 1 })).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
    expect(resolveSendGapMs({ ...base, jitterMs: 45 * MIN + 1 })).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
  });

  it('the P1 band accepts exactly 8..15 minutes', () => {
    const base = { candidateClass: 'P1' as const, previousSend: prev(1, true, 'P2') };
    expect(resolveSendGapMs({ ...base, jitterMs: 8 * MIN }).ok).toBe(true);
    expect(resolveSendGapMs({ ...base, jitterMs: 15 * MIN }).ok).toBe(true);
    expect(resolveSendGapMs({ ...base, jitterMs: 8 * MIN - 1 })).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
    expect(resolveSendGapMs({ ...base, jitterMs: 15 * MIN + 1 })).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
  });

  it('non-integer, negative and non-finite jitter fails invalid_input before any band check', () => {
    const base = { candidateClass: 'P2' as const, previousSend: prev(1, true, 'P2') };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -30 * MIN, 1000.5]) {
      expect(resolveSendGapMs({ ...base, jitterMs: bad })).toEqual({
        ok: false,
        reason: 'invalid_input',
      });
    }
  });
});

describe('enforceSameGameCooldown — the 90-minute rule', () => {
  const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

  it('a null gameKey ⇒ no rule (the publication is not game-scoped)', () => {
    const result = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: null,
      lastSameGamePublishMs: NOW - MIN,
      meaningfulUpdate: false,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ allowed: true, cooldownRule: 'no_rule' });
  });

  it('a game key with no prior publication ⇒ no rule', () => {
    const result = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: 'game-alpha',
      lastSameGamePublishMs: null,
      meaningfulUpdate: false,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ allowed: true, cooldownRule: 'no_rule' });
  });

  it('exactly 90 minutes elapsed ⇒ outside the cooldown (boundary inclusive)', () => {
    const result = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: 'game-alpha',
      lastSameGamePublishMs: NOW - 90 * MIN,
      meaningfulUpdate: false,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ allowed: true, cooldownRule: 'outside_cooldown' });
  });

  it('89:59 elapsed ⇒ blocked with the exact eligibleAtMs (last + 90 min)', () => {
    const last = NOW - 90 * MIN + 1;
    const result = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: 'game-alpha',
      lastSameGamePublishMs: last,
      meaningfulUpdate: false,
    });
    if (!result.ok || result.value.allowed) throw new Error('expected a typed block');
    expect(result.value).toEqual({
      allowed: false,
      reason: 'same_game_cooldown',
      eligibleAtMs: last + SAME_GAME_COOLDOWN_MS,
    });
  });

  it('a MEANINGFUL UPDATE bypasses the cooldown — an explicit story-layer flag, never an inference', () => {
    const result = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: 'game-alpha',
      lastSameGamePublishMs: NOW - 5 * MIN,
      meaningfulUpdate: true,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ allowed: true, cooldownRule: 'bypassed_meaningful_update' });
  });

  it('input contract: empty/oversized gameKey, non-integer instants, and a FUTURE last-publish fail typed', () => {
    expect(
      enforceSameGameCooldown({
        nowMs: NOW,
        gameKey: '',
        lastSameGamePublishMs: null,
        meaningfulUpdate: false,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      enforceSameGameCooldown({
        nowMs: NOW,
        gameKey: 'g'.repeat(129),
        lastSameGamePublishMs: null,
        meaningfulUpdate: false,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      enforceSameGameCooldown({
        nowMs: 1.5,
        gameKey: 'game-alpha',
        lastSameGamePublishMs: null,
        meaningfulUpdate: false,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      enforceSameGameCooldown({
        nowMs: NOW,
        gameKey: 'game-alpha',
        lastSameGamePublishMs: NOW + 1,
        meaningfulUpdate: false,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('enforceLayoutRunCap — at most three consecutive', () => {
  it('a trailing run of 0, 1 or 2 is allowed; 3 is blocked', () => {
    const cases: ReadonlyArray<readonly [readonly string[], boolean, number]> = [
      [['B'], true, 0],
      [['A'], true, 1],
      [['A', 'A'], true, 2],
      [['A', 'A', 'A'], false, 3],
    ];
    for (const [recentLayouts, allowed, trailingRun] of cases) {
      const result = enforceLayoutRunCap({ layout: 'A', recentLayouts });
      if (!result.ok) throw new Error(result.reason);
      expect(result.value).toEqual({ allowed, trailingRun });
    }
  });

  it('the trailing run counts from the END: A,A,A,B then candidate A is allowed (run 0)', () => {
    const result = enforceLayoutRunCap({ layout: 'A', recentLayouts: ['A', 'A', 'A', 'B'] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ allowed: true, trailingRun: 0 });
  });

  it('an alternating history never accumulates a run (A,B,A,B,A ⇒ run 1)', () => {
    const result = enforceLayoutRunCap({ layout: 'A', recentLayouts: ['A', 'B', 'A', 'B', 'A'] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual({ allowed: true, trailingRun: 1 });
  });

  it('input contract: an empty/oversized layout label or an over-64-entry history fails typed', () => {
    expect(enforceLayoutRunCap({ layout: '', recentLayouts: [] })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(enforceLayoutRunCap({ layout: 'x'.repeat(65), recentLayouts: [] })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(
      enforceLayoutRunCap({ layout: 'A', recentLayouts: Array.from({ length: 65 }, () => 'B') }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('enforceCategoryShare — 40% of the rolling six, exact integer math', () => {
  const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
  const cat = (category: string, minutesAgo: number) => ({
    category,
    atMs: NOW - minutesAgo * MIN,
  });

  it('0 or 1 same-category posts in the rolling six ⇒ allowed; 2 ⇒ blocked unless event-driven', () => {
    const zero = enforceCategoryShare({
      nowMs: NOW,
      category: 'mods',
      recent: [],
      eventDriven: false,
    });
    if (!zero.ok) throw new Error(zero.reason);
    expect(zero.value).toEqual({
      allowed: true,
      rollingCount: 0,
      windowSize: 6,
      maxAllowedCount: 2,
    });

    const one = enforceCategoryShare({
      nowMs: NOW,
      category: 'mods',
      recent: [cat('mods', 10)],
      eventDriven: false,
    });
    if (!one.ok) throw new Error(one.reason);
    expect(one.value.allowed).toBe(true);
    expect(one.value.rollingCount).toBe(1);

    const two = enforceCategoryShare({
      nowMs: NOW,
      category: 'mods',
      recent: [cat('mods', 10), cat('mods', 30)],
      eventDriven: false,
    });
    if (!two.ok) throw new Error('expected a decision');
    expect(two.value).toEqual({
      allowed: false,
      reason: 'category_share_cap',
      rollingCount: 2,
      windowSize: 6,
      maxAllowedCount: 2,
    });

    const twoEventDriven = enforceCategoryShare({
      nowMs: NOW,
      category: 'mods',
      recent: [cat('mods', 10), cat('mods', 30)],
      eventDriven: true,
    });
    if (!twoEventDriven.ok) throw new Error(twoEventDriven.reason);
    expect(twoEventDriven.value.allowed).toBe(true);
  });

  it('the rolling window takes the SIX MOST RECENT — an old same-category post outside the window must NOT count', () => {
    // 7 entries: the OLDEST is the candidate's category but falls outside
    // the six most recent; the newest six contain only 1 same-category post.
    const recent = [
      cat('mainstream_industry', 1),
      cat('leak_rumor', 2),
      cat('mods', 3),
      cat('mainstream_industry', 4),
      cat('leak_rumor', 5),
      cat('mainstream_industry', 6),
      cat('mods', 10_000), // oldest listed = least recent (way outside the six newest)
    ];
    const result = enforceCategoryShare({
      nowMs: NOW,
      category: 'mods',
      recent,
      eventDriven: false,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.rollingCount).toBe(1);
    expect(result.value.allowed).toBe(true);
  });

  it('the category vocabulary is CLOSED: an unknown category fails unknown_category', () => {
    expect(
      enforceCategoryShare({ nowMs: NOW, category: 'gossip', recent: [], eventDriven: false }),
    ).toEqual({ ok: false, reason: 'unknown_category' });
    expect(
      enforceCategoryShare({
        nowMs: NOW,
        category: 'mods',
        recent: [cat('gossip', 1)],
        eventDriven: false,
      }),
    ).toEqual({ ok: false, reason: 'unknown_category' });
  });

  it('input contract: a future timestamp or an over-512-entry history fails invalid_input', () => {
    expect(
      enforceCategoryShare({
        nowMs: NOW,
        category: 'mods',
        recent: [cat('mods', -1)],
        eventDriven: false,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    const tooMany = Array.from({ length: 513 }, (_, index) => cat('mods', index + 1));
    expect(
      enforceCategoryShare({ nowMs: NOW, category: 'mods', recent: tooMany, eventDriven: false }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('assessWeeklyMix — the rolling seven-day report, integer-exact', () => {
  const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
  const cat = (category: string, atMs: number) => ({ category, atMs });

  it('an empty window reports no_data for every category with the exact targets', () => {
    const result = assessWeeklyMix({ nowMs: NOW, recent: [] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.total).toBe(0);
    expect(result.value.perCategory).toHaveLength(10);
    for (const row of result.value.perCategory) {
      expect(row.count).toBe(0);
      expect(row.status).toBe('no_data');
      expect(row.targetPerMille).toBe(MIX_TARGET_PER_MILLE[row.category]);
    }
  });

  it('the window is (now−168h, now]: the boundary post is EXCLUDED, one millisecond newer is INCLUDED', () => {
    const boundary = NOW - WEEKLY_MIX_WINDOW_MS;
    const excluded = assessWeeklyMix({ nowMs: NOW, recent: [cat('mods', boundary)] });
    if (!excluded.ok) throw new Error(excluded.reason);
    expect(excluded.value.total).toBe(0);

    const included = assessWeeklyMix({ nowMs: NOW, recent: [cat('mods', boundary + 1)] });
    if (!included.ok) throw new Error(included.reason);
    expect(included.value.total).toBe(1);
    expect(included.value.perCategory.find((row) => row.category === 'mods')?.count).toBe(1);

    const future = assessWeeklyMix({ nowMs: NOW, recent: [cat('mods', NOW + 1)] });
    expect(future).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('the count comparison is integer-exact: 1 of 10 crack_drm = on_target; 2 = over; 0 = under', () => {
    const recent = [
      cat('crack_drm', NOW - MIN),
      cat('mainstream_industry', NOW - 2 * MIN),
      cat('mainstream_industry', NOW - 3 * MIN),
      cat('release_trailer_patch_dlc', NOW - 4 * MIN),
      cat('mobile', NOW - 5 * MIN),
      cat('hardware', NOW - 6 * MIN),
      cat('leak_rumor', NOW - 7 * MIN),
      cat('esports', NOW - 8 * MIN),
      cat('free_discount_indie', NOW - 9 * MIN),
      cat('emulator_homebrew_jailbreak', NOW - 10 * MIN),
    ];
    const result = assessWeeklyMix({ nowMs: NOW, recent });
    if (!result.ok) throw new Error(result.reason);
    const crack = result.value.perCategory.find((row) => row.category === 'crack_drm');
    expect(crack?.count).toBe(1);
    expect(crack?.status).toBe('on_target'); // 1×1000 === 10×100
    const mainstream = result.value.perCategory.find(
      (row) => row.category === 'mainstream_industry',
    );
    expect(mainstream?.count).toBe(2);
    expect(mainstream?.status).toBe('under_target'); // 2×1000 < 10×250

    const twoCrack = assessWeeklyMix({
      nowMs: NOW,
      recent: [...recent, cat('crack_drm', NOW - 11 * MIN)],
    });
    if (!twoCrack.ok) throw new Error(twoCrack.reason);
    const crack2 = twoCrack.value.perCategory.find((row) => row.category === 'crack_drm');
    expect(crack2?.count).toBe(2);
    expect(crack2?.status).toBe('over_target'); // 2×1000 > 10×100
  });

  it('a post exactly NOW counts; the window end is inclusive', () => {
    const result = assessWeeklyMix({ nowMs: NOW, recent: [cat('hardware', NOW)] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.total).toBe(1);
  });

  it('input contract: unknown categories and oversized history fail typed', () => {
    expect(assessWeeklyMix({ nowMs: NOW, recent: [cat('gossip', NOW)] })).toEqual({
      ok: false,
      reason: 'unknown_category',
    });
    const tooMany = Array.from({ length: 513 }, (_, index) => cat('mods', NOW - index - 1));
    expect(assessWeeklyMix({ nowMs: NOW, recent: tooMany })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });
});

describe('determinism', () => {
  it('the same inputs always yield JSON-equal decisions across all four policies', () => {
    const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
    const gapA = resolveSendGapMs({
      candidateClass: 'P1',
      jitterMs: 10 * MIN,
      previousSend: prev(NOW),
    });
    const gapB = resolveSendGapMs({
      candidateClass: 'P1',
      jitterMs: 10 * MIN,
      previousSend: prev(NOW),
    });
    expect(JSON.stringify(gapA)).toBe(JSON.stringify(gapB));

    const cdA = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: 'g',
      lastSameGamePublishMs: NOW,
      meaningfulUpdate: false,
    });
    const cdB = enforceSameGameCooldown({
      nowMs: NOW,
      gameKey: 'g',
      lastSameGamePublishMs: NOW,
      meaningfulUpdate: false,
    });
    expect(JSON.stringify(cdA)).toBe(JSON.stringify(cdB));

    const lrA = enforceLayoutRunCap({ layout: 'A', recentLayouts: ['A', 'A'] });
    const lrB = enforceLayoutRunCap({ layout: 'A', recentLayouts: ['A', 'A'] });
    expect(JSON.stringify(lrA)).toBe(JSON.stringify(lrB));

    const mixA = assessWeeklyMix({ nowMs: NOW, recent: [{ category: 'mods', atMs: NOW }] });
    const mixB = assessWeeklyMix({ nowMs: NOW, recent: [{ category: 'mods', atMs: NOW }] });
    expect(JSON.stringify(mixA)).toBe(JSON.stringify(mixB));
  });
});
