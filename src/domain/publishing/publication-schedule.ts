/**
 * Phase 8.1 — THE PUBLICATION SCHEDULE COMPOSITION (blueprint §16).
 *
 * The composed TOTAL decision the Phase 8.2 durable scheduler will
 * consume: Tehran windows (twp1) × priority classes (pcp1) ×
 * anti-robot rules (arp1) under the composition version `psp1`.
 * Pure — no I/O, no clock, no network, no randomness (the jitter is
 * ALWAYS a caller-supplied deterministic input); the same input
 * ALWAYS yields the JSON-equal decision.
 *
 * THE DOCUMENTED PRECEDENCE (every rule evaluated + recorded in
 * `appliedRules`; typed input failures propagate in rule order; the
 * most restrictive outcome wins):
 *   1. layout run cap — NOT time-resolvable ⇒ a block is a typed
 *      DEFER with dueAtMs NULL (the caller must change the input);
 *   2. category share cap — NOT time-resolvable by waiting alone ⇒
 *      a block is a typed DEFER unless eventDriven (bypass record);
 *   3. mix gate — enforcement ONLY on P3 filler discretion
 *      (over-target ⇒ typed DEFER `mix_target_cap`); P0/P1/P2 get an
 *      ADVISORY record — news is never blocked by mix («never forced
 *      per day», honored);
 *   4. time computation — P0: now + the selected gap jitter
 *      (anti-flood 2–4 min unrelated / normal 25–45 min related /
 *      none without a previous send); P1: now + jitterMs validated
 *      against the LATENCY bounds (5–20 min), raised to the fixed
 *      spacing floor (previous send + 8 min P1 gap minimum — the
 *      floor can dominate and that is recorded, never hidden);
 *      P2/P3: max(now, previous send + 25–45 min jitter), clamped so
 *      a due is NEVER in the past;
 *   5. same-game cooldown shift (time-resolvable: due = max(due,
 *      eligibleAt), recorded `shifted_to_eligible_at`);
 *   6. window gate LAST, quiet-gated classes ONLY (P2/P3 — the
 *      blueprint names quiet «for P2/P3»; P0 explicitly bypasses;
 *      P1's 5–20 minute contract is incompatible with a quiet
 *      deferral — the documented pin): a due outside an ACTIVE
 *      window defers to the next active window START
 *      (`deferred_to_window_start`, the abandoned candidate recorded).
 *
 * A DEFERRED decision carries dueAtMs NULL — no fabricated
 * timestamp. Every decision carries the four component policy
 * versions. Honest history: a previousSend / lastPublish / history
 * entry timestamped in the future fails typed.
 */

import {
  ANTI_ROBOT_POLICY_VERSION,
  P1_GAP_MIN_MS,
  assessWeeklyMix,
  enforceCategoryShare,
  enforceLayoutRunCap,
  enforceSameGameCooldown,
  isMixCategoryValue,
  resolveSendGapMs,
  type MixCategory,
  type MixStatus,
  type SendGapRule,
} from './anti-robot';
import {
  PRIORITY_POLICY_VERSION,
  classifyPriority,
  type PublicationPriorityClass,
} from './priority-classes';
import {
  TEHRAN_WINDOWS_POLICY_VERSION,
  classifyTehranWindow,
  nextActiveWindowStart,
  type TehranWindowKind,
  type TehranWindowName,
} from './tehran-windows';

export const SCHEDULE_POLICY_VERSION = 'psp1' as const;

const P1_LATENCY_MIN_MS = 5 * 60_000;
const P1_LATENCY_MAX_MS = 20 * 60_000;
/** The composition's bounded layout-history input (anti-robot's pin). */
const MAX_LAYOUT_HISTORY = 64;

const PRIORITY_CLASSES: readonly PublicationPriorityClass[] = ['P0', 'P1', 'P2', 'P3'];

function isPriorityClass(value: string): value is PublicationPriorityClass {
  return (PRIORITY_CLASSES as readonly string[]).includes(value);
}

