import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_GUARD_LIMITATIONS,
  EVIDENCE_GUARD_VERSION,
  buildEvidenceGuardReport,
  normalizeForDirectTextMatch,
  readEvidenceGuardReport,
  type EvidenceGuardInput,
} from '../../src/domain/editorial/evidence-guard';

/**
 * Evidence Guard v1 unit contracts (R1.12 Phase 5B) — the pure evaluator's
 * honesty boundary, offline and deterministic. These map onto the round's
 * acceptance list (cases 1–7 + determinism/reader contracts).
 */

const SNAPSHOT = {
  sourceItemId: 'item-1',
  contentHash: 'a'.repeat(64),
};

/** A well-formed input builder; every test overrides only what it needs. */
function guardInput(overrides?: Partial<EvidenceGuardInput>): EvidenceGuardInput {
  return {
    snapshot: SNAPSHOT,
    evidence: {
      evidenceId: 'item-1',
      excerptText: 'استودیوی نمونه اعلام کرد به‌روزرسانی بزرگ بازی نمونه منتشر شد.',
      excerptTruncated: false,
      ...(overrides?.evidence ?? {}),
    },
    draftClaims: overrides?.draftClaims ?? [
      { text: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد.', evidenceIds: ['item-1'] },
    ],
    draftHeadlineFa: overrides?.draftHeadlineFa ?? 'تیتر مدل',
    draftSummaryFa: overrides?.draftSummaryFa ?? 'خلاصه مدل',
    draftSourceItemId: overrides?.draftSourceItemId ?? 'item-1',
  };
}

/** The report JSON must never smuggle in success vocabulary. */
function expectNoSuccessVocabulary(report: unknown): void {
  const json = JSON.stringify(report);
  expect(json).not.toContain('verified');
  expect(json).not.toContain('confirmed');
  expect(json).not.toContain('supported');
  expect(json).not.toContain('auto_approved');
  expect(json).not.toContain('validated');
}

describe('evidence guard v1 — acceptance case 1: valid reference, unrelated text', () => {
  it('an unrelated claim over a valid evidenceId stays UNRESOLVED — never verified, never false', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [{ text: 'قیمت سهام استودیو در بورس دو برابر شد.', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.evaluationStatus).toBe('evaluated');
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
    expect(report.claims[0]!.reasonCodes).toEqual(['no_direct_text_match']);
    expect(report.counts).toEqual({
      total: 1,
      directTextObserved: 0,
      unresolvedRequiresFurtherVerification: 1,
      invalidReferenceOrSnapshot: 0,
      notEvaluatedIdentityInvalid: 0,
    });
    expectNoSuccessVocabulary(report);
  });
});

describe('evidence guard v1 — acceptance case 2: exact text is an observation only', () => {
  it('a claim quoted verbatim from the excerpt is direct_text_observed — still NOT verified', () => {
    const report = buildEvidenceGuardReport(guardInput());
    expect(report.claims[0]!.status).toBe('direct_text_observed');
    expect(report.claims[0]!.reasonCodes).toEqual(['direct_text_observed']);
    // The limitation stays attached: an observation is not truth.
    expect(report.limitations).toContain('direct_text_is_not_truth');
    expectNoSuccessVocabulary(report);
    // The status name itself carries no trust upgrade.
    expect(report.claims[0]!.status).not.toMatch(/verif|confirm|approv/);
  });

  it('the defined whitespace normalization applies (and is the ONLY relaxation)', () => {
    expect(normalizeForDirectTextMatch('بازی\nجدید\t منتشر   شد')).toBe('بازی جدید منتشر شد');
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'بازی\nجدید\t منتشر   شد',
          excerptTruncated: false,
        },
        draftClaims: [{ text: ' بازی جدید منتشر شد ', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('direct_text_observed');
  });

  it('NFC composition differences match; ZWNJ differences honestly do NOT', () => {
    // NFC: decomposed vs composed forms of the same text.
    const decomposed = '\u0628\u0627\u0632\u06CC \u062C\u062F\u06CC\u062F';
    expect(normalizeForDirectTextMatch(decomposed.normalize('NFD'))).toBe(
      normalizeForDirectTextMatch(decomposed),
    );
    // ZWNJ is NOT stripped: 'می‌شود' (with ZWNJ) never equals 'میشود'.
    expect(normalizeForDirectTextMatch('می‌شود')).toBe('می\u200cشود');
    expect(normalizeForDirectTextMatch('می\u200cشود')).not.toBe('میشود');
  });
});

describe('evidence guard v1 — acceptance case 3: paraphrase/translation is unresolved, NOT false', () => {
  it('a Persian paraphrase of the Persian source does not match directly', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [
          {
            text: 'نسخهٔ تازهٔ بازی نمونه توسط استودیوی نمونه عرضه گردید.',
            evidenceIds: ['item-1'],
          },
        ],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
    expect(report.limitations).toContain('no_semantic_analysis');
  });

  it('a Persian claim over an ENGLISH source excerpt is unresolved, not false', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'The studio announced a major update with a new story chapter.',
          excerptTruncated: false,
        },
        draftClaims: [{ text: 'استودیو از به‌روزرسانی بزرگ خبر داد.', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
    expect(report.claims[0]!.reasonCodes).toEqual(['no_direct_text_match']);
    expectNoSuccessVocabulary(report);
  });
});

describe('evidence guard v1 — acceptance case 4: distinct honest failure outcomes', () => {
  it('an UNKNOWN evidence id is invalid_reference_or_snapshot with a stable code', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [
          { text: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد.', evidenceIds: ['item-ghost'] },
        ],
      }),
    );
    expect(report.claims[0]!.status).toBe('invalid_reference_or_snapshot');
    expect(report.claims[0]!.reasonCodes).toEqual(['unknown_evidence_id']);
  });

  it('empty text / empty refs / both produce sorted stable codes', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [
          { text: '', evidenceIds: [] },
          { text: '   ', evidenceIds: ['item-1'] },
          { text: '', evidenceIds: ['item-1'] },
        ],
      }),
    );
    expect(report.claims[0]!.reasonCodes).toEqual(['empty_claim_text', 'empty_evidence_refs']);
    expect(report.claims[1]!.reasonCodes).toEqual(['empty_claim_text']);
    expect(report.claims[2]!.reasonCodes).toEqual(['empty_claim_text']);
    expect(report.counts.invalidReferenceOrSnapshot).toBe(3);
  });

  it('a draft recorded for a DIFFERENT item is invalid_snapshot_identity; NOTHING is evaluated', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [
          { text: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد.', evidenceIds: ['item-1'] },
          { text: 'هر متن دیگری.', evidenceIds: ['item-1'] },
        ],
        draftSourceItemId: 'item-999',
      }),
    );
    expect(report.evaluationStatus).toBe('invalid_snapshot_identity');
    expect(report.claims).toHaveLength(2);
    for (const claim of report.claims) {
      expect(claim.status).toBe('not_evaluated_identity_invalid');
      expect(claim.reasonCodes).toEqual(['draft_snapshot_identity_mismatch']);
    }
    expect(report.counts.notEvaluatedIdentityInvalid).toBe(2);
    expect(report.counts.directTextObserved).toBe(0);
  });

  it('inconsistent evidence-vs-snapshot identity fails closed before text work', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-other',
          excerptText: 'هر متنی',
          excerptTruncated: false,
        },
      }),
    );
    expect(report.evaluationStatus).toBe('invalid_snapshot_identity');
    expect(report.claims[0]!.status).toBe('not_evaluated_identity_invalid');
    expect(report.claims[0]!.reasonCodes).toEqual(['evidence_id_identity_inconsistent']);
  });

  it('the reader distinguishes absent / unsupported_version / malformed / guard_v1', () => {
    // Pre-5B draft: no payload at all.
    expect(readEvidenceGuardReport({ schemaVersion: 1, modelClaims: [] })).toEqual({
      kind: 'absent',
    });
    // A future/unversioned payload is NEVER shown as a current result.
    expect(readEvidenceGuardReport({ evidenceGuard: { guardVersion: 99 } })).toEqual({
      kind: 'unsupported_version',
      guardVersion: 99,
    });
    expect(readEvidenceGuardReport({ evidenceGuard: {/* no version */} })).toEqual({
      kind: 'unsupported_version',
      guardVersion: undefined,
    });
    // Wrong shapes.
    expect(readEvidenceGuardReport({ evidenceGuard: 'x' })).toEqual({ kind: 'malformed' });
    expect(readEvidenceGuardReport({ evidenceGuard: { guardVersion: 1 } })).toEqual({
      kind: 'malformed',
    });
    expect(readEvidenceGuardReport('not-an-object')).toEqual({ kind: 'malformed' });
    // A real report reads back as guard_v1.
    const report = buildEvidenceGuardReport(guardInput());
    expect(readEvidenceGuardReport({ evidenceGuard: report })).toEqual({
      kind: 'guard_v1',
      report,
    });
  });
});

