/**
 * Versioned candidate-ADJUDICATION report (Phase 5.3 — the V4 owner
 * authorization 2026-11-10 lifted the former "5.3 waits for an owner
 * decision" restriction FOR LOCAL design/build/test): the HONEST,
 * DETERMINISTIC, CONSERVATIVE adjudication layer OVER the same draft's
 * `candidateMatching` report (which transitively rests on the sibling
 * `candidateDiscovery` + `candidateAssessment`) at the lookup moment.
 * NO SQL, NO network, NO SDK, NO model call, NO clock — a PURE derivation
 * stored INSIDE `drafts.document_json` next to its siblings by the SAME
 * fenced atomic commit (zero new statements, zero extra execution calls,
 * zero cost).
 *
 * WHAT IT ADDS (and nothing else):
 * - a per-candidate STANCE that separates the ONLY identity-grade
 *   observation — the versioned content-composite fingerprint match
 *   (`exact_content_identity_observed`, disposition
 *   `reuse_locator_supported`) — from every weaker similarity
 *   (`identity_not_established_url_only` / `..._title_only` /
 *   `..._signals_only`, ALL with disposition `defer_to_review` and the
 *   explicit `similarity_never_proves_identity` reason). This is the
 *   roadmap's support/contradict/unclear modeling in its honest form:
 *   the exact-composite identity is the ONLY thing that can SUPPORT a
 *   reuse locator, similarity NEVER establishes identity, and nothing
 *   here ever concludes "definitely unrelated" — a reject is not ours to
 *   conclude (`unrelatednessConcluded` stays FIXED false);
 * - a report-level MERGE DISPOSITION under the versioned policy `mp1`
 *   with a FIXED, tested precedence: nothing observed ⇒
 *   `no_ground_no_candidates`; an incomplete discovery window (probe
 *   overflow OR report truncation) ⇒ `defer_incomplete_coverage` — the
 *   suppression policy adopted from the preserved sm1 proposal (an
 *   incomplete window never yields a merge/locator PROPOSAL, while the
 *   per-candidate stances stay visible as observations); TWO OR MORE
 *   exact-identity candidates ⇒ `defer_conflict_multiple_identity_candidates`
 *   (a transparent typed conflict record — never auto-picked); exactly
 *   ONE ⇒ `reuse_locator_single_exact_identity` (an ECHO of the verified
 *   5C-3 reuse locator path, never itself an executed merge); only
 *   weaker signals ⇒ `defer_similarity_only`. Ambiguity never wins: a
 *   tie is a conflict or a similarity-only defer by construction. Every
 *   defer sets `reviewRequired: true` — ambiguous or risky ⇒ review,
 *   NEVER a merge;
 * - audit/provenance/version/conflict/undo-review properties BY
 *   CONSTRUCTION: the report is versioned (`adjudicationVersion: 1`,
 *   `mergePolicyVersion: 'mp1'`), carries fixed basis labels, mirrors
 *   the sibling matching outcome/resolution verbatim, keeps the
 *   discovery coverage limits verbatim, and — being a PURE advisory
 *   report — MUTATES NOTHING (there is nothing to undo: no merge, no
 *   duplicate marking, no supersede, no evidence change, no state
 *   write beyond the document field itself; the only "action" it ever
 *   supports is the already-verified, already-shipped 5C-3 reuse
 *   locator path, which it merely ECHOES). Source independence stays
 *   in the fixed `unassessed` tuple — correlated signals are NEVER
 *   independent confirmations.
 *
 * WHAT THE REPORT NEVER CLAIMS OR DOES: a merge, a duplicate marking, a
 * supersede, an evidence-stance change, a trust/confidence raise, a
 * same-event proof, truth verification, source-independence assessment,
 * or any path to validation/approval/publication. No candidate data is
 * re-fetched or re-validated; no new signal is invented anywhere; the
 * score/threshold layer is deliberately NOT reintroduced (the preserved
 * sm1 threshold proposal was REVIEWED as a recorded design input and its
 * threshold-based identity proposals were REJECTED — a score cutoff
 * would claim identity from similarity, which V4 forbids; the adopted
 * sm1 concepts are the incomplete-window suppression, the
 * ambiguity-never-picks-a-winner rule, and the weak-title insufficiency,
 * each in its honest form above).
 *
 * The typed reader (R1.12.1 lesson applied from birth) validates the
 * REAL v1 invariants — INCLUDING cross-validation against the sibling
 * `candidateMatching` report (which itself requires BOTH of ITS
 * siblings): mirrors re-checked, stances/dispositions/reasons and the
 * merge disposition and reviewRequired re-derived from the sibling's
 * verdicts and limits — a stored lie is malformed. A payload that merely
 * CLAIMS the version is `malformed`, never a current result. The reader
 * is a shape/invariant validator — NOT authenticity, NOT semantic
 * support.
 */

