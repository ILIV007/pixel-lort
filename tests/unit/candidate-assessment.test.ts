import { describe, expect, it } from 'vitest';
import {
  buildCandidateDiscoveryReport,
  type CandidateDiscoveryInput,
  type CandidateDiscoveryReport,
} from '../../src/domain/editorial/candidate-discovery';
import {
  CANDIDATE_ASSESSMENT_BASIS,
  CANDIDATE_ASSESSMENT_LIMITATIONS,
  CANDIDATE_ASSESSMENT_UNASSESSED,
  CANDIDATE_ASSESSMENT_VERDICTS,
  assessCandidateSignals,
  buildCandidateAssessmentReport,
  readCandidateAssessmentReport,
} from '../../src/domain/editorial/candidate-assessment';

/**
 * R1.14 candidate-ASSESSMENT contracts (Phase 5C-2): the pure deterministic
 * classification of what was actually OBSERVED about a draft's discovery
 * candidates, and the typed reader that validates the REAL v1 invariants —
 * including cross-validation against the sibling `candidateDiscovery`
 * report. Posidon R1.14 acceptance mapping:
 *
 * - identical content, different ids/sources → content equality OBSERVED,
 *   never truth confirmation or source independence;
 * - same URL, different title/body → only URL sharing observed;
 * - same title, different text → the WEAK title signal;
 * - several signals → ALL reasons kept, never independent confirmations;
 * - no candidate → no "definitely unrelated" conclusion (ever);
 * - discovery truncation/overflow → limits preserved verbatim;
 * - verdicts carry no confidence, no score, no threshold;
 * - same input → byte-identical output, with explicit tested ordering.
 */

const SNAPSHOT = { sourceItemId: 'item-1', contentHash: 'a'.repeat(64) };
const SELF = 'edst_self';

function discoveryInput(overrides?: Partial<CandidateDiscoveryInput>): CandidateDiscoveryInput {
  return {
    snapshot: SNAPSHOT,
    storyId: SELF,
    lookups: [],
    matches: [],
    ...overrides,
  };
}

/** A builder pair (sibling discovery + its assessment) for one scenario. */
function pair(input: CandidateDiscoveryInput): {
  discovery: CandidateDiscoveryReport;
  document: Record<string, unknown>;
} {
  const discovery = buildCandidateDiscoveryReport(input);
  return {
    discovery,
    document: {
      candidateDiscovery: discovery,
      candidateAssessment: buildCandidateAssessmentReport({ discovery }),
    },
  };
}

const MULTI_SIGNAL_PAIR = pair(
  discoveryInput({
    lookups: [
      { kind: 'url', overflow: false },
      { kind: 'content_hash', overflow: false },
      { kind: 'title_key', overflow: false },
    ],
    matches: [
      { kind: 'url', storyId: 'edst_a' },
      { kind: 'content_hash', storyId: 'edst_a' },
      { kind: 'title_key', storyId: 'edst_a' },
      { kind: 'url', storyId: 'edst_b' },
      { kind: 'title_key', storyId: 'edst_b' },
      { kind: 'url', storyId: 'edst_c' },
      { kind: 'title_key', storyId: 'edst_d' },
    ],
  }),
);

const EMPTY_PAIR = pair(discoveryInput());

const TRUNCATED_PAIR = pair(
  discoveryInput({
    lookups: [{ kind: 'url', overflow: true }],
    matches: Array.from({ length: 12 }, (_, index) => ({
      kind: 'url' as const,
      storyId: `edst_${String(index).padStart(2, '0')}`,
    })),
  }),
);

