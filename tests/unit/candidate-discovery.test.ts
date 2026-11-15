import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_DISCOVERY_LIMITATIONS,
  CANDIDATE_DISCOVERY_MAX_CANDIDATES,
  CANDIDATE_DISCOVERY_MAX_ROWS_PER_LOOKUP,
  buildCandidateDiscoveryReport,
  readCandidateDiscoveryReport,
  type CandidateDiscoveryInput,
} from '../../src/domain/editorial/candidate-discovery';

/**
 * R1.13 candidate-discovery contracts: the builder's deterministic honest
 * merging/capping, and the typed reader that validates the REAL v1
 * invariants (the R1.12.1 lesson applied from birth: a payload that merely
 * CLAIMS the version is malformed, never a current result).
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

function mutatedDocument(mutate: (report: Record<string, unknown>) => void): unknown {
  const report = JSON.parse(
    JSON.stringify(
      buildCandidateDiscoveryReport(
        discoveryInput({
          lookups: [
            { kind: 'url', overflow: false },
            { kind: 'title_key', overflow: false },
          ],
          matches: [
            { kind: 'url', storyId: 'edst_b' },
            { kind: 'title_key', storyId: 'edst_a' },
          ],
        }),
      ),
    ),
  ) as Record<string, unknown>;
  mutate(report);
  return { candidateDiscovery: report };
}

describe('candidate discovery — deterministic honest builder', () => {
  it('no lookups → no_candidates_observed, honest zero counts (never "unique story")', () => {
    const report = buildCandidateDiscoveryReport(discoveryInput());
    expect(report.observation).toBe('no_candidates_observed');
    expect(report.candidates).toEqual([]);
    expect(report.counts).toEqual({
      lookupsPerformed: 0,
      uniqueCandidatesObserved: 0,
      candidatesReported: 0,
    });
    expect(report.candidatesTruncated).toBe(false);
    expect(report.limitations).toContain('candidate_only_not_merge');
    expect(report.limitations).toContain('not_truth_verification');
  });

  it('merges duplicate candidates across signals, keeping deduplicated priority-ordered signals', () => {
    const report = buildCandidateDiscoveryReport(
      discoveryInput({
        lookups: [
          { kind: 'url', overflow: false },
          { kind: 'content_hash', overflow: false },
          { kind: 'title_key', overflow: false },
        ],
        matches: [
          { kind: 'title_key', storyId: 'edst_x' },
          { kind: 'url', storyId: 'edst_x' },
          { kind: 'url', storyId: 'edst_x' }, // duplicate signal — merged
          { kind: 'content_hash', storyId: 'edst_x' },
        ],
      }),
    );
    expect(report.counts.uniqueCandidatesObserved).toBe(1);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.storyId).toBe('edst_x');
    expect(report.candidates[0]!.matchedSignals.map((signal) => signal.kind)).toEqual([
      'url',
      'content_hash',
      'title_key',
    ]);
    expect(report.candidates[0]!.matchedSignals[0]!.reasonCode).toBe('url_fingerprint_match');
  });

  it('excludes the current story and orders candidates by ascending storyId', () => {
    const report = buildCandidateDiscoveryReport(
      discoveryInput({
        lookups: [{ kind: 'url', overflow: false }],
        matches: [
          { kind: 'url', storyId: SELF },
          { kind: 'url', storyId: 'edst_c' },
          { kind: 'url', storyId: 'edst_a' },
          { kind: 'url', storyId: 'edst_b' },
        ],
      }),
    );
    expect(report.candidates.map((candidate) => candidate.storyId)).toEqual([
      'edst_a',
      'edst_b',
      'edst_c',
    ]);
  });

  it('caps at 8 candidates with an explicit truncation flag and honest observed count', () => {
    const matches = Array.from({ length: 12 }, (_, index) => ({
      kind: 'url' as const,
      storyId: `edst_${String(index).padStart(2, '0')}`,
    }));
    const report = buildCandidateDiscoveryReport(
      discoveryInput({ lookups: [{ kind: 'url', overflow: true }], matches }),
    );
    expect(report.counts.uniqueCandidatesObserved).toBe(12);
    expect(report.counts.candidatesReported).toBe(CANDIDATE_DISCOVERY_MAX_CANDIDATES);
    expect(report.candidatesTruncated).toBe(true);
    expect(report.lookup.overflowObserved).toBe(true);
  });

  it('is deterministic: the same input yields a byte-identical report', () => {
    const input = discoveryInput({
      lookups: [{ kind: 'url', overflow: false }],
      matches: [{ kind: 'url', storyId: 'edst_b' }],
    });
    expect(JSON.stringify(buildCandidateDiscoveryReport(input))).toBe(
      JSON.stringify(buildCandidateDiscoveryReport(input)),
    );
  });
});

describe('candidate discovery — typed reader (real v1 invariants)', () => {
  it('round-trips EVERY builder output as candidate_discovery_v1', () => {
    const scenarios: CandidateDiscoveryInput[] = [
      discoveryInput(),
      discoveryInput({
        lookups: [{ kind: 'url', overflow: false }],
        matches: [{ kind: 'url', storyId: 'edst_a' }],
      }),
      discoveryInput({
        lookups: [
          { kind: 'url', overflow: false },
          { kind: 'content_hash', overflow: false },
          { kind: 'title_key', overflow: true },
        ],
        matches: [
          { kind: 'content_hash', storyId: 'edst_b' },
          { kind: 'title_key', storyId: 'edst_a' },
        ],
      }),
      discoveryInput({
        lookups: [{ kind: 'title_key', overflow: true }],
        matches: Array.from({ length: 12 }, (_, index) => ({
          kind: 'title_key' as const,
          storyId: `edst_${String(index).padStart(2, '0')}`,
        })),
      }),
    ];
    for (const input of scenarios) {
      const report = buildCandidateDiscoveryReport(input);
      expect(readCandidateDiscoveryReport({ candidateDiscovery: report })).toEqual({
        kind: 'candidate_discovery_v1',
        report,
      });
    }
  });

  it('distinguishes absent / unsupported_version / malformed', () => {
    expect(readCandidateDiscoveryReport({ schemaVersion: 1, modelClaims: [] })).toEqual({
      kind: 'absent',
    });
    expect(readCandidateDiscoveryReport({ candidateDiscovery: { discoveryVersion: 2 } })).toEqual({
      kind: 'unsupported_version',
      discoveryVersion: 2,
    });
    expect(readCandidateDiscoveryReport({ candidateDiscovery: 'x' })).toEqual({
      kind: 'malformed',
    });
    expect(readCandidateDiscoveryReport({ candidateDiscovery: { discoveryVersion: 1 } })).toEqual({
      kind: 'malformed',
    });
    expect(readCandidateDiscoveryReport('not-an-object')).toEqual({ kind: 'malformed' });
  });

  it.each([
    [
      'stripped limitations (the R1.12.1 finding class)',
      (report: Record<string, unknown>) => {
        report['limitations'] = [];
      },
    ],
    [
      'a removed mandatory limitation label',
      (report: Record<string, unknown>) => {
        report['limitations'] = (report['limitations'] as string[]).slice(1);
      },
    ],
    [
      'coverage mutated (historical backfill claimed)',
      (report: Record<string, unknown>) => {
        (report['coverage'] as Record<string, unknown>)['historicalBackfill'] = true;
      },
    ],
    [
      'coverage maxCandidates drifted',
      (report: Record<string, unknown>) => {
        (report['coverage'] as Record<string, unknown>)['maxCandidates'] = 100;
      },
    ],
    [
      'counts inconsistent with the candidate list',
      (report: Record<string, unknown>) => {
        (report['counts'] as Record<string, unknown>)['candidatesReported'] = 99;
      },
    ],
    [
      'lookupsPerformed inconsistent with the signals',
      (report: Record<string, unknown>) => {
        (report['counts'] as Record<string, unknown>)['lookupsPerformed'] = 3;
      },
    ],
    [
      'a negative count',
      (report: Record<string, unknown>) => {
        (report['counts'] as Record<string, unknown>)['uniqueCandidatesObserved'] = -1;
      },
    ],
    [
      'a fractional count',
      (report: Record<string, unknown>) => {
        (report['counts'] as Record<string, unknown>)['lookupsPerformed'] = 0.5;
      },
    ],
    [
      'candidate list reordered (non-ascending storyIds)',
      (report: Record<string, unknown>) => {
        const candidates = report['candidates'] as Record<string, unknown>[];
        const first = candidates[0]!;
        const second = candidates[1]!;
        candidates[0] = second;
        candidates[1] = first;
      },
    ],
    [
      'a duplicate candidate storyId',
      (report: Record<string, unknown>) => {
        report['candidates'] = [report['candidates'], report['candidates']].flat();
      },
    ],
    [
      'the current story listed as its own candidate',
      (report: Record<string, unknown>) => {
        (report['candidates'] as Record<string, unknown>[])[0]!['storyId'] = report['storyId'];
      },
    ],
    [
      'an unknown signal kind in the lookup scope',
      (report: Record<string, unknown>) => {
        (report['lookup'] as Record<string, unknown>)['signals'] = ['url', 'mystery'];
      },
    ],
    [
      'a matched signal kind OUTSIDE the performed lookups',
      (report: Record<string, unknown>) => {
        const candidates = report['candidates'] as Record<string, unknown>[];
        (candidates[0]!['matchedSignals'] as Record<string, unknown>[])[0]!['kind'] =
          'content_hash';
      },
    ],
    [
      'a reasonCode inconsistent with the signal kind',
      (report: Record<string, unknown>) => {
        const candidates = report['candidates'] as Record<string, unknown>[];
        (candidates[0]!['matchedSignals'] as Record<string, unknown>[])[0]!['reasonCode'] =
          'verified_truth';
      },
    ],
    [
      'empty matchedSignals',
      (report: Record<string, unknown>) => {
        (report['candidates'] as Record<string, unknown>[])[0]!['matchedSignals'] = [];
      },
    ],
    [
      'a duplicated matched signal',
      (report: Record<string, unknown>) => {
        const candidates = report['candidates'] as Record<string, unknown>[];
        const candidate = candidates[0]!;
        candidate['matchedSignals'] = [
          candidate['matchedSignals'] as unknown[],
          candidate['matchedSignals'] as unknown[],
        ].flat();
      },
    ],
    [
      'candidatesTruncated inconsistent with the observed count',
      (report: Record<string, unknown>) => {
        report['candidatesTruncated'] = !report['candidatesTruncated'];
      },
    ],
    [
      'observation inconsistent with the candidate list',
      (report: Record<string, unknown>) => {
        report['observation'] = 'no_candidates_observed';
      },
    ],
    [
      'maxRowsPerLookup drifted',
      (report: Record<string, unknown>) => {
        (report['lookup'] as Record<string, unknown>)['maxRowsPerLookup'] = 1000;
      },
    ],
    [
      'signals out of the canonical priority order',
      (report: Record<string, unknown>) => {
        (report['lookup'] as Record<string, unknown>)['signals'] = ['title_key', 'url'];
      },
    ],
  ])('malformed: %s', (_label, mutate) => {
    expect(readCandidateDiscoveryReport(mutatedDocument(mutate)).kind).toBe('malformed');
  });

  it('carries the fixed documentation constants', () => {
    expect(CANDIDATE_DISCOVERY_LIMITATIONS).toEqual([
      'candidate_only_not_merge',
      'not_truth_verification',
      'lookup_moment_visibility',
      'title_signal_is_weak',
    ]);
    expect(CANDIDATE_DISCOVERY_MAX_ROWS_PER_LOOKUP).toBe(9);
    expect(CANDIDATE_DISCOVERY_MAX_CANDIDATES).toBe(8);
  });
});
