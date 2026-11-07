/**
 * Phase 9A configuration surface — the FIRST read-only admin review slice
 * (R1.18; ADR-0046).
 *
 * ONE INDEPENDENT, fail-closed, non-secret feature flag:
 * - `ADMIN_REVIEW_ENABLED` ('true' | 'false', default 'false') gates the
 *   new read-only `/drafts` and `/drafts <draftId>` Telegram commands and
 *   their /help advertisement ONLY. While OFF (or while a PRESENT value is
 *   invalid — the enum issue is recorded, the feature stays disabled, and
 *   the commands keep their existing unknown-command noop semantics), the
 *   review surface performs ZERO editorial queries and ZERO disclosure.
 * - Independence: this gate NEVER implies or enables AI/editorial/ingestion/
 *   relation generation, the Telegram ingress itself, or any write path. The
 *   review surface is read-only against the drafts table and depends on the
 *   ALREADY-persisted Phase 5 output; historical drafts stay reviewable with
 *   every AI/editorial flag OFF.
 * - Format validation runs whenever a value is PRESENT, regardless of the
 *   flag (a present-but-invalid value is never silently coerced — there is
 *   NO truthy-string coercion anywhere).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigValidationResult } from './validate';

export const ADMIN_REVIEW_FLAG_VALUES = ['true', 'false'] as const;

export const PHASE_9A_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'ADMIN_REVIEW_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...ADMIN_REVIEW_FLAG_VALUES],
    default: 'false',
    description:
      'Read-only admin review surface gate (non-secret; ADR-0046). Gates the /drafts list/detail Telegram commands and their help advertisement only — fail-closed default false; never enables AI, editorial generation, ingestion, the relation step, or any write path.',
    phase: 9,
  },
]);

/** Validated Phase 9A flag state (values only; no secrets involved). */
export interface AdminReviewConfig {
  readonly reviewEnabled: boolean;
}

/**
 * Validate the Phase 9A configuration from a raw env-like record. Never
 * throws; issues carry field names and stable reason codes only.
 *
 * Fail-closed reading: the feature is enabled ONLY when the WHOLE spec
 * validation is ok AND the value is exactly 'true'. An invalid-present
 * value (e.g. 'TRUE', '1', 'yes') records an `invalid_enum` issue in the
 * result and keeps the flag disabled — it is never coerced to a truthy
 * boolean.
 */
export function parseAdminReviewConfig(env: Readonly<Record<string, unknown>>): {
  config: AdminReviewConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_9A_CONFIG_SPEC);
  return {
    config: {
      reviewEnabled: result.ok === true && result.config.ADMIN_REVIEW_ENABLED === 'true',
    },
    result,
  };
}