import {
  readCandidateMatchingReport,
  type CandidateMatchingEntry,
  type CandidateMatchingReport,
} from './candidate-matching';
import { CANDIDATE_DISCOVERY_COVERAGE, type CandidateDiscoveryReport } from './candidate-discovery';
import type { CandidateAssessmentReport, CandidateAssessmentVerdict } from './candidate-assessment';

/** Report schema version — bump ONLY with a documented contract change. */
export const CANDIDATE_ADJUDICATION_VERSION = 1 as const;

/**
 * The versioned MERGE POLICY id — the transparent conditions under which
 * the report supports a locator or defers. Any condition change bumps
 * THIS (and is a documented contract change), never a silent rewrite.
 */
export const CANDIDATE_ADJUDICATION_MERGE_POLICY_VERSION = 'mp1' as const;

/** Fixed basis label — a pure view of the sibling matching v1 report. */
export const CANDIDATE_ADJUDICATION_BASIS =
  'candidate_matching_v1_report_at_lookup_moment' as const;

/** The index namespace the underlying discovery lookups are scoped to. */
export const CANDIDATE_ADJUDICATION_INDEX_VERSION = 'sc1' as const;

/** The per-candidate stance universe (fixed; additive-only in futures). */
export const CANDIDATE_ADJUDICATION_STANCES = [
  'exact_content_identity_observed',
  'identity_not_established_url_only',
  'identity_not_established_title_only',
  'identity_not_established_signals_only',
] as const;
export type CandidateAdjudicationStance = (typeof CANDIDATE_ADJUDICATION_STANCES)[number];

/** The per-candidate disposition universe (fixed). */
export const CANDIDATE_ADJUDICATION_DISPOSITIONS = [
  'reuse_locator_supported',
  'defer_to_review',
] as const;
export type CandidateAdjudicationDisposition = (typeof CANDIDATE_ADJUDICATION_DISPOSITIONS)[number];

/** The report-level merge disposition universe (fixed). */
export const CANDIDATE_ADJUDICATION_MERGE_DISPOSITIONS = [
  'no_ground_no_candidates',
  'defer_incomplete_coverage',
  'defer_conflict_multiple_identity_candidates',
  'reuse_locator_single_exact_identity',
  'defer_similarity_only',
] as const;
export type CandidateAdjudicationMergeDisposition =
  (typeof CANDIDATE_ADJUDICATION_MERGE_DISPOSITIONS)[number];

/** Fixed limitation labels (order is part of the deterministic output). */
export const CANDIDATE_ADJUDICATION_LIMITATIONS = [
  'adjudication_report_only_no_executed_merge',
  'reuse_locator_supports_verified_exact_path_only',
  'similarity_never_proves_identity',
  'correlated_signals_not_independent_confirmations',
  'incomplete_coverage_never_yields_merge_proposal',
  'conflict_never_auto_resolved',
  'matching_data_not_refetched_or_validated',
  'title_signal_is_weak',
  'evidence_stance_untouched_no_truth_conversion',
] as const;

/** Fixed unassessed tuple — what this adjudication NEVER judges. */
export const CANDIDATE_ADJUDICATION_UNASSESSED = [
  'same_event',
  'truth',
  'source_independence',
] as const;