function isIntegerMs(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

export interface PublicationScheduleInputV1 {
  readonly schemaVersion: 1;
  /** The decision instant (epoch ms, integer). */
  readonly nowMs: number;
  /** The candidate's editorial category (CLOSED mix vocabulary). */
  readonly category: MixCategory;
  /** The candidate's opaque layout label (the run cap's subject). */
  readonly candidateLayout: string;
  /** The editorial score 0..100 (integer). */
  readonly priorityScore: number;
  /** The caller-supplied deterministic jitter (validated per class). */
  readonly jitterMs: number;
  readonly previousSend: {
    readonly atMs: number;
    readonly related: boolean;
    readonly priorityClass: PublicationPriorityClass;
  } | null;
  /** Chronological, OLDEST FIRST, at most 64 opaque labels. */
  readonly recentLayouts: readonly string[];
  /** The rolling category history (also the 7-day mix history). */
  readonly recentCategories: readonly { readonly category: string; readonly atMs: number }[];
  readonly sameGame: {
    readonly gameKey: string | null;
    readonly lastPublishMs: number | null;
    readonly meaningfulUpdate: boolean;
  } | null;
  /** The EXPLICIT story-layer event-driven flag. */
  readonly eventDriven: boolean;
}

export type ScheduleWindowSummary = {
  readonly name: TehranWindowName;
  readonly kind: TehranWindowKind;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
};

export type ScheduleAppliedRule =
  | { readonly rule: 'send_gap'; readonly gapRule: SendGapRule }
  | { readonly rule: 'latency_bound'; readonly class: 'P1' }
  | {
      readonly rule: 'window_gate';
      readonly result: 'inside_active_window' | 'deferred_to_window_start';
      readonly deferredFromMs?: number;
    }
  | {
      readonly rule: 'same_game_cooldown';
      readonly result:
        'no_rule' | 'outside_cooldown' | 'bypassed_meaningful_update' | 'shifted_to_eligible_at';
    }
  | {
      readonly rule: 'layout_run_cap';
      readonly trailingRun: number;
      readonly result: 'within_cap' | 'blocked';
    }
  | {
      readonly rule: 'category_share_cap';
      readonly rollingCount: number;
      readonly result: 'within_cap' | 'bypassed_event_driven' | 'blocked';
    }
  | {
      readonly rule: 'mix_target';
      readonly category: MixCategory;
      readonly status: MixStatus;
      readonly result: 'advisory' | 'filler_blocked';
    };

export type SchedulePolicyVersions = {
  readonly windows: typeof TEHRAN_WINDOWS_POLICY_VERSION;
  readonly priority: typeof PRIORITY_POLICY_VERSION;
  readonly antiRobot: typeof ANTI_ROBOT_POLICY_VERSION;
  readonly composition: typeof SCHEDULE_POLICY_VERSION;
};

export type ScheduleInputFailureReason =
  | 'schema_version_malformed'
  | 'schema_version_unsupported'
  | 'invalid_input'
  | 'invalid_score'
  | 'jitter_out_of_bounds'
  | 'unknown_category';

export type PublicationScheduleDecision =
  | {
      ok: true;
      outcome: 'schedule';
      schemaVersion: 1;
      dueAtMs: number;
      window: ScheduleWindowSummary;
      appliedRules: readonly ScheduleAppliedRule[];
      policyVersions: SchedulePolicyVersions;
    }
  | {
      ok: true;
      outcome: 'defer';
      schemaVersion: 1;
      reason: 'layout_run_cap' | 'category_share_cap' | 'mix_target_cap';
      dueAtMs: null;
      appliedRules: readonly ScheduleAppliedRule[];
      policyVersions: SchedulePolicyVersions;
    }
  | { ok: false; reason: ScheduleInputFailureReason };

const POLICY_VERSIONS: SchedulePolicyVersions = {
  windows: TEHRAN_WINDOWS_POLICY_VERSION,
  priority: PRIORITY_POLICY_VERSION,
  antiRobot: ANTI_ROBOT_POLICY_VERSION,
  composition: SCHEDULE_POLICY_VERSION,
};

function isValidPreviousSend(
  previous: PublicationScheduleInputV1['previousSend'],
  nowMs: number,
): boolean {
  if (previous === null) return true;
  if (typeof previous !== 'object') return false;
  if (!isIntegerMs(previous.atMs) || previous.atMs > nowMs) return false;
  if (typeof previous.related !== 'boolean') return false;
  if (typeof previous.priorityClass !== 'string' || !isPriorityClass(previous.priorityClass))
    return false;
  return true;
}

function isValidCategoryHistory(
  recent: PublicationScheduleInputV1['recentCategories'],
  nowMs: number,
): boolean {
  if (!Array.isArray(recent) || recent.length > 512) return false;
  for (const entry of recent) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.category !== 'string') return false;
    if (!isIntegerMs(entry.atMs) || entry.atMs > nowMs) return false;
  }
  return true;
}

