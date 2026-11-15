import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_ADJUDICATION_DISPOSITIONS,
  CANDIDATE_ADJUDICATION_LIMITATIONS,
  CANDIDATE_ADJUDICATION_MERGE_DISPOSITIONS,
  CANDIDATE_ADJUDICATION_STANCES,
  CANDIDATE_ADJUDICATION_UNASSESSED,
  adjudicateCandidateVerdict,
  buildCandidateAdjudicationReport,
  classifyMergeDisposition,
  readCandidateAdjudicationReport,
} from '../../src/domain/editorial/candidate-adjudication';
import {
  buildCandidateMatchingReport,
  type CandidateMatchingReport,
} from '../../src/domain/editorial/candidate-matching';
import {
  buildCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
  type CandidateRawMatch,
  type CandidateSignalKind,
} from '../../src/domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';

/**
 * Phase 5.3 (V4 owner authorization 2026-11-10) unit contracts for the
 * DETERMINISTIC candidate-ADJUDICATION report: the per-candidate stance
 * separates the EXACT content-composite identity (the only identity-grade
 * observation, supporting the VERIFIED 5C-3 reuse locator) from every
 * weaker similarity (identity NOT established — never a same-news claim);
 * the report-level merge disposition is conservative (ambiguous, risky or
 * incompletely-covered inputs DEFER, conflicts are never auto-resolved);
 * the typed reader re-derives EVERYTHING from the sibling matching report
 * and treats absent/unsupported_version/malformed as distinct.
 */

const SIGNAL_PRIORITY: readonly CandidateSignalKind[] = ['url', 'content_hash', 'title_key'];

interface FakeCandidate {
  readonly storyId: string;
  readonly kinds: readonly CandidateSignalKind[];
}

function makeDiscovery(
  candidates: readonly FakeCandidate[],
  options?: { readonly overflow?: boolean; readonly truncated?: boolean },
): CandidateDiscoveryReport {
  const kinds = SIGNAL_PRIORITY.filter((kind) =>
    candidates.some((candidate) => candidate.kinds.includes(kind)),
  );
  const matches: CandidateRawMatch[] = candidates.flatMap((candidate) =>
    candidate.kinds.map((kind) => ({ kind, storyId: candidate.storyId })),
  );
  const overflow = options?.overflow ?? false;
  const lookups =
    kinds.length > 0
      ? kinds.map((kind) => ({ kind, overflow }))
      : overflow
        ? [{ kind: 'url' as const, overflow: true }]
        : [];
  const discovery = buildCandidateDiscoveryReport({
    snapshot: { sourceItemId: 'item-adj-1', contentHash: 'h'.repeat(64) },
    storyId: 'edst_current',
    lookups,
    matches,
  });
  if (options?.truncated ?? false) {
    return {
      ...discovery,
      counts: { ...discovery.counts, uniqueCandidatesObserved: 9 },
      candidatesTruncated: true,
    };
  }
  return discovery;
}

/** The FULL sibling chain: discovery → assessment → matching. */
function makeSiblings(
  candidates: readonly FakeCandidate[],
  options?: { readonly overflow?: boolean; readonly truncated?: boolean },
): {
  readonly discovery: CandidateDiscoveryReport;
  readonly assessment: ReturnType<typeof buildCandidateAssessmentReport>;
  readonly matching: CandidateMatchingReport;
} {
  const discovery = makeDiscovery(candidates, options);
  const assessment = buildCandidateAssessmentReport({ discovery });
  const matching = buildCandidateMatchingReport({ discovery, assessment });
  return { discovery, assessment, matching };
}

