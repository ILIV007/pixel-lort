/**
 * Payload contracts and canonical JSON (Phase 3 — ADR-0036 §2/§7; Zod per
 * ADR-0010).
 *
 * The durable `jobs.payload_json` column is the ONLY execution payload; the
 * queue carries no payload at all. Payloads are:
 * - validated by Zod schemas keyed by registered job type;
 * - stored CANONICALLY (recursively key-sorted JSON) so idempotent-create
 *   comparisons are byte-stable;
 * - size-bounded (`JOB_PAYLOAD_MAX_BYTES`) at creation AND re-checked before
 *   execution (bound parsing and payload size — blueprint §26 work package 2).
 */
import { z } from 'zod';
import { JOB_TYPE_MAX_LENGTH, JOB_TYPE_PATTERN } from './job-types';

/** Hard bound for a canonical persisted payload. */
export const JOB_PAYLOAD_MAX_BYTES = 16_384;

/** Hard bound for a persisted idempotency key. */
export const JOB_IDEMPOTENCY_KEY_MAX_LENGTH = 256;

/** Bounded optional free-text note (never logged, never delivered onward). */
export const MaintenanceHeartbeatPayloadSchema = z
  .object({
    note: z.string().max(200).optional(),
  })
  .strict();

export type MaintenanceHeartbeatPayload = z.infer<typeof MaintenanceHeartbeatPayloadSchema>;

/**
 * Per-type payload schemas. Only REGISTERED (implemented) job types appear
 * here; the engine refuses to create or execute a type without a schema
 * (fail-safe — ADR-0036 §7). Later phases append their schemas together
 * with their handlers.
 */
export const PAYLOAD_SCHEMAS: ReadonlyMap<string, z.ZodTypeAny> = new Map([
  ['jobs.maintenance_heartbeat', MaintenanceHeartbeatPayloadSchema],
]);

/** Create-time input validation (type is bounded syntax, NOT yet registered). */
export const CreateJobInputSchema = z
  .object({
    type: z.string().max(JOB_TYPE_MAX_LENGTH).regex(JOB_TYPE_PATTERN),
    idempotencyKey: z.string().min(1).max(JOB_IDEMPOTENCY_KEY_MAX_LENGTH),
    payload: z.unknown(),
    priority: z.number().int().min(0).max(100).optional(),
    runAfterMs: z.number().int().min(0).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    aggregateType: z.string().min(1).max(64).optional(),
    aggregateId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;

/** Canonical JSON: recursively key-sorted, no undefined, bounded depth. */
export function canonicalizeJson(value: unknown, maxDepth = 16): string {
  return JSON.stringify(sortValue(value, 0, maxDepth));
}

function sortValue(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) {
    throw new Error('payload_depth_exceeded');
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item, depth + 1, maxDepth));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      out[key] = sortValue(v, depth + 1, maxDepth);
    }
    return out;
  }
  return value;
}

export type PayloadParseResult<P = unknown> =
  | { readonly ok: true; readonly payload: P }
  | {
      readonly ok: false;
      readonly reason: 'unregistered_type' | 'payload_invalid' | 'payload_oversized';
    };

/**
 * Validate a persisted payload for a job type. `unregistered_type` is
 * distinct so the engine can poison the JOB (no handler will ever exist in
 * this deployment) instead of treating the payload as corrupt.
 */
export function parseJobPayload(jobType: string, rawPayloadJson: string): PayloadParseResult {
  if (rawPayloadJson.length > JOB_PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: 'payload_oversized' };
  }
  const schema = PAYLOAD_SCHEMAS.get(jobType);
  if (schema === undefined) {
    return { ok: false, reason: 'unregistered_type' };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawPayloadJson);
  } catch {
    return { ok: false, reason: 'payload_invalid' };
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, reason: 'payload_invalid' };
  }
  return { ok: true, payload: parsed.data };
}
