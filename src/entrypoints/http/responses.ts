/**
 * HTTP response helpers.
 *
 * Every response is constructed here so security headers are applied
 * consistently. Error responses can only be produced via `errorResponse`,
 * which routes through the safe serializer (shared/errors/serialize.ts) and
 * therefore never leaks stacks, causes, or environment values.
 */
import { HTTP_STATUS_BY_CODE, toAppError } from '../../shared/errors/app-error';
import { toPublicErrorBody } from '../../shared/errors/serialize';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS },
  });
}

/**
 * Build a minimal, safe error response from any thrown value.
 * The raw error is logged by the caller; only the sanitized body is returned.
 */
export function errorResponse(value: unknown, requestId: string): Response {
  const appError = toAppError(value);
  const body = toPublicErrorBody(value, requestId);
  return jsonResponse(HTTP_STATUS_BY_CODE[appError.code] ?? 500, body);
}
