import { describe, expect, it } from 'vitest';
import {
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
  SEND_OUTCOME_POLICY_VERSION,
  classifySendOutcome,
} from '../../src/domain/publishing/send-outcome';

/**
 * Phase 8.2 — the send outcome classifier (sop1): the ADR-0032 gate's
 * HONEST classification of every transport outcome.
 *
 * - published:        a parsed Bot API response carrying a message id
 *                     (the caller owns the proof; the classifier sees the
 *                     error channel only).
 * - failed_proved:    PROVED non-delivery — the request was NOT accepted:
 *                     429 rate limiting (rejected before processing,
 *                     retryable after the server's retry_after) and the
 *                     4xx client family (hold — blueprint §7: no blind
 *                     retry; hold and notify).
 * - uncertain:        the ADR-0032 ambiguous window — timeout, network
 *                     failure, 5xx, an unreadable response envelope, and
 *                     ANY unknown throw shape (fail-safe default). The
 *                     message MAY have arrived; an uncertain row is NEVER
 *                     auto-resent.
 *
 * DELIBERATE pin vs the admin-post path (recorded in ADR-0058): the
 * admin-post classifier treats 429 as uncertain in code while its own
 * docblock names 429 as proved non-delivery — the publications classifier
 * pins 429 as failed_proved{retryable} per the blueprint §7 «Telegram 429:
 * respect retry_after» and the admin-post docblock; the admin-post code
 * mismatch is recorded as a finding (conservative direction, no unsafe
 * behavior — a 429-marked-uncertain admin post simply waits for a human).
 */

function telegramError(
  code: string,
  extra: { retryable?: boolean; retryAfterMs?: number } = {},
): { name: string; code: string; retryable?: boolean; retryAfterMs?: number } {
  return { name: 'TelegramApiError', code, ...extra };
}

describe('publishing-82 send outcome: the policy tag', () => {
  it('exposes the classifier policy version', () => {
    expect(SEND_OUTCOME_POLICY_VERSION).toBe('sop1');
  });

  it('exposes the retry_after validation bounds (the client contract: 1s .. 1h)', () => {
    expect(RETRY_AFTER_MIN_MS).toBe(1_000);
    expect(RETRY_AFTER_MAX_MS).toBe(3_600_000);
  });
});

describe('publishing-82 send outcome: PROVED non-delivery (429 rate limiting)', () => {
  it('429 is failed_proved and retryable, honoring the server retry_after', () => {
    expect(
      classifySendOutcome(telegramError('telegram_rate_limited', { retryAfterMs: 30_000 })),
    ).toEqual({
      kind: 'failed_proved',
      retryable: true,
      hold: false,
      retryAfterMs: 30_000,
      code: 'telegram_rate_limited',
    });
  });

  it('a missing retry_after still proves non-delivery with retryAfterMs null (the floor applies later)', () => {
    expect(classifySendOutcome(telegramError('telegram_rate_limited'))).toEqual({
      kind: 'failed_proved',
      retryable: true,
      hold: false,
      retryAfterMs: null,
      code: 'telegram_rate_limited',
    });
  });

  it('an out-of-contract retry_after is dropped to null, never trusted', () => {
    expect(
      classifySendOutcome(telegramError('telegram_rate_limited', { retryAfterMs: 0 })),
    ).toEqual({
      kind: 'failed_proved',
      retryable: true,
      hold: false,
      retryAfterMs: null,
      code: 'telegram_rate_limited',
    });
    expect(
      classifySendOutcome(telegramError('telegram_rate_limited', { retryAfterMs: 3_600_001 })),
    ).toEqual({
      kind: 'failed_proved',
      retryable: true,
      hold: false,
      retryAfterMs: null,
      code: 'telegram_rate_limited',
    });
    expect(
      classifySendOutcome(telegramError('telegram_rate_limited', { retryAfterMs: 30_000.5 })),
    ).toMatchObject({ retryAfterMs: null });
  });
});

describe('publishing-82 send outcome: PROVED non-delivery, hold family (4xx)', () => {
  it('the 4xx client family is failed_proved, non-retryable, hold', () => {
    for (const code of [
      'telegram_unauthorized',
      'telegram_forbidden',
      'telegram_not_found',
      'telegram_bad_request',
    ]) {
      expect(classifySendOutcome(telegramError(code))).toEqual({
        kind: 'failed_proved',
        retryable: false,
        hold: true,
        retryAfterMs: null,
        code,
      });
    }
  });

  it('a hold failure NEVER carries a retry_after even if the transport attached one', () => {
    expect(
      classifySendOutcome(telegramError('telegram_bad_request', { retryAfterMs: 5_000 })),
    ).toEqual({
      kind: 'failed_proved',
      retryable: false,
      hold: true,
      retryAfterMs: null,
      code: 'telegram_bad_request',
    });
  });
});

describe('publishing-82 send outcome: the ADR-0032 ambiguous window (uncertain)', () => {
  it('timeout, network failure, 5xx and an unreadable envelope are uncertain', () => {
    for (const code of [
      'telegram_timeout',
      'telegram_network_error',
      'telegram_server_error',
      'telegram_response_invalid',
    ]) {
      expect(classifySendOutcome(telegramError(code))).toEqual({
        kind: 'uncertain',
        code,
      });
    }
  });

  it('an unknown TelegramApiError code stays uncertain (fail-safe vocabulary growth)', () => {
    expect(classifySendOutcome(telegramError('telegram_something_new'))).toEqual({
      kind: 'uncertain',
      code: 'telegram_something_new',
    });
  });

  it('a TelegramApiError shape missing the code is uncertain with the honest unknown code', () => {
    expect(classifySendOutcome({ name: 'TelegramApiError' })).toEqual({
      kind: 'uncertain',
      code: 'unknown_error',
    });
  });

  it('unknown throw shapes stay uncertain (the fail-safe default)', () => {
    expect(classifySendOutcome(new Error('boom'))).toEqual({
      kind: 'uncertain',
      code: 'unknown_error',
    });
    expect(classifySendOutcome('a string')).toEqual({ kind: 'uncertain', code: 'unknown_error' });
    expect(classifySendOutcome(null)).toEqual({ kind: 'uncertain', code: 'unknown_error' });
    expect(classifySendOutcome(undefined)).toEqual({ kind: 'uncertain', code: 'unknown_error' });
    expect(classifySendOutcome({ code: 42 })).toEqual({ kind: 'uncertain', code: 'unknown_error' });
  });

  it('the classifier is deterministic (JSON-equal on repeated calls)', () => {
    const error = telegramError('telegram_timeout');
    expect(JSON.stringify(classifySendOutcome(error))).toBe(
      JSON.stringify(classifySendOutcome(error)),
    );
  });
});
