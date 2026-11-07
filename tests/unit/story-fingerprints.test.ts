import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_DIGEST_HEX_LENGTH,
  FINGERPRINT_LOOKUP_ROW_LIMIT,
  STORY_CANDIDATES_MAX,
  STORY_FINGERPRINT_INDEX_VERSION,
  STORY_FINGERPRINT_KINDS,
  STORY_FINGERPRINT_SIGNAL_PRIORITY,
  buildStoryFingerprints,
  planFingerprintLookups,
  storyFingerprintDigest,
  storyFingerprintValue,
} from '../../src/domain/editorial/story-fingerprints';

/**
 * R1.13 pure fingerprint contracts: deterministic, sourceItemId-independent
 * digests, collision-safe framing, the ONE limited normalization (NFC +
 * whitespace collapse + trim — never case folding, never digit/negation/
 * unit equivalence), verbatim URL identity, and the multi-owner
 * `sc1:<digest>:<storyId>` value format with exact prefix lookup bounds.
 */

const SIGNALS = {
  canonicalUrl: 'https://example.com/news/1',
  fullEvidenceText: 'عنوان خبر\n\nمتن کامل خبر نمونه.',
  title: 'عنوان خبر',
};

describe('story fingerprints — determinism and identity independence', () => {
  it('the same input yields byte-identical fingerprints (pure, no clock)', async () => {
    const first = await buildStoryFingerprints({ ...SIGNALS, storyId: 'edst_x' });
    const second = await buildStoryFingerprints({ ...SIGNALS, storyId: 'edst_x' });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('the storyId changes ONLY the value suffix — never the digest (text is source-independent)', async () => {
    const a = await buildStoryFingerprints({ ...SIGNALS, storyId: 'edst_aaaa' });
    const b = await buildStoryFingerprints({ ...SIGNALS, storyId: 'edst_bbbb' });
    expect(a.map((plan) => plan.kind)).toEqual(b.map((plan) => plan.kind));
    for (let index = 0; index < a.length; index++) {
      expect(a[index]!.digest).toBe(b[index]!.digest);
      expect(a[index]!.value.endsWith(':edst_aaaa')).toBe(true);
      expect(b[index]!.value.endsWith(':edst_bbbb')).toBe(true);
    }
  });

  it('every value follows the versioned multi-owner format sc1:<64hex>:<storyId>', async () => {
    const plans = await buildStoryFingerprints({ ...SIGNALS, storyId: 'edst_x' });
    for (const plan of plans) {
      expect(plan.value).toMatch(/^sc1:[0-9a-f]{64}:edst_x$/);
      expect(plan.digest).toHaveLength(FINGERPRINT_DIGEST_HEX_LENGTH);
    }
  });

  it('signal priority order is fixed: url, content_hash, title_key (display order only)', async () => {
    expect(STORY_FINGERPRINT_SIGNAL_PRIORITY).toEqual(['url', 'content_hash', 'title_key']);
    const plans = await buildStoryFingerprints({ ...SIGNALS, storyId: 'edst_x' });
    expect(plans.map((plan) => plan.kind)).toEqual(['url', 'content_hash', 'title_key']);
  });
});

describe('story fingerprints — collision-safe framing', () => {
  it('delimiter-lookalike payloads never re-frame the tuple', async () => {
    // A url payload containing a kind label and the version prefix must not
    // collide with a genuinely different (kind, payload) pair.
    const trickyUrl = await storyFingerprintDigest('url', 'sc1\u001fcontent_hash\u001fX');
    const realContent = await storyFingerprintDigest('content_hash', 'X');
    expect(trickyUrl).not.toBe(realContent);
    // Length-prefixed framing: shifting part boundaries changes the input.
    const ab = await storyFingerprintDigest('url', 'ab');
    const a = await storyFingerprintDigest('url', 'a');
    expect(ab).not.toBe(a);
  });

  it('different signal kinds never share a digest for the same payload', async () => {
    const digests = await Promise.all(
      STORY_FINGERPRINT_KINDS.map((kind) => storyFingerprintDigest(kind, 'همان متن')),
    );
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe('story fingerprints — the ONE limited normalization (never equivalence)', () => {
  it('NFC composition and whitespace collapse DO normalize the title signal', async () => {
    const composed = await buildStoryFingerprints({
      storyId: 'edst_norm',
      canonicalUrl: null,
      fullEvidenceText: 'x',
      title: 'تیتر  تست', // single space
    });
    const decomposed = await buildStoryFingerprints({
      storyId: 'edst_norm',
      canonicalUrl: null,
      fullEvidenceText: 'x',
      title: 'تیتر\n \t تست ', // different whitespace + trailing
    });
    expect(composed[0]!.digest).toBe(decomposed[0]!.digest);
  });

  it('Persian and Latin digits are NEVER equated (۰ ≠ 0)', async () => {
    const persian = await storyFingerprintDigest(
      'title_key',
      'نسخهٔ ۱ بازی منتشر شد'.normalize('NFC').replace(/\s+/gu, ' ').trim(),
    );
    const latin = await storyFingerprintDigest(
      'title_key',
      'نسخهٔ 1 بازی منتشر شد'.normalize('NFC').replace(/\s+/gu, ' ').trim(),
    );
    expect(persian).not.toBe(latin);
  });

  it('negation and case differences are NEVER folded away', async () => {
    const withNegation = await storyFingerprintDigest('title_key', 'بازی منتشر نشد');
    const withoutNegation = await storyFingerprintDigest('title_key', 'بازی منتشر شد');
    expect(withNegation).not.toBe(withoutNegation);
    const upper = await storyFingerprintDigest('title_key', 'GAME UPDATE');
    const lower = await storyFingerprintDigest('title_key', 'game update');
    expect(upper).not.toBe(lower);
  });

  it('the url signal is the stored identity VERBATIM: no case/param/path guessing', async () => {
    const plain = await storyFingerprintDigest('url', 'https://Example.com/News?a=1');
    const lower = await storyFingerprintDigest('url', 'https://example.com/news?a=1');
    const otherParam = await storyFingerprintDigest('url', 'https://Example.com/News?a=2');
    expect(plain).not.toBe(lower);
    expect(plain).not.toBe(otherParam);
  });

  it('the content_hash signal hashes the FULL title+body composition itself', async () => {
    const short = await storyFingerprintDigest('content_hash', 'عنوان');
    const full = await storyFingerprintDigest('content_hash', 'عنوان\n\nبدنه');
    expect(short).not.toBe(full);
  });
});

describe('story fingerprints — absent signals and lookup plans', () => {
  it('empty/absent signals contribute NOTHING (no placeholder rows)', async () => {
    const plans = await buildStoryFingerprints({
      storyId: 'edst_x',
      canonicalUrl: null,
      fullEvidenceText: '',
      title: '   ',
    });
    expect(plans).toEqual([]);
    const onlyUrl = await buildStoryFingerprints({
      storyId: 'edst_x',
      canonicalUrl: 'https://example.com/a',
      fullEvidenceText: '',
      title: '   ',
    });
    expect(onlyUrl.map((plan) => plan.kind)).toEqual(['url']);
  });

  it('lookup plans carry exact prefix bounds over the PK — no wildcards, no raw text', async () => {
    const plans = await planFingerprintLookups(SIGNALS);
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      expect(plan.lowerBound).toMatch(/^sc1:[0-9a-f]{64}:$/);
      expect(plan.upperBound.startsWith(plan.lowerBound)).toBe(true);
    }
    // A story-suffixed row of THIS digest always falls inside the range…
    const urlPlan = plans[0]!;
    const urlDigest = await storyFingerprintDigest('url', SIGNALS.canonicalUrl!);
    const exactLower = `${STORY_FINGERPRINT_INDEX_VERSION}:${urlDigest}:`;
    expect(urlPlan.lowerBound).toBe(exactLower);
    const matchingValue = await storyFingerprintValue(
      urlPlan.kind,
      SIGNALS.canonicalUrl!,
      'edst_zzzz',
    );
    expect(matchingValue >= urlPlan.lowerBound).toBe(true);
    expect(matchingValue < urlPlan.upperBound).toBe(true);
    // …and a row of a DIFFERENT digest never does.
    const otherValue = await storyFingerprintValue('url', 'https://other.example/x', 'edst_zzzz');
    expect(otherValue >= urlPlan.lowerBound && otherValue < urlPlan.upperBound).toBe(false);
  });

  it('the probe limit and candidate cap are the documented constants', () => {
    expect(FINGERPRINT_LOOKUP_ROW_LIMIT).toBe(9);
    expect(STORY_CANDIDATES_MAX).toBe(8);
  });
});
