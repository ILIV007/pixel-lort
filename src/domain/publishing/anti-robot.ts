/**
 * Phase 8.1 — ANTI-ROBOT RULES (blueprint §16 «Anti-robot rules»).
 *
 * TOTAL, DETERMINISTIC, PURE policy functions under the pinned policy
 * version `arp1`. No I/O, no clock, no network, no randomness: the
 * humanizing jitter is ALWAYS a caller-supplied deterministic input
 * validated against the selected band — the domain never generates a
 * random value (JSON-equal determinism is pinned by test).
 *
 * THE RULES (blueprint §16, with the arp1 pins marked):
 *   1. send-gap bands — 25–45 minutes NORMAL; 8–15 minutes when the
 *      candidate is P1; an UNRELATED P0 may bypass with a SMALL
 *      anti-flood gap. The blueprint leaves «small» UNQUANTIFIED, so
 *      arp1 pins it honestly: 2–4 minutes (a documented policy pin,
 *      recorded in the ADR — a pin, not a blueprint quote). A RELATED
 *      P0 does NOT bypass: the conservative normal band applies (the
 *      arp1 pin — the blueprint grants the bypass to UNRELATED P0
 *      only, and says nothing about related ones; the safer reading
 *      is taken and documented).
 *   2. same-game cooldown — 90 minutes UNLESS the story layer asserts
 *      a meaningful update (an EXPLICIT input flag, the 7.2
 *      storyDemands… precedent: never an inference).
 *   3. layout run cap — at most THREE consecutive posts with the same
 *      opaque layout label; the trailing run is counted from the END
 *      of the chronological history (oldest first — the order is
 *      pinned and tested).
 *   4. category share cap — a candidate category may not become more
 *      than 40% of the rolling six most recent posts unless the story
 *      layer marks the publication event-driven. EXACT integer math:
 *      admitted iff (rollingCount + 1) ≤ 2 (2.4 floored by the
 *      ≤ comparison — never a floating-point share). The rolling six
 *      are the six most recent by timestamp (ties broken by earlier
 *      input position — deterministic).
 *   5. weekly content mix — the ten blueprint categories with their
 *      EXACT per-mille targets over a ROLLING 168-hour window
 *      (now−168h, now]: the comparison is integer-exact
 *      (count×1000 vs total×target); the status vocabulary is
 *      under_target / on_target / over_target (no_data for an empty
 *      window). NO floating-point percentage is ever produced. The
 *      mix REPORT is advisory for news classes; the HARD enforcement
 *      point is the P3 FILLER discretion in the Phase 8.1 composition
 *      (documented there and in the ADR) — «never forced per day» is
 *      honored because the mix gate never blocks news.
 *
 * THE CATEGORY VOCABULARY IS CLOSED: the ten blueprint §16 mix
 * categories, translated to stable snake_case labels (the mapping is
 * verbatim in MIX_TARGET_PER_MILLE). An unknown category fails TYPED
 * (`unknown_category`) — widening the vocabulary is a policy-version
 * change, never a silent pass.
 *
 * EVERY input-contract violation fails TYPED — never clamped, never
 * guessed: non-integer/future timestamps, non-boolean flags, empty or
 * oversized opaque labels/keys, oversized bounded histories.
 */

import type { PublicationPriorityClass } from './priority-classes';

export const ANTI_ROBOT_POLICY_VERSION = 'arp1' as const;

/** 25–45 minutes — the normal gap band (blueprint §16). */
export const NORMAL_GAP_MIN_MS = 25 * 60_000;
export const NORMAL_GAP_MAX_MS = 45 * 60_000;

/** 8–15 minutes — the P1 gap band (blueprint §16). */
export const P1_GAP_MIN_MS = 8 * 60_000;
export const P1_GAP_MAX_MS = 15 * 60_000;

/**
 * 2–4 minutes — the arp1 pin for the blueprint's unquantified
 * «small anti-flood gap» granted to an UNRELATED P0.
 */
export const ANTI_FLOOD_GAP_MIN_MS = 2 * 60_000;
export const ANTI_FLOOD_GAP_MAX_MS = 4 * 60_000;

