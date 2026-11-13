import { describe, expect, it } from 'vitest';
import {
  buildCandidateAdjudicationReport,
  classifyMergeDisposition,
  type CandidateAdjudicationEntry,
} from '../../src/domain/editorial/candidate-adjudication';
import {
  buildCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
} from '../../src/domain/editorial/candidate-discovery';
import {
  buildCandidateAssessmentReport,
  type CandidateAssessmentReport,
} from '../../src/domain/editorial/candidate-assessment';
import {
  buildCandidateMatchingReport,
  type CandidateMatchingReport,
} from '../../src/domain/editorial/candidate-matching';

/**
 * Phase 5.4 (V4 roadmap: tests & self-review) — the MISSING precedence cells
 * of the candidate-ADJUDICATION merge-disposition matrix. The existing unit
 * suite pins none → incomplete → conflict → single-exact → similarity-only
 * for ONE and TWO exact candidates; the cells proven HERE complete the
 * honest matrix:
 *
 * - ZERO candidates UNDER an incomplete-coverage flag → `no_ground_no_candidates`
 *   still wins (nothing observed is more honest than a suppression story —
 *   the mirrored cell of the matching resolution's zero-candidate precedence,
 *   previously unasserted for the ADJUDICATION layer);
 * - THREE (≥3) exact-identity candidates keep the typed conflict (the ≥2
 *   boundary beyond the tested exactly-2 case);
 * - the derived reviewRequired ↔ disposition coherence holds over the whole
 *   honest shape space (reviewRequired is DERIVED, never a stored opinion).
 */

const SNAPSHOT = { sourceItemId: 'item-54-unit', contentHash: 'a'.repeat(64) };
const STORY_ID = 'edst_54_unit';

/** Build a fully coherent sibling chain from raw per-signal matches. */
function makeSiblings(input: {
  readonly matches: readonly {
    readonly kind: 'url' | 'content_hash' | 'title_key';
    readonly storyId: string;
  }[];
  readonly lookups?: readonly {
    readonly kind: 'url' | 'content_hash' | 'title_key';
    readonly overflow: boolean;
  }[];
}): {
  readonly discovery: CandidateDiscoveryReport;
  readonly assessment: CandidateAssessmentReport;
  readonly matching: CandidateMatchingReport;
} {
  const discovery = buildCandidateDiscoveryReport({
    snapshot: SNAPSHOT,
    storyId: STORY_ID,
    lookups: input.lookups ?? [
      { kind: 'url', overflow: false },
      { kind: 'content_hash', overflow: false },
      { kind: 'title_key', overflow: false },
    ],
    matches: input.matches,
  });
  const assessment = buildCandidateAssessmentReport({ discovery });
  const matching = buildCandidateMatchingReport({ discovery, assessment });
  return { discovery, assessment, matching };
}

function exactEntries(count: number): readonly CandidateAdjudicationEntry[] {
  return Array.from({ length: count }, (_value, index) => ({
    storyId: `edst_exact_${index}`,
    verdict: 'full_content_equality_observed' as const,
    stance: 'exact_content_identity_observed' as const,
    disposition: 'reuse_locator_supported' as const,
    reasons: ['exact_content_composite_identity_observed'],
  }));
}

