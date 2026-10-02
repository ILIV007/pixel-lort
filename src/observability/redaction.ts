/**
 * Value redaction for structured logs.
 *
 * Walks arbitrary log fields and:
 * 1. Replaces ERROR instances (at any depth) with fail-safe summaries —
 *    never message, stack, or cause (see observability/safe-error.ts and
 *    ADR-0017). Key-based redaction alone cannot catch secrets embedded
 *    inside error strings.
 * 2. Replaces values whose KEYS look sensitive (see
 *    shared/security/sensitive-keys.ts) with a redaction marker.
 *
 * Walking is bounded by depth and key count so hostile or accidental huge
 * objects cannot blow the CPU/memory budget of a Worker invocation.
 *
 * Redaction is fail-safe by default: values of sensitive keys are never
 * inspected, transformed, truncated, or logged — they are replaced wholesale.
 */
import { isSensitiveKeyName } from '../shared/security/sensitive-keys';
import type { LogFields } from './logger';
import { toSafeErrorFields } from './safe-error';

export const REDACTED_MARKER = '[REDACTED]';
export const TRUNCATED_MARKER = '[TRUNCATED]';

const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;

export function redactValue(value: unknown, depth: number = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Fail-safe error handling BEFORE any structural walk: an Error at any
  // depth collapses to safe fields, never message/stack/cause (ADR-0017).
  if (value instanceof Error) {
    return toSafeErrorFields(value);
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED_MARKER;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ENTRIES) {
      items.push(TRUNCATED_MARKER);
    }
    return items;
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const keys = Object.keys(source).slice(0, MAX_ENTRIES);
  for (const key of keys) {
    output[key] = isSensitiveKeyName(key) ? REDACTED_MARKER : redactValue(source[key], depth + 1);
  }
  if (Object.keys(source).length > MAX_ENTRIES) {
    output[TRUNCATED_MARKER] = REDACTED_MARKER;
  }
  return output;
}

/** Redact a log-fields record before it is serialized to a log line. */
export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, 0) as LogFields;
}
