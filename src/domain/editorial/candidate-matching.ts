/**
 * Versioned candidate-MATCHING report (Phase 5C-4 — the V4 Phase 5.2
 * local engineering slice): the HONEST, DETERMINISTIC, CONSERVATIVE
 * matching layer OVER the same draft's `candidateDiscovery` +
 * `candidateAssessment` reports at the lookup moment. NO SQL, NO network,
 * NO SDK, NO model call, NO clock — a PURE derivation stored INSIDE
 * `drafts.document_json` next to its siblings by the SAME fenced atomic
 * commit (zero new statements, zero extra execution calls).
 *
 * WHAT IT ADDS (and nothing else):
 * - a TRANSPARENT, versioned score per candidate — a canonical ONE-TO-ONE
 *   encoding of the observed signal set (weights 1/4/8 make every
 *   non-empty subset sum unique): equal scores ⇔ identical observed
 *   signal sets. The score is a RANKING INDEX of observations, NEVER a
 *   confidence/probability, NEVER compared across reports, NEVER a
 *   threshold and NEVER an acceptance decision — every candidate stays
 *   listed with the assessment's verdict; there is no cutoff anywhere;
 * - a report-level OUTCOME that separates the identical-content relation
 *   (`identical_content_relation_observed` — ONLY when the versioned
 *   content-composite fingerprint really matched; a LOCATOR for the
 *   verified 5C-3 reuse path, never itself a merge/dedup/processing
 *   decision) from `similar_signals_only_observed` (any weaker signal
 *   combination — explicitly NEVER same-news evidence);
 * - a report-level RESOLUTION that is honest about ambiguity and
 *   coverage: an incomplete candidate list (probe overflow or report
 *   truncation) is `unresolvable_incomplete_coverage` — no
 *   best-candidate claim; a tie at the top score over the SAME observed
 *   signal set is `ambiguous_tie_observed`; a single top score is
 *   `single_top_candidate_observed` — an observation of the candidate
 *   list shape, never a confirmation;
 * - `unrelatednessConcluded` stays FIXED `false` and the same
 *   `unassessed` tuple (same_event/truth/source_independence) rides
 *   verbatim — nothing here ever concludes "definitely unrelated" or
 *   "same event".
 *
 * WHAT THE REPORT NEVER CLAIMS: a merge, a duplicate marking, a
 * supersede, an evidence-stance change, a confidence/trust raise, a
 * same-event proof, truth verification, or any path to
 * validation/approval/publication. Correlated signals are never counted
 * as independent confirmations (the encoding is a set — duplicates
 * collapse). Discovery truncation/overflow/coverage limits are preserved
 * verbatim; candidate data was NOT re-fetched or re-validated.
 *
 * The typed reader (R1.12.1 lesson applied from birth) validates the REAL
 * v1 invariants — INCLUDING cross-validation against BOTH siblings (the
 * discovery AND the assessment of the same document: same story/snapshot/
 * observation, entries 1:1 in the same deterministic order, verdicts and
 * scores and outcome/resolution/topScore re-derived from the sibling's
 * matched signals) — before surfacing `candidate_matching_v1`. A payload
 * that merely CLAIMS the version is `malformed`, never a current result.
 * The reader is a shape/invariant validator — NOT authenticity, NOT
 * semantic support.
 */

import {
  CANDIDATE_DISCOVERY_COVERAGE,
  readCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
  type CandidateSignalKind,
} from './candidate-discovery';
import {
  assessCandidateSignals,
  readCandidateAssessmentReport,
  type CandidateAssessmentReport,
  type CandidateAssessmentVerdict,
} from './candidate-assessment';

/** Report schema version — bump ONLY with a documented contract change. */
export const CANDIDATE_MATCHING_VERSION = 1 as const;

/** The index namespace the underlying discovery lookups are scoped to. */
export const CANDIDATE_MATCHING_INDEX_VERSION = 'sc1' as const;

/** Fixed basis label — the matching is a pure view of discovery v1 + assessment v1. */
export const CANDIDATE_MATCHING_BASIS =
  'candidate_discovery_v1_and_assessment_v1_at_lookup_moment' as const;

