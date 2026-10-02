import { describe, expect, it } from 'vitest';
import { cryptoIdGenerator, UUID_V4_PATTERN } from '../../src/shared/ids/id';
import {
  formatIdempotencyKey,
  normalizeKeyPart,
  sanitizeScope,
  sha256Hex,
} from '../../src/shared/ids/idempotency-key';
import { isValidRequestId } from '../../src/shared/ids/request-id';

describe('sha256Hex', () => {
  it('produces the standard empty-string digest', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces the standard "abc" digest', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('formatIdempotencyKey', () => {
  it('is deterministic for identical inputs', async () => {
    const a = await formatIdempotencyKey('tg-update', ['123456']);
    const b = await formatIdempotencyKey('tg-update', ['123456']);
    expect(a).toBe(b);
    expect(a.startsWith('tg-update:')).toBe(true);
  });

  it('differs for different inputs', async () => {
    const a = await formatIdempotencyKey('tg-update', ['123456']);
    const b = await formatIdempotencyKey('tg-update', ['123457']);
    expect(a).not.toBe(b);
  });

  it('separates parts so ["a:b"] and ["a","b"] do not collide', async () => {
    const a = await formatIdempotencyKey('scope', ['a:b']);
    const b = await formatIdempotencyKey('scope', ['a', 'b']);
    expect(a).not.toBe(b);
  });

  it('normalizes parts and scopes deterministically', async () => {
    const a = await formatIdempotencyKey('Source Item', ['  ABC 123 ']);
    const b = await formatIdempotencyKey('source-item', ['abc 123']);
    expect(a).toBe(b);
  });

  it('sanitizes hostile scope characters', () => {
    expect(sanitizeScope('  Bad Scope!! ')).toBe('bad-scope-');
    expect(sanitizeScope('ok_scope.v1')).toBe('ok_scope.v1');
  });

  it('normalizes key parts with collapsed whitespace', () => {
    expect(normalizeKeyPart('  Multiple   Spaces ')).toBe('multiple spaces');
  });
});

describe('cryptoIdGenerator', () => {
  it('generates UUID v4 values', () => {
    const id = cryptoIdGenerator.newId();
    expect(UUID_V4_PATTERN.test(id)).toBe(true);
    expect(cryptoIdGenerator.newId()).not.toBe(id);
  });
});

describe('isValidRequestId', () => {
  it('accepts bounded printable ASCII values', () => {
    expect(isValidRequestId('req-abc-123')).toBe(true);
    expect(isValidRequestId('a'.repeat(128))).toBe(true);
  });

  it('rejects hostile or malformed values', () => {
    expect(isValidRequestId('short')).toBe(false);
    expect(isValidRequestId('has space')).toBe(false);
    expect(isValidRequestId('a'.repeat(129))).toBe(false);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('خطا')).toBe(false);
    expect(isValidRequestId('line\nbreak')).toBe(false);
  });
});