describe('candidate adjudication — the per-candidate stance mapping is total and transparent', () => {
  it('exact content-composite equality is the ONLY identity-grade stance (reuse-locator support)', () => {
    const mapped = adjudicateCandidateVerdict('full_content_equality_observed');
    expect(mapped).toEqual({
      stance: 'exact_content_identity_observed',
      disposition: 'reuse_locator_supported',
      reasons: ['exact_content_composite_identity_observed'],
    });
  });

  it('a shared URL never establishes identity (deferred to review)', () => {
    const mapped = adjudicateCandidateVerdict('shared_url_observed');
    expect(mapped).toEqual({
      stance: 'identity_not_established_url_only',
      disposition: 'defer_to_review',
      reasons: ['similarity_never_proves_identity', 'url_is_not_content_identity'],
    });
  });

  it('the weak title signal never establishes identity (deferred to review)', () => {
    const mapped = adjudicateCandidateVerdict('shared_title_observed');
    expect(mapped).toEqual({
      stance: 'identity_not_established_title_only',
      disposition: 'defer_to_review',
      reasons: ['similarity_never_proves_identity', 'title_signal_is_weak'],
    });
  });

  it('several correlated signals never establish identity (never independent confirmations)', () => {
    const mapped = adjudicateCandidateVerdict('multiple_signals_observed');
    expect(mapped).toEqual({
      stance: 'identity_not_established_signals_only',
      disposition: 'defer_to_review',
      reasons: [
        'similarity_never_proves_identity',
        'correlated_signals_not_independent_confirmations',
      ],
    });
  });

  it('the fixed stance/disposition/unassessed sets ride verbatim on every report', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['url'] }]);
    const report = buildCandidateAdjudicationReport(siblings);
    expect(CANDIDATE_ADJUDICATION_STANCES).toEqual([
      'exact_content_identity_observed',
      'identity_not_established_url_only',
      'identity_not_established_title_only',
      'identity_not_established_signals_only',
    ]);
    expect(CANDIDATE_ADJUDICATION_DISPOSITIONS).toEqual([
      'reuse_locator_supported',
      'defer_to_review',
    ]);
    expect(CANDIDATE_ADJUDICATION_MERGE_DISPOSITIONS).toEqual([
      'no_ground_no_candidates',
      'defer_incomplete_coverage',
      'defer_conflict_multiple_identity_candidates',
      'reuse_locator_single_exact_identity',
      'defer_similarity_only',
    ]);
    expect(CANDIDATE_ADJUDICATION_UNASSESSED).toEqual([
      'same_event',
      'truth',
      'source_independence',
    ]);
    expect(report.unassessed).toEqual([...CANDIDATE_ADJUDICATION_UNASSESSED]);
    expect(report.limitations).toEqual([...CANDIDATE_ADJUDICATION_LIMITATIONS]);
    expect(report.unrelatednessConcluded).toBe(false);
  });
});

describe('candidate adjudication — the merge disposition precedence is documented and tested', () => {
  it('nothing observed stays no_ground_no_candidates with no review requirement', () => {
    const siblings = makeSiblings([]);
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.observation).toBe('no_candidates_observed');
    expect(report.mergeDisposition).toBe('no_ground_no_candidates');
    expect(report.reviewRequired).toBe(false);
    expect(report.entries).toEqual([]);
    expect(report.counts).toEqual({ adjudicated: 0 });
  });

  it('incomplete coverage defers EVEN with an exact-identity candidate visible (suppression; the stance stays listed)', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['content_hash'] }], {
      truncated: true,
    });
    const report = buildCandidateAdjudicationReport(siblings);
    // The per-candidate stance stays an honest observation:
    expect(report.entries[0]).toMatchObject({
      stance: 'exact_content_identity_observed',
      disposition: 'reuse_locator_supported',
    });
    // ...but the PROPOSAL is suppressed on the incomplete window:
    expect(report.mergeDisposition).toBe('defer_incomplete_coverage');
    expect(report.reviewRequired).toBe(true);
  });

  it('probe overflow defers exactly like truncation (same suppression policy)', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['content_hash'] }], {
      overflow: true,
    });
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.mergeDisposition).toBe('defer_incomplete_coverage');
    expect(report.mergeDispositionReasons).toContain(
      'incomplete_coverage_never_yields_merge_proposal',
    );
  });

  it('TWO exact-identity candidates are a typed CONFLICT — never auto-picked', () => {
    const siblings = makeSiblings([
      { storyId: 'edst_a', kinds: ['content_hash'] },
      { storyId: 'edst_b', kinds: ['content_hash'] },
    ]);
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.mergeDisposition).toBe('defer_conflict_multiple_identity_candidates');
    expect(report.reviewRequired).toBe(true);
    expect(report.mergeDispositionReasons).toContain('conflict_never_auto_resolved');
    // Both entries keep their honest identity-grade stance (observations are
    // preserved; only the PROPOSAL is deferred):
    expect(report.entries.every((entry) => entry.disposition === 'reuse_locator_supported')).toBe(
      true,
    );
  });

  it('exactly one exact-identity candidate echoes the verified reuse-locator path (no review required)', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['content_hash'] }]);
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.mergeDisposition).toBe('reuse_locator_single_exact_identity');
    expect(report.reviewRequired).toBe(false);
    expect(report.counts).toEqual({ adjudicated: 1 });
  });

  it('weaker signals only ⇒ similarity-only defer with review required (never same-news)', () => {
    const siblings = makeSiblings([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['title_key'] },
    ]);
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.mergeDisposition).toBe('defer_similarity_only');
    expect(report.reviewRequired).toBe(true);
    expect(report.mergeDispositionReasons).toContain('similarity_never_proves_identity');
  });

  it('the precedence order is none → incomplete → conflict → single-exact → similarity-only', () => {
    // conflict + similarity mixed (exact candidates + weaker ones):
    const mixed = makeSiblings([
      { storyId: 'edst_a', kinds: ['content_hash'] },
      { storyId: 'edst_b', kinds: ['content_hash'] },
      { storyId: 'edst_c', kinds: ['url'] },
    ]);
    expect(
      classifyMergeDisposition({
        entries: buildCandidateAdjudicationReport(mixed).entries,
        candidatesTruncated: false,
        overflowObserved: false,
      }),
    ).toBe('defer_conflict_multiple_identity_candidates');
    // incomplete beats conflict:
    const incompleteConflict = makeSiblings(
      [
        { storyId: 'edst_a', kinds: ['content_hash'] },
        { storyId: 'edst_b', kinds: ['content_hash'] },
      ],
      { overflow: true },
    );
    expect(buildCandidateAdjudicationReport(incompleteConflict).mergeDisposition).toBe(
      'defer_incomplete_coverage',
    );
  });

  it('same input → byte-identical report (fixed field order, no timestamps, no randomness)', () => {
    const siblings = makeSiblings([
      { storyId: 'edst_a', kinds: ['content_hash', 'url'] },
      { storyId: 'edst_b', kinds: ['title_key'] },
    ]);
    const first = JSON.stringify(buildCandidateAdjudicationReport(siblings));
    const second = JSON.stringify(buildCandidateAdjudicationReport(siblings));
    expect(first).toBe(second);
  });

  it('a matching report that does not mirror its discovery is a typed builder error', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['url'] }]);
    const foreign = makeSiblings([{ storyId: 'edst_other', kinds: ['url'] }]);
    expect(() =>
      buildCandidateAdjudicationReport({
        matching: siblings.matching,
        discovery: siblings.discovery,
        assessment: buildCandidateAssessmentReport({ discovery: foreign.discovery }),
      }),
    ).toThrow('candidate_adjudication_basis_mismatch');
    expect(() =>
      buildCandidateAdjudicationReport({
        matching: foreign.matching,
        discovery: siblings.discovery,
        assessment: siblings.assessment,
      }),
    ).toThrow('candidate_adjudication_basis_mismatch');
  });
});

