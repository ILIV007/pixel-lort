/**
 * Request/correlation ID helpers.
 *
 * Correlation IDs tie logs across an event's lifetime. Incoming IDs are
 * honored only when they pass a strict format check; everything else is
 * replaced with a fresh UUID so malformed or hostile input cannot pollute
 * logs or response headers.
 */
import type { IdGenerator } from './id';
import { cryptoIdGenerator } from './id';

/** Printable ASCII, no spaces, bounded length. */
export const REQUEST_ID_PATTERN = /^[!-~]{8,128}$/;

export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export interface RequestIdResolution {
  readonly requestId: string;
  readonly source: 'header' | 'generated';
}

/**
 * Resolve the correlation ID for an incoming request. The header value is
 * used only if it matches the strict format; otherwise a new UUID is
 * generated. The raw header value is never echoed when invalid.
 */
export function resolveRequestId(
  request: Request,
  idGenerator: IdGenerator = cryptoIdGenerator,
): RequestIdResolution {
  const raw = request.headers.get('x-request-id')?.trim();
  if (raw !== undefined && raw !== '' && isValidRequestId(raw)) {
    return { requestId: raw, source: 'header' };
  }
  return { requestId: idGenerator.newId(), source: 'generated' };
}
