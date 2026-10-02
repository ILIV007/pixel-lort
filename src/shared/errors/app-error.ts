/**
 * Typed application errors.
 *
 * Rules:
 * - Every error that crosses a boundary carries a stable machine code.
 * - `message` values for known codes are authored constants (safe for HTTP).
 * - `details` is strictly sanitized: string values only, bounded, and keys
 *   that look sensitive are redacted before storage.
 * - Unknown thrown values are converted to `internal_error` and their raw
 *   message/stack stay internal (logs only) — never serialized to responses.
 */
import { isSensitiveKeyName } from '../security/sensitive-keys';

export const APP_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
  'service_unavailable',
  'config_invalid',
  // D1/database boundary errors (Phase 1A) — stable codes for mapped D1
  // failures; raw driver messages are classified internally and never
  // surfaced (see src/adapters/db/d1-errors.ts and docs/SECURITY_MODEL.md).
  'db_constraint_violation',
  'db_schema_invalid',
  'db_query_failed',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** HTTP status mapping for every application error code. */
export const HTTP_STATUS_BY_CODE: Readonly<Record<AppErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
  service_unavailable: 503,
  config_invalid: 503,
  db_constraint_violation: 409,
  db_schema_invalid: 503,
  db_query_failed: 500,
};

/**
 * Default, author-controlled messages. These are the ONLY strings that reach
 * production HTTP responses for their code. Never include dynamic values here.
 */
export const DEFAULT_ERROR_MESSAGES: Readonly<Record<AppErrorCode, string>> = {
  bad_request: 'Bad Request',
  unauthorized: 'Unauthorized',
  not_found: 'Not Found',
  method_not_allowed: 'Method Not Allowed',
  payload_too_large: 'Payload Too Large',
  unsupported_media_type: 'Unsupported Media Type',
  internal_error: 'Internal Server Error',
  service_unavailable: 'Service Unavailable',
  config_invalid: 'Service Configuration Invalid',
  db_constraint_violation: 'Database Constraint Violation',
  db_schema_invalid: 'Database Schema Invalid',
  db_query_failed: 'Database Query Failed',
};

export interface AppErrorOptions {
  /** Overrides the safe default message. Must never contain secret values. */
  message?: string;
  /** Safe, bounded metadata (e.g. { field: 'LOG_LEVEL' }). Values are sanitized. */
  details?: Readonly<Record<string, unknown>>;
  /** Original cause, preserved for internal logging only. */
  cause?: unknown;
}

const MAX_DETAILS_ENTRIES = 25;
const MAX_DETAIL_KEY_LENGTH = 64;
const MAX_DETAIL_VALUE_LENGTH = 256;

/** Sanitize details: string values only, bounded sizes, sensitive keys redacted. */
export function sanitizeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  if (!details) {
    return {};
  }
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    if (Object.keys(sanitized).length >= MAX_DETAILS_ENTRIES) {
      break;
    }
    const key = rawKey.slice(0, MAX_DETAIL_KEY_LENGTH);
    if (typeof rawValue !== 'string') {
      // Non-string detail values are not representable safely; drop them.
      continue;
    }
    sanitized[key] = isSensitiveKeyName(key)
      ? '[REDACTED]'
      : rawValue.slice(0, MAX_DETAIL_VALUE_LENGTH);
  }
  return sanitized;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: AppErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? DEFAULT_ERROR_MESSAGES[code], {
      cause: options.cause,
    });
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    this.details = sanitizeDetails(options.details);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Wrap any thrown value into an AppError without leaking its internals. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }
  return new AppError('internal_error', { cause: value });
}
