import { describe, expect, it } from 'vitest';
import {
  REUSE_REFERENCE_ITEM_LIMIT,
  composedFullTextEquals,
  exactContentAnchorValue,
  exactContentDigest,
  selectExactContentReuseTarget,
  type ReuseCandidateVerification,
} from '../../src/domain/editorial/exact-content';
import {
  STORY_FINGERPRINT_INDEX_VERSION,
  storyFingerprintDigest,
  storyFingerprintValue,
} from '../../src/domain/editorial/story-fingerprints';
import { buildFullEvidenceText } from '../../src/domain/editorial/mapper';

/**
 * R1.15 (Phase 5C-3) unit contracts for the PURE exact-content identity
 * and reuse-selection layer: the digest is the SAME versioned `sc1`
 * content digest the fingerprint index uses, the anchor is group-unique
 * by construction, equality is byte-exact (NO normalization), and the
 * target selection is deterministic and verification-driven.
 */

describe('exactContentDigest — the sc1 content digest contract', () => {
  it('equals the fingerprint index digest for the SAME composed text', async () => {
    const text = 'تیتر خبر\n\nبدنهٔ کامل خبر';
    await expect(exactContentDigest(text)).resolves.toBe(
      await storyFingerprintDigest('content_hash', text),
    );
  });

  it('is independent of item/source identity: the same text from two items digests identically', async () => {
    const itemA = { title: 'عنوان', body_excerpt: 'متن' };
    const itemB = { title: 'عنوان', body_excerpt: 'متن' };
    const textA = buildFullEvidenceText(itemA);
    const textB = buildFullEvidenceText(itemB);
    expect(await exactContentDigest(textA)).toBe(await exactContentDigest(textB));
    // ...and NEVER equals the story-scoped fingerprint value (different shape).
    const scoped = await storyFingerprintValue('content_hash', textA, 'edst_some_story');
    expect(scoped).toBe(
      `${STORY_FINGERPRINT_INDEX_VERSION}:${await exactContentDigest(textA)}:edst_some_story`,
    );
    expect(scoped).not.toBe(exactContentAnchorValue(await exactContentDigest(textA)));
  });

  it('differs when ANY stored text difference exists (negation, digits, units, punctuation)', async () => {
    const base = 'قیمت ۱۰۰ دلار شد';
    const variants = [
      'قیمت ۱۰۰ دلار نشد', // negation
      'قیمت ۱۰۱ دلار شد', // number
      'قیمت 100 دلار شد', // Persian vs Latin digit
      'قیمت ۱۰۰ تومان شد', // unit
      'قیمت ۱۰۰ دلار شد.', // punctuation
      'قیمت  ۱۰۰ دلار شد', // inner whitespace
    ];
    const baseDigest = await exactContentDigest(base);
    for (const variant of variants) {
      expect(await exactContentDigest(variant)).not.toBe(baseDigest);
    }
  });
});

describe('exactContentAnchorValue — the group-unique anchor shape', () => {
  it('is the namespace-prefixed digest WITHOUT a story suffix', async () => {
    const digest = await exactContentDigest('متن آزمایشی');
    const anchor = exactContentAnchorValue(digest);
    expect(anchor).toBe(`${STORY_FINGERPRINT_INDEX_VERSION}:${digest}`);
    expect(anchor).toMatch(/^sc1:[0-9a-f]{64}$/);
  });

  it('differs from every story-scoped value of the same digest', async () => {
    const digest = await exactContentDigest('متن آزمایشی');
    const anchor = exactContentAnchorValue(digest);
    const scoped = `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}:edst_x`;
    expect(anchor.endsWith(':edst_x')).toBe(false);
    expect(anchor).not.toBe(scoped);
  });
});

describe('composedFullTextEquals — byte-exact, zero normalization', () => {
  it('is exact string equality', () => {
    expect(composedFullTextEquals('abc', 'abc')).toBe(true);
    expect(composedFullTextEquals('abc', 'abd')).toBe(false);
    expect(composedFullTextEquals('', '')).toBe(true);
  });

  it('NEVER equates numbers, negations, units, Persian/Latin digits, or case', () => {
    expect(composedFullTextEquals('عرضه ۱۰ مرداد', 'عرضه ۱۱ مرداد')).toBe(false);
    expect(composedFullTextEquals('عرضه ۱۰ مرداد', 'عرضه 10 مرداد')).toBe(false);
    expect(composedFullTextEquals('فروخته شد', 'فروخته نشد')).toBe(false);
    expect(composedFullTextEquals('۱۰۰ دلار', '۱۰۰ تومان')).toBe(false);
    expect(composedFullTextEquals('NEWS', 'news')).toBe(false);
  });
});

describe('selectExactContentReuseTarget — deterministic, verification-driven', () => {
  const verification = (
    storyId: string,
    hasUsableDraft: boolean,
    contentVerified: boolean,
  ): ReuseCandidateVerification => ({ storyId, hasUsableDraft, contentVerified });

  it('picks the FIRST candidate that is BOTH usable AND really content-equal', () => {
    const target = selectExactContentReuseTarget([
      verification('story-a', true, false), // usable but text differs — never a target
      verification('story-b', true, true), // verified → THE target
      verification('story-c', true, true), // would also verify — never reached
    ]);
    expect(target).toEqual({ storyId: 'story-b' });
  });

  it('never reuses on fingerprint-only evidence: usable-draft-without-verification fails', () => {
    expect(selectExactContentReuseTarget([verification('story-a', true, false)])).toBeNull();
  });

  it('never reuses without a usable draft: verified-but-dead draft fails', () => {
    expect(selectExactContentReuseTarget([verification('story-a', false, true)])).toBeNull();
  });

  it('is deterministic: order in, order out', () => {
    const input = [verification('story-c', true, true), verification('story-a', true, true)];
    expect(selectExactContentReuseTarget(input)).toEqual({ storyId: 'story-c' });
    expect(selectExactContentReuseTarget([...input].reverse())).toEqual({ storyId: 'story-a' });
  });

  it('returns null for an empty verification list', () => {
    expect(selectExactContentReuseTarget([])).toBeNull();
  });

  it('keeps the reference-item bound defensive (stories carry few items)', () => {
    expect(REUSE_REFERENCE_ITEM_LIMIT).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(REUSE_REFERENCE_ITEM_LIMIT)).toBe(true);
  });
});
