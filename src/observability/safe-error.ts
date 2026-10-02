/**
 * Fail-safe error serialization for LOGS (ADR-0017).
 *
 * Key-based redaction alone cannot protect secrets embedded INSIDE a string:
 * `new Error("provider request failed using token <secret>")` has the
 * non-sensitive key `message`, yet the value contains a credential.
 *
 * Policy (docs/SECURITY_MODEL.md §2):
 * - The default logger NEVER serializes raw unknown Error messages, stacks,
 *   causes, response bodies, or provider payloads — at any depth.
 * - Only safe fields are emitted: error name, stable application code, HTTP
 *   status, and a discriminator for unexpected thrown values.
 * - Known AppError codes may be logged (they are author-controlled constants).
 * - Raw stack traces are never emitted by the default logger.
 * - Arbitrary thrown values are never stringified: non-Error values reduce to
 *   their JS type tag only.
 */
import { isAppError } from '../shared/errors/app-error';

export interface SafeErrorFields {
  readonly errorKind: 'app_error' | 'error' | 'unexpected';
  /** Error class name (e.g. "Error", "AppError", "TypeError"). */
  readonly name: string;
  /** Stable application code — only present for AppError. */
  readonly code?: string;
  /** Mapped HTTP status — only present for AppError. */
  readonly httpStatus?: number;
  /** JS type tag for non-Error thrown values, e.g. "[object String]". */
  readonly typeName?: string;
}

/**
 * Reduce any thrown value to safe, bounded log fields. The returned object
 * structurally cannot contain `message`, `stack`, `cause`, or any dynamic
 * string content from the value.
 */
export function toSafeErrorFields(value: unknown): SafeErrorFields {
  if (isAppError(value)) {
    return {
      errorKind: 'app_error',
      name: 'AppError',
      code: value.code,
      httpStatus: value.status,
    };
  }
  if (value instanceof Error) {
    return { errorKind: 'error', name: value.name };
  }
  return {
    errorKind: 'unexpected',
    name: 'UnknownThrownValue',
    typeName: Object.prototype.toString.call(value),
  };
}