/** One adjudicated candidate: a minimal, non-contradictory projection. */
export interface CandidateAdjudicationEntry {
  /** The candidate story (same value and order as the sibling matching). */
  readonly storyId: string;
  /** The mirrored sibling verdict (re-validated by the reader). */
  readonly verdict: CandidateAssessmentVerdict;
  /** The deterministic identity-stance of the observed relation. */
  readonly stance: CandidateAdjudicationStance;
  /** The per-candidate disposition under the fixed `mp1` policy. */
  readonly disposition: CandidateAdjudicationDisposition;
  /** ALL fixed reason codes of the disposition, in their fixed order. */
  readonly reasons: readonly string[];
}

/** The versioned, deterministic report stored with the draft. */
export interface CandidateAdjudicationReport {
  readonly adjudicationVersion: typeof CANDIDATE_ADJUDICATION_VERSION;
  /** The versioned merge-policy id (conditions changes bump THIS). */
  readonly mergePolicyVersion: typeof CANDIDATE_ADJUDICATION_MERGE_POLICY_VERSION;
  /** Fixed basis label — what this report is derived from (and only that). */
  readonly basis: typeof CANDIDATE_ADJUDICATION_BASIS;
  readonly indexVersion: typeof CANDIDATE_ADJUDICATION_INDEX_VERSION;
  /** Mirrors the sibling matching report (cross-validated by the reader). */
  readonly storyId: string;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** Mirrors the sibling matching observation — never a stronger claim. */
  readonly observation: 'no_candidates_observed' | 'candidates_observed';
  /** One entry per sibling candidate, SAME deterministic ascending order. */
  readonly entries: readonly CandidateAdjudicationEntry[];
  /** The report-level merge disposition under the fixed `mp1` policy. */
  readonly mergeDisposition: CandidateAdjudicationMergeDisposition;
  /** ALL fixed reason codes of the merge disposition, in fixed order. */
  readonly mergeDispositionReasons: readonly string[];
  /**
   * TRUE for every defer (ambiguous/risky/incomplete ⇒ review, never a
   * merge); FALSE only for the verified-locator echo and the honest
   * nothing-observed case.
   */
  readonly reviewRequired: boolean;
  /** Mirrors the sibling matching outcome verbatim (provenance). */
  readonly matchingOutcome: CandidateMatchingReport['outcome'];
  /** Mirrors the sibling matching resolution verbatim (provenance). */
  readonly matchingResolution: CandidateMatchingReport['resolution'];
  readonly counts: {
    /** Adjudicated candidates (= entries.length = sibling matched). */
    readonly adjudicated: number;
  };
  /** FIXED `false` — this report never concludes "definitely unrelated". */
  readonly unrelatednessConcluded: false;
  /** The discovery coverage/truncation limits, PRESERVED verbatim. */
  readonly discoveryLimits: {
    readonly candidatesTruncated: boolean;
    readonly overflowObserved: boolean;
    readonly maxCandidates: CandidateMatchingReport['discoveryLimits']['maxCandidates'];
    readonly indexedScope: 'index_version_sc1_only';
    readonly historicalBackfill: false;
  };
  readonly limitations: readonly string[];
  readonly unassessed: readonly string[];
}

/**
 * The deterministic per-candidate stance/disposition/reasons for one
 * sibling matching verdict. PURE and TOTAL over the v1 verdict universe:
 * the exact content-composite identity is the ONLY identity-grade
 * stance; every weaker similarity defers with the explicit
 * `similarity_never_proves_identity` reason kept FIRST.
 */
