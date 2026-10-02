/**
 * Phase 1A configuration surface (data foundation + /version contract).
 *
 * Adds typed NON-SECRET build/schema metadata configuration:
 * - APP_COMMIT: commit identifier reported by GET /version.
 * - SCHEMA_VERSION: expected D1 schema version as a strict positive decimal
 *   integer string (pattern-validated — no silent coercion; an invalid value
 *   makes readiness fail safely instead of falling back, per ADR-0021).
 *
 * Local development-safe defaults are documented in `.env.example` and
 * wrangler.jsonc. The local APP_COMMIT placeholder is invalid in production
 * (fail-closed guard below).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';
import type { Environment } from './phase0';

/** The approved Phase 1A schema version (migration 0001 — ADR-0019). */
export const EXPECTED_SCHEMA_VERSION = 1;

/** Local-development placeholder commit identifier (never valid in production). */
export const DEFAULT_APP_COMMIT = 'local-dev';

export const PHASE_1A_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'APP_COMMIT',
    type: 'string',
    required: false,
    secret: false,
    default: DEFAULT_APP_COMMIT,
    description: 'Commit identifier reported by GET /version (build metadata).',
    phase: 1,
  },
  {
    name: 'SCHEMA_VERSION',
    type: 'string',
    required: false,
    secret: false,
    default: String(EXPECTED_SCHEMA_VERSION),
    pattern: /^[1-9][0-9]*$/,
    description: 'Expected D1 schema version as a strict positive decimal integer string.',
    phase: 1,
  },
]);

export interface DataFoundationConfig {
  readonly APP_COMMIT: string;
  /** Parsed, validated positive integer schema version. */
  readonly schemaVersion: number;
}

function withIssue(result: ConfigValidationResult, issue: ConfigIssue): ConfigValidationResult {
  return { ok: false as const, config: result.config, issues: [...result.issues, issue] };
}

/**
 * Parse and validate the Phase 1A configuration subset.
 *
 * Unlike the Phase 0 parser (which falls back to safe defaults so health
 * endpoints always boot), THIS parser never coerces values: when validation
 * fails, `config` is `null` and callers must fail safely (readiness ->
 * not_ready; /version -> 503 config_invalid). Issues carry field names and
 * reason codes only — never values.
 */
export function parseDataFoundationConfig(
  env: Readonly<Record<string, unknown>>,
  environment: Environment,
): {
  readonly config: DataFoundationConfig | null;
  readonly result: ConfigValidationResult;
} {
  let result = validateConfig(env, PHASE_1A_CONFIG_SPEC);

  if (environment === 'production' && result.config['APP_COMMIT'] === DEFAULT_APP_COMMIT) {
    result = withIssue(result, {
      field: 'APP_COMMIT',
      reason: 'invalid_value',
      note: 'the local development placeholder is not valid in production',
    });
  }

  if (!result.ok) {
    return { config: null, result };
  }

  const rawVersion = result.config['SCHEMA_VERSION'];
  const parsed = typeof rawVersion === 'string' ? Number.parseInt(rawVersion, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    // Unreachable when the pattern validation holds; kept fail-safe.
    return {
      config: null,
      result: withIssue(result, {
        field: 'SCHEMA_VERSION',
        reason: 'invalid_format',
        note: 'value must be a positive decimal integer',
      }),
    };
  }

  const commit = result.config['APP_COMMIT'];
  if (typeof commit !== 'string' || commit === '') {
    return {
      config: null,
      result: withIssue(result, {
        field: 'APP_COMMIT',
        reason: 'missing_required',
        note: 'required configuration value is not set (phase 1)',
      }),
    };
  }

  return {
    config: { APP_COMMIT: commit, schemaVersion: parsed },
    result,
  };
}
