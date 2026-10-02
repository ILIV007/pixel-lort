/**
 * Observability policy for failed requests (ADR-0017).
 *
 * - Expected 4xx application errors produce ONE concise warn event with
 *   stable code + HTTP status. They are routine (unknown paths, method
 *   probing) and must not create error-level logs or stack traces.
 * - Unexpected 5xx errors may use error level — but still only fail-safe
 *   fields (no raw message, stack, cause, or thrown values).
 * - HTTP responses are unaffected: bodies are built separately by
 *   entrypoints/http/responses.ts through the safe serializer.
 */
import { toAppError, type AppError } from '../../shared/errors/app-error';
import type { Logger } from '../../observability/logger';

/**
 * Log a failed request according to policy and return the normalized
 * AppError so the caller can build the response from the same value.
 */
export function logRequestError(logger: Logger, thrown: unknown): AppError {
  const appError = toAppError(thrown);
  if (appError.status < 500) {
    logger.warn('http.request.client_error', {
      code: appError.code,
      httpStatus: appError.status,
    });
  } else {
    logger.error('http.request.failed', {
      code: appError.code,
      httpStatus: appError.status,
      // Fail-safe serialization: AppError collapses to
      // { errorKind, name, code, httpStatus } — never message/stack/cause.
      error: appError,
    });
  }
  return appError;
}
