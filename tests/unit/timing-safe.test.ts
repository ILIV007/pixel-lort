import { describe, expect, it } from 'vitest';
import { timingSafeEqualStrings } from '../../src/shared/security/timing-safe';

/**
 * Timing-safe secret comparison behavior (Phase 2A, ADR-0024).
 *
 * The comparison must be EXACT (equal only for equal strings) while never
 * taking input-dependent shortcuts: the implementation signs both inputs
 * with a fresh random HMAC key and compares fixed-length digests, so there
 * is no early-exit path and no length-dependent raw comparison.
 */
describe('timingSafeEqualStrings', () => {
  it('returns true for identical strings', async () => {
    await expect(timingSafeEqualStrings('same-secret-value', 'same-secret-value')).resolves.toBe(
      true,
    );
  });

  it('returns false for different strings of the same length', async () => {
    await expect(timingSafeEqualStrings('secret-value-AAAA', 'secret-value-BBBB')).resolves.toBe(
      false,
    );
  });

  it('returns false for strings of different lengths (no exception)', async () => {
    await expect(timingSafeEqualStrings('short', 'a-much-longer-secret-value')).resolves.toBe(
      false,
    );
    await expect(timingSafeEqualStrings('', 'x')).resolves.toBe(false);
  });

  it('treats two empty strings as equal', async () => {
    await expect(timingSafeEqualStrings('', '')).resolves.toBe(true);
  });

  it('is exact for single-character differences anywhere in the string', async () => {
    const base = 'a'.repeat(64);
    for (const position of [0, 15, 32, 63]) {
      const mutated = `${base.slice(0, position)}b${base.slice(position + 1)}`;
      await expect(timingSafeEqualStrings(base, mutated)).resolves.toBe(false);
    }
  });

  it('handles non-ASCII (UTF-8) input exactly', async () => {
    await expect(timingSafeEqualStrings('تاریخ-مخفی-۰۰۱', 'تاریخ-مخفی-۰۰۱')).resolves.toBe(true);
    await expect(timingSafeEqualStrings('تاریخ-مخفی-۰۰۱', 'تاریخ-مخفی-۰۰۲')).resolves.toBe(false);
  });

  it('produces a stable verdict across repeated comparisons of the same pair', async () => {
    const verdicts = await Promise.all(
      Array.from({ length: 8 }, () => timingSafeEqualStrings('alpha-secret', 'alpha-secret')),
    );
    for (const verdict of verdicts) {
      expect(verdict).toBe(true);
    }
  });
});
