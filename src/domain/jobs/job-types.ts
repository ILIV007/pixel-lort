/**
 * Job framework domain types (Phase 3 — ADR-0036).
 *
 * Pure domain vocabulary: no Cloudflare, Telegram, provider SDK, or HTTP
 * client types (blueprint §3). Persistence lives in `src/adapters/db/`,
 * orchestration in `src/application/jobs/`, entrypoints in
 * `src/entrypoints/`.
 *
 * Clock unit: epoch MILLISECONDS everywhere (matches the rest of the
 * schema — ADR-0036 §1).
 */

/**
 * Job statuses (blueprint schema CHECK constraint, migration 0001).
 *
 * `failed` is RESERVED: never written by the Phase 3 engine. The durable
 * lifecycle distinguishes `retry_wait` (durable schedule in `run_after`)
 * from terminal `dead_letter`; a raw `failed` row encountered by the
 * consumer or reconciliation is treated as non-executable and left alone.
 * A future phase that owns that status must document it in its own ADR.
 */
export type JobStatus =
  | 'pending'
  | 'queued'
  | 'claimed'
  | 'succeeded'
  | 'retry_wait'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

/** Statuses from which the atomic claim may take ownership. */
export const CLAIMABLE_STATUSES: readonly ['pending', 'queued', 'retry_wait'] = [
  'pending',
  'queued',
  'retry_wait',
];

/** Terminal statuses: never executable, safe to acknowledge on redelivery. */
export const TERMINAL_STATUSES: readonly ['succeeded', 'dead_letter', 'cancelled'] = [
  'succeeded',
  'dead_letter',
  'cancelled',
];

export function isJobStatus(value: string): value is JobStatus {
  return (
    value === 'pending' ||
    value === 'queued' ||
    value === 'claimed' ||
    value === 'succeeded' ||
    value === 'retry_wait' ||
    value === 'failed' ||
    value === 'dead_letter' ||
    value === 'cancelled'
  );
}

/**
 * Registered job types. ONLY implemented handlers are registered
 * (ADR-0036 §7, ADR-0038 §1): the Phase 3 maintenance heartbeat, the
 * Phase 4 source poll (registered ONLY while the ingestion gate is on),
 * and the Phase 5A editorial prepare-draft (registered ONLY while the
 * editorial gate is on — an unregistered type can never be created or
 * executed, ADR-0036 §7; the gate-off pause is LOSSLESS per ADR-0040/0042).
 */
export const JOB_TYPES = [
  'jobs.maintenance_heartbeat',
  'sources.fetch_poll',
  'editorial.prepare_draft',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

/** Bounded job-type syntax enforced on every contract boundary. */
export const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
export const JOB_TYPE_MAX_LENGTH = 64;

/**
 * Stable, safe error codes persisted in `jobs.last_error` and carried in
 * DLQ references. These are AUTHORED constants — never raw provider error
 * messages, source text, tokens, or dynamic strings (AGENTS.md §3; the
 * persisted value must be safe to log, audit, and deliver).
 */
export const JOB_ERROR_CODES = [
  'job_exhausted',
  'job_payload_invalid',
  'job_type_unregistered',
  'job_handler_retryable_error',
  'job_handler_permanent_error',
  'job_handler_timeout',
  'job_internal_error',
  // Phase 4 source ingestion (ADR-0038 §4) — stable, safe constants.
  'ingestion_source_missing',
  'ingestion_connector_unavailable',
  // Round 1.6 policy pause (ADR-0040): a schema-KNOWN type whose handler is
  // missing in this deployment while its enablement gate is NOT holding it
  // back — a visible wiring bug, deliberately DISTINCT from the pause
  // (`paused_by_policy`) and from the unknown-type poison class.
  'handler_misconfigured',
  // Round 1.9.1 (R19-01): the schema capability is unavailable or not a
  // known version — the handler fails closed BEFORE budget/network/items/
  // source-state effects and returns this stable RECOVERABLE code; the
  // engine's own retry bookkeeping (retry_wait/last_error) carries it.
  'ingestion_capability_unresolved',
  // Phase 5A editorial (ADR-0042) — stable, safe, authored constants.
  // The handler maps AI/identity failures onto these; the engine's fenced
  // bookkeeping carries them into retry_wait/dead_letter/last_error.
  'editorial_source_item_missing',
  'editorial_source_missing',
  'editorial_snapshot_mismatch',
  'editorial_input_invalid',
  'editorial_ai_refused',
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export function isJobErrorCode(value: string): value is JobErrorCode {
  return (JOB_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Bounded error-code syntax for values persisted by the engine. Handlers
 * may only return codes from JOB_ERROR_CODES; this pattern is the fail-safe
 * backstop before anything reaches `last_error` or a DLQ reference.
 */
export const JOB_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
