/**
 * Phase 5A configuration surface (editorial source→draft — ADR-0042 §3).
 *
 * ONE INDEPENDENT, fail-closed, non-secret feature flag:
 * - `EDITORIAL_ENABLED` ('true' | 'false', default 'false') gates the
 *   `editorial.prepare_draft` job type ONLY. While OFF: the handler is
 *   never registered, the enqueue boundary still validates but the type
 *   is LOSSLESSLY policy-paused (ADR-0040 semantics — pre-claim
 *   `paused_by_policy` acknowledgment with zero attempt burn, zero
 *   poison, zero durable writes, and dispatch/recovery scan exclusion),
 *   and NO AI call, NO budget write, NO editorial write can happen.
 *   Absent/invalid configuration never enables the path and never breaks
 *   the existing Telegram/health/job behaviors.
 *
 * Independence: `EDITORIAL_ENABLED` is a distinct gate from `JOBS_ENABLED`
 * (the engine), `SOURCE_INGESTION_ENABLED` (poll scheduling) and
 * `AI_ENABLED` (the draft service). The editorial gate REQUIRES the jobs
 * engine when on (fail closed), but never implies AI activation: with the
 * editorial gate ON and `AI_ENABLED` off, executions resolve the typed
 * deferred `ai_disabled` retry path with ZERO provider calls.
 *
 * Format validation runs whenever a value is PRESENT, regardless of the
 * flag (a present-but-invalid value is never silently ignored).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';

export const EDITORIAL_FLAG_VALUES = ['true', 'false'] as const;

export const PHASE_5A_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'EDITORIAL_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...EDITORIAL_FLAG_VALUES],
    default: 'false',
    description:
      'Editorial source→draft pipeline gate (non-secret; ADR-0042). Gates the editorial.prepare_draft job type only — fail-closed default false; the AI service keeps its own independent gates.',
    phase: 5,
  },
]);

/** Validated Phase 5A flag state (values only; no secrets involved). */
export interface EditorialConfig {
  readonly EDITORIAL_ENABLED: boolean;
}

/**
 * Validate the Phase 5A configuration from a raw env-like record. Never
 * throws; issues carry field names and stable reason codes only.
 */
export function parseEditorialConfig(env: Readonly<Record<string, unknown>>): {
  config: EditorialConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_5A_CONFIG_SPEC);
  return {
    config: {
      EDITORIAL_ENABLED: result.config.EDITORIAL_ENABLED === 'true',
    },
    result,
  };
}

export type { ConfigIssue };
