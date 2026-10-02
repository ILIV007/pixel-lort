/**
 * Value redaction for structured logs.
 *
 * Walks arbitrary log fields and replaces values whose KEYS look sensitive
 * (see shared/security/sensitive-keys.ts). Walking is bounded by depth and
 * key count so hostile or accidental huge objects cannot blow the CPU/memory
 * budget of a Worker invocation.
 *
 * Redaction is key-based: values of sensitive keys are never inspected,
 * transformed, truncated, or logged — they are replaced wholesale.
 */
import { isSensitiveKeyName } from '../shared/security/sensitive-keys';
import type { LogFields } from './logger';

export const REDACTED_MARKER = '[REDACTED]';
export const TRUNCATED_MARKER = '[TRUNCATED]';

const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;

export function redactValue(value: unknown, depth: number = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
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