describe('candidate adjudication — typed reader (absent / unsupported / malformed distinct)', () => {
  it('a built report round-trips through the typed reader deep-equal', () => {
    const siblings = makeSiblings([
      { storyId: 'edst_a', kinds: ['content_hash', 'url'] },
      { storyId: 'edst_b', kinds: ['title_key'] },
    ]);
    const report = buildCandidateAdjudicationReport(siblings);
    const stored = {
      candidateDiscovery: siblings.discovery,
      candidateAssessment: siblings.assessment,
      candidateMatching: siblings.matching,
      candidateAdjudication: report,
    };
    const read = readCandidateAdjudicationReport(stored);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind === 'candidate_adjudication_v1') {
      expect(read.report).toEqual(report);
    }
  });

  it('absence is honest: no key (or a pre-slice document) reads absent', () => {
    expect(readCandidateAdjudicationReport({})).toEqual({ kind: 'absent' });
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['url'] }]);
    const document = {
      candidateDiscovery: siblings.discovery,
      candidateAssessment: siblings.assessment,
      candidateMatching: siblings.matching,
    };
    expect(readCandidateAdjudicationReport(document)).toEqual({ kind: 'absent' });
  });

  it('a foreign version never reads as a current result', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['url'] }]);
    const report = buildCandidateAdjudicationReport(siblings);
    const future = {
      candidateDiscovery: siblings.discovery,
      candidateAssessment: siblings.assessment,
      candidateMatching: siblings.matching,
      candidateAdjudication: { ...report, adjudicationVersion: 2 },
    };
    expect(readCandidateAdjudicationReport(future)).toEqual({
      kind: 'unsupported_version',
      adjudicationVersion: 2,
    });
  });

  it('non-object payloads are malformed', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['url'] }]);
    const document = {
      candidateDiscovery: siblings.discovery,
      candidateAssessment: siblings.assessment,
      candidateMatching: siblings.matching,
    };
    expect(
      readCandidateAdjudicationReport({ ...document, candidateAdjudication: 'garbage' }).kind,
    ).toBe('malformed');
    expect(readCandidateAdjudicationReport({ ...document, candidateAdjudication: 42 }).kind).toBe(
      'malformed',
    );
  });

  it('an adjudication payload WITHOUT its valid matching sibling chain is malformed (never standalone)', () => {
    const siblings = makeSiblings([{ storyId: 'edst_a', kinds: ['url'] }]);
    const report = buildCandidateAdjudicationReport(siblings);
    // No siblings at all:
    expect(readCandidateAdjudicationReport({ candidateAdjudication: report }).kind).toBe(
      'malformed',
    );
    // Matching sibling missing:
    expect(
      readCandidateAdjudicationReport({
        candidateDiscovery: siblings.discovery,
        candidateAssessment: siblings.assessment,
        candidateAdjudication: report,
      }).kind,
    ).toBe('malformed');
    // A corrupt matching sibling:
    expect(
      readCandidateAdjudicationReport({
        candidateDiscovery: siblings.discovery,
        candidateAssessment: siblings.assessment,
        candidateMatching: { matchingVersion: 99 },
        candidateAdjudication: report,
      }).kind,
    ).toBe('malformed');
  });

  it('every mirrored field and every derived value is re-validated — a lie is malformed', () => {
    const siblings = makeSiblings([
      { storyId: 'edst_a', kinds: ['content_hash'] },
      { storyId: 'edst_b', kinds: ['url'] },
    ]);
    const document = {
      candidateDiscovery: siblings.discovery,
      candidateAssessment: siblings.assessment,
      candidateMatching: siblings.matching,
    };
    const report = buildCandidateAdjudicationReport(siblings);
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['storyId', { ...report, storyId: 'edst_elsewhere' }],
      [
        'snapshot',
        { ...report, snapshot: { sourceItemId: 'item-other', contentHash: 'h'.repeat(64) } },
      ],
      ['observation', { ...report, observation: 'no_candidates_observed' }],
      ['entries reordered', { ...report, entries: [report.entries[1]!, report.entries[0]!] }],
      [
        'entry storyId lie',
        { ...report, entries: [{ ...report.entries[0]!, storyId: 'edst_z' }, report.entries[1]!] },
      ],
      [
        'stance lie',
        {
          ...report,
          entries: [
            { ...report.entries[0]!, stance: 'identity_not_established_url_only' },
            report.entries[1]!,
          ],
        },
      ],
      [
        'disposition lie',
        {
          ...report,
          entries: [{ ...report.entries[0]!, disposition: 'defer_to_review' }, report.entries[1]!],
        },
      ],
      [
        'reasons lie',
        {
          ...report,
          entries: [{ ...report.entries[0]!, reasons: ['made_up_reason'] }, report.entries[1]!],
        },
      ],
      [
        'verdict lie',
        {
          ...report,
          entries: [
            { ...report.entries[0]!, verdict: 'shared_title_observed' },
            report.entries[1]!,
          ],
        },
      ],
      ['mergeDisposition lie', { ...report, mergeDisposition: 'defer_similarity_only' }],
      ['mergeDispositionReasons lie', { ...report, mergeDispositionReasons: ['made_up'] }],
      ['reviewRequired lie', { ...report, reviewRequired: true }],
      ['counts lie', { ...report, counts: { adjudicated: 7 } }],
      ['unrelatedness lie', { ...report, unrelatednessConcluded: true }],
      [
        'limitations lie',
        { ...report, limitations: [...CANDIDATE_ADJUDICATION_LIMITATIONS.slice(1)] },
      ],
      [
        'unassessed lie',
        { ...report, unassessed: [...CANDIDATE_ADJUDICATION_UNASSESSED].reverse() },
      ],
      [
        'discoveryLimits lie',
        { ...report, discoveryLimits: { ...report.discoveryLimits, overflowObserved: true } },
      ],
      [
        'matchingResolution mirror lie',
        { ...report, matchingResolution: 'ambiguous_tie_observed' },
      ],
      ['matchingOutcome mirror lie', { ...report, matchingOutcome: 'no_candidates_observed' }],
      ['basis lie', { ...report, basis: 'something_else' }],
      ['indexVersion lie', { ...report, indexVersion: 'sc9' }],
      ['mergePolicyVersion lie', { ...report, mergePolicyVersion: 'mp0' }],
    ];
    for (const [label, payload] of cases) {
      const read = readCandidateAdjudicationReport({ ...document, candidateAdjudication: payload });
      expect(read.kind, `case ${label} must be malformed`).toBe('malformed');
    }
  });

  it('a missing entry (fewer entries than sibling matching candidates) is malformed', () => {
    const siblings = makeSiblings([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['url'] },
    ]);
    const document = {
      candidateDiscovery: siblings.discovery,
      candidateAssessment: siblings.assessment,
      candidateMatching: siblings.matching,
    };
    const report = buildCandidateAdjudicationReport(siblings);
    const short = { ...report, entries: [report.entries[0]!] };
    expect(
      readCandidateAdjudicationReport({ ...document, candidateAdjudication: short }).kind,
    ).toBe('malformed');
  });
});
