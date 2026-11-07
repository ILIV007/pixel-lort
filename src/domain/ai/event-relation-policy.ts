/**
 * Versioned policy/bounds for the `event_relation` task (Phase 5E-1 —
 * R1.17, ADR-0045). Immutable, testable constants — the shared provider
 * allowlist, eligibility and daily attempt caps are NOT changed by this
 * task (AI_MODEL_ALLOWLIST_V1 / AI_DAILY_REQUEST_ATTEMPT_CAPS stay the
 * single authority the task shares with drafting; no separate budget
 * bucket exists to bypass the shared provider cap).
 */

/** Version marker for the shipped event-relation prompt contract. */
export const EVENT_RELATION_PROMPT_VERSION = 'pixel-event-relation-v1' as const;

/** Validated, testable application bounds for ONE relation step. */
export const EVENT_RELATION_BOUNDS = {
  /** Public input bound per PAIR bundle (both sides' text total, UTF-8). */
  maxBundleUtf8Bytes: 16 * 1024,
  /** Output token bound passed to providers (same as drafting). */
  maxOutputTokens: 768,
  /** TOTAL wall deadline for the WHOLE relation step (all pairs + waits). */
  stepWallDeadlineMs: 15_000,
  /** Maximum REAL provider attempts for the WHOLE step (shared across
   * pairs — never per pair). */
  maxProviderAttemptsPerStep: 3,
  /** Maximum pairs evaluated in ONE job attempt. */
  maxPairs: 2,
  /** Raw provider output length bound (chars) before parsing. */
  maxOutputRawChars: 8192,
} as const;

/** Bounded reason/conflict shape the model output must respect. */
export const EVENT_RELATION_OUTPUT_LIMITS = {
  maxReasons: 4,
  maxReasonChars: 200,
  maxReferences: 8,
  maxConflicts: 4,
  maxConflictChars: 200,
} as const;
