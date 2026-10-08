/**
 * Queue envelope contract and validation (Phase 3 — ADR-0036 §5; blueprint
 * §7 "Message envelope"; Zod introduced per ADR-0010).
 *
 * The envelope is a REFERENCE, never a payload: `{ version: 1, jobId, type,
 * attempt, traceId }`. No source content, secrets, or execution payload
 * ever travels in a queue message (blueprint §1.2; AGENTS.md §3).
 *
 * Envelope `attempt` semantics (ADR-0036 §5): the execution generation the
 * delivery is EXPECTED to award (`row.attempts + 1` at send time, minimum 1
 * — the blueprint counter starts at 1). Strictly informational. The awarded
 * execution generation is EXCLUSIVELY the row's `attempts` after the atomic
 * claim. A stale or forged envelope can never override row values or bypass
 * `run_after`: the claim precondition enforces due-ness and claimability,
 * fenced mutations enforce generation, and a mismatch is only logged as a
 * stable anomaly.
 */
import { z } from 'zod';
import { JOB_TYPE_MAX_LENGTH, JOB_TYPE_PATTERN } from './job-types';

/** Envelope schema version (blueprint §7). Only version 1 is supported. */
export const ENVELOPE_VERSION = 1 as const;

export const ENVELOPE_JOB_ID_MAX_LENGTH = 64;
export const ENVELOPE_TRACE_ID_MAX_LENGTH = 128;
export const ENVELOPE_ATTEMPT_MAX = 1_000_000;

/**
 * Raw wire shape. `type` is bounded syntax (NOT the registered union):
 * an unknown-but-well-formed type must REACH the engine so the durable row
 * can be dead-lettered fail-safe (poison JOB handling, ADR-0036 §4) instead
 * of being silently dropped as a parse error.
 */
export const QueueEnvelopeSchema = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    jobId: z.string().min(1).max(ENVELOPE_JOB_ID_MAX_LENGTH),
    type: z.string().max(JOB_TYPE_MAX_LENGTH).regex(JOB_TYPE_PATTERN),
    attempt: z.number().int().min(1).max(ENVELOPE_ATTEMPT_MAX),
    traceId: z.string().min(1).max(ENVELOPE_TRACE_ID_MAX_LENGTH),
  })
  // STRICT: the envelope is a reference — any extra field (e.g. smuggled
  // payload content) is malformed by contract.
  .strict();

export type QueueEnvelope = z.infer<typeof QueueEnvelopeSchema>;

/** Stable parse outcomes — no raw Zod issues ever leave this module. */
export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: QueueEnvelope }
  | { readonly ok: false; readonly reason: 'malformed_envelope' | 'unsupported_version' };

/**
 * Parse and validate an untrusted queue message body.
 *
 * `version` is validated FIRST so an unsupported (future) version yields the
 * distinct `unsupported_version` outcome; everything else that fails shape,
 * bounds, or type checks is `malformed_envelope`. All outcomes are safe to
 * ack — the caller never retries a message that can never parse.
 */
export function parseQueueEnvelope(body: unknown): EnvelopeParseResult {
  if (
    typeof body === 'object' &&
    body !== null &&
    'version' in body &&
    (body as { version?: unknown }).version !== ENVELOPE_VERSION
  ) {
    return { ok: false, reason: 'unsupported_version' };
  }
  const parsed = QueueEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed_envelope' };
  }
  return { ok: true, envelope: parsed.data };
}

/** Serialize an envelope for sending (bounded, stable field order). */
export function serializeQueueEnvelope(envelope: QueueEnvelope): string {
  return JSON.stringify({
    version: envelope.version,
    jobId: envelope.jobId,
    type: envelope.type,
    attempt: envelope.attempt,
    traceId: envelope.traceId,
  });
}
