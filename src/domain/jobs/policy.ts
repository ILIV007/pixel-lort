/**
 * Explicit job-type enablement policy (Round 1.6 — D01; design authority:
 * `docs/reviews/PIXEL_ROUND1_5_1_OWNERSHIP_PAUSE_DESIGN.md` §5/§10.2,
 * independently accepted with manager clarifications).
 *
 * A job type is DISABLED-BY-POLICY only if it is listed in the explicit
 * enablement registry below AND its gate is currently off. Membership in
 * `PAYLOAD_SCHEMAS` alone confers NOTHING (a missing handler or schema
 * membership never implies a pause), and an unlisted type can never be
 * paused by the policy (the registry cannot pause what it does not map —
 * unknown and misconfigured types stay on their ordinary visible paths).
 *
 * Failure-class taxonomy (three DISTINCT classes, never conflated):
 *   unknown type        — no payload schema: pre-claim poison →
 *                         `dead_letter` / `job_type_unregistered`
 *                         (shipped behavior, unchanged).
 *   misconfiguration    — schema-known, handler missing in THIS deployment,
 *                         and NOT paused: a wiring bug — pre-claim poison →
 *                         `dead_letter` / `handler_misconfigured` (distinct,
 *                         visible, alerting; never a silent pause).
 *   disabled-by-policy  — listed here AND its gate is off: EXPECTED
 *                         operation. The consumer acknowledges
 *                         `paused_by_policy` BEFORE the atomic claim (no
 *                         attempt burn, no poison, no DLQ, no durable
 *                         write), and dispatch/recovery scans exclude the
 *                         paused types IN SQL (zero scan-slot cost —
 *                         fairness for every other type).
 *
 * The gate snapshot is per-invocation state derived from the strictly
 * parsed configuration (`resolveJobsEngine`); callers must never assume an
 * environment variable changes inside a running invocation.
 */

import { PAYLOAD_SCHEMAS } from './payloads';
import type { JobHandlerRegistry } from './handler';

/** Named configuration gates that can hold a job type (code-defined). */
export type PolicyGateName = 'ingestion_gate' | 'editorial_gate';

/**
 * Per-invocation gate snapshot. `ingestionGateOn` mirrors the strictly
 * parsed `SOURCE_INGESTION_ENABLED` flag; `editorialGateOn` mirrors the
 * strictly parsed `EDITORIAL_ENABLED` flag (ADR-0042). Both flags are
 * OPTIONAL for backward compatibility with direct offline harnesses:
 * an engine constructed without an explicit snapshot (`createJobsEngine`
 * direct harnesses) behaves as if every gate is ON: no pause or scan
 * exclusion. The new distinct handler_misconfigured behavior still
 * applies; whole-engine byte-equivalence is not claimed.
 */
export interface JobsPolicyGates {
  readonly ingestionGateOn: boolean;
  /** ADR-0042: absent (offline harnesses) behaves as ON — no pause. */
  readonly editorialGateOn?: boolean;
}

/** One enablement-registry entry: which gate holds the job type. */
export interface JobEnablementEntry {
  readonly gate: PolicyGateName;
}

/**
 * Explicit enablement registry (code-defined, reviewed). A type is
 * disabled-by-policy ONLY if listed here AND its gate is off.
 */
export const JOB_ENABLEMENT_POLICY: ReadonlyMap<string, JobEnablementEntry> = new Map([
  ['sources.fetch_poll', { gate: 'ingestion_gate' }],
  ['editorial.prepare_draft', { gate: 'editorial_gate' }],
]);

/** True iff the named gate is OFF under the snapshot (absent = ON). */
function isGateOff(gate: PolicyGateName, gates: JobsPolicyGates): boolean {
  if (gate === 'ingestion_gate') {
    return !gates.ingestionGateOn;
  }
  return gates.editorialGateOn === false;
}

/** Disabled-by-policy test: listed in the registry AND its gate is off. */
export function isPausedByPolicy(jobType: string, gates: JobsPolicyGates): boolean {
  const entry = JOB_ENABLEMENT_POLICY.get(jobType);
  if (entry === undefined) {
    return false;
  }
  return isGateOff(entry.gate, gates);
}

/**
 * The job types currently excluded from dispatch/recovery scans (bounded,
 * code-defined list derived once per engine from the gate snapshot).
 */
export function policyExcludedTypes(gates: JobsPolicyGates): readonly string[] {
  const excluded: string[] = [];
  for (const [type, entry] of JOB_ENABLEMENT_POLICY.entries()) {
    if (isGateOff(entry.gate, gates)) {
      excluded.push(type);
    }
  }
  return excluded;
}

/**
 * Misconfiguration test: the payload schema is registered, the handler is
 * NOT, and the type is not currently paused by policy. Policy precedence:
 * the pause decision comes FIRST — a paused type with a missing handler is
 * expected gate-off operation, never an alert.
 */
export function isHandlerMisconfigured(
  jobType: string,
  handlers: JobHandlerRegistry,
  gates: JobsPolicyGates,
): boolean {
  if (!PAYLOAD_SCHEMAS.has(jobType)) {
    return false; // unknown type — the poison class owns it
  }
  if (isPausedByPolicy(jobType, gates)) {
    return false; // disabled-by-policy — expected operation
  }
  return handlers.get(jobType) === undefined;
}