describe('candidate assessment — verdict derivation (fixed universe, no scores)', () => {
  it('content_hash shared → full content equality observed (the title+body composite)', () => {
    expect(assessCandidateSignals(['content_hash'])).toBe('full_content_equality_observed');
  });

  it('content_hash with other signals stays full content equality — ALL reasons kept', () => {
    // Identical content ALWAYS co-occurs with the title signal (the title
    // is part of the composite); the verdict names the strongest observed
    // relation while verdictReasons preserves every real reason.
    expect(assessCandidateSignals(['content_hash', 'title_key'])).toBe(
      'full_content_equality_observed',
    );
    expect(assessCandidateSignals(['url', 'content_hash', 'title_key'])).toBe(
      'full_content_equality_observed',
    );
  });

  it('only url → shared url; only title → shared title; url+title → multiple signals', () => {
    expect(assessCandidateSignals(['url'])).toBe('shared_url_observed');
    expect(assessCandidateSignals(['title_key'])).toBe('shared_title_observed');
    expect(assessCandidateSignals(['url', 'title_key'])).toBe('multiple_signals_observed');
  });

  it('the verdict set is exactly the four documented labels', () => {
    expect(CANDIDATE_ASSESSMENT_VERDICTS).toEqual([
      'full_content_equality_observed',
      'shared_url_observed',
      'shared_title_observed',
      'multiple_signals_observed',
    ]);
  });
});

describe('candidate assessment — deterministic honest builder', () => {
  it('no candidates → zero entries and unrelatednessConcluded FALSE (never "unrelated")', () => {
    const report = buildCandidateAssessmentReport({ discovery: EMPTY_PAIR.discovery });
    expect(report.observation).toBe('no_candidates_observed');
    expect(report.entries).toEqual([]);
    expect(report.counts).toEqual({ assessed: 0 });
    expect(report.unrelatednessConcluded).toBe(false);
    expect(report.basis).toBe('candidate_discovery_v1_signals_at_lookup_moment');
    expect(report.limitations).toContain('not_truth_verification');
    expect(report.limitations).toContain('not_same_event_proof');
    expect(report.limitations).toContain('not_source_independence_proof');
    expect(report.limitations).toContain('signals_not_independent_confirmations');
    expect(report.limitations).toContain('discovery_data_not_refetched_or_validated');
    expect(report.unassessed).toEqual(['same_event', 'truth', 'source_independence']);
  });

  it('classifies each candidate and keeps ALL real reasons in signal-priority order', () => {
    const report = buildCandidateAssessmentReport({ discovery: MULTI_SIGNAL_PAIR.discovery });
    expect(report.observation).toBe('candidates_observed');
    expect(report.entries).toEqual([
      {
        storyId: 'edst_a',
        verdict: 'full_content_equality_observed',
        verdictReasons: [
          'url_fingerprint_match',
          'content_hash_fingerprint_match',
          'title_key_fingerprint_match',
        ],
      },
      {
        storyId: 'edst_b',
        verdict: 'multiple_signals_observed',
        verdictReasons: ['url_fingerprint_match', 'title_key_fingerprint_match'],
      },
      {
        storyId: 'edst_c',
        verdict: 'shared_url_observed',
        verdictReasons: ['url_fingerprint_match'],
      },
      {
        storyId: 'edst_d',
        verdict: 'shared_title_observed',
        verdictReasons: ['title_key_fingerprint_match'],
      },
    ]);
    expect(report.counts).toEqual({ assessed: 4 });
    expect(report.unrelatednessConcluded).toBe(false);
  });

  it('preserves discovery truncation/overflow/coverage limits verbatim', () => {
    const report = buildCandidateAssessmentReport({ discovery: TRUNCATED_PAIR.discovery });
    expect(report.discoveryLimits).toEqual({
      candidatesTruncated: true,
      overflowObserved: true,
      maxCandidates: 8,
      indexedScope: 'index_version_sc1_only',
      historicalBackfill: false,
    });
  });

  it('is deterministic: the same discovery yields a byte-identical assessment', () => {
    expect(
      JSON.stringify(buildCandidateAssessmentReport({ discovery: MULTI_SIGNAL_PAIR.discovery })),
    ).toBe(
      JSON.stringify(buildCandidateAssessmentReport({ discovery: MULTI_SIGNAL_PAIR.discovery })),
    );
  });

  it('carries the fixed documentation constants', () => {
    expect(CANDIDATE_ASSESSMENT_LIMITATIONS).toEqual([
      'candidate_only_not_merge',
      'not_truth_verification',
      'not_same_event_proof',
      'not_source_independence_proof',
      'signals_not_independent_confirmations',
      'discovery_data_not_refetched_or_validated',
      'title_signal_is_weak',
    ]);
    expect(CANDIDATE_ASSESSMENT_UNASSESSED).toEqual(['same_event', 'truth', 'source_independence']);
    expect(CANDIDATE_ASSESSMENT_BASIS).toBe('candidate_discovery_v1_signals_at_lookup_moment');
  });
});

