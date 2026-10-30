/**
 * Phase 6 configuration surface (AI adapters — ADR-0041 §3).
 *
 * Two INDEPENDENT, fail-closed, non-secret feature flags:
 * - `AI_ENABLED` ('true' | 'false', default 'false') gates the AI draft
 *   service as a whole. While OFF: zero provider calls, zero budget
 *   writes, zero binding access — the outcome is the typed deferred
 *   `ai_disabled`. Absent/invalid configuration must never enable calls
 *   and must never break the existing Telegram/health/job paths.
 * - `AI_GEMINI_ENABLED` ('true' | 'false', default 'false') is the
 *   additional operator gate for the Gemini fallback path. It may be set
 *   'true' ONLY after a documented verification of the CURRENT official
 *   Free-tier eligibility docs (the versioned policy still marks Gemini
 *   eligibility as unverified in this round, so the fallback stays OFF
 *   even with this flag true — unknown eligibility never reaches the
 *   network).
 * - `EVENT_RELATION_ENABLED` ('true' | 'false', default 'false') is the
 *   INDEPENDENT fail-closed gate for the R1.17 event-relation task
 *   (Phase 5E-1). It NEVER implies AI_ENABLED or EDITORIAL_ENABLED; with
 *   the flag OFF the relation step performs ZERO retrieval, ZERO
 *   adjudication, and ZERO writes, and the accepted normal path stays
 *   intact. Only offline tests/demos turn it on with a fixture port.
 *
 * Format validation runs whenever a value is PRESENT, regardless of the
 * flag (a present-but-invalid value is never silently ignored).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';

export const AI_FLAG_VALUES = ['true', 'false'] as const;

export const PHASE_6_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'AI_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...AI_FLAG_VALUES],
    default: 'false',
    description:
      'AI adapters feature flag (non-secret; ADR-0041). Gates the whole AI draft service — fail-closed default false.',
    phase: 6,
  },
  {
    name: 'AI_GEMINI_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...AI_FLAG_VALUES],
    default: 'false',
    description:
      'Gemini fallback operator gate (non-secret; ADR-0041). Requires verified Free-tier eligibility; the versioned policy keeps Gemini eligibility unverified this round.',
    phase: 6,
  },
  {
    name: 'EVENT_RELATION_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...AI_FLAG_VALUES],
    default: 'false',
    description:
      'Event-relation adjudication task gate (non-secret; R1.17/ADR-0045). Independent fail-closed flag — never implies AI_ENABLED or EDITORIAL_ENABLED.',
    phase: 6,
  },
]);

/** Validated Phase 6 flag state (values only; no secrets involved). */
export interface AiConfig {
  readonly AI_ENABLED: boolean;
  readonly AI_GEMINI_ENABLED: boolean;
  readonly EVENT_RELATION_ENABLED: boolean;
}

/**
 * Validate the Phase 6 configuration from a raw env-like record. Never
 * throws; issues carry field names and stable reason codes only.
 */
export function parseAiConfig(env: Readonly<Record<string, unknown>>): {
  config: AiConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_6_CONFIG_SPEC);
  return {
    config: {
      AI_ENABLED: result.config.AI_ENABLED === 'true',
      AI_GEMINI_ENABLED: result.config.AI_GEMINI_ENABLED === 'true',
      EVENT_RELATION_ENABLED: result.config.EVENT_RELATION_ENABLED === 'true',
    },
    result,
  };
}

export type { ConfigIssue };
