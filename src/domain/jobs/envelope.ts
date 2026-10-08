/**
 * Queue envelope contract and validation (Phase 3 — ADR-0036 §5; blueprint
 * §7 "Message envelope"; Zod introduced per ADR-0010; wire transfer
 * contract corrected by ADR-0037).
 *
 * The envelope is a REFERENCE, never a payload: `{ version: 1, jobId, type,
 * attempt, traceId }`. No source content, secrets, or execution payload
 * ever travels in a queue message (blueprint §1.2; AGENTS.md §3).
 *
 * WIRE TRANSFER CONTRACT — ONE canonical form (ADR-0037, v1.3.1):
 * - CANONICAL: producers send the validated structured envelope OBJECT.
 *   Cloudflare Queues serializes it, and the consumer receives the same
 *   object as `message.body` — there is no second serialization layer on
 *   either side, so producer and consumer can never disagree about the
 *   delivered body again (the v1.3.0 review found a valid message
 *   classified as poison because the producer pre-stringified while the
 *   consumer expected an object).
 * - DEFENSIVE: the consumer additionally normalizes a JSON-ENCODED STRING
 *   (one bounded parse) through the SAME validation path. This keeps
 *   pre-upgrade in-flight string messages and offline operator replay
 *   tooling working; content validation is identical for both forms.
 *   Anything else — invalid JSON, wrong shapes, oversized bodies — is
 *   malformed and fail-safe.
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
 * Hard bound for a JSON-ENCODED STRING body accepted by the defensive
 * normalization (ADR-0037). The canonical envelope serializes to well under
 * ~500 chars (jobId 64 + type 64 + traceId 128 + fields); 2048 chars is a
 * generous headroom that still bounds parse work — anything larger is
 * malformed by contract (fail-safe, no parse DoS surface).
 */
export const ENVELOPE_WIRE_JSON_MAX_CHARS = 2_048;

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
 * The CANONICAL wire form is the structured envelope object (ADR-0037). A
 * JSON-encoded string is normalized defensively (ONE bounded parse) and
 * then validated through the SAME path — so a pre-upgrade string message or
 * a replay tool's body resolves exactly like the canonical object.
 *
 * `version` is validated FIRST so an unsupported (future) version yields the
 * distinct `unsupported_version` outcome; everything else that fails shape,
 * bounds, or type checks is `malformed_envelope`. All outcomes are safe to
 * ack — the caller never retries a message that can never parse.
 */
export function parseQueueEnvelope(body: unknown): EnvelopeParseResult {
  let candidate: unknown = body;
  if (typeof body === 'string') {
    if (body.length > ENVELOPE_WIRE_JSON_MAX_CHARS) {
      return { ok: false, reason: 'malformed_envelope' };
    }
    try {
      candidate = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'malformed_envelope' };
    }
  }
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'version' in candidate &&
    (candidate as { version?: unknown }).version !== ENVELOPE_VERSION
  ) {
    return { ok: false, reason: 'unsupported_version' };
  }
  const parsed = QueueEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed_envelope' };
  }
  return { ok: true, envelope: parsed.data };
}

/**
 * Validate an envelope and return the CANONICAL wire OBJECT (ADR-0037):
 * producers hand this object to `queue.send()`; the platform serializes it
 * and the consumer receives the identical object. The Zod pass guarantees
 * that only the five bounded reference fields ever enter a queue message —
 * an invalid envelope fails the send (a recoverable enqueue failure for the
 * caller) instead of putting a malformed body on the wire.
 */
export function toWireEnvelope(envelope: QueueEnvelope): QueueEnvelope {
  return QueueEnvelopeSchema.parse(envelope);
}
