/**
 * Phase 8.1 — PRIORITY CLASSES (blueprint §16 «Priority»).
 *
 * A TOTAL typed classification over the editorial score 0..100 under
 * the pinned policy version `pcp1`. The descriptors carry EXACTLY the
 * blueprint facts plus the DOCUMENTED interpretive pins — nothing
 * invented, nothing hidden:
 *
 *   P0 (90–100): publish after verification, NO daily cap, bypasses
 *                quiet hours (the ONLY class the blueprint grants
 *                that bypass). Window policy: anytime.
 *   P1 (75–89):  within 5–20 minutes (the latency bound). Window
 *                policy: latency_bound.
 *                DOCUMENTED PIN: the blueprint's quiet label names
 *                «P2/P3» only, and a quiet deferral would break the
 *                5–20 minute contract — so P1 is NOT quiet-gated.
 *                This is the literal blueprint text, pinned and
 *                tested, recorded in the ADR.
 *   P2 (40–74):  dynamic window (the scheduling windows apply — the
 *                composition defers a P2/P3 due outside an ACTIVE
 *                window to the next active window start).
 *   P3 (0–39):   evergreen filler only (the mix gate and the window
 *                gate apply; a P3 never initiates a send on its own
 *                authority — the durable scheduler's filler selection
 *                is the Phase 8.2 consumer).
 *
 * THE BOUNDARY VALUES ARE PINNED: 90 ⇒ P0, 89 ⇒ P1, 75 ⇒ P1,
 * 74 ⇒ P2, 40 ⇒ P2, 39 ⇒ P3, 0 ⇒ P3, 100 ⇒ P0.
 *
 * THE INPUT CONTRACT: scores are INTEGERS in [0, 100]. Every
 * out-of-vocabulary input (non-integer, <0, >100, NaN, ±Infinity)
 * fails TYPED (`invalid_score`) — never rounded, never clamped,
 * never guessed.
 *
 * The quiet-hours applicability matrix is EXPLICIT data
 * (`isQuietGated` / the descriptor's `quietGated`): P2/P3 gated (the
 * blueprint names them), P0 bypasses (the blueprint says so), P1
 * latency-bound (the documented pin above).
 *
 * BOUNDARY: pure — no I/O, no clock, no network, no Telegram types.
 * The SAME input ALWAYS yields the SAME answer (JSON-equal
 * determinism).
 */

export const PRIORITY_POLICY_VERSION = 'pcp1' as const;

export type PublicationPriorityClass = 'P0' | 'P1' | 'P2' | 'P3';

export type PriorityWindowPolicy = 'anytime' | 'latency_bound' | 'dynamic_window' | 'filler_only';

export interface PriorityClassDescriptor {
  readonly class: PublicationPriorityClass;
  /** Inclusive lower score bound. */
  readonly scoreMin: number;
  /** Inclusive upper score bound. */
  readonly scoreMax: number;
  /**
   * `false` ONLY for P0 — the blueprint's explicit «no daily cap».
   * `null` for the other classes: the blueprint specifies no cap for
   * them and this policy invents none.
   */
  readonly dailyCap: false | null;
  /** The blueprint's explicit P0 quiet bypass. */
  readonly bypassesQuietHours: boolean;
  /**
   * The quiet-hours applicability: P2/P3 true (the blueprint names
   * them), P0 false (explicit bypass), P1 false (the documented
   * latency pin — quiet is «for P2/P3»).
   */
  readonly quietGated: boolean;
  /** The P1 latency bound in ms; null for the other classes. */
  readonly latencyBoundMs: { readonly minMs: number; readonly maxMs: number } | null;
  readonly windowPolicy: PriorityWindowPolicy;
}

export const PRIORITY_CLASS_DESCRIPTORS: Readonly<
  Record<PublicationPriorityClass, PriorityClassDescriptor>
> = {
  P0: {
    class: 'P0',
    scoreMin: 90,
    scoreMax: 100,
    dailyCap: false,
    bypassesQuietHours: true,
    quietGated: false,
    latencyBoundMs: null,
    windowPolicy: 'anytime',
  },
  P1: {
    class: 'P1',
    scoreMin: 75,
    scoreMax: 89,
    dailyCap: null,
    bypassesQuietHours: false,
    quietGated: false,
    latencyBoundMs: { minMs: 5 * 60_000, maxMs: 20 * 60_000 },
    windowPolicy: 'latency_bound',
  },
  P2: {
    class: 'P2',
    scoreMin: 40,
    scoreMax: 74,
    dailyCap: null,
    bypassesQuietHours: false,
    quietGated: true,
    latencyBoundMs: null,
    windowPolicy: 'dynamic_window',
  },
  P3: {
    class: 'P3',
    scoreMin: 0,
    scoreMax: 39,
    dailyCap: null,
    bypassesQuietHours: false,
    quietGated: true,
    latencyBoundMs: null,
    windowPolicy: 'filler_only',
  },
} as const;

export type ClassifyPriorityResult =
  | { ok: true; value: { class: PublicationPriorityClass; descriptor: PriorityClassDescriptor } }
  | { ok: false; reason: 'invalid_score' };

/**
 * Classify an editorial score into its blueprint §16 priority class.
 * TOTAL over the integer range [0, 100]; every violation fails typed.
 */
export function classifyPriority(score: number): ClassifyPriorityResult {
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100
  ) {
    return { ok: false, reason: 'invalid_score' };
  }
  if (score >= 90)
    return { ok: true, value: { class: 'P0', descriptor: PRIORITY_CLASS_DESCRIPTORS.P0 } };
  if (score >= 75)
    return { ok: true, value: { class: 'P1', descriptor: PRIORITY_CLASS_DESCRIPTORS.P1 } };
  if (score >= 40)
    return { ok: true, value: { class: 'P2', descriptor: PRIORITY_CLASS_DESCRIPTORS.P2 } };
  return { ok: true, value: { class: 'P3', descriptor: PRIORITY_CLASS_DESCRIPTORS.P3 } };
}

/**
 * The quiet-hours applicability matrix as a TOTAL function over the
 * four classes (explicit data, never inferred).
 */
export function isQuietGated(class_: PublicationPriorityClass): boolean {
  return PRIORITY_CLASS_DESCRIPTORS[class_].quietGated;
}
