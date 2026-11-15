import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_MATCHING_LIMITATIONS,
  CANDIDATE_MATCHING_MAX_SCORE,
  CANDIDATE_MATCHING_SIGNAL_WEIGHTS,
  CANDIDATE_MATCHING_UNASSESSED,
  buildCandidateMatchingReport,
  readCandidateMatchingReport,
  scoreCandidateSignals,
} from '../../src/domain/editorial/candidate-matching';
import {
  buildCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
  type CandidateRawMatch,
  type CandidateSignalKind,
} from '../../src/domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';

/**
 * Phase 5C-4 (V4 Phase 5.2) unit contracts for the DETERMINISTIC
 * candidate-MATCHING report: the score is a canonical one-to-one ENCODING
 * of the observed signal set (never a confidence, never a threshold), the
 * report-level outcome separates the identical-content locator from
 * similar-signal observations, and the resolution dimension is honest
 * about ambiguity, overflow and truncation. The typed reader re-derives
 * EVERYTHING from the sibling discovery + assessment and treats
 * absent/unsupported_version/malformed as distinct.
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
  // An overflow with ZERO candidates models the real shape: the probe hit
  // its full 9-row page but every row belonged to the CURRENT story (self
  // rows are excluded) — the lookup happened, nothing matched.
  const lookups =
    kinds.length > 0
      ? kinds.map((kind) => ({ kind, overflow }))
      : overflow
        ? [{ kind: 'url' as const, overflow: true }]
        : [];
  const discovery = buildCandidateDiscoveryReport({
    snapshot: { sourceItemId: 'item-m1', contentHash: 'h'.repeat(64) },
    storyId: 'edst_current',
    lookups,
    matches,
  });
  if (options?.truncated ?? false) {
    // Force the truncated flag the way the cap would (9 observed > 8 cap):
    // the builder itself only truncates from real inputs, so the shaped
    // fixture patches the two honest bookkeeping fields the discovery
    // reader validates against each other (counts + flag).
    return {
      ...discovery,
      counts: { ...discovery.counts, uniqueCandidatesObserved: 9 },
      candidatesTruncated: true,
    };
  }
  return discovery;
}

function makeDocument(discovery: CandidateDiscoveryReport): {
  readonly candidateDiscovery: CandidateDiscoveryReport;
  readonly candidateAssessment: ReturnType<typeof buildCandidateAssessmentReport>;
} {
  return {
    candidateDiscovery: discovery,
    candidateAssessment: buildCandidateAssessmentReport({ discovery }),
  };
}

describe('candidate matching — the score is a canonical observation-set encoding', () => {
  it('every non-empty subset of the three signals maps to a UNIQUE score (subset-sum injectivity)', () => {
    const subsets: readonly (readonly CandidateSignalKind[])[] = [
      ['url'],
      ['content_hash'],
      ['title_key'],
      ['url', 'content_hash'],
      ['url', 'title_key'],
      ['content_hash', 'title_key'],
      ['url', 'content_hash', 'title_key'],
    ];
    const scores = subsets.map((subset) => scoreCandidateSignals(subset));
    expect(new Set(scores).size).toBe(subsets.length);
    // Equal scores imply identical observed signal sets — verified on the
    // canonical singletons.
    expect(scoreCandidateSignals(['url'])).toBe(CANDIDATE_MATCHING_SIGNAL_WEIGHTS.url);
    expect(scoreCandidateSignals(['content_hash'])).toBe(
      CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash,
    );
    expect(scoreCandidateSignals(['title_key'])).toBe(CANDIDATE_MATCHING_SIGNAL_WEIGHTS.title_key);
    expect(scoreCandidateSignals(['content_hash', 'url'])).toBe(
      CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash + CANDIDATE_MATCHING_SIGNAL_WEIGHTS.url,
    );
  });

  it('duplicate signals are deduplicated (correlated observations never compound)', () => {
    expect(scoreCandidateSignals(['url', 'url'])).toBe(CANDIDATE_MATCHING_SIGNAL_WEIGHTS.url);
    expect(scoreCandidateSignals(['content_hash', 'content_hash', 'title_key', 'title_key'])).toBe(
      CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash + CANDIDATE_MATCHING_SIGNAL_WEIGHTS.title_key,
    );
  });

  it('the score is bounded by the documented maximum and never negative', () => {
    expect(CANDIDATE_MATCHING_MAX_SCORE).toBe(
      CANDIDATE_MATCHING_SIGNAL_WEIGHTS.url +
        CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash +
        CANDIDATE_MATCHING_SIGNAL_WEIGHTS.title_key,
    );
    const subsets: readonly (readonly CandidateSignalKind[])[] = [
      ['url'],
      ['content_hash'],
      ['title_key'],
      ['url', 'content_hash', 'title_key'],
    ];
    for (const subset of subsets) {
      const score = scoreCandidateSignals(subset);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(CANDIDATE_MATCHING_MAX_SCORE);
    }
  });

  it('an empty signal set is a typed error (never a zero score)', () => {
    expect(() => scoreCandidateSignals([])).toThrow(
      'candidate_matching_requires_at_least_one_signal',
    );
  });
});

describe('candidate matching — deterministic report building', () => {
  it('same input → byte-identical report (fixed field order, no timestamps, no randomness)', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['content_hash', 'url'] },
    ]);
    const assessment = buildCandidateAssessmentReport({ discovery });
    const first = JSON.stringify(buildCandidateMatchingReport({ discovery, assessment }));
    const second = JSON.stringify(buildCandidateMatchingReport({ discovery, assessment }));
    expect(first).toBe(second);
  });

  it('entries mirror the sibling discovery 1:1 with re-derived verdicts and set-encoded scores', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['content_hash', 'url'] },
    ]);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.entries.map((entry) => entry.storyId)).toEqual(['edst_a', 'edst_b']);
    expect(report.entries[0]).toMatchObject({ verdict: 'shared_url_observed', score: 4 });
    expect(report.entries[1]).toMatchObject({
      verdict: 'full_content_equality_observed',
      score: 12,
    });
    expect(report.counts).toEqual({ matched: 2 });
  });

  it('identical-content relation is reported at report level ONLY as a reuse locator', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['content_hash'] }]);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.outcome).toBe('identical_content_relation_observed');
    expect(report.limitations).toContain('identical_content_relation_is_reuse_locator_only');
    expect(report.unrelatednessConcluded).toBe(false);
  });

  it('similar signals WITHOUT the content composite never read as same-news evidence', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['title_key'] },
    ]);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.outcome).toBe('similar_signals_only_observed');
    expect(report.limitations).toContain('similar_signals_never_same_news');
    // Scores differ (4 vs 1) → a single top candidate, never a threshold.
    expect(report.topScoreObserved).toBe(4);
    expect(report.resolution).toBe('single_top_candidate_observed');
  });

  it('two candidates tied at the same observed signal set are an honest AMBIGUOUS tie', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['url'] },
    ]);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.resolution).toBe('ambiguous_tie_observed');
    expect(report.topScoreObserved).toBe(4);
  });

  it('nothing observed stays an honest observation — never "unique story"', () => {
    const discovery = makeDiscovery([]);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.observation).toBe('no_candidates_observed');
    expect(report.outcome).toBe('no_candidates_observed');
    expect(report.resolution).toBe('no_candidate_to_resolve');
    expect(report.topScoreObserved).toBeNull();
    expect(report.entries).toEqual([]);
    expect(report.unrelatednessConcluded).toBe(false);
  });

  it('overflow at the lookup moment makes the resolution honestly INCOMPLETE (no best-candidate claim)', () => {
    const discovery = makeDiscovery(
      [
        { storyId: 'edst_a', kinds: ['url'] },
        { storyId: 'edst_b', kinds: ['url'] },
      ],
      { overflow: true },
    );
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.resolution).toBe('unresolvable_incomplete_coverage');
    expect(report.discoveryLimits.overflowObserved).toBe(true);
  });

  it('discovery truncation (cap) makes the resolution honestly INCOMPLETE even without probe overflow', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }], {
      truncated: true,
    });
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.resolution).toBe('unresolvable_incomplete_coverage');
    expect(report.discoveryLimits.candidatesTruncated).toBe(true);
  });

  it('overflow with ZERO candidates still resolves honestly as nothing-to-resolve (precedence)', () => {
    const discovery = makeDiscovery([], { overflow: true });
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.resolution).toBe('no_candidate_to_resolve');
    expect(report.discoveryLimits.overflowObserved).toBe(true);
  });

  it('incomplete coverage beats an ambiguous tie in the deterministic precedence', () => {
    const discovery = makeDiscovery(
      [
        { storyId: 'edst_a', kinds: ['url'] },
        { storyId: 'edst_b', kinds: ['url'] },
      ],
      { truncated: true },
    );
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.resolution).toBe('unresolvable_incomplete_coverage');
  });

  it('the fixed limitation and unassessed sets ride verbatim, and the limits are preserved', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }]);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: buildCandidateAssessmentReport({ discovery }),
    });
    expect(report.limitations).toEqual([...CANDIDATE_MATCHING_LIMITATIONS]);
    expect(report.unassessed).toEqual([...CANDIDATE_MATCHING_UNASSESSED]);
    expect(report.discoveryLimits).toEqual({
      candidatesTruncated: discovery.candidatesTruncated,
      overflowObserved: discovery.lookup.overflowObserved,
      maxCandidates: discovery.coverage.maxCandidates,
      indexedScope: discovery.coverage.indexedScope,
      historicalBackfill: discovery.coverage.historicalBackfill,
    });
    expect(report.basis).toBe('candidate_discovery_v1_and_assessment_v1_at_lookup_moment');
    expect(report.indexVersion).toBe('sc1');
  });

  it('an assessment that does not mirror its discovery is a typed builder error', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }]);
    const foreign = makeDiscovery([{ storyId: 'edst_other', kinds: ['url'] }]);
    expect(() =>
      buildCandidateMatchingReport({
        discovery,
        assessment: buildCandidateAssessmentReport({ discovery: foreign }),
      }),
    ).toThrow('candidate_matching_basis_mismatch');
  });
});

describe('candidate matching — typed reader (absent / unsupported / malformed distinct)', () => {
  it('a built report round-trips through the typed reader deep-equal', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['content_hash', 'url'] },
      { storyId: 'edst_b', kinds: ['title_key'] },
    ]);
    const document = makeDocument(discovery);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: document.candidateAssessment,
    });
    const stored = { ...document, candidateMatching: report };
    const read = readCandidateMatchingReport(stored);
    expect(read.kind).toBe('candidate_matching_v1');
    if (read.kind === 'candidate_matching_v1') {
      expect(read.report).toEqual(report);
    }
  });

  it('absence is honest: no key (or a pre-slice document) reads absent', () => {
    expect(readCandidateMatchingReport({})).toEqual({ kind: 'absent' });
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }]);
    const document = makeDocument(discovery);
    expect(readCandidateMatchingReport(document)).toEqual({ kind: 'absent' });
  });

  it('a foreign version never reads as a current result', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }]);
    const document = makeDocument(discovery);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: document.candidateAssessment,
    });
    const future = {
      ...document,
      candidateMatching: { ...report, matchingVersion: 2 },
    };
    expect(readCandidateMatchingReport(future)).toEqual({
      kind: 'unsupported_version',
      matchingVersion: 2,
    });
  });

  it('non-object payloads are malformed', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }]);
    const document = makeDocument(discovery);
    expect(readCandidateMatchingReport({ ...document, candidateMatching: 'garbage' }).kind).toBe(
      'malformed',
    );
    expect(readCandidateMatchingReport({ ...document, candidateMatching: 42 }).kind).toBe(
      'malformed',
    );
  });

  it('a matching payload WITHOUT both valid siblings is malformed (never standalone)', () => {
    const discovery = makeDiscovery([{ storyId: 'edst_a', kinds: ['url'] }]);
    const document = makeDocument(discovery);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: document.candidateAssessment,
    });
    // No discovery sibling:
    expect(readCandidateMatchingReport({ candidateMatching: report }).kind).toBe('malformed');
    // No assessment sibling:
    expect(
      readCandidateMatchingReport({ candidateDiscovery: discovery, candidateMatching: report })
        .kind,
    ).toBe('malformed');
    // A foreign/corrupt discovery sibling:
    expect(
      readCandidateMatchingReport({
        ...document,
        candidateDiscovery: { discoveryVersion: 99 },
        candidateMatching: report,
      }).kind,
    ).toBe('malformed');
  });

  it('every mirrored field and every derived value is re-validated — a lie is malformed', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['content_hash'] },
    ]);
    const document = makeDocument(discovery);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: document.candidateAssessment,
    });
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['storyId', { ...report, storyId: 'edst_elsewhere' }],
      [
        'snapshot',
        {
          ...report,
          snapshot: { sourceItemId: 'item-other', contentHash: 'h'.repeat(64) },
        },
      ],
      ['observation', { ...report, observation: 'no_candidates_observed' }],
      [
        'entries reordered',
        {
          ...report,
          entries: [report.entries[1]!, report.entries[0]!],
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
      [
        'score lie',
        { ...report, entries: [{ ...report.entries[0]!, score: 13 }, report.entries[1]!] },
      ],
      [
        'entry order lie',
        {
          ...report,
          entries: [{ ...report.entries[0]!, storyId: 'edst_c' }, report.entries[1]!],
        },
      ],
      ['outcome lie', { ...report, outcome: 'similar_signals_only_observed' }],
      ['resolution lie', { ...report, resolution: 'ambiguous_tie_observed' }],
      ['topScore lie', { ...report, topScoreObserved: 13 }],
      ['counts lie', { ...report, counts: { matched: 7 } }],
      ['unrelatedness lie', { ...report, unrelatednessConcluded: true }],
      ['limitations lie', { ...report, limitations: [...CANDIDATE_MATCHING_LIMITATIONS.slice(1)] }],
      ['unassessed lie', { ...report, unassessed: [...CANDIDATE_MATCHING_UNASSESSED].reverse() }],
      [
        'discoveryLimits lie',
        { ...report, discoveryLimits: { ...report.discoveryLimits, overflowObserved: true } },
      ],
      ['basis lie', { ...report, basis: 'something_else' }],
      ['indexVersion lie', { ...report, indexVersion: 'sc9' }],
    ];
    for (const [label, payload] of cases) {
      const read = readCandidateMatchingReport({ ...document, candidateMatching: payload });
      expect(read.kind, `case ${label} must be malformed`).toBe('malformed');
    }
  });

  it('a missing entry (fewer entries than sibling candidates) is malformed', () => {
    const discovery = makeDiscovery([
      { storyId: 'edst_a', kinds: ['url'] },
      { storyId: 'edst_b', kinds: ['url'] },
    ]);
    const document = makeDocument(discovery);
    const report = buildCandidateMatchingReport({
      discovery,
      assessment: document.candidateAssessment,
    });
    const short = { ...report, entries: [report.entries[0]!] };
    expect(readCandidateMatchingReport({ ...document, candidateMatching: short }).kind).toBe(
      'malformed',
    );
  });
});