export function adjudicateCandidateVerdict(verdict: CandidateAssessmentVerdict): {
  readonly stance: CandidateAdjudicationStance;
  readonly disposition: CandidateAdjudicationDisposition;
  readonly reasons: readonly string[];
} {
  switch (verdict) {
    case 'full_content_equality_observed':
      return {
        stance: 'exact_content_identity_observed',
        disposition: 'reuse_locator_supported',
        reasons: ['exact_content_composite_identity_observed'],
      };
    case 'shared_url_observed':
      return {
        stance: 'identity_not_established_url_only',
        disposition: 'defer_to_review',
        reasons: ['similarity_never_proves_identity', 'url_is_not_content_identity'],
      };
    case 'shared_title_observed':
      return {
        stance: 'identity_not_established_title_only',
        disposition: 'defer_to_review',
        reasons: ['similarity_never_proves_identity', 'title_signal_is_weak'],
      };
    case 'multiple_signals_observed':
      return {
        stance: 'identity_not_established_signals_only',
        disposition: 'defer_to_review',
        reasons: [
          'similarity_never_proves_identity',
          'correlated_signals_not_independent_confirmations',
        ],
      };
  }
}

/** The FIXED reason codes of each report-level merge disposition. */
const MERGE_DISPOSITION_REASONS: Readonly<
  Record<CandidateAdjudicationMergeDisposition, readonly string[]>
> = {
  no_ground_no_candidates: ['no_candidates_observed'],
  defer_incomplete_coverage: ['incomplete_coverage_never_yields_merge_proposal'],
  defer_conflict_multiple_identity_candidates: [
    'conflict_never_auto_resolved',
    'exact_identity_candidates_conflict',
  ],
  reuse_locator_single_exact_identity: [
    'exact_content_composite_identity_observed',
    'reuse_locator_supports_verified_exact_path_only',
  ],
  defer_similarity_only: ['similarity_never_proves_identity'],
};

/** `reviewRequired` is a DERIVED value — never a stored opinion. */
function reviewRequiredFor(disposition: CandidateAdjudicationMergeDisposition): boolean {
  return (
    disposition !== 'reuse_locator_single_exact_identity' &&
    disposition !== 'no_ground_no_candidates'
  );
}

/**
 * The deterministic report-level merge disposition. Precedence
 * (documented, tested): nothing observed → no ground; incomplete
 * coverage (probe overflow OR report truncation) → suppression; ≥2
 * exact-identity candidates → typed conflict; exactly 1 → the verified
 * locator echo; otherwise similarity-only defer. NONE of these labels
 * ever executes a merge — they classify the PROPOSAL space only.
 */
export function classifyMergeDisposition(input: {
  readonly candidatesTruncated: boolean;
  readonly overflowObserved: boolean;
  readonly entries: readonly CandidateAdjudicationEntry[];
}): CandidateAdjudicationMergeDisposition {
  if (input.entries.length === 0) {
    return 'no_ground_no_candidates';
  }
  if (input.candidatesTruncated || input.overflowObserved) {
    return 'defer_incomplete_coverage';
  }
  const exactCount = input.entries.filter(
    (entry) => entry.stance === 'exact_content_identity_observed',
  ).length;
  if (exactCount >= 2) {
    return 'defer_conflict_multiple_identity_candidates';
  }
  if (exactCount === 1) {
    return 'reuse_locator_single_exact_identity';
  }
  return 'defer_similarity_only';
}

function adjudicationBasisMismatch(): Error {
  return new Error('candidate_adjudication_basis_mismatch');
}

/**
 * Build the versioned adjudication report from the SAME draft's matching
 * report (+ its discovery/assessment parents, cross-checked). TOTAL and
 * DETERMINISTIC: same input → byte-identical output (fixed field order,
 * inherited candidate order, no timestamps, no randomness). The builder
 * reads NOTHING but the three sibling reports — no text comparison, no
 * re-fetch, no new signal anywhere. A mismatch between the siblings is a
 * typed builder error, never a silently accepted basis.
 */
