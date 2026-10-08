import { describe, expect, it } from 'vitest';
import { parseQueueEnvelope, serializeQueueEnvelope } from '../../src/domain/jobs/envelope';
import {
  canonicalizeJson,
  parseJobPayload,
  JOB_PAYLOAD_MAX_BYTES,
} from '../../src/domain/jobs/payloads';
import { computeBackoffDelayMs, decideRetry } from '../../src/domain/jobs/lifecycle';

/**
 * Envelope + payload contract tests (Phase 3 — ADR-0036 §2/§5; Zod per
 * ADR-0010). Boundaries, forged/stale shapes, and canonical-JSON stability
 * are pinned here; engine behavior is covered by the integration suites.
 */

describe('queue envelope contract', () => {
  const valid = { version: 1 as const, jobId: 'job-1', type: 'jobs.maintenance_heartbeat', attempt: 1, traceId: 'trace-1' };

  it('accepts a valid envelope', () => {
    const parsed = parseQueueEnvelope(valid);
    expect(parsed).toEqual({ ok: true, envelope: valid });
  });

  it('classifies an unsupported (future) version distinctly', () => {
    const parsed = parseQueueEnvelope({ ...valid, version: 2 });
    expect(parsed).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  it.each([
    ['null body', null],
    ['non-object body', 'plain-payload'],
    ['missing jobId', { ...valid, jobId: undefined }],
    ['empty jobId', { ...valid, jobId: '' }],
    ['oversized jobId', { ...valid, jobId: 'x'.repeat(65) }],
    ['malformed type syntax', { ...valid, type: 'NOT A TYPE' }],
    ['oversized type', { ...valid, type: 'a'.repeat(65) }],
    ['zero attempt', { ...valid, attempt: 0 }],
    ['non-integer attempt', { ...valid, attempt: 1.5 }],
    ['attempt over bound', { ...valid, attempt: 2_000_000 }],
    ['missing traceId', { ...valid, traceId: undefined }],
    ['oversized traceId', { ...valid, traceId: 't'.repeat(129) }],
    ['extra top-level field', { ...valid, payload: { secret: 'value' } }],
  ])('rejects %s as malformed (never a parse-crash)', (_label, body) => {
    const parsed = parseQueueEnvelope(body);
    expect(parsed).toEqual({ ok: false, reason: 'malformed_envelope' });
  });

  it('serializes with a stable field set (reference only — no payload possible)', () => {
    const wire = JSON.parse(serializeQueueEnvelope(valid));
    expect(Object.keys(wire).sort()).toEqual(['attempt', 'jobId', 'traceId', 'type', 'version']);
  });
});

describe('payload contracts', () => {
  it('parses a valid maintenance heartbeat payload (note optional)', () => {
    expect(parseJobPayload('jobs.maintenance_heartbeat', '{}')).toEqual({ ok: true, payload: {} });
    expect(parseJobPayload('jobs.maintenance_heartbeat', '{"note":"tick"}')).toEqual({
      ok: true,
      payload: { note: 'tick' },
    });
  });

  it('rejects an oversized note', () => {
    const raw = JSON.stringify({ note: 'x'.repeat(201) });
    expect(parseJobPayload('jobs.maintenance_heartbeat', raw)).toEqual({
      ok: false,
      reason: 'payload_invalid',
    });
  });

  it('rejects unknown fields (strict schemas)', () => {
    expect(parseJobPayload('jobs.maintenance_heartbeat', '{"extra":1}')).toEqual({
      ok: false,
      reason: 'payload_invalid',
    });
  });

  it('distinguishes unregistered types from corrupt payloads', () => {
    expect(parseJobPayload('future.not_implemented', '{}')).toEqual({
      ok: false,
      reason: 'unregistered_type',
    });
    expect(parseJobPayload('jobs.maintenance_heartbeat', '{broken')).toEqual({
      ok: false,
      reason: 'payload_invalid',
    });
  });

  it('bounds payload size before parsing', () => {
    const oversized = ' '.repeat(JOB_PAYLOAD_MAX_BYTES + 1);
    expect(parseJobPayload('jobs.maintenance_heartbeat', oversized)).toEqual({
      ok: false,
      reason: 'payload_oversized',
    });
  });

  it('canonicalizes JSON with recursively sorted keys (stable comparisons)', () => {
    expect(canonicalizeJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    // Object key order never changes the canonical form.
    expect(canonicalizeJson({ a: 1, b: 2 })).toBe(canonicalizeJson({ b: 2, a: 1 }));
    // undefined values are omitted.
    expect(canonicalizeJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('backoff (full jitter, bounded)', () => {
  const params = { baseMs: 2000, capMs: 3600000 };

  it('grows exponentially and never exceeds the cap', () => {
    // random() = 1 → the delay equals the exponential bound.
    for (const [attempt, expected] of [
      [1, 2000],
      [2, 4000],
      [3, 8000],
      [20, 3600000],
    ] as const) {
      expect(computeBackoffDelayMs(attempt, params, () => 1)).toBe(expected);
    }
  });

  it('is deterministic under an injected random (full jitter range)', () => {
    expect(computeBackoffDelayMs(2, params, () => 0)).toBe(0);
    expect(computeBackoffDelayMs(2, params, () => 0.5)).toBe(2000);
    expect(computeBackoffDelayMs(2, params, () => 0.9999)).toBe(4000);
  });

  it('raises to the retry_after floor and caps it', () => {
    const floored = { ...params, retryAfterFloorMs: 30_000 };
    expect(computeBackoffDelayMs(1, floored, () => 0)).toBe(30_000);
    const bigFloor = { ...params, retryAfterFloorMs: 10_000_000 };
    expect(computeBackoffDelayMs(1, bigFloor, () => 0)).toBe(3_600_000);
  });

  it('never reschedules beyond max_attempts and dead-letters permanents', () => {
    expect(decideRetry('permanent', 'job_handler_permanent_error', 1, 3, params, () => 0)).toEqual({
      kind: 'exhausted',
    });
    expect(decideRetry('retryable', 'job_handler_retryable_error', 3, 3, params, () => 0)).toEqual({
      kind: 'exhausted',
    });
    expect(decideRetry('retryable', 'job_handler_retryable_error', 2, 3, params, () => 1)).toEqual({
      kind: 'reschedule',
      delayMs: 4000,
    });
  });
});