/**
 * Fixed signal weights — the ONLY input of the score. Chosen as 1/4/8 so
 * that every distinct observed-signal subset has a UNIQUE sum (subset-sum
 * injectivity): the score adds NO information beyond the observed signal
 * set, and equal scores imply identical observed sets. The strength order
 * mirrors the assessment verdict precedence: the versioned content
 * composite (content_hash) dominates, the stored URL value is next, and
 * the weak limited-normalization title key is smallest. Any weight change
 * is a documented contract change (version bump).
 */
export const CANDIDATE_MATCHING_SIGNAL_WEIGHTS: Readonly<Record<CandidateSignalKind, number>> = {
  url: 4,
  content_hash: 8,
  title_key: 1,
};

/** The documented maximum score (sum of all weights) — tested bound. */
export const CANDIDATE_MATCHING_MAX_SCORE: number =
  CANDIDATE_MATCHING_SIGNAL_WEIGHTS.url +
  CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash +
  CANDIDATE_MATCHING_SIGNAL_WEIGHTS.title_key;

/** Fixed limitation labels (order is part of the deterministic output). */
export const CANDIDATE_MATCHING_LIMITATIONS = [
  'candidate_only_not_merge',
  'not_truth_verification',
  'not_same_event_proof',
  'score_is_observation_set_encoding_not_confidence',
  'score_never_compared_across_reports',
  'no_threshold_no_acceptance',
  'identical_content_relation_is_reuse_locator_only',
  'similar_signals_never_same_news',
  'discovery_data_not_refetched_or_validated',
  'title_signal_is_weak',
] as const;

/** Fixed unassessed tuple — what this report NEVER judges. */
export const CANDIDATE_MATCHING_UNASSESSED = [
  'same_event',
  'truth',
  'source_independence',
] as const;

/** The report-level outcome: identical-content locator vs similar signals. */
export type CandidateMatchingOutcome =
  | 'no_candidates_observed'
  | 'identical_content_relation_observed'
  | 'similar_signals_only_observed';

/** The report-level resolution: ambiguity and coverage honesty. */
export type CandidateMatchingResolution =
  | 'no_candidate_to_resolve'
  | 'single_top_candidate_observed'
  | 'ambiguous_tie_observed'
  | 'unresolvable_incomplete_coverage';

/** One matched candidate: a minimal, non-contradictory projection. */
export interface CandidateMatchingEntry {
  /** The candidate story (same value and order as the sibling discovery). */
  readonly storyId: string;
  /** The deterministic classification of the observed signals (mirrored). */
  readonly verdict: CandidateAssessmentVerdict;
  /** The canonical set-encoding score of the observed signals (derived). */
  readonly score: number;
}

/** The versioned, deterministic report stored with the draft. */
export interface CandidateMatchingReport {
  readonly matchingVersion: typeof CANDIDATE_MATCHING_VERSION;
  /** Fixed basis label — what this report is derived from (and only that). */
  readonly basis: typeof CANDIDATE_MATCHING_BASIS;
  readonly indexVersion: typeof CANDIDATE_MATCHING_INDEX_VERSION;
  /** Mirrors both siblings (cross-validated by the reader). */
  readonly storyId: string;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** Mirrors the sibling discovery observation — never a stronger claim. */
  readonly observation: 'no_candidates_observed' | 'candidates_observed';
  /** One entry per sibling candidate, SAME deterministic ascending order. */
  readonly entries: readonly CandidateMatchingEntry[];
  /** Report-level identical-vs-similar classification (see the type). */
  readonly outcome: CandidateMatchingOutcome;
  /** Report-level ambiguity/coverage honesty (see the type). */
  readonly resolution: CandidateMatchingResolution;
  /** Highest observed score, or null when nothing was observed. */
  readonly topScoreObserved: number | null;
  readonly counts: {
    /** Matched candidates (= entries.length = sibling candidatesReported). */
    readonly matched: number;
  };
  /** FIXED `false` — this report never concludes "definitely unrelated". */
  readonly unrelatednessConcluded: false;
  /** The discovery coverage/truncation limits, PRESERVED verbatim. */
  readonly discoveryLimits: {
    readonly candidatesTruncated: boolean;
    readonly overflowObserved: boolean;
    readonly maxCandidates: typeof CANDIDATE_DISCOVERY_COVERAGE.maxCandidates;
    readonly indexedScope: 'index_version_sc1_only';
    readonly historicalBackfill: false;
  };
  readonly limitations: readonly string[];
  readonly unassessed: readonly string[];
}