export function buildCandidateAdjudicationReport(input: {
  readonly matching: CandidateMatchingReport;
  readonly discovery: CandidateDiscoveryReport;
  readonly assessment: CandidateAssessmentReport;
}): CandidateAdjudicationReport {
  const matching = input.matching;
  const discovery = input.discovery;
  const assessment = input.assessment;
  if (
    matching.storyId !== discovery.storyId ||
    matching.snapshot.sourceItemId !== discovery.snapshot.sourceItemId ||
    matching.snapshot.contentHash !== discovery.snapshot.contentHash ||
    matching.observation !== discovery.observation ||
    matching.entries.length !== discovery.candidates.length ||
    matching.discoveryLimits.candidatesTruncated !== discovery.candidatesTruncated ||
    matching.discoveryLimits.overflowObserved !== discovery.lookup.overflowObserved ||
    assessment.storyId !== discovery.storyId ||
    assessment.snapshot.sourceItemId !== discovery.snapshot.sourceItemId ||
    assessment.snapshot.contentHash !== discovery.snapshot.contentHash ||
    assessment.observation !== discovery.observation ||
    assessment.entries.length !== discovery.candidates.length
  ) {
    throw adjudicationBasisMismatch();
  }
  const entries: CandidateAdjudicationEntry[] = matching.entries.map(
    (entry: CandidateMatchingEntry) => {
      const verdict = entry.verdict;
      const mirrored = assessment.entries.find((candidate) => candidate.storyId === entry.storyId);
      if (mirrored === undefined || mirrored.verdict !== verdict) {
        throw adjudicationBasisMismatch();
      }
      return { storyId: entry.storyId, verdict, ...adjudicateCandidateVerdict(verdict) };
    },
  );
  const mergeDisposition = classifyMergeDisposition({
    candidatesTruncated: discovery.candidatesTruncated,
    overflowObserved: discovery.lookup.overflowObserved,
    entries,
  });
  return {
    adjudicationVersion: CANDIDATE_ADJUDICATION_VERSION,
    mergePolicyVersion: CANDIDATE_ADJUDICATION_MERGE_POLICY_VERSION,
    basis: CANDIDATE_ADJUDICATION_BASIS,
    indexVersion: CANDIDATE_ADJUDICATION_INDEX_VERSION,
    storyId: discovery.storyId,
    snapshot: {
      sourceItemId: discovery.snapshot.sourceItemId,
      contentHash: discovery.snapshot.contentHash,
    },
    observation: discovery.observation,
    entries,
    mergeDisposition,
    mergeDispositionReasons: MERGE_DISPOSITION_REASONS[mergeDisposition],
    reviewRequired: reviewRequiredFor(mergeDisposition),
    matchingOutcome: matching.outcome,
    matchingResolution: matching.resolution,
    counts: {
      adjudicated: entries.length,
    },
    unrelatednessConcluded: false,
    discoveryLimits: {
      candidatesTruncated: discovery.candidatesTruncated,
      overflowObserved: discovery.lookup.overflowObserved,
      maxCandidates: CANDIDATE_DISCOVERY_COVERAGE.maxCandidates,
      indexedScope: CANDIDATE_DISCOVERY_COVERAGE.indexedScope,
      historicalBackfill: CANDIDATE_DISCOVERY_COVERAGE.historicalBackfill,
    },
    limitations: CANDIDATE_ADJUDICATION_LIMITATIONS,
    unassessed: CANDIDATE_ADJUDICATION_UNASSESSED,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — payloads that merely claim the version are malformed,
// and an adjudication report is ONLY valid next to the sibling matching
// report (which itself requires BOTH of ITS siblings) it derives from.
// ---------------------------------------------------------------------------

export type CandidateAdjudicationRead =
  | { readonly kind: 'candidate_adjudication_v1'; readonly report: CandidateAdjudicationReport }
  /** A pre-5.3 draft (no adjudication payload). Honest absence — no backfill. */
  | { readonly kind: 'absent' }
  /** An adjudication-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly adjudicationVersion: unknown }
  /** Not an adjudication payload at all — including one that violates v1 or
   *  lacks the valid sibling matching chain to derive from. */
  | { readonly kind: 'malformed' };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Same element sequence (order-sensitive) — no reorder, no duplicate. */
function sameStringSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const OBSERVATIONS: ReadonlySet<string> = new Set([
  'no_candidates_observed',
  'candidates_observed',
]);
const STANCES: ReadonlySet<string> = new Set(CANDIDATE_ADJUDICATION_STANCES);
const DISPOSITIONS: ReadonlySet<string> = new Set(CANDIDATE_ADJUDICATION_DISPOSITIONS);
const MERGE_DISPOSITIONS: ReadonlySet<string> = new Set(CANDIDATE_ADJUDICATION_MERGE_DISPOSITIONS);

/**
 * Read the adjudication payload from a PARSED `drafts.document_json`
 * value. Consumers must treat `absent`/`unsupported_version`/`malformed`
 * as "no current adjudication result" — none of them validates anything,
 * and NONE of them ever means "unrelated" or "same news" or "merge".
 */
export function readCandidateAdjudicationReport(document: unknown): CandidateAdjudicationRead {
  if (typeof document !== 'object' || document === null) {
    return { kind: 'malformed' };
  }
  const adjudication = (document as Record<string, unknown>)['candidateAdjudication'];
  if (adjudication === undefined) {
    return { kind: 'absent' };
  }
  if (typeof adjudication !== 'object' || adjudication === null) {
    return { kind: 'malformed' };
  }
  const a = adjudication as Record<string, unknown>;
  if (a['adjudicationVersion'] !== CANDIDATE_ADJUDICATION_VERSION) {
    return { kind: 'unsupported_version', adjudicationVersion: a['adjudicationVersion'] };
  }

  // ---- Sibling basis: a v1 adjudication WITHOUT a valid v1 sibling
  //      matching report is not a current result (the matching reader
  //      enforces ITS discovery + assessment siblings transitively).
  const matchingRead = readCandidateMatchingReport(document);
  if (matchingRead.kind !== 'candidate_matching_v1') {
    return { kind: 'malformed' };
  }
  const matching = matchingRead.report;

  const snapshot = a['snapshot'];
  const discoveryLimits = a['discoveryLimits'];
  const counts = a['counts'];
  const entries = a['entries'];
  if (
    a['basis'] !== CANDIDATE_ADJUDICATION_BASIS ||
    a['indexVersion'] !== CANDIDATE_ADJUDICATION_INDEX_VERSION ||
    a['mergePolicyVersion'] !== CANDIDATE_ADJUDICATION_MERGE_POLICY_VERSION ||
    typeof a['storyId'] !== 'string' ||
    a['storyId'].length === 0 ||
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    typeof a['observation'] !== 'string' ||
    !OBSERVATIONS.has(a['observation']) ||
    typeof a['mergeDisposition'] !== 'string' ||
    !MERGE_DISPOSITIONS.has(a['mergeDisposition']) ||
    !Array.isArray(a['mergeDispositionReasons']) ||
    !isStringArray(a['mergeDispositionReasons']) ||
    typeof a['reviewRequired'] !== 'boolean' ||
    typeof a['matchingOutcome'] !== 'string' ||
    typeof a['matchingResolution'] !== 'string' ||
    a['unrelatednessConcluded'] !== false ||
    !Array.isArray(entries) ||
    typeof counts !== 'object' ||
    counts === null ||
    typeof discoveryLimits !== 'object' ||
    discoveryLimits === null ||
    !Array.isArray(a['limitations']) ||
    !isStringArray(a['limitations']) ||
    !Array.isArray(a['unassessed']) ||
    !isStringArray(a['unassessed'])
  ) {
    return { kind: 'malformed' };
  }

  // ---- Limitations/unassessed: exactly the fixed v1 sets, each once.
  const fixedLimitations = CANDIDATE_ADJUDICATION_LIMITATIONS as readonly string[];
  const limitations = a['limitations'] as readonly string[];
  const unassessed = a['unassessed'] as readonly string[];
  const fixedUnassessed = CANDIDATE_ADJUDICATION_UNASSESSED as readonly string[];
  if (
    limitations.length !== fixedLimitations.length ||
    new Set(limitations).size !== limitations.length ||
    !limitations.every((label) => fixedLimitations.includes(label)) ||
    !sameStringSequence(unassessed, fixedUnassessed)
  ) {
    return { kind: 'malformed' };
  }

  // ---- Discovery limits: PRESERVED verbatim from the sibling.
  const limits = discoveryLimits as Record<string, unknown>;
  if (
    limits['candidatesTruncated'] !== matching.discoveryLimits.candidatesTruncated ||
    limits['overflowObserved'] !== matching.discoveryLimits.overflowObserved ||
    limits['maxCandidates'] !== CANDIDATE_DISCOVERY_COVERAGE.maxCandidates ||
    limits['indexedScope'] !== CANDIDATE_DISCOVERY_COVERAGE.indexedScope ||
    limits['historicalBackfill'] !== CANDIDATE_DISCOVERY_COVERAGE.historicalBackfill
  ) {
    return { kind: 'malformed' };
  }

  // ---- Identity mirrors: story, snapshot, observation (vs the sibling).
  if (
    a['storyId'] !== matching.storyId ||
    (snapshot as Record<string, unknown>)['sourceItemId'] !== matching.snapshot.sourceItemId ||
    (snapshot as Record<string, unknown>)['contentHash'] !== matching.snapshot.contentHash ||
    a['observation'] !== matching.observation
  ) {
    return { kind: 'malformed' };
  }

  // ---- Matching mirrors: outcome + resolution ride verbatim (provenance).
  if (
    a['matchingOutcome'] !== matching.outcome ||
    a['matchingResolution'] !== matching.resolution
  ) {
    return { kind: 'malformed' };
  }

  // ---- Entries: EXACTLY one per sibling candidate, same order, verdict
  //      mirrored from the sibling matching entry, stance/disposition/
  //      reasons re-derived from that verdict.
  if (entries.length !== matching.entries.length) {
    return { kind: 'malformed' };
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const matchingEntry = matching.entries[index]!;
    if (typeof entry !== 'object' || entry === null) {
      return { kind: 'malformed' };
    }
    const record = entry as Record<string, unknown>;
    const verdict = record['verdict'];
    const stance = record['stance'];
    const disposition = record['disposition'];
    const reasons = record['reasons'];
    if (
      record['storyId'] !== matchingEntry.storyId ||
      verdict !== matchingEntry.verdict ||
      typeof stance !== 'string' ||
      !STANCES.has(stance) ||
      typeof disposition !== 'string' ||
      !DISPOSITIONS.has(disposition) ||
      !Array.isArray(reasons) ||
      !isStringArray(reasons)
    ) {
      return { kind: 'malformed' };
    }
    const expected = adjudicateCandidateVerdict(matchingEntry.verdict);
    if (
      stance !== expected.stance ||
      disposition !== expected.disposition ||
      !sameStringSequence(reasons as readonly string[], expected.reasons)
    ) {
      return { kind: 'malformed' };
    }
  }
  const typedEntries = entries as readonly CandidateAdjudicationEntry[];

  // ---- Derived values: merge disposition, reasons and reviewRequired are
  //      re-derived from the sibling-backed entries + limits — a stored
  //      lie is malformed.
  const expectedDisposition = classifyMergeDisposition({
    candidatesTruncated: matching.discoveryLimits.candidatesTruncated,
    overflowObserved: matching.discoveryLimits.overflowObserved,
    entries: typedEntries,
  });
  if (
    a['mergeDisposition'] !== expectedDisposition ||
    !sameStringSequence(
      a['mergeDispositionReasons'] as readonly string[],
      MERGE_DISPOSITION_REASONS[expectedDisposition],
    ) ||
    a['reviewRequired'] !== reviewRequiredFor(expectedDisposition)
  ) {
    return { kind: 'malformed' };
  }

  // ---- Counts: the single count EXACTLY describes the payload.
  const adjudicated = (counts as Record<string, unknown>)['adjudicated'];
  if (
    !isNonNegativeInteger(adjudicated) ||
    (adjudicated as number) !== typedEntries.length ||
    (adjudicated as number) !== matching.counts.matched
  ) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'candidate_adjudication_v1',
    report: adjudication as unknown as CandidateAdjudicationReport,
  };
}
