/**
 * Structured logging interface and JSON-line implementation.
 *
 * Rules (docs/SECURITY_MODEL.md):
 * - This module is the ONLY code allowed to write to console in Worker code.
 * - Every line is a single JSON object: { ts, level, msg, ...fields }.
 * - Fields are REDACTED before serialization; sensitive keys never reach the
 *   sink even if a caller passes them by mistake.
 * - Error values passed as `fields.error` are serialized to
 *   { name, message, stack } for internal logs. Stacks are log-only and must
 *   never be copied into HTTP responses.
 * - Request bodies, authorization headers, cookies, tokens, and full
 *   environment objects must never be passed to the logger by callers.
 */
import { levelRank, type LogLevel } from '../shared/types/log-level';
import type { Clock } from '../shared/time/clock';
import { systemClock } from '../shared/time/clock';
import { redactFields } from './redaction';

export type LogFields = Record<string, unknown>;

export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger with additional base fields (e.g. requestId). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit; lower levels are dropped. Default: info. */
  level?: LogLevel;
  /** Fields merged into every line (redacted). */
  base?: LogFields;
  /** Clock for timestamps; inject a fixed clock in tests. */
  clock?: Clock;
  /** Output sink; inject a capture sink in tests. Default: console JSON lines. */
  sink?: LogSink;
}

function defaultSink(level: LogLevel, line: string): void {
  switch (level) {
    case 'debug':
      console.debug(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
      console.error(line);
      break;
  }
}

/** Serialize an unknown thrown value for logs (never for HTTP responses). */
export function serializeError(value: unknown, depth: number = 0): Record<string, unknown> {
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    if (depth < 3) {
      if (typeof value.stack === 'string') {
        out.stack = value.stack;
      }
      if (value.cause !== undefined && value.cause !== null) {
        out.cause = serializeError(value.cause, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    return { value };
  }
  return { value: Object.prototype.toString.call(value) };
}

class JsonLineLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel,
    private readonly base: LogFields,
    private readonly clock: Clock,
    private readonly sink: LogSink,
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLineLogger(this.minLevel, { ...this.base, ...fields }, this.clock, this.sink);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (levelRank(level) < levelRank(this.minLevel)) {
      return;
    }
    let safeFields: LogFields = fields ?? {};
    if (safeFields['error'] !== undefined) {
      safeFields = { ...safeFields, error: serializeError(safeFields['error']) };
    }
    const merged = redactFields({ ...this.base, ...safeFields });
    const line = JSON.stringify({
      ts: new Date(this.clock.now()).toISOString(),
      level,
      msg: message,
      ...merged,
    });
    this.sink(level, line);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new JsonLineLogger(
    options.level ?? 'info',
    options.base ?? {},
    options.clock ?? systemClock,
    options.sink ?? defaultSink,
  );
}
