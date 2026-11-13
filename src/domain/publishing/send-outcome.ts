/**
 * Phase 8.2 — the send outcome classifier (sop1): the ADR-0032 gate's HONEST
 * classification of every transport error shape.
 *
 * The classifier is a TOTAL function over `unknown`: every input yields
 * exactly one outcome, never a throw. The transport error is consumed as a
 * STRUCTURAL shape (name 'TelegramApiError' + a string `code`) — the domain
 * imports no adapter (the 7.2 house rule); the application layer passes the
 * real TelegramApiError and its shape matches structurally.
 *
 * The outcome families (ADR-0032):
 *  - `failed_proved` — PROVED non-delivery: the request was NOT accepted.
 *      * 429 rate limiting: rejected BEFORE processing (no message was
 *        created); retryable after the server's retry_after, which is
 *        validated against the client contract (1s..1h) and dropped to null
 *        when out of contract — never trusted blindly.
 *      * the 4xx client family (unauthorized / forbidden / not_found /
 *        bad_request): hold — blueprint §7: «Telegram 400 semantic error:
 *        no blind retry; hold and notify». Never carries a retry_after.
 *  - `uncertain` — the ADR-0032 ambiguous window: timeout, network failure,
 *    5xx, an unreadable response envelope, an unknown error-code vocabulary
 *    growth, a malformed error shape, and ANY unknown throw shape. The
 *    message MAY have arrived; an uncertain row is NEVER auto-resent.
 *
 * DELIBERATE pin vs the admin-post path (recorded in ADR-0058): the
 * admin-post classifier treats 429 as uncertain IN CODE while its own
 * docblock names 429 as proved non-delivery («including 429 rate limiting —
 * the request was NOT accepted»). This classifier pins 429 as
 * failed_proved{retryable} per the blueprint §7 «Telegram 429: respect
 * retry_after» and the admin-post docblock. The admin-post code mismatch is
 * recorded as a finding: its direction is conservative (a 429-marked-
 * uncertain admin post simply waits for human confirmation — no false
 * success, no auto-resend), so it is NOT fixed inside the Phase 8.2 scope;
 * the publications engine needs the precise classification because it owns
 * the bounded retry machinery.
 *
 * Pure: no I/O, no clock, no randomness; JSON-equal deterministic.
 */

export const SEND_OUTCOME_POLICY_VERSION = 'sop1' as const;

/** The client's retry_after contract bound: 1 second .. 1 hour. */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 3_600_000;

export type SendOutcome =
  | {
      readonly kind: 'failed_proved';
      /** true only for 429 (retry after the server's retry_after). */
      readonly retryable: boolean;
      /** true for the 4xx hold family (blueprint §7: hold and notify). */
      readonly hold: boolean;
      /** The validated server retry_after, or null (the 60s floor applies later). */
      readonly retryAfterMs: number | null;
      readonly code: string;
    }
  | {
      readonly kind: 'uncertain';
      readonly code: string;
    };

/** The 4xx family that is PROVED non-delivery and held for a human. */
const HOLD_CODES: ReadonlySet<string> = new Set([
  'telegram_unauthorized',
  'telegram_forbidden',
  'telegram_not_found',
  'telegram_bad_request',
]);

/** The ambiguous-window codes: the request MAY have been processed. */
const UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  'telegram_timeout',
  'telegram_network_error',
  'telegram_server_error',
  'telegram_response_invalid',
]);

function isValidRetryAfterMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= RETRY_AFTER_MIN_MS &&
    value <= RETRY_AFTER_MAX_MS
  );
}

export function classifySendOutcome(error: unknown): SendOutcome {
  if (
    error === null ||
    typeof error !== 'object' ||
    (error as { name?: unknown }).name !== 'TelegramApiError'
  ) {
    return { kind: 'uncertain', code: 'unknown_error' };
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
    return { kind: 'uncertain', code: 'unknown_error' };
  }
  if (code === 'telegram_rate_limited') {
    const rawRetryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    return {
      kind: 'failed_proved',
      retryable: true,
      hold: false,
      retryAfterMs: isValidRetryAfterMs(rawRetryAfterMs) ? rawRetryAfterMs : null,
      code,
    };
  }
  if (HOLD_CODES.has(code)) {
    return {
      kind: 'failed_proved',
      retryable: false,
      hold: true,
      retryAfterMs: null,
      code,
    };
  }
  if (UNCERTAIN_CODES.has(code)) {
    return { kind: 'uncertain', code };
  }
  // An unknown code in the adapter's vocabulary growth stays uncertain —
  // never guessed into a proved outcome.
  return { kind: 'uncertain', code };
}