/** 90 minutes — the same-game cooldown (blueprint §16). */
export const SAME_GAME_COOLDOWN_MS = 90 * 60_000;

/** At most three consecutive posts with the same layout (blueprint §16). */
export const MAX_CONSECUTIVE_SAME_LAYOUT = 3;

/** The category share cap rides the rolling SIX most recent posts. */
export const CATEGORY_ROLLING_WINDOW = 6;

/**
 * The exact integer ceiling for one category inside the rolling six:
 * 40% of six is 2.4 — the candidate is admitted iff
 * (rollingCount + 1) ≤ 2, so at most 2 of any six-window.
 */
export const CATEGORY_MAX_ALLOWED_COUNT = 2;

/** The rolling seven-day mix window: exactly 168 hours. */
export const WEEKLY_MIX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Bounded history sizes (input-contract pins). */
export const MAX_LAYOUT_HISTORY = 64;
export const MAX_CATEGORY_HISTORY = 512;
export const MAX_OPAQUE_LABEL_LENGTH = 64;
export const MAX_GAME_KEY_LENGTH = 128;

/**
 * The CLOSED mix-category vocabulary, translated verbatim from the
 * blueprint §16 weekly target mix into stable snake_case labels.
 */
export const MIX_CATEGORIES = [
  'crack_drm',
  'leak_rumor',
  'mods',
  'emulator_homebrew_jailbreak',
  'mainstream_industry',
  'release_trailer_patch_dlc',
  'mobile',
  'hardware',
  'free_discount_indie',
  'esports',
] as const;

export type MixCategory = (typeof MIX_CATEGORIES)[number];

/** The exact blueprint §16 weekly targets, in per-mille (sum = 1000). */
export const MIX_TARGET_PER_MILLE: Readonly<Record<MixCategory, number>> = {
  crack_drm: 100, // crack/DRM 10%
  leak_rumor: 80, // leak/rumor 8%
  mods: 70, // mods 7%
  emulator_homebrew_jailbreak: 50, // emulator/homebrew/jailbreak 5%
  mainstream_industry: 250, // mainstream/industry 25%
  release_trailer_patch_dlc: 150, // release/trailer/patch/DLC 15%
  mobile: 100, // mobile 10%
  hardware: 100, // hardware 10%
  free_discount_indie: 70, // free/discount/indie 7%
  esports: 30, // esports 3%
};

function isMixCategory(value: string): value is MixCategory {
  return (MIX_CATEGORIES as readonly string[]).includes(value);
}

/** The CLOSED-vocabulary predicate, exported for composition inputs. */
export function isMixCategoryValue(value: string): value is MixCategory {
  return isMixCategory(value);
}

