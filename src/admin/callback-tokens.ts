/**
 * Callback data contract (Phase 2A).
 *
 * Telegram limits callback_data to 64 UTF-8 bytes. The approved admin map
 * (docs/blueprint/v1/pixel_admin_map_v1.json → callbackEncoding) fixes the
 * contract: `a:<base64url_token>`, at most 64 bytes, with all state held
 * SERVER-SIDE in the D1 `admin_action_tokens` table. Nothing else is ever
 * embedded: no JSON payload, no permission decision, no user identity —
 * the token is opaque and resolves to (and only for) its bound user.
 */

export const CALLBACK_DATA_MAX_BYTES = 64;
export const CALLBACK_TOKEN_PREFIX = 'a:';
/** base64url token bounds: 16..43 characters keeps `a:` + token <= 64 bytes. */
export const CALLBACK_TOKEN_MIN_LENGTH = 16;
export const CALLBACK_TOKEN_MAX_LENGTH = 43;
export const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,43}$/;

export type CallbackDataParseReason = 'empty' | 'too_long' | 'bad_prefix' | 'bad_token_format';

export type CallbackDataParseResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: CallbackDataParseReason };

/**
 * Parse callback data in the `a:<base64url_token>` contract.
 * Length is checked on UTF-8 BYTES (multibyte content cannot smuggle itself
 * past the 64-byte Telegram limit). Reasons are stable codes only — the
 * raw data is never logged by callers.
 */
export function parseCallbackData(data: string): CallbackDataParseResult {
  if (data.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  // Cheap character pre-bound first: byteLength >= charLength for UTF-8.
  if (data.length > CALLBACK_DATA_MAX_BYTES) {
    return { ok: false, reason: 'too_long' };
  }
  if (new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) {
    return { ok: false, reason: 'too_long' };
  }
  if (!data.startsWith(CALLBACK_TOKEN_PREFIX)) {
    return { ok: false, reason: 'bad_prefix' };
  }
  const token = data.slice(CALLBACK_TOKEN_PREFIX.length);
  if (!CALLBACK_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'bad_token_format' };
  }
  return { ok: true, token };
}

/**
 * Format a token into callback data. Invalid tokens (wrong shape or too
 * long) are rejected loudly — authors must never receive truncated or
 * silently "fixed" callback data.
 */
export function formatCallbackData(token: string): string {
  if (!CALLBACK_TOKEN_PATTERN.test(token)) {
    throw new Error('callback token rejected: invalid format');
  }
  const data = `${CALLBACK_TOKEN_PREFIX}${token}`;
  if (new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) {
    throw new Error('callback token rejected: exceeds 64 byte limit');
  }
  return data;
}