describe('Phase 5.4 adversarial — the missing merge-disposition precedence cells', () => {
  it('ZERO candidates under BOTH incomplete-coverage flags → no_ground_no_candidates still wins (review NOT required)', () => {
    // The direct classifier cell: an empty entry list is decided BEFORE the
    // coverage flags are consulted — nothing observed beats a suppression
    // story (mirrors the matching resolution's zero-candidate precedence).
    expect(
      classifyMergeDisposition({ candidatesTruncated: true, overflowObserved: true, entries: [] }),
    ).toBe('no_ground_no_candidates');
    // The full builder path: a discovery with an overflowing probe but ZERO
    // unique candidates builds an honest no-ground adjudication.
    const siblings = makeSiblings({
      matches: [],
      lookups: [
        { kind: 'url', overflow: false },
        { kind: 'content_hash', overflow: true },
        { kind: 'title_key', overflow: false },
      ],
    });
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.observation).toBe('no_candidates_observed');
    expect(report.discoveryLimits.overflowObserved).toBe(true);
    expect(report.entries).toHaveLength(0);
    expect(report.mergeDisposition).toBe('no_ground_no_candidates');
    expect(report.mergeDispositionReasons).toEqual(['no_candidates_observed']);
    expect(report.reviewRequired).toBe(false);
    expect(report.unrelatednessConcluded).toBe(false);
  });

  it('THREE exact-identity candidates keep the typed conflict — the ≥2 boundary beyond the tested exactly-2 case', () => {
    const matches = [1, 2, 3].map((index) => ({
      kind: 'content_hash' as const,
      storyId: `edst_54_unit_exact_${index}`,
    }));
    const siblings = makeSiblings({ matches });
    const report = buildCandidateAdjudicationReport(siblings);
    expect(report.entries).toHaveLength(3);
    expect(
      report.entries.every((entry) => entry.stance === 'exact_content_identity_observed'),
    ).toBe(true);
    expect(report.mergeDisposition).toBe('defer_conflict_multiple_identity_candidates');
    expect(report.mergeDispositionReasons).toEqual([
      'conflict_never_auto_resolved',
      'exact_identity_candidates_conflict',
    ]);
    expect(report.reviewRequired).toBe(true);
    // Determinism: the same input rebuilds byte-identically (no count-based drift).
    expect(buildCandidateAdjudicationReport(siblings)).toEqual(report);
  });

  it('reviewRequired ↔ disposition coherence holds over the honest shape space (derived, never a stored opinion)', () => {
    const neverReview = new Set(['no_ground_no_candidates', 'reuse_locator_single_exact_identity']);
    const shapes: readonly {
      readonly label: string;
      readonly input: {
        readonly candidatesTruncated: boolean;
        readonly overflowObserved: boolean;
        readonly entries: readonly CandidateAdjudicationEntry[];
      };
    }[] = [
      {
        label: 'zero candidates',
        input: { candidatesTruncated: false, overflowObserved: false, entries: [] },
      },
      {
        label: 'zero candidates + overflow',
        input: { candidatesTruncated: true, overflowObserved: true, entries: [] },
      },
      {
        label: 'one similarity-only candidate',
        input: {
          candidatesTruncated: false,
          overflowObserved: false,
          entries: [
            {
              storyId: 'edst_sim',
              verdict: 'shared_title_observed',
              stance: 'identity_not_established_title_only',
              disposition: 'defer_to_review',
              reasons: ['similarity_never_proves_identity', 'title_signal_is_weak'],
            },
          ],
        },
      },
      {
        label: 'one exact candidate',
        input: {
          candidatesTruncated: false,
          overflowObserved: false,
          entries: exactEntries(1),
        },
      },
      {
        label: 'two exact candidates',
        input: {
          candidatesTruncated: false,
          overflowObserved: false,
          entries: exactEntries(2),
        },
      },
      {
        label: 'three exact candidates + truncation (suppression wins)',
        input: {
          candidatesTruncated: true,
          overflowObserved: false,
          entries: exactEntries(3),
        },
      },
    ];
    for (const shape of shapes) {
      const disposition = classifyMergeDisposition(shape.input);
      const reviewRequired = !neverReview.has(disposition);
      expect(
        reviewRequired,
        `shape "${shape.label}" → ${disposition} must derive reviewRequired=${reviewRequired}`,
      ).toBe(
        disposition !== 'no_ground_no_candidates' &&
          disposition !== 'reuse_locator_single_exact_identity',
      );
      // Suppression precedes conflict AND the single-exact echo.
      if (shape.input.candidatesTruncated || shape.input.overflowObserved) {
        if (shape.input.entries.length > 0) {
          expect(disposition, `shape "${shape.label}" suppressed`).toBe(
            'defer_incomplete_coverage',
          );
        }
      }
    }
  });
});