describe('evidence guard v1 — acceptance case 5: negation/number/unit never normalize into a match', () => {
  it('a NEGATED claim does not match its non-negated source text', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [{ text: 'بازی نمونه منتشر نشد.', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
    expect(report.claims[0]!.status).not.toBe('direct_text_observed');
  });

  it('a DIFFERENT number does not match, in Persian or Latin digits', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'بازی نمونه ۵۰۰ هزار فروش داشت.',
          excerptTruncated: false,
        },
        draftClaims: [{ text: '۵۰۱', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
  });

  it('a Persian digit never matches its Latin equivalent (no digit conversion)', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'نسخهٔ ۵ بازی منتشر شد.',
          excerptTruncated: false,
        },
        draftClaims: [{ text: 'نسخهٔ 5 بازی منتشر شد.', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
  });

  it('a changed UNIT does not match', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'انتشار بازی ۵ ساعت تأخیر داشت.',
          excerptTruncated: false,
        },
        draftClaims: [{ text: '۵ روز تأخیر', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
  });

  it('punctuation is significant: added punctuation is not silently stripped', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'گفت: بازی منتشر نشد؟',
          excerptTruncated: false,
        },
        draftClaims: [{ text: 'بازی منتشر نشد.', evidenceIds: ['item-1'] }],
      }),
    );
    // The claim's trailing period differs from the source's question mark:
    // a DIFFERENT text — honest unresolved, the normalization deliberately
    // does not strip punctuation (substring direction: claim ⊆ excerpt).
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
  });
});