describe('candidate assessment — typed reader (real v1 invariants)', () => {
  it('round-trips EVERY builder output as candidate_assessment_v1', () => {
    const scenarios = [
      EMPTY_PAIR,
      MULTI_SIGNAL_PAIR,
      TRUNCATED_PAIR,
      pair(
        discoveryInput({
          lookups: [{ kind: 'title_key', overflow: false }],
          matches: [{ kind: 'title_key', storyId: 'edst_t' }],
        }),
      ),
    ];
    for (const scenario of scenarios) {
      expect(readCandidateAssessmentReport(scenario.document)).toEqual({
        kind: 'candidate_assessment_v1',
        report: buildCandidateAssessmentReport({ discovery: scenario.discovery }),
      });
    }
  });

  it('distinguishes absent / unsupported_version / malformed', () => {
    // A pre-5C-2 draft: discovery without an assessment payload.
    expect(readCandidateAssessmentReport({ candidateDiscovery: EMPTY_PAIR.discovery })).toEqual({
      kind: 'absent',
    });
    expect(readCandidateAssessmentReport({ schemaVersion: 1, modelClaims: [] })).toEqual({
      kind: 'absent',
    });
    expect(
      readCandidateAssessmentReport({ candidateAssessment: { assessmentVersion: 2 } }),
    ).toEqual({
      kind: 'unsupported_version',
      assessmentVersion: 2,
    });
    expect(readCandidateAssessmentReport({ candidateAssessment: 'x' })).toEqual({
      kind: 'malformed',
    });
    expect(readCandidateAssessmentReport('not-an-object')).toEqual({ kind: 'malformed' });
    // An assessment WITHOUT its sibling discovery is never a current result.
    expect(
      readCandidateAssessmentReport({
        candidateAssessment: EMPTY_PAIR.document['candidateAssessment'],
      }),
    ).toEqual({
      kind: 'malformed',
    });
  });

  it('an assessment next to an invalid sibling discovery is malformed', () => {
    const brokenSibling = {
      candidateDiscovery: { ...EMPTY_PAIR.discovery, discoveryVersion: 7 },
      candidateAssessment: EMPTY_PAIR.document['candidateAssessment'],
    };
    expect(readCandidateAssessmentReport(brokenSibling).kind).toBe('malformed');
  });

  function mutatedDocument(
    base: Record<string, unknown>,
    mutate: (document: Record<string, unknown>) => void,
  ): unknown {
    const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    mutate(clone);
    return clone;
  }

  it.each([
    [
      'assessment storyId differs from the sibling discovery',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['storyId'] = 'edst_elsewhere';
      },
    ],
    [
      'assessment snapshot contentHash differs from the sibling',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['snapshot'] as Record<
            string,
            unknown
          >
        )['contentHash'] = 'f'.repeat(64);
      },
    ],
    [
      'assessment observation differs from the sibling observation',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['observation'] =
          'no_candidates_observed';
      },
    ],
    [
      'an entry dropped (list no longer mirrors the sibling candidates)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['entries'] = (
          (document['candidateAssessment'] as Record<string, unknown>)['entries'] as unknown[]
        ).slice(0, 2);
      },
    ],
    [
      'entries reordered against the sibling ascending storyId order',
      (document: Record<string, unknown>) => {
        const entries = (document['candidateAssessment'] as Record<string, unknown>)[
          'entries'
        ] as Record<string, unknown>[];
        const first = entries[0]!;
        const second = entries[1]!;
        entries[0] = second;
        entries[1] = first;
      },
    ],
    [
      'a verdict swapped to a WRONG-but-known label',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['entries'] as Record<
            string,
            unknown
          >[]
        )[0]!['verdict'] = 'shared_url_observed';
      },
    ],
    [
      'an unknown verdict label',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['entries'] as Record<
            string,
            unknown
          >[]
        )[0]!['verdict'] = 'same_event_confirmed';
      },
    ],
    [
      'verdictReasons inconsistent with the sibling matched signals',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['entries'] as Record<
            string,
            unknown
          >[]
        )[0]!['verdictReasons'] = ['made_up_reason'];
      },
    ],
    [
      'verdictReasons emptied (a real reason dropped)',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['entries'] as Record<
            string,
            unknown
          >[]
        )[0]!['verdictReasons'] = [];
      },
    ],
    [
      'counts.assessed inconsistent with the entries',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['counts'] as Record<
            string,
            unknown
          >
        )['assessed'] = 99;
      },
    ],
    [
      'a fractional count',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['counts'] as Record<
            string,
            unknown
          >
        )['assessed'] = 0.5;
      },
    ],
    [
      'unrelatednessConcluded flipped to true (a forbidden negative proof)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['unrelatednessConcluded'] =
          true;
      },
    ],
    [
      'limitations stripped (the R1.12.1 finding class)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['limitations'] = [];
      },
    ],
    [
      'a removed mandatory limitation label',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['limitations'] = (
          (document['candidateAssessment'] as Record<string, unknown>)['limitations'] as string[]
        ).slice(1);
      },
    ],
    [
      'an invented limitation label',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['limitations'] = [
          ...((document['candidateAssessment'] as Record<string, unknown>)[
            'limitations'
          ] as string[]),
          'auto_merge_allowed',
        ];
      },
    ],
    [
      'unassessed tuple reordered (the fixed order is part of the contract)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['unassessed'] = [
          'truth',
          'same_event',
          'source_independence',
        ];
      },
    ],
    [
      'unassessed tuple stripped (a non-assessment silently claimed)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['unassessed'] = [];
      },
    ],
    [
      'discoveryLimits.candidatesTruncated flipped against the sibling',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['discoveryLimits'] as Record<
            string,
            unknown
          >
        )['candidatesTruncated'] = true;
      },
    ],
    [
      'discoveryLimits.maxCandidates drifted',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['discoveryLimits'] as Record<
            string,
            unknown
          >
        )['maxCandidates'] = 100;
      },
    ],
    [
      'discoveryLimits claims historical backfill',
      (document: Record<string, unknown>) => {
        (
          (document['candidateAssessment'] as Record<string, unknown>)['discoveryLimits'] as Record<
            string,
            unknown
          >
        )['historicalBackfill'] = true;
      },
    ],
    [
      'basis label replaced (a different basis silently claimed)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['basis'] =
          'full_semantic_adjudication';
      },
    ],
    [
      'indexVersion replaced',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['indexVersion'] = 'sc2';
      },
    ],
  ])('malformed: %s', (_label, mutate) => {
    expect(
      readCandidateAssessmentReport(mutatedDocument(MULTI_SIGNAL_PAIR.document, mutate)).kind,
    ).toBe('malformed');
  });

  it.each([
    [
      'unrelatednessConcluded flipped on an EMPTY report too',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['unrelatednessConcluded'] =
          true;
      },
    ],
    [
      'fake entries invented on an EMPTY discovery (no candidate assessed out of thin air)',
      (document: Record<string, unknown>) => {
        (document['candidateAssessment'] as Record<string, unknown>)['entries'] = [
          {
            storyId: 'edst_ghost',
            verdict: 'shared_url_observed',
            verdictReasons: ['url_fingerprint_match'],
          },
        ];
      },
    ],
  ])('malformed (empty sibling): %s', (_label, mutate) => {
    expect(readCandidateAssessmentReport(mutatedDocument(EMPTY_PAIR.document, mutate)).kind).toBe(
      'malformed',
    );
  });
});