/**
 * The canonical set-encoding score for one candidate's observed signal
 * kinds (deduplicated). PURE and TOTAL over non-empty inputs; an empty
 * set is a typed error (a candidate always carries at least one matched
 * signal — the discovery reader enforces it).
 */
export function scoreCandidateSignals(kinds: readonly CandidateSignalKind[]): number {
  const unique = [...new Set(kinds)];
  if (unique.length === 0) {
    throw new Error('candidate_matching_requires_at_least_one_signal');
  }
  return unique.reduce((sum, kind) => sum + CANDIDATE_MATCHING_SIGNAL_WEIGHTS[kind], 0);
}

/** The deterministic report-level outcome for the assessed entries. */
export function classifyMatchingOutcome(
  entries: readonly CandidateMatchingEntry[],
): CandidateMatchingOutcome {
  if (entries.length === 0) {
    return 'no_candidates_observed';
  }
  return entries.some((entry) => entry.verdict === 'full_content_equality_observed')
    ? 'identical_content_relation_observed'
    : 'similar_signals_only_observed';
}

/**
 * The deterministic report-level resolution. Precedence (documented,
 * tested): nothing observed → nothing to resolve; incomplete coverage
 * (probe overflow OR report truncation) → unresolvable; a tie at the top
 * score → ambiguous; otherwise a single top candidate. NONE of these
 * labels ever confirms a best match — they describe the observed list
 * shape only.
 */
export function classifyMatchingResolution(input: {
  readonly candidatesTruncated: boolean;
  readonly overflowObserved: boolean;
  readonly entries: readonly CandidateMatchingEntry[];
}): CandidateMatchingResolution {
  if (input.entries.length === 0) {
    return 'no_candidate_to_resolve';
  }
  if (input.candidatesTruncated || input.overflowObserved) {
    return 'unresolvable_incomplete_coverage';
  }
  const topScore = Math.max(...input.entries.map((entry) => entry.score));
  const topCount = input.entries.filter((entry) => entry.score === topScore).length;
  return topCount >= 2 ? 'ambiguous_tie_observed' : 'single_top_candidate_observed';
}

function matchingBasisMismatch(): Error {
  return new Error('candidate_matching_basis_mismatch');
}

/**
 * Build the versioned matching report from the SAME draft's discovery +
 * assessment reports. TOTAL and DETERMINISTIC: same input → byte-identical
 * output (fixed field order, inherited candidate order, no timestamps, no
 * randomness). The builder reads NOTHING but the two sibling reports —
 * there is no text comparison, no re-fetch, and no new signal anywhere.
 * The assessment input is cross-checked to mirror its own discovery
 * (a mismatch is a typed builder error, never a silently accepted basis).
 */