describe('evidence guard v1 — acceptance case 6: truncated excerpt keeps the coverage limitation', () => {
  it('an unresolved claim over a truncated excerpt carries excerpt_truncated_coverage', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'استودیوی نمونه اعلام کرد به‌روزرسانی بزرگ بازی نمونه…',
          excerptTruncated: true,
        },
        draftClaims: [{ text: 'بازی نمونه ۳ مهر عرضه شد.', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('unresolved_requires_further_verification');
    expect(report.claims[0]!.reasonCodes).toEqual([
      'excerpt_truncated_coverage',
      'no_direct_text_match',
    ]);
    expect(report.evidence.excerptTruncated).toBe(true);
    expect(report.limitations).toContain('excerpt_scope_only');
  });

  it('the truncation flag is recorded even when a quoted part IS observed', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        evidence: {
          evidenceId: 'item-1',
          excerptText: 'به‌روزرسانی بزرگ بازی نمونه…',
          excerptTruncated: true,
        },
        draftClaims: [{ text: 'به‌روزرسانی بزرگ بازی نمونه', evidenceIds: ['item-1'] }],
      }),
    );
    expect(report.claims[0]!.status).toBe('direct_text_observed');
    expect(report.evidence.excerptTruncated).toBe(true);
    expect(report.evidence.excerptMaxChars).toBeGreaterThan(0);
  });
});

describe('evidence guard v1 — acceptance case 7: headline/summary are explicitly unassessed', () => {
  it('unassessedFields is pinned regardless of headline/summary content', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftHeadlineFa: 'تیتر مدل که هیچ بررسی‌ای روی آن انجام نشد',
        draftSummaryFa: 'خلاصهٔ مدل که هیچ بررسی‌ای روی آن انجام نشد',
      }),
    );
    expect(report.unassessedFields).toEqual(['headlineFa', 'summaryFa']);
    expect(report.limitations).toContain('headline_summary_unassessed');
  });

  it('a headline quoting the excerpt VERBATIM stays unassessed (no implicit check)', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftHeadlineFa: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد.',
      }),
    );
    expect(report.unassessedFields).toEqual(['headlineFa', 'summaryFa']);
    // No claim entry exists for the headline — the scope is claims only.
    expect(report.claims).toHaveLength(1);
    expect(report.claims[0]!.claimIndex).toBe(0);
  });
});

describe('evidence guard v1 — determinism and versioning contract', () => {
  it('the same input yields a BYTE-IDENTICAL report (no clock, no randomness)', () => {
    const input = guardInput({
      draftClaims: [
        { text: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد.', evidenceIds: ['item-1'] },
        { text: 'ادعای مستقل نامرتبط.', evidenceIds: ['item-1'] },
      ],
    });
    const first = JSON.stringify(buildEvidenceGuardReport(input));
    const second = JSON.stringify(buildEvidenceGuardReport(input));
    expect(first).toBe(second);
  });

  it('claim order follows the input order; reason codes are sorted and deduplicated', () => {
    const report = buildEvidenceGuardReport(
      guardInput({
        draftClaims: [
          { text: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد.', evidenceIds: ['item-1'] },
          { text: 'ادعای دوم.', evidenceIds: ['item-1'] },
          { text: '', evidenceIds: [] },
        ],
      }),
    );
    expect(report.claims.map((claim) => claim.claimIndex)).toEqual([0, 1, 2]);
    expect(report.claims[0]!.status).toBe('direct_text_observed');
    expect(report.claims[1]!.status).toBe('unresolved_requires_further_verification');
    expect(report.claims[2]!.status).toBe('invalid_reference_or_snapshot');
    expect(report.claims[2]!.reasonCodes).toEqual(['empty_claim_text', 'empty_evidence_refs']);
  });

  it('the report pins guardVersion 1 and the fixed limitation set', () => {
    const report = buildEvidenceGuardReport(guardInput());
    expect(report.guardVersion).toBe(EVIDENCE_GUARD_VERSION);
    expect(EVIDENCE_GUARD_LIMITATIONS).toEqual([
      'excerpt_scope_only',
      'direct_text_is_not_truth',
      'no_semantic_analysis',
      'headline_summary_unassessed',
    ]);
  });

  it('an empty claim list yields an honest zero report (still versioned)', () => {
    const report = buildEvidenceGuardReport(guardInput({ draftClaims: [] }));
    expect(report.counts.total).toBe(0);
    expect(report.claims).toEqual([]);
    expect(report.guardVersion).toBe(1);
    expectNoSuccessVocabulary(report);
  });
});