function isIntegerMs(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isValidOpaqueLabel(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength;
}

// ---------------------------------------------------------------------------
// 1. the send-gap bands
// ---------------------------------------------------------------------------

export type SendGapRule = 'no_previous_send' | 'anti_flood_bypass' | 'normal_gap' | 'p1_gap';

export interface SendGapBounds {
  readonly minMs: number;
  readonly maxMs: number;
}

export interface SendGapInput {
  readonly candidateClass: PublicationPriorityClass;
  /** Caller-supplied deterministic jitter INSIDE the selected band. */
  readonly jitterMs: number;
  readonly previousSend: {
    readonly atMs: number;
    readonly related: boolean;
    readonly priorityClass: PublicationPriorityClass;
  } | null;
}

export type SendGapResult =
  | {
      ok: true;
      value: {
        gapMs: number;
        rule: SendGapRule;
        /** null when no previous send exists — no band applies. */
        boundsMs: SendGapBounds | null;
      };
    }
  | { ok: false; reason: 'invalid_input' | 'jitter_out_of_bounds' };

const PRIORITY_CLASSES: readonly PublicationPriorityClass[] = ['P0', 'P1', 'P2', 'P3'];

function isPriorityClass(value: string): value is PublicationPriorityClass {
  return (PRIORITY_CLASSES as readonly string[]).includes(value);
}

/**
 * Select the send-gap band for a candidate and validate the
 * caller-supplied jitter against EXACTLY that band. With no previous
 * send no band applies (gapMs 0, bounds null) and the jitter is
 * accepted as long as it is a valid non-negative integer (it is
 * simply not used).
 */
export function resolveSendGapMs(input: SendGapInput): SendGapResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  if (typeof input.candidateClass !== 'string' || !isPriorityClass(input.candidateClass)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!isIntegerMs(input.jitterMs)) return { ok: false, reason: 'invalid_input' };
  const previous = input.previousSend;
  if (previous !== null) {
    if (typeof previous !== 'object') return { ok: false, reason: 'invalid_input' };
    if (!isIntegerMs(previous.atMs)) return { ok: false, reason: 'invalid_input' };
    if (typeof previous.related !== 'boolean') return { ok: false, reason: 'invalid_input' };
    if (typeof previous.priorityClass !== 'string' || !isPriorityClass(previous.priorityClass)) {
      return { ok: false, reason: 'invalid_input' };
    }
  }
  if (previous === null) {
    return { ok: true, value: { gapMs: 0, rule: 'no_previous_send', boundsMs: null } };
  }
  let rule: Exclude<SendGapRule, 'no_previous_send'>;
  let bounds: SendGapBounds;
  if (input.candidateClass === 'P0' && !previous.related) {
    rule = 'anti_flood_bypass';
    bounds = { minMs: ANTI_FLOOD_GAP_MIN_MS, maxMs: ANTI_FLOOD_GAP_MAX_MS };
  } else if (input.candidateClass === 'P1') {
    rule = 'p1_gap';
    bounds = { minMs: P1_GAP_MIN_MS, maxMs: P1_GAP_MAX_MS };
  } else {
    // P2/P3 always; a RELATED P0 too (the conservative arp1 pin).
    rule = 'normal_gap';
    bounds = { minMs: NORMAL_GAP_MIN_MS, maxMs: NORMAL_GAP_MAX_MS };
  }
  if (input.jitterMs < bounds.minMs || input.jitterMs > bounds.maxMs) {
    return { ok: false, reason: 'jitter_out_of_bounds' };
  }
  return { ok: true, value: { gapMs: input.jitterMs, rule, boundsMs: bounds } };
}

// ---------------------------------------------------------------------------
// 2. the same-game cooldown
// ---------------------------------------------------------------------------

export type SameGameCooldownDecision =
  | { allowed: true; cooldownRule: 'no_rule' | 'outside_cooldown' | 'bypassed_meaningful_update' }
  | { allowed: false; reason: 'same_game_cooldown'; eligibleAtMs: number };

export type SameGameCooldownResult =
  { ok: true; value: SameGameCooldownDecision } | { ok: false; reason: 'invalid_input' };

export interface SameGameCooldownInput {
  readonly nowMs: number;
  /** The opaque game identity key, or null when not game-scoped. */
  readonly gameKey: string | null;
  readonly lastSameGamePublishMs: number | null;
  /** The EXPLICIT story-layer flag — never inferred here. */
  readonly meaningfulUpdate: boolean;
}

/**
 * The 90-minute same-game cooldown. `gameKey: null` or a first
 * publication for the game ⇒ no rule. The cooldown has elapsed when
 * nowMs ≥ last + 90min (boundary inclusive). Within the cooldown the
 * EXPLICIT `meaningfulUpdate` flag bypasses with a recorded rule —
 * the cooldown block itself carries the EXACT eligibleAtMs.
 */
