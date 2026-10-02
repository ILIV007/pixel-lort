/**
 * Safe error serialization for HTTP responses.
 *
 * This module is the ONLY sanctioned path from a thrown value to an HTTP
 * error body. Guarantees:
 * - The body carries only: code, safe message, requestId, sanitized details.
 * - Raw error messages, stacks, and causes NEVER reach the response.
 * - Unknown errors collapse to `internal_error` with a generic message.
 */
import { DEFAULT_ERROR_MESSAGES, toAppError, type AppError, type AppErrorCode } from './app-error';

export interface PublicErrorBody {
  error: {
    code: AppErrorCode;
    message: string;
    requestId?: string;
    details?: Readonly<Record<string, string>>;
  };
}

/** Convert any thrown value into a minimal, safe, JSON-serializable body. */
export function toPublicErrorBody(value: unknown, requestId?: string): PublicErrorBody {
  const appError: AppError = toAppError(value);
  const body: PublicErrorBody = {
    error: {
      code: appError.code,
      message: appError.message ?? DEFAULT_ERROR_MESSAGES[appError.code],
    },
  };
  if (requestId !== undefined) {
    body.error.requestId = requestId;
  }
  if (Object.keys(appError.details).length > 0) {
    body.error.details = appError.details;
  }
  return body;
}
