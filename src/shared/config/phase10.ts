/**
 * R1.20-R configuration surface — the admin post pipeline slice.
 *
 * TWO INDEPENDENT, fail-closed, NON-SECRET feature flags PLUS the R1.22
 * editorial-bridge gate (all three independent, all default false):
 * - `ADMIN_POST_ENABLED` ('true' | 'false', default 'false') gates the whole
 *   admin-authored post surface: plain-text capture from authorized admins in
 *   private chats, /post_preview / /post_status / /post_cancel, and the
 *   approve/publish callback actions. While OFF (or while a PRESENT value is
 *   invalid), every legacy behavior is byte-identical: non-command text keeps
 *   its `not_a_command` noop and callback queries keep their
 *   `callback_not_supported` noop. The flag never implies the Telegram
 *   ingress itself, AI, editorial, ingestion, or any other gate.
 * - `ADMIN_POST_LIVE_PUBLISH_ENABLED` ('true' | 'false', default 'false') is
 *   the SEPARATE live-publication gate. While OFF, an approved post can
 *   NEVER reach the real channel: the publish action stops BEFORE any
 *   publication row or Bot API call with an explicit honest reply. Enabling
 *   the capture/approve pipeline never enables sending. This implements the
 *   round contract: live publication ships disabled by default.
 * - `EDITORIAL_TO_POST_ENABLED` ('true' | 'false', default 'false'; R1.22
 *   Phase A) gates ONLY the /post_from_draft conversion command — deriving
 *   an admin post version from a stored READY editorial draft. It is
 *   INDEPENDENT of the other two flags and can never turn anything on by
 *   itself: while ADMIN_POST_ENABLED is OFF the whole admin post surface
 *   (including this command) is inert, and the live-publish gate always
 *   separately gates the send. While OFF the command keeps its exact
 *   legacy unknown-command noop semantics.
 *
 * Format validation runs whenever a value is PRESENT, regardless of the flag
 * (a present-but-invalid value is never silently coerced — no truthy-string
 * coercion anywhere).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigValidationResult } from './validate';

export const ADMIN_POST_FLAG_VALUES = ['true', 'false'] as const;

export const PHASE_10_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'ADMIN_POST_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...ADMIN_POST_FLAG_VALUES],
    default: 'false',
    description:
      'Admin post pipeline gate (non-secret; R1.20-R). Gates authorized admin post capture, preview, version-bound approval and the callback surface only — fail-closed default false; never implies the ingress, AI, editorial, ingestion or any other path.',
    phase: 10,
  },
  {
    name: 'ADMIN_POST_LIVE_PUBLISH_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...ADMIN_POST_FLAG_VALUES],
    default: 'false',
    description:
      'Admin post LIVE publication gate (non-secret; R1.20-R). While false an approved post can never be sent to the real channel — the publish action stops before any publication row or Bot API call. Ships false; independent of ADMIN_POST_ENABLED.',
    phase: 10,
  },
  {
    name: 'EDITORIAL_TO_POST_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...ADMIN_POST_FLAG_VALUES],
    default: 'false',
    description:
      'Editorial→post bridge gate (non-secret; R1.22 Phase A). Gates ONLY the /post_from_draft conversion of a stored READY editorial draft into an admin post version (durable per-version provenance, no fabrication). Ships false; independent of ADMIN_POST_ENABLED and ADMIN_POST_LIVE_PUBLISH_ENABLED — it can never enable the capture surface or any send by itself.',
    phase: 10,
  },
]);

/** Validated admin-post flag state (values only; no secrets involved). */
export interface AdminPostConfig {
  readonly adminPostEnabled: boolean;
  readonly livePublishEnabled: boolean;
  readonly editorialToPostEnabled: boolean;
}

/**
 * Validate the admin-post flags from a raw env-like record. Never throws;
 * issues carry field names and stable reason codes only. Fail-closed: a
 * flag is enabled ONLY when the WHOLE spec validation is ok AND the value is
 * exactly 'true'.
 */
export function parseAdminPostConfig(env: Readonly<Record<string, unknown>>): {
  config: AdminPostConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_10_CONFIG_SPEC);
  return {
    config: {
      adminPostEnabled: result.ok === true && result.config.ADMIN_POST_ENABLED === 'true',
      livePublishEnabled:
        result.ok === true && result.config.ADMIN_POST_LIVE_PUBLISH_ENABLED === 'true',
      editorialToPostEnabled:
        result.ok === true && result.config.EDITORIAL_TO_POST_ENABLED === 'true',
    },
    result,
  };
}
