/**
 * Phase 3 configuration surface (job/queue engine — ADR-0036 §7).
 *
 * Adds the NON-SECRET feature flag `JOBS_ENABLED` ('true' | 'false',
 * default 'false'). Activation is fail-closed:
 *
 * - While DISABLED the cron and queue entrypoints preserve the exact
 *   Telegram-only Phase 2 behavior (cron logs only; a delivered queue
 *   message is retried, never falsely acknowledged).
 * - While ENABLED, dispatch requires the `JOBS` producer binding and the
 *   consumer requires the D1 binding; a missing binding is a stable,
 *   safe-logged configuration error (no dispatch, no ack-all) — the
 *   deployment fails closed instead of half-running.
 * - Format validation runs whenever a value is PRESENT, regardless of the
 *   flag; a present-but-invalid value is never silently ignored.
 *
 * Engine bounds are centralized constants (lease, batch sizes, grace
 * window, backoff base/cap) — deliberately NOT environment knobs for this
 * phase; changing them is a reviewed code change.
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';

export const JOBS_FLAG_VALUES = ['true', 'false'] as const;

export const PHASE_3_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'JOBS_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...JOBS_FLAG_VALUES],
    default: 'false',
    description: 'Durable job/queue engine feature flag (non-secret; ADR-0036).',
    phase: 3,
  },
]);

/** Validated Phase 3 flag state (values only; no secrets involved). */
export interface JobsConfig {
  readonly JOBS_ENABLED: boolean;
}

/**
 * Validate the Phase 3 configuration from a raw env-like record. Never
 * throws; issues carry field names and stable reason codes only.
 */
export function parseJobsConfig(env: Readonly<Record<string, unknown>>): {
  config: JobsConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_3_CONFIG_SPEC);
  const flag = result.config.JOBS_ENABLED === 'true';
  return { config: { JOBS_ENABLED: flag }, result };
}

// ---------------------------------------------------------------------------
// Engine bounds (ADR-0036 §1/§3/§4) — reviewed constants, not env knobs.
// ---------------------------------------------------------------------------

/** Claim lease for a running job. Above bounded handler work, below recovery horizons. */
export const JOBS_CLAIM_LEASE_MS = 2 * 60 * 1000;

/** Maximum rows dispatched per cron tick (bounded indexed scan). */
export const JOBS_DISPATCH_BATCH = 25;

/** Maximum dead-letter rows reconciled to the DLQ per cron tick. */
export const JOBS_DLQ_RECONCILE_BATCH = 25;

/** Maximum expired claims reclaimed per cron tick. */
export const JOBS_RECLAIM_BATCH = 25;

/**
 * Grace window for the `queued` dispatch marker: a queued row whose state
 * has not transitioned within this window becomes dispatchable again
 * (bounded re-kick; duplicate references are absorbed by claim fencing).
 */
export const JOBS_DISPATCH_GRACE_MS = 60 * 1000;

/** Backoff defaults (full jitter, capped — ADR-0036 §4). */
export const JOBS_BACKOFF_BASE_MS = 2_000;
export const JOBS_BACKOFF_CAP_MS = 3_600_000;

/**
 * Bounded consumer retry delay hint in seconds (Queue `retry({
 * delaySeconds })` is a HINT only — correctness never depends on it).
 * Clamped into the provider-accepted range; the durable schedule lives in
 * D1.
 */
export const JOBS_RETRY_HINT_MAX_SECONDS = 3_600;

export type { ConfigIssue };
