/**
 * Phase 4 configuration surface (source ingestion — ADR-0038 §1).
 *
 * Adds the NON-SECRET feature flag `SOURCE_INGESTION_ENABLED`
 * ('true' | 'false', default 'false'). It gates the INGESTION subsystem
 * only — due-source scheduling in cron and registration of the
 * `sources.fetch_poll` handler — never the existing jobs engine
 * (ADR-0036).
 *
 * Activation is fail-closed and layered:
 * - While DISABLED, source scheduling never runs and the poll handler is
 *   never registered. Since Round 1.6 (ADR-0040) the OFF gate additionally
 *   LOSSLESSLY PAUSES in-flight `sources.fetch_poll` durable work (the D01
 *   contract): delivered poll messages are acknowledged `paused_by_policy`
 *   pre-claim and the engine's dispatch/recovery scans exclude the paused
 *   type IN SQL — no poison, no attempt burn, no durable rewrite. (The
 *   earlier "byte-identical to Phase 3 v1.3.1" wording in ADR-0038 §1 is
 *   superseded on exactly this point; all other mechanics are unchanged.)
 * - While ENABLED, the jobs engine must ALSO be enabled and valid
 *   (`ingestion_requires_jobs` otherwise — readiness fails closed, no
 *   scheduling, no handler registration).
 * - Format validation runs whenever a value is PRESENT, regardless of
 *   the flag (a present-but-invalid value is never silently ignored).
 *
 * Per-source enablement (`sources.enabled`) is a separate explicit owner
 * control; the delivered tree ships every source disabled.
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';

export const SOURCE_INGESTION_FLAG_VALUES = ['true', 'false'] as const;

export const PHASE_4_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'SOURCE_INGESTION_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...SOURCE_INGESTION_FLAG_VALUES],
    default: 'false',
    description:
      'Source ingestion feature flag (non-secret; ADR-0038). Gates source scheduling and poll handlers only — never the jobs engine.',
    phase: 4,
  },
]);

/** Validated Phase 4 flag state (values only; no secrets involved). */
export interface IngestionConfig {
  readonly SOURCE_INGESTION_ENABLED: boolean;
}

/**
 * Validate the Phase 4 configuration from a raw env-like record. Never
 * throws; issues carry field names and stable reason codes only.
 */
export function parseIngestionConfig(env: Readonly<Record<string, unknown>>): {
  config: IngestionConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_4_CONFIG_SPEC);
  const flag = result.config.SOURCE_INGESTION_ENABLED === 'true';
  return { config: { SOURCE_INGESTION_ENABLED: flag }, result };
}

// ---------------------------------------------------------------------------
// Ingestion bounds (ADR-0038) — reviewed constants, not env knobs.
// ---------------------------------------------------------------------------

/** Sources scheduled per cron pass (bounded indexed scan). */
export const INGESTION_SCHEDULE_BATCH = 10;

/** Poll reservation hold (just above the 2-minute claim lease). */
export const INGESTION_POLL_HOLD_MS = 120_000;

/** Backoff when the request budget is exhausted (no network). */
export const INGESTION_BUDGET_RETRY_MS = 10 * 60 * 1000;

/** Circuit open duration after 401/403 credential rejection. */
export const INGESTION_CIRCUIT_MS = 30 * 60 * 1000;

/** Maximum adaptive source backoff (blueprint §9 adaptive ladder cap). */
export const INGESTION_BACKOFF_CAP_MS = 30 * 60 * 1000;

/** ±10 % polling jitter (blueprint §9) applied with the injected random. */
export const INGESTION_JITTER_FRACTION = 0.1;

export type { ConfigIssue };
