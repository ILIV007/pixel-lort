/**
 * Safe classification of D1 driver errors into stable application error
 * codes (Phase 1A).
 *
 * SECURITY: the raw driver message is inspected ONLY for classification and
 * is never surfaced. The returned AppError carries an author-constant safe
 * message; the original error is preserved as `cause` for INTERNAL fail-safe
 * logging only (collapsed to name/code/status by src/observability/safe-error.ts).
 * Raw messages can contain table/column names but never bind-parameter values;
 * they are still never logged or serialized.
 */
import { AppError } from '../../shared/errors/app-error';

/** Stable codes for mapped D1 failures. */
export type DbErrorCode = 'db_constraint_violation' | 'db_schema_invalid' | 'db_query_failed';

const CONSTRAINT_PATTERNS: readonly RegExp[] = [
  /UNIQUE constraint failed/i,
  /FOREIGN KEY constraint failed/i,
  /CHECK constraint failed/i,
  /NOT NULL constraint failed/i,
  /PRIMARY KEY must be unique/i,
];

const SCHEMA_PATTERNS: readonly RegExp[] = [/no such table/i, /no such column/i];

/**
 * Classify any thrown value from a D1 operation into a stable DbErrorCode.
 * Unknown shapes classify as `db_query_failed` (fail-safe default).
 */
export function classifyD1Error(error: unknown): DbErrorCode {
  let raw = '';
  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      raw = message;
    }
  }

  if (CONSTRAINT_PATTERNS.some((pattern) => pattern.test(raw))) {
    return 'db_constraint_violation';
  }
  if (SCHEMA_PATTERNS.some((pattern) => pattern.test(raw))) {
    return 'db_schema_invalid';
  }
  return 'db_query_failed';
}

/** Map any thrown D1 error into a stable AppError (raw value kept as cause). */
export function toDbAppError(error: unknown): AppError {
  return new AppError(classifyD1Error(error), { cause: error });
}