export function buildCandidateMatchingReport(input: {
  readonly discovery: CandidateDiscoveryReport;
  readonly assessment: CandidateAssessmentReport;
}): CandidateMatchingReport {
  const discovery = input.discovery;
  const assessment = input.assessment;
  if (
    assessment.storyId !== discovery.storyId ||
    assessment.snapshot.sourceItemId !== discovery.snapshot.sourceItemId ||
    assessment.snapshot.contentHash !== discovery.snapshot.contentHash ||
    assessment.observation !== discovery.observation ||
    assessment.entries.length !== discovery.candidates.length
  ) {
    throw matchingBasisMismatch();
  }
  const entries: CandidateMatchingEntry[] = discovery.candidates.map((candidate) => {
    const kinds = candidate.matchedSignals.map((signal) => signal.kind);
    const verdict = assessCandidateSignals(kinds);
    const mirrored = assessment.entries.find((entry) => entry.storyId === candidate.storyId);
    if (mirrored === undefined || mirrored.verdict !== verdict) {
      throw matchingBasisMismatch();
    }
    return { storyId: candidate.storyId, verdict, score: scoreCandidateSignals(kinds) };
  });
  const resolution = classifyMatchingResolution({
    candidatesTruncated: discovery.candidatesTruncated,
    overflowObserved: discovery.lookup.overflowObserved,
    entries,
  });
  return {
    matchingVersion: CANDIDATE_MATCHING_VERSION,
    basis: CANDIDATE_MATCHING_BASIS,
    indexVersion: CANDIDATE_MATCHING_INDEX_VERSION,
    storyId: discovery.storyId,
    snapshot: {
      sourceItemId: discovery.snapshot.sourceItemId,
      contentHash: discovery.snapshot.contentHash,
    },
    observation: discovery.observation,
    entries,
    outcome: classifyMatchingOutcome(entries),
    resolution,
    topScoreObserved: entries.length > 0 ? Math.max(...entries.map((entry) => entry.score)) : null,
    counts: {
      matched: entries.length,
    },
    unrelatednessConcluded: false,
    discoveryLimits: {
      candidatesTruncated: discovery.candidatesTruncated,
      overflowObserved: discovery.lookup.overflowObserved,
      maxCandidates: CANDIDATE_DISCOVERY_COVERAGE.maxCandidates,
      indexedScope: CANDIDATE_DISCOVERY_COVERAGE.indexedScope,
      historicalBackfill: CANDIDATE_DISCOVERY_COVERAGE.historicalBackfill,
    },
    limitations: CANDIDATE_MATCHING_LIMITATIONS,
    unassessed: CANDIDATE_MATCHING_UNASSESSED,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — payloads that merely claim the version are malformed,
// and a matching report is ONLY valid next to BOTH siblings it derives from.
// ---------------------------------------------------------------------------

export type CandidateMatchingRead =
  | { readonly kind: 'candidate_matching_v1'; readonly report: CandidateMatchingReport }
  /** A pre-5C-4 draft (no matching payload). Honest absence — no backfill. */
  | { readonly kind: 'absent' }
  /** A matching-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly matchingVersion: unknown }
  /** Not a matching payload at all — including one that violates v1 or
   *  lacks the valid sibling discovery AND assessment to derive from. */
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
const OUTCOMES: ReadonlySet<string> = new Set([
  'no_candidates_observed',
  'identical_content_relation_observed',
  'similar_signals_only_observed',
]);
const RESOLUTIONS: ReadonlySet<string> = new Set([
  'no_candidate_to_resolve',
  'single_top_candidate_observed',
  'ambiguous_tie_observed',
  'unresolvable_incomplete_coverage',
]);

/**
 * Read the matching payload from a PARSED `drafts.document_json` value.
 * Consumers must treat `absent`/`unsupported_version`/`malformed` as "no
 * current matching result" — none of them validates anything, and NONE of
 * them ever means "unrelated" or "same news".
 */
export function readCandidateMatchingReport(document: unknown): CandidateMatchingRead {
  if (typeof document !== 'object' || document === null) {
    return { kind: 'malformed' };
  }
  const matching = (document as Record<string, unknown>)['candidateMatching'];
  if (matching === undefined) {
    return { kind: 'absent' };
  }
  if (typeof matching !== 'object' || matching === null) {
    return { kind: 'malformed' };
  }
  const m = matching as Record<string, unknown>;
  if (m['matchingVersion'] !== CANDIDATE_MATCHING_VERSION) {
    return { kind: 'unsupported_version', matchingVersion: m['matchingVersion'] };
  }

  // ---- Sibling basis: a v1 matching report WITHOUT BOTH valid siblings is
  //      not a current result (a standalone copy could contradict its own
  //      basis — the assessment reader enforces the discovery sibling, and
  //      the matching reader adds the assessment sibling).
  const discoveryRead = readCandidateDiscoveryReport(document);
  if (discoveryRead.kind !== 'candidate_discovery_v1') {
    return { kind: 'malformed' };
  }
  const discovery = discoveryRead.report;
  const assessmentRead = readCandidateAssessmentReport(document);
  if (assessmentRead.kind !== 'candidate_assessment_v1') {
    return { kind: 'malformed' };
  }
  const assessment = assessmentRead.report;

  const snapshot = m['snapshot'];
  const discoveryLimits = m['discoveryLimits'];
  const counts = m['counts'];
  const entries = m['entries'];
  if (
    m['basis'] !== CANDIDATE_MATCHING_BASIS ||
    m['indexVersion'] !== CANDIDATE_MATCHING_INDEX_VERSION ||
    typeof m['storyId'] !== 'string' ||
    m['storyId'].length === 0 ||
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    typeof m['observation'] !== 'string' ||
    !OBSERVATIONS.has(m['observation']) ||
    typeof m['outcome'] !== 'string' ||
    !OUTCOMES.has(m['outcome']) ||
    typeof m['resolution'] !== 'string' ||
    !RESOLUTIONS.has(m['resolution']) ||
    (m['topScoreObserved'] !== null && !isNonNegativeInteger(m['topScoreObserved'])) ||
    m['unrelatednessConcluded'] !== false ||
    !Array.isArray(entries) ||
    typeof counts !== 'object' ||
    counts === null ||
    typeof discoveryLimits !== 'object' ||
    discoveryLimits === null ||
    !Array.isArray(m['limitations']) ||
    !isStringArray(m['limitations']) ||
    !Array.isArray(m['unassessed']) ||
    !isStringArray(m['unassessed'])
  ) {
    return { kind: 'malformed' };
  }

  // ---- Limitations/unassessed: exactly the fixed v1 sets, each once.
  const fixedLimitations = CANDIDATE_MATCHING_LIMITATIONS as readonly string[];
  const limitations = m['limitations'] as readonly string[];
  const unassessed = m['unassessed'] as readonly string[];
  const fixedUnassessed = CANDIDATE_MATCHING_UNASSESSED as readonly string[];
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
    limits['candidatesTruncated'] !== discovery.candidatesTruncated ||
    limits['overflowObserved'] !== discovery.lookup.overflowObserved ||
    limits['maxCandidates'] !== CANDIDATE_DISCOVERY_COVERAGE.maxCandidates ||
    limits['indexedScope'] !== CANDIDATE_DISCOVERY_COVERAGE.indexedScope ||
    limits['historicalBackfill'] !== false
  ) {
    return { kind: 'malformed' };
  }

  // ---- Identity mirrors: story, snapshot, observation (BOTH siblings).
  if (
    m['storyId'] !== discovery.storyId ||
    assessment.storyId !== discovery.storyId ||
    (snapshot as Record<string, unknown>)['sourceItemId'] !== discovery.snapshot.sourceItemId ||
    (snapshot as Record<string, unknown>)['contentHash'] !== discovery.snapshot.contentHash ||
    m['observation'] !== discovery.observation
  ) {
    return { kind: 'malformed' };
  }

  // ---- Entries: EXACTLY one per sibling candidate, same order, verdict
  //      mirrored from the sibling assessment AND re-derived from the
  //      sibling discovery's matched signals, score re-derived.
  if (entries.length !== discovery.candidates.length) {
    return { kind: 'malformed' };
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const candidate = discovery.candidates[index]!;
    const assessmentEntry = assessment.entries[index]!;
    if (typeof entry !== 'object' || entry === null) {
      return { kind: 'malformed' };
    }
    const record = entry as Record<string, unknown>;
    const verdict = record['verdict'];
    const score = record['score'];
    if (
      record['storyId'] !== candidate.storyId ||
      typeof verdict !== 'string' ||
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > CANDIDATE_MATCHING_MAX_SCORE
    ) {
      return { kind: 'malformed' };
    }
    const kinds = candidate.matchedSignals.map((signal) => signal.kind);
    if (verdict !== assessCandidateSignals(kinds) || verdict !== assessmentEntry.verdict) {
      return { kind: 'malformed' };
    }
    if (score !== scoreCandidateSignals(kinds)) {
      return { kind: 'malformed' };
    }
  }
  const typedEntries = entries as readonly CandidateMatchingEntry[];

  // ---- Derived values: outcome, resolution and top score are re-derived
  //      from the sibling-backed entries — a stored lie is malformed.
  if (
    m['outcome'] !== classifyMatchingOutcome(typedEntries) ||
    m['resolution'] !==
      classifyMatchingResolution({
        candidatesTruncated: discovery.candidatesTruncated,
        overflowObserved: discovery.lookup.overflowObserved,
        entries: typedEntries,
      })
  ) {
    return { kind: 'malformed' };
  }
  const expectedTop =
    typedEntries.length > 0 ? Math.max(...typedEntries.map((entry) => entry.score)) : null;
  if (m['topScoreObserved'] !== expectedTop) {
    return { kind: 'malformed' };
  }

  // ---- Counts: the single count EXACTLY describes the payload.
  const matched = (counts as Record<string, unknown>)['matched'];
  if (
    !isNonNegativeInteger(matched) ||
    (matched as number) !== typedEntries.length ||
    (matched as number) !== discovery.counts.candidatesReported
  ) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'candidate_matching_v1',
    report: matching as unknown as CandidateMatchingReport,
  };
}