export function enforceSameGameCooldown(input: SameGameCooldownInput): SameGameCooldownResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  if (!isIntegerMs(input.nowMs)) return { ok: false, reason: 'invalid_input' };
  if (input.gameKey !== null && !isValidOpaqueLabel(input.gameKey, MAX_GAME_KEY_LENGTH)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.lastSameGamePublishMs !== null && !isIntegerMs(input.lastSameGamePublishMs)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (typeof input.meaningfulUpdate !== 'boolean') return { ok: false, reason: 'invalid_input' };
  if (input.gameKey === null || input.lastSameGamePublishMs === null) {
    return { ok: true, value: { allowed: true, cooldownRule: 'no_rule' } };
  }
  // Honest history: a last-publish timestamp cannot be in the future.
  if (input.lastSameGamePublishMs > input.nowMs) return { ok: false, reason: 'invalid_input' };
  const eligibleAtMs = input.lastSameGamePublishMs + SAME_GAME_COOLDOWN_MS;
  if (input.nowMs >= eligibleAtMs) {
    return { ok: true, value: { allowed: true, cooldownRule: 'outside_cooldown' } };
  }
  if (input.meaningfulUpdate) {
    return { ok: true, value: { allowed: true, cooldownRule: 'bypassed_meaningful_update' } };
  }
  return { ok: true, value: { allowed: false, reason: 'same_game_cooldown', eligibleAtMs } };
}

// ---------------------------------------------------------------------------
// 3. the layout run cap
// ---------------------------------------------------------------------------

export type LayoutRunResult =
  | { ok: true; value: { allowed: boolean; trailingRun: number } }
  | { ok: false; reason: 'invalid_input' };

export interface LayoutRunInput {
  readonly layout: string;
  /** Chronological, OLDEST FIRST (pinned order), at most 64 entries. */
  readonly recentLayouts: readonly string[];
}

/**
 * At most three consecutive posts with the same opaque layout label.
 * The trailing run counts CONSECUTIVE equal labels from the END of
 * the chronological history; the candidate is allowed iff the run it
 * would extend is shorter than three (trailingRun < 3).
 */
export function enforceLayoutRunCap(input: LayoutRunInput): LayoutRunResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  if (!isValidOpaqueLabel(input.layout, MAX_OPAQUE_LABEL_LENGTH)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Array.isArray(input.recentLayouts) || input.recentLayouts.length > MAX_LAYOUT_HISTORY) {
    return { ok: false, reason: 'invalid_input' };
  }
  for (const entry of input.recentLayouts) {
    if (!isValidOpaqueLabel(entry, MAX_OPAQUE_LABEL_LENGTH))
      return { ok: false, reason: 'invalid_input' };
  }
  let trailingRun = 0;
  for (let index = input.recentLayouts.length - 1; index >= 0; index--) {
    if (input.recentLayouts[index] !== input.layout) break;
    trailingRun++;
  }
  return { ok: true, value: { allowed: trailingRun < MAX_CONSECUTIVE_SAME_LAYOUT, trailingRun } };
}

// ---------------------------------------------------------------------------
// 4. the category share cap (rolling six, exact integer math)
// ---------------------------------------------------------------------------

export interface CategoryHistoryEntry {
  readonly category: string;
  readonly atMs: number;
}

export type CategoryShareDecision =
  | { allowed: true; rollingCount: number; windowSize: number; maxAllowedCount: number }
  | {
      allowed: false;
      reason: 'category_share_cap';
      rollingCount: number;
      windowSize: number;
      maxAllowedCount: number;
    };

export type CategoryShareResult =
  | { ok: true; value: CategoryShareDecision }
  | { ok: false; reason: 'unknown_category' | 'invalid_input' };

export interface CategoryShareInput {
  readonly nowMs: number;
  readonly category: string;
  readonly recent: readonly CategoryHistoryEntry[];
  /** The EXPLICIT story-layer event-driven flag — never inferred. */
  readonly eventDriven: boolean;
}

/**
 * The 40%-of-rolling-six cap with EXACT integer math: the candidate
 * is admitted iff (rollingCount + 1) ≤ 2 (at most 2 of any six
 * window), unless the story layer asserted `eventDriven`. The
 * rolling six are the six most recent entries by atMs (ties broken
 * by the earlier input position — deterministic, never by array
 * luck).
 */
