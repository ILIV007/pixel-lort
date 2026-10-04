import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DATA_MAX_BYTES,
  formatCallbackData,
  parseCallbackData,
} from '../../src/admin/callback-tokens';

/**
 * Callback data contract tests (Phase 2A): `a:<base64url_token>`,
 * at most 64 UTF-8 bytes, no embedded payload of any kind.
 */

describe('formatCallbackData', () => {
  it('formats a valid token into the a: contract', () => {
    expect(formatCallbackData('AAAbbCCCdddEEEff')).toBe('a:AAAbbCCCdddEEEff');
  });

  it('rejects invalid token shapes loudly', () => {
    expect(() => formatCallbackData('short')).toThrow();
    expect(() => formatCallbackData('has+slash=eq')).toThrow();
    expect(() => formatCallbackData(`${'x'.repeat(44)}`)).toThrow();
  });
});

describe('parseCallbackData', () => {
  it('accepts well-formed data and returns the opaque token', () => {
    const token = 'AAAbbCCCdddEEEff';
    expect(parseCallbackData(`a:${token}`)).toEqual({ ok: true, token });
  });

  it('accepts the maximum token length (a: + 43 chars = 45 bytes)', () => {
    const token = 'x'.repeat(43);
    expect(parseCallbackData(`a:${token}`)).toEqual({ ok: true, token });
  });

  it('rejects empty data', () => {
    expect(parseCallbackData('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects data beyond the 64-byte Telegram limit', () => {
    const longAscii = `a:${'x'.repeat(64)}`; // 65 bytes
    expect(parseCallbackData(longAscii)).toEqual({ ok: false, reason: 'too_long' });

    // Multibyte content cannot smuggle itself past the byte limit: 32
    // Persian letters encode to 66 bytes ("a:" + 32*2) and are rejected on
    // BYTES; 31 letters encode to 64 bytes and pass the byte bound but fail
    // the base64url token charset (the contract is an opaque token, not
    // free-form text).
    const overLimit = `a:${'ا'.repeat(32)}`; // 66 bytes
    expect(parseCallbackData(overLimit)).toEqual({ ok: false, reason: 'too_long' });

    const atByteLimit = `a:${'ا'.repeat(31)}`; // exactly 64 bytes
    expect(new TextEncoder().encode(atByteLimit).length).toBe(CALLBACK_DATA_MAX_BYTES);
    expect(parseCallbackData(atByteLimit)).toEqual({ ok: false, reason: 'bad_token_format' });
  });

  it('rejects data without the a: prefix', () => {
    expect(parseCallbackData('b:AAAbbCCCdddEEEff')).toEqual({ ok: false, reason: 'bad_prefix' });
    expect(parseCallbackData('AAAbbCCCdddEEEff')).toEqual({ ok: false, reason: 'bad_prefix' });
  });

  it('rejects tokens with bad charset or length', () => {
    expect(parseCallbackData('a:has+slash=eqaa')).toEqual({
      ok: false,
      reason: 'bad_token_format',
    });
    expect(parseCallbackData('a:short')).toEqual({ ok: false, reason: 'bad_token_format' });
    expect(parseCallbackData(`a:${'x'.repeat(44)}`)).toEqual({
      ok: false,
      reason: 'bad_token_format',
    });
    expect(parseCallbackData('a:')).toEqual({ ok: false, reason: 'bad_token_format' });
  });

  it('carries reason codes only — never the raw data', () => {
    const hostile = 'a:<script>alert(1)</script>';
    const result = parseCallbackData(hostile);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('<script>');
  });
});
