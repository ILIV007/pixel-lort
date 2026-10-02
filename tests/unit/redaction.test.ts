import { describe, expect, it } from 'vitest';
import { isSensitiveKeyName } from '../../src/shared/security/sensitive-keys';
import {
  redactFields,
  redactValue,
  REDACTED_MARKER,
  TRUNCATED_MARKER,
} from '../../src/observability/redaction';

describe('isSensitiveKeyName', () => {
  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'token',
    'apiKey',
    'api_key',
    'API_KEY',
    'secret',
    'clientSecret',
    'password',
    'telegramBotToken',
    'bot_token',
    'webhookSecret',
    'x-auth-token',
    'refreshToken',
    'privateKey',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKeyName(key)).toBe(true);
  });

  it.each([
    'requestId',
    'path',
    'status',
    'durationMs',
    'layoutKey',
    'message',
    'level',
    'authorName',
    'authorized_at_count_only_safe_example',
  ])('treats %s as non-sensitive', (key) => {
    expect(isSensitiveKeyName(key)).toBe(false);
  });
});

describe('redactValue', () => {
  it('leaves primitives untouched', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue('text')).toBe('text');
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
    expect(redactValue(true)).toBe(true);
  });

  it('redacts keys in nested maps without mutating the input', () => {
    const input = { a: { b: { token: 'x' } }, keep: 1 };
    const snapshot = JSON.stringify(input);
    const output = redactValue(input) as Record<string, unknown>;

    expect(
      ((output['a'] as Record<string, unknown>)['b'] as Record<string, unknown>)['token'],
    ).toBe(REDACTED_MARKER);
    expect(output['keep']).toBe(1);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('truncates oversized arrays and objects', () => {
    const bigArray = Array.from({ length: 150 }, (_, i) => ({ [`k${i}`]: i }));
    const outArray = redactValue(bigArray) as unknown[];
    expect(outArray.length).toBe(101);
    expect(outArray[100]).toBe(TRUNCATED_MARKER);

    const bigObject: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) {
      bigObject[`k${i}`] = i;
    }
    const outObject = redactValue(bigObject) as Record<string, unknown>;
    expect(Object.keys(outObject).length).toBe(101);
    expect(outObject[TRUNCATED_MARKER]).toBe(REDACTED_MARKER);
  });

  it('collapses Error instances at ANY depth to fail-safe fields', () => {
    // Marker embedded in the error message; deliberately NOT token-shaped.
    const embedded = 'SECRET-NESTED-ERROR-VALUE';
    const input = { outer: [new Error(`boom with ${embedded}`)], keep: 1 };
    const output = redactValue(input) as Record<string, unknown>;

    const item = (output['outer'] as Array<Record<string, unknown>>)[0]!;
    expect(item['errorKind']).toBe('error');
    expect(item['name']).toBe('Error');
    expect(item['message']).toBeUndefined();
    expect(item['stack']).toBeUndefined();
    expect(item['cause']).toBeUndefined();
    expect(output['keep']).toBe(1);
    expect(JSON.stringify(output)).not.toContain(embedded);
  });
});

describe('redactFields', () => {
  it('returns a redacted copy of log fields', () => {
    const fields = { requestId: 'r-1', authorization: 'Bearer x', nested: { apiKey: 'k' } };
    const redacted = redactFields(fields);

    expect(redacted['requestId']).toBe('r-1');
    expect(redacted['authorization']).toBe(REDACTED_MARKER);
    expect((redacted['nested'] as Record<string, unknown>)['apiKey']).toBe(REDACTED_MARKER);
  });
});
