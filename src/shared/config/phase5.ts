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
 * - `EDITORIAL_MATCHING_ENABLED` ('true' | 'false', default 'false') is
 *   the INDEPENDENT fail-closed gate for the Phase 5C-4 deterministic
 *   candidate-MATCHING report (V4 Phase 5.2 local slice). It NEVER
 *   implies `EDITORIAL_ENABLED`, `AI_ENABLED` or any other gate; while
 *   OFF the handler computes and stores NO `candidateMatching` payload
 *   (the accepted document shape stays byte-identical) and while ON it
 *   adds ZERO SQL statements, ZERO provider calls and ZERO cost — the
 *   report is a pure derivation of the discovery + assessment already
 *   produced by the same commit. Absent/invalid configuration never
 *   enables the payload and never breaks existing behaviors.
 * - `EDITORIAL_ADJUDICATION_ENABLED` ('true' | 'false', default 'false')
 *   is the INDEPENDENT fail-closed gate for the Phase 5.3 deterministic
 *   candidate-ADJUDICATION report (V4 owner authorization 2026-11-10). It
 *   NEVER implies `EDITORIAL_ENABLED`, `AI_ENABLED`, the matching gate or
 *   any other gate; while OFF the handler computes and stores NO
 *   `candidateAdjudication` payload; while ON the payload is produced
 *   ONLY when its sibling matching gate is ALSO on (the flags never imply
 *   each other — without the sibling there is no basis and an honest warn
 *   is logged), and it adds ZERO SQL statements, ZERO provider calls and
 *   ZERO cost — the report is a pure derivation of the matching report
 *   already produced by the same commit, and it NEVER executes a merge.
 *   Absent/invalid configuration never enables the payload and never
 *   breaks existing behaviors.
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
  {
    name: 'EDITORIAL_MATCHING_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...EDITORIAL_FLAG_VALUES],
    default: 'false',
    description:
      'Candidate-matching report gate (non-secret; Phase 5C-4/V4 5.2). Independent fail-closed flag — while OFF no candidateMatching payload is computed or stored; while ON it is a pure zero-SQL/zero-cost derivation. Never implies EDITORIAL_ENABLED or AI_ENABLED.',
    phase: 5,
  },
  {
    name: 'EDITORIAL_ADJUDICATION_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...EDITORIAL_FLAG_VALUES],
    default: 'false',
    description:
      'Candidate-adjudication report gate (non-secret; Phase 5.3/V4). Independent fail-closed flag — while OFF no candidateAdjudication payload is computed or stored; while ON it is a pure zero-SQL/zero-cost derivation of the matching report (requires the matching gate too; the flags never imply each other) and NEVER executes a merge. Never implies EDITORIAL_ENABLED or AI_ENABLED.',
    phase: 5,
  },
]);

/** Validated Phase 5A flag state (values only; no secrets involved). */
export interface EditorialConfig {
  readonly EDITORIAL_ENABLED: boolean;
  readonly EDITORIAL_MATCHING_ENABLED: boolean;
  readonly EDITORIAL_ADJUDICATION_ENABLED: boolean;
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
      EDITORIAL_MATCHING_ENABLED: result.config.EDITORIAL_MATCHING_ENABLED === 'true',
      EDITORIAL_ADJUDICATION_ENABLED: result.config.EDITORIAL_ADJUDICATION_ENABLED === 'true',
    },
    result,
  };
}

export type { ConfigIssue };