export function planPublicationTime(
  input: PublicationScheduleInputV1,
): PublicationScheduleDecision {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  if (
    input.schemaVersion === undefined ||
    input.schemaVersion === null ||
    typeof input.schemaVersion !== 'number'
  ) {
    return { ok: false, reason: 'schema_version_malformed' };
  }
  if (input.schemaVersion !== 1) return { ok: false, reason: 'schema_version_unsupported' };
  if (!isIntegerMs(input.nowMs)) return { ok: false, reason: 'invalid_input' };
  if (typeof input.eventDriven !== 'boolean') return { ok: false, reason: 'invalid_input' };
  if (typeof input.category !== 'string' || !isMixCategoryValue(input.category)) {
    return { ok: false, reason: 'unknown_category' };
  }
  if (!isValidPreviousSend(input.previousSend, input.nowMs))
    return { ok: false, reason: 'invalid_input' };
  if (!isValidCategoryHistory(input.recentCategories, input.nowMs)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (
    !Array.isArray(input.recentLayouts) ||
    input.recentLayouts.length > MAX_LAYOUT_HISTORY ||
    input.recentLayouts.some((entry) => typeof entry !== 'string')
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.sameGame !== null) {
    if (typeof input.sameGame !== 'object') return { ok: false, reason: 'invalid_input' };
    if (input.sameGame.gameKey !== null && typeof input.sameGame.gameKey !== 'string') {
      return { ok: false, reason: 'invalid_input' };
    }
    if (input.sameGame.lastPublishMs !== null && !isIntegerMs(input.sameGame.lastPublishMs)) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (input.sameGame.lastPublishMs !== null && input.sameGame.lastPublishMs > input.nowMs) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (typeof input.sameGame.meaningfulUpdate !== 'boolean') {
      return { ok: false, reason: 'invalid_input' };
    }
  }

  const priority = classifyPriority(input.priorityScore);
  if (!priority.ok) return { ok: false, reason: priority.reason };
  const priorityClass = priority.value.class;
  const descriptor = priority.value.descriptor;

  const appliedRules: ScheduleAppliedRule[] = [];

  // --- 1. the layout run cap (NOT time-resolvable) ----------------------
  const layoutCheck = enforceLayoutRunCap({
    layout: input.candidateLayout,
    recentLayouts: input.recentLayouts,
  });
  if (!layoutCheck.ok) return { ok: false, reason: 'invalid_input' };
  if (!layoutCheck.value.allowed) {
    return {
      ok: true,
      outcome: 'defer',
      schemaVersion: 1,
      reason: 'layout_run_cap',
      dueAtMs: null,
      appliedRules: [
        ...appliedRules,
        { rule: 'layout_run_cap', trailingRun: layoutCheck.value.trailingRun, result: 'blocked' },
      ],
      policyVersions: POLICY_VERSIONS,
    };
  }
  appliedRules.push({
    rule: 'layout_run_cap',
    trailingRun: layoutCheck.value.trailingRun,
    result: 'within_cap',
  });

  // --- 2. the category share cap (NOT time-resolvable by waiting) -------
  const shareCheck = enforceCategoryShare({
    nowMs: input.nowMs,
    category: input.category,
    recent: input.recentCategories,
    eventDriven: input.eventDriven,
  });
  if (!shareCheck.ok) return { ok: false, reason: shareCheck.reason };
  if (!shareCheck.value.allowed) {
    return {
      ok: true,
      outcome: 'defer',
      schemaVersion: 1,
      reason: 'category_share_cap',
      dueAtMs: null,
      appliedRules: [
        ...appliedRules,
        {
          rule: 'category_share_cap',
          rollingCount: shareCheck.value.rollingCount,
          result: 'blocked',
        },
      ],
      policyVersions: POLICY_VERSIONS,
    };
  }
  appliedRules.push({
    rule: 'category_share_cap',
    rollingCount: shareCheck.value.rollingCount,
    result:
      input.eventDriven && shareCheck.value.rollingCount + 1 > shareCheck.value.maxAllowedCount
        ? 'bypassed_event_driven'
        : 'within_cap',
  });

  // --- 3. the mix gate (enforcement ONLY on P3 filler discretion) -------
  const mix = assessWeeklyMix({ nowMs: input.nowMs, recent: input.recentCategories });
  if (!mix.ok) return { ok: false, reason: mix.reason };
  const mixRow = mix.value.perCategory.find((row) => row.category === input.category);
  if (!mixRow) return { ok: false, reason: 'unknown_category' };
  if (priorityClass === 'P3' && mixRow.status === 'over_target') {
    return {
      ok: true,
      outcome: 'defer',
      schemaVersion: 1,
      reason: 'mix_target_cap',
      dueAtMs: null,
      appliedRules: [
        ...appliedRules,
        {
          rule: 'mix_target',
          category: input.category,
          status: mixRow.status,
          result: 'filler_blocked',
        },
      ],
      policyVersions: POLICY_VERSIONS,
    };
  }
  appliedRules.push({
    rule: 'mix_target',
    category: input.category,
    status: mixRow.status,
    result: 'advisory',
  });

  // --- 4. the time computation ------------------------------------------
  let dueAtMs: number;
  if (priorityClass === 'P0') {
    const gap = resolveSendGapMs({
      candidateClass: 'P0',
      jitterMs: input.jitterMs,
      previousSend: input.previousSend,
    });
    if (!gap.ok) return { ok: false, reason: gap.reason };
    dueAtMs = input.nowMs + gap.value.gapMs;
    appliedRules.push({ rule: 'send_gap', gapRule: gap.value.rule });
  } else if (priorityClass === 'P1') {
    if (
      !Number.isFinite(input.jitterMs) ||
      !Number.isInteger(input.jitterMs) ||
      input.jitterMs < 0
    ) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (input.jitterMs < P1_LATENCY_MIN_MS || input.jitterMs > P1_LATENCY_MAX_MS) {
      return { ok: false, reason: 'jitter_out_of_bounds' };
    }
    dueAtMs = input.nowMs + input.jitterMs;
    appliedRules.push({ rule: 'latency_bound', class: 'P1' });
    if (input.previousSend !== null) {
      const spacingFloor = input.previousSend.atMs + P1_GAP_MIN_MS;
      if (spacingFloor > dueAtMs) dueAtMs = spacingFloor;
      appliedRules.push({ rule: 'send_gap', gapRule: 'p1_gap' });
    } else {
      appliedRules.push({ rule: 'send_gap', gapRule: 'no_previous_send' });
    }
  } else {
    const gap = resolveSendGapMs({
      candidateClass: priorityClass,
      jitterMs: input.jitterMs,
      previousSend: input.previousSend,
    });
    if (!gap.ok) return { ok: false, reason: gap.reason };
    dueAtMs =
      input.previousSend !== null
        ? Math.max(input.nowMs, input.previousSend.atMs + gap.value.gapMs)
        : input.nowMs;
    appliedRules.push({ rule: 'send_gap', gapRule: gap.value.rule });
  }

  // --- 5. the same-game cooldown shift (time-resolvable) ----------------
  if (input.sameGame !== null) {
    const cooldown = enforceSameGameCooldown({
      nowMs: input.nowMs,
      gameKey: input.sameGame.gameKey,
      lastSameGamePublishMs: input.sameGame.lastPublishMs,
      meaningfulUpdate: input.sameGame.meaningfulUpdate,
    });
    if (!cooldown.ok) return { ok: false, reason: cooldown.reason };
    if (cooldown.value.allowed) {
      appliedRules.push({ rule: 'same_game_cooldown', result: cooldown.value.cooldownRule });
    } else {
      dueAtMs = Math.max(dueAtMs, cooldown.value.eligibleAtMs);
      appliedRules.push({ rule: 'same_game_cooldown', result: 'shifted_to_eligible_at' });
    }
  }

  // --- 6. the window gate LAST (quiet-gated classes only) ---------------
  const dueWindow = classifyTehranWindow(dueAtMs);
  if (!dueWindow.ok) return { ok: false, reason: 'invalid_input' };
  if (descriptor.quietGated && dueWindow.value.kind !== 'active') {
    const nextWindow = nextActiveWindowStart(dueAtMs);
    if (!nextWindow.ok) return { ok: false, reason: 'invalid_input' };
    const deferredFromMs = dueAtMs;
    dueAtMs = nextWindow.value.atMs;
    const finalWindow = classifyTehranWindow(dueAtMs);
    if (!finalWindow.ok) return { ok: false, reason: 'invalid_input' };
    return {
      ok: true,
      outcome: 'schedule',
      schemaVersion: 1,
      dueAtMs,
      window: finalWindow.value,
      appliedRules: [
        ...appliedRules,
        { rule: 'window_gate', result: 'deferred_to_window_start', deferredFromMs },
      ],
      policyVersions: POLICY_VERSIONS,
    };
  }
  if (descriptor.quietGated) {
    appliedRules.push({ rule: 'window_gate', result: 'inside_active_window' });
  }

  return {
    ok: true,
    outcome: 'schedule',
    schemaVersion: 1,
    dueAtMs,
    window: dueWindow.value,
    appliedRules,
    policyVersions: POLICY_VERSIONS,
  };
}