export function enforceCategoryShare(input: CategoryShareInput): CategoryShareResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  if (!isIntegerMs(input.nowMs)) return { ok: false, reason: 'invalid_input' };
  if (typeof input.category !== 'string' || !isMixCategory(input.category)) {
    return { ok: false, reason: 'unknown_category' };
  }
  if (typeof input.eventDriven !== 'boolean') return { ok: false, reason: 'invalid_input' };
  if (!Array.isArray(input.recent) || input.recent.length > MAX_CATEGORY_HISTORY) {
    return { ok: false, reason: 'invalid_input' };
  }
  for (const entry of input.recent) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'invalid_input' };
    if (typeof entry.category !== 'string' || !isMixCategory(entry.category)) {
      return { ok: false, reason: 'unknown_category' };
    }
    if (!isIntegerMs(entry.atMs) || entry.atMs > input.nowMs) {
      return { ok: false, reason: 'invalid_input' };
    }
  }
  const ordered = input.recent
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.atMs !== b.entry.atMs ? b.entry.atMs - a.entry.atMs : a.index - b.index,
    )
    .slice(0, CATEGORY_ROLLING_WINDOW);
  const rollingCount = ordered.filter((item) => item.entry.category === input.category).length;
  const windowSize = CATEGORY_ROLLING_WINDOW;
  const maxAllowedCount = CATEGORY_MAX_ALLOWED_COUNT;
  if (rollingCount + 1 <= maxAllowedCount || input.eventDriven) {
    return { ok: true, value: { allowed: true, rollingCount, windowSize, maxAllowedCount } };
  }
  return {
    ok: true,
    value: {
      allowed: false,
      reason: 'category_share_cap',
      rollingCount,
      windowSize,
      maxAllowedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. the weekly content mix (rolling 168h, integer-exact)
// ---------------------------------------------------------------------------

export type MixStatus = 'under_target' | 'on_target' | 'over_target' | 'no_data';

export interface MixCategoryReport {
  readonly category: MixCategory;
  readonly count: number;
  readonly targetPerMille: number;
  readonly status: MixStatus;
}

export type WeeklyMixResult =
  | {
      ok: true;
      value: {
        windowStartMs: number;
        windowEndMs: number;
        total: number;
        perCategory: readonly MixCategoryReport[];
      };
    }
  | { ok: false; reason: 'unknown_category' | 'invalid_input' };

export interface WeeklyMixInput {
  readonly nowMs: number;
  readonly recent: readonly CategoryHistoryEntry[];
}

/**
 * The rolling seven-day mix report over the CLOSED ten-category
 * vocabulary. The window is (nowMs − 168h, nowMs] — strictly after
 * the start boundary, inclusive at now. The comparison is
 * integer-exact: count×1000 vs total×targetPerMille (equal ⇒
 * on_target); an empty window reports no_data for every category.
 * NO floating-point share is ever computed or reported.
 */
export function assessWeeklyMix(input: WeeklyMixInput): WeeklyMixResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  if (!isIntegerMs(input.nowMs)) return { ok: false, reason: 'invalid_input' };
  if (!Array.isArray(input.recent) || input.recent.length > MAX_CATEGORY_HISTORY) {
    return { ok: false, reason: 'invalid_input' };
  }
  for (const entry of input.recent) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'invalid_input' };
    if (typeof entry.category !== 'string' || !isMixCategory(entry.category)) {
      return { ok: false, reason: 'unknown_category' };
    }
    if (!isIntegerMs(entry.atMs) || entry.atMs > input.nowMs) {
      return { ok: false, reason: 'invalid_input' };
    }
  }
  const windowStartMs = input.nowMs - WEEKLY_MIX_WINDOW_MS;
  const inWindow = input.recent.filter(
    (entry) => entry.atMs > windowStartMs && entry.atMs <= input.nowMs,
  );
  const total = inWindow.length;
  const perCategory: MixCategoryReport[] = MIX_CATEGORIES.map((category) => {
    const targetPerMille = MIX_TARGET_PER_MILLE[category];
    const count = inWindow.filter((entry) => entry.category === category).length;
    if (total === 0) return { category, count: 0, targetPerMille, status: 'no_data' as const };
    const scaled = count * 1000;
    const targetScaled = total * targetPerMille;
    const status: MixStatus =
      scaled < targetScaled
        ? 'under_target'
        : scaled === targetScaled
          ? 'on_target'
          : 'over_target';
    return { category, count, targetPerMille, status };
  });
  return { ok: true, value: { windowStartMs, windowEndMs: input.nowMs, total, perCategory } };
}
