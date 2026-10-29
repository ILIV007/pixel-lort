import { describe, expect, it } from 'vitest';
import {
  REUSE_REFERENCE_ITEM_LIMIT,
  composedFullTextEquals,
  exactContentAnchorValue,
  exactContentDigest,
  readReuseDocumentBasis,
  selectExactContentReuseTarget,
  verifyExactContentReuseCandidate,
  type ReuseCandidateVerification,
} from '../../src/domain/editorial/exact-content';
import {
  STORY_FINGERPRINT_INDEX_VERSION,
  storyFingerprintDigest,
  storyFingerprintValue,
} from '../../src/domain/editorial/story-fingerprints';
import {
  buildDraftDocument,
  buildFullEvidenceText,
  buildTraceableExcerpt,
} from '../../src/domain/editorial/mapper';
import { buildEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import { buildCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';

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

// ---------------------------------------------------------------------------
// R1.15.1 — the IMMUTABLE reuse basis: the document parse and the pure
// verification decision (Posidon P1+P2 correctness contract).
// ---------------------------------------------------------------------------

/** Build a PRODUCTION-shaped pipeline document for one (itemId, title, body). */
async function pipelineDocumentFor(input: {
  readonly itemId: string;
  readonly contentHash: string;
  readonly title: string;
  readonly body: string;
}): Promise<string> {
  const excerpt = buildTraceableExcerpt({
    title: input.title,
    body_excerpt: input.body,
  });
  const evidenceGuard = buildEvidenceGuardReport({
    snapshot: { sourceItemId: input.itemId, contentHash: input.contentHash },
    evidence: {
      evidenceId: input.itemId,
      excerptText: excerpt.text,
      excerptTruncated: excerpt.truncated,
    },
    draftClaims: [],
    draftHeadlineFa: 'تیتر',
    draftSummaryFa: 'خلاصه.',
    draftSourceItemId: input.itemId,
  });
  const discovery = buildCandidateDiscoveryReport({
    snapshot: { sourceItemId: input.itemId, contentHash: input.contentHash },
    storyId: 'edst_unit_story',
    lookups: [],
    matches: [],
  });
  const document = buildDraftDocument({
    sourceItemId: input.itemId,
    sourceName: 'منبع',
    excerpt,
    semanticDraft: { headlineFa: 'تیتر', summaryFa: 'خلاصه.', claims: [] },
    evidenceGuard,
    candidateDiscovery: discovery,
    candidateAssessment: buildCandidateAssessmentReport({ discovery }),
  });
  return canonicalizeJson(document.document);
}

describe('readReuseDocumentBasis — the defensive immutable-basis parse (R1.15.1)', () => {
  const itemId = 'item-unit-doc';
  const contentHash = 'a'.repeat(64);
  const title = 'تیتر سند';
  const body = 'بدنهٔ سند.';
  const fullText = buildFullEvidenceText({ title, body_excerpt: body });

  it('reads the PRODUCTION document shape: sourceReport + guard snapshot identity', async () => {
    const documentJson = await pipelineDocumentFor({ itemId, contentHash, title, body });
    const basis = readReuseDocumentBasis(documentJson);
    expect(basis).not.toBeNull();
    expect(basis!.sourceItemId).toBe(itemId);
    expect(basis!.excerptText).toBe(fullText);
    expect(basis!.truncated).toBe(false);
    expect(basis!.guardSnapshot).toEqual({ sourceItemId: itemId, contentHash });
  });

  it('reads NO basis from foreign shapes: unparseable JSON, missing sourceReport, incoherent guard', async () => {
    expect(readReuseDocumentBasis('not-json-at-all')).toBeNull();
    expect(readReuseDocumentBasis('{}')).toBeNull();
    expect(readReuseDocumentBasis('[]')).toBeNull();
    expect(readReuseDocumentBasis('{"sourceReport":{"sourceItemId":"x"}}')).toBeNull();
    // The document must self-agree: a guard naming a DIFFERENT source item
    // than the sourceReport is corrupt — never a basis.
    const documentJson = await pipelineDocumentFor({ itemId, contentHash, title, body });
    const parsed = JSON.parse(documentJson) as {
      evidenceGuard: { snapshot: { sourceItemId: string } };
    };
    parsed.evidenceGuard.snapshot.sourceItemId = 'a-different-item';
    expect(readReuseDocumentBasis(JSON.stringify(parsed))).toBeNull();
  });
});

describe('verifyExactContentReuseCandidate — the pure immutable-basis decision (R1.15.1)', () => {
  const itemId = 'item-unit-ver';
  const contentHash = 'b'.repeat(64);
  const title = 'تیتر وارسی';
  const body = 'بدنهٔ وارسی.';
  const fullText = buildFullEvidenceText({ title, body_excerpt: body });

  async function basisFor(): Promise<NonNullable<ReturnType<typeof readReuseDocumentBasis>>> {
    const documentJson = await pipelineDocumentFor({
      itemId,
      contentHash,
      title,
      body,
    });
    const basis = readReuseDocumentBasis(documentJson);
    if (basis === null) {
      throw new Error('expected a parseable basis');
    }
    return basis;
  }

  const referenceRow = (overrides?: {
    readonly id?: string;
    readonly content_hash?: string;
    readonly title?: string;
    readonly body_excerpt?: string | null;
  }): {
    id: string;
    content_hash: string;
    title: string;
    body_excerpt: string | null;
  } => ({
    id: overrides?.id ?? itemId,
    content_hash: overrides?.content_hash ?? contentHash,
    title: overrides?.title ?? title,
    body_excerpt: overrides?.body_excerpt !== undefined ? overrides.body_excerpt : body,
  });

  it('verifies through the IMMUTABLE document text and carries the fence identity as read', async () => {
    const basis = await basisFor();
    const decision = verifyExactContentReuseCandidate({
      basis,
      referenceRow: referenceRow(),
      fullText,
    });
    expect(decision.verified).toBe(true);
    expect(decision.fence).toEqual({ referenceItemId: itemId, referenceContentHash: contentHash });
    // ANY textual difference is refused — no normalization, ever.
    const different = verifyExactContentReuseCandidate({
      basis,
      referenceRow: referenceRow(),
      fullText: `${fullText} `,
    });
    expect(different.verified).toBe(false);
    expect(different.fence).toBeUndefined();
  });

  it('refuses when the reference row is no longer the snapshot the draft was built from', async () => {
    const basis = await basisFor();
    // The row identity (id) does not match the document's original item.
    const foreignRow = verifyExactContentReuseCandidate({
      basis,
      referenceRow: referenceRow({ id: 'a-different-item' }),
      fullText,
    });
    expect(foreignRow.verified).toBe(false);
    // Missing row / missing basis: never verified, never guessed.
    expect(verifyExactContentReuseCandidate({ basis, referenceRow: null, fullText }).verified).toBe(
      false,
    );
    expect(
      verifyExactContentReuseCandidate({ basis: null, referenceRow: referenceRow(), fullText })
        .verified,
    ).toBe(false);
  });

  it('TRUNCATED basis: verifies ONLY through the guard-hash identity bridge to the original row', async () => {
    // A >4000-char composition: the document excerpt is truncated, so the
    // full text exists ONLY through the bridged reference row.
    const longBody = 'X'.repeat(4200);
    const longText = buildFullEvidenceText({ title, body_excerpt: longBody });
    const documentJson = await pipelineDocumentFor({
      itemId,
      contentHash,
      title,
      body: longBody,
    });
    const basis = readReuseDocumentBasis(documentJson);
    expect(basis!.truncated).toBe(true);
    // BRIDGE HOLDS: the row still carries the guard's recorded snapshot hash
    // AND the original snapshot's full text.
    const bridged = verifyExactContentReuseCandidate({
      basis,
      referenceRow: referenceRow({ body_excerpt: longBody }), // hash == guard hash → the row IS the original snapshot
      fullText: longText,
    });
    expect(bridged.verified).toBe(true);
    expect(bridged.fence).toEqual({ referenceItemId: itemId, referenceContentHash: contentHash });
    // BRIDGE BROKEN (the P2 pre-verification mutation): the row's hash no
    // longer matches the guard's recorded ORIGINAL snapshot hash → refuse
    // BEFORE any commit — the mutated text can never be attributed to the
    // old draft.
    const broken = verifyExactContentReuseCandidate({
      basis,
      referenceRow: referenceRow({ content_hash: 'c'.repeat(64) }),
      fullText: longText,
    });
    expect(broken.verified).toBe(false);
    // A truncated basis WITHOUT a guard: no bridge is possible — refuse.
    const guardless = verifyExactContentReuseCandidate({
      basis: { ...basis!, guardSnapshot: null },
      referenceRow: referenceRow(),
      fullText: longText,
    });
    expect(guardless.verified).toBe(false);
  });

  it('selection rides the fence identity with the chosen target', () => {
    const target = selectExactContentReuseTarget([
      { storyId: 'story-a', hasUsableDraft: true, contentVerified: false },
      {
        storyId: 'story-b',
        hasUsableDraft: true,
        contentVerified: true,
        fence: { referenceItemId: 'item-b', referenceContentHash: 'h-b' },
      },
    ]);
    expect(target).toEqual({
      storyId: 'story-b',
      fence: { referenceItemId: 'item-b', referenceContentHash: 'h-b' },
    });
  });
});
