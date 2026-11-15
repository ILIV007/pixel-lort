/**
 * Versioned candidate-ASSESSMENT report (Phase 5C-2 — R1.14): the HONEST,
 * DETERMINISTIC, CONSERVATIVE classification of what was ACTUALLY OBSERVED
 * about the relation of a draft to the candidates its OWN discovery
 * proposed. NO SQL, NO network, NO SDK, NO model call, NO clock — a PURE
 * derivation of the `candidateDiscovery` report of the SAME draft, stored
 * INSIDE `drafts.document_json` next to it by the SAME fenced atomic
 * commit (zero new statements, zero extra execution calls).
 *
 * WHAT THE ASSESSMENT DISTINGUISHES (Posidon R1.14 §4 — and nothing else):
 * - `full_content_equality_observed` — ONLY the versioned `content_hash`
 *   fingerprint signal (the FULL title+body composition digest) is really
 *   shared. This is a TEXT-COMPOSITE observation: it is NOT truth
 *   verification, NOT a same-event proof, NOT source independence.
 * - `shared_url_observed` — the shared STORED URL value was observed.
 *   Only relation by the same stored value: NOT necessarily one event,
 *   NOT necessarily one content version.
 * - `shared_title_observed` — the weak normalized-title signal was
 *   observed, under the ONE limited normalization. NO fuzzy matching, no
 *   translation, no digit conversion.
 * - `multiple_signals_observed` — several signals matched WITHOUT the
 *   content composite (e.g. url + title_key). ALL real reasons are kept;
 *   correlated signals are NEVER counted as independent confirmations.
 * - Unassessed — no candidate, an invalid/foreign discovery payload, or
 *   missing information NEVER becomes "definitely unrelated".
 *
 * VERDICT PRECEDENCE (deterministic, documented, tested): a shared
 * content_hash decides `full_content_equality_observed` (the strongest
 * available observation) while ALL matched reasons stay listed;
 * `multiple_signals_observed` covers ≥2 signals without it; a single
 * url/title_key maps to its own label. The verdict is a CLASSIFICATION of
 * observed signals — NEVER a confidence, probability, score, or threshold.
 *
 * WHAT THE REPORT EXPLICITLY DECLARES: its basis is the discovery signals
 * at the LOOKUP moment; candidate data was NOT re-fetched or re-validated;
 * same-event and truth are NOT assessed; NO merge or auto-confirmation is
 * allowed; discovery truncation/coverage limits are preserved verbatim;
 * `unrelatednessConcluded` is FIXED `false` — absence of shared signals is
 * never a negative proof.
 *
 * The typed reader (R1.12.1 lesson applied from birth) validates the REAL
 * v1 invariants — including CROSS-validation against the sibling
 * `candidateDiscovery` report of the same document (same story/snapshot,
 * same candidates in the same order, verdicts re-derived from the
 * sibling's matched signals) — before surfacing
 * `candidate_assessment_v1`. A payload that merely CLAIMS the version is
 * `malformed`, never a current result. The reader is a shape/invariant
 * validator — NOT authenticity, NOT semantic support.
 */

import {
  CANDIDATE_DISCOVERY_COVERAGE,
  readCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
  type CandidateSignalKind,
} from './candidate-discovery';

/** Report schema version — bump ONLY with a documented contract change. */
export const CANDIDATE_ASSESSMENT_VERSION = 1 as const;

/** The index namespace the underlying discovery lookups are scoped to. */
export const CANDIDATE_ASSESSMENT_INDEX_VERSION = 'sc1' as const;

/** Fixed basis label — the assessment is a pure view of discovery v1. */
export const CANDIDATE_ASSESSMENT_BASIS =
  'candidate_discovery_v1_signals_at_lookup_moment' as const;

/** The verdict universe (fixed; additive-only in possible future versions). */
export const CANDIDATE_ASSESSMENT_VERDICTS = [
  'full_content_equality_observed',
  'shared_url_observed',
  'shared_title_observed',
  'multiple_signals_observed',
] as const;
export type CandidateAssessmentVerdict = (typeof CANDIDATE_ASSESSMENT_VERDICTS)[number];

/** Fixed limitation labels (order is part of the deterministic output). */
export const CANDIDATE_ASSESSMENT_LIMITATIONS = [
  'candidate_only_not_merge',
  'not_truth_verification',
  'not_same_event_proof',
  'not_source_independence_proof',
  'signals_not_independent_confirmations',
  'discovery_data_not_refetched_or_validated',
  'title_signal_is_weak',
] as const;

/** Fixed unassessed tuple — what this assessment NEVER judges. */
export const CANDIDATE_ASSESSMENT_UNASSESSED = [
  'same_event',
  'truth',
  'source_independence',
] as const;

/**
 * The deterministic verdict for one candidate's observed signal kinds
 * (deduplicated, priority-ordered — exactly the sibling discovery's
 * matchedSignals kinds). PURE and TOTAL.
 */
export function assessCandidateSignals(
  kinds: readonly CandidateSignalKind[],
): CandidateAssessmentVerdict {
  const unique = new Set(kinds);
  if (unique.size === 0) {
    // Unreachable from the builder (a discovery candidate always carries
    // at least one matched signal — its reader enforces it); kept TOTAL.
    throw new Error('candidate_assessment_requires_at_least_one_signal');
  }
  if (unique.has('content_hash')) {
    // The versioned title+body composite digest is shared — the strongest
    // observation available. ALL other shared signals stay in the reasons.
    return 'full_content_equality_observed';
  }
  if (unique.size >= 2) {
    return 'multiple_signals_observed';
  }
  return unique.has('url') ? 'shared_url_observed' : 'shared_title_observed';
}

/** One assessed candidate: a minimal, non-contradictory projection. */
export interface CandidateAssessmentEntry {
  /** The candidate story (same value and order as the sibling discovery). */
  readonly storyId: string;
  /** The deterministic classification of the observed signals. */
  readonly verdict: CandidateAssessmentVerdict;
  /** ALL real reason codes of the observed signals, in their order. */
  readonly verdictReasons: readonly string[];
}

/** The versioned, deterministic report stored with the draft. */
export interface CandidateAssessmentReport {
  readonly assessmentVersion: typeof CANDIDATE_ASSESSMENT_VERSION;
  /** Fixed basis label — what this report is derived from (and only that). */
  readonly basis: typeof CANDIDATE_ASSESSMENT_BASIS;
  readonly indexVersion: typeof CANDIDATE_ASSESSMENT_INDEX_VERSION;
  /** Mirrors the sibling discovery (cross-validated by the reader). */
  readonly storyId: string;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** Mirrors the sibling discovery observation — never a stronger claim. */
  readonly observation: 'no_candidates_observed' | 'candidates_observed';
  /** One entry per sibling candidate, SAME deterministic ascending order. */
  readonly entries: readonly CandidateAssessmentEntry[];
  readonly counts: {
    /** Assessed candidates (= entries.length = sibling candidatesReported). */
    readonly assessed: number;
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
 * Build the versioned assessment from the SAME draft's discovery report.
 * TOTAL and DETERMINISTIC: same discovery → byte-identical assessment
 * (fixed field order, inherited candidate order, no timestamps, no
 * randomness). The builder reads NOTHING but the discovery report — there
 * is no text comparison, no re-fetch, and no new signal anywhere.
 */
export function buildCandidateAssessmentReport(input: {
  readonly discovery: CandidateDiscoveryReport;
}): CandidateAssessmentReport {
  const discovery = input.discovery;
  return {
    assessmentVersion: CANDIDATE_ASSESSMENT_VERSION,
    basis: CANDIDATE_ASSESSMENT_BASIS,
    indexVersion: CANDIDATE_ASSESSMENT_INDEX_VERSION,
    storyId: discovery.storyId,
    snapshot: {
      sourceItemId: discovery.snapshot.sourceItemId,
      contentHash: discovery.snapshot.contentHash,
    },
    observation: discovery.observation,
    entries: discovery.candidates.map((candidate) => ({
      storyId: candidate.storyId,
      verdict: assessCandidateSignals(candidate.matchedSignals.map((signal) => signal.kind)),
      verdictReasons: candidate.matchedSignals.map((signal) => signal.reasonCode),
    })),
    counts: {
      assessed: discovery.candidates.length,
    },
    unrelatednessConcluded: false,
    discoveryLimits: {
      candidatesTruncated: discovery.candidatesTruncated,
      overflowObserved: discovery.lookup.overflowObserved,
      maxCandidates: CANDIDATE_DISCOVERY_COVERAGE.maxCandidates,
      indexedScope: CANDIDATE_DISCOVERY_COVERAGE.indexedScope,
      historicalBackfill: CANDIDATE_DISCOVERY_COVERAGE.historicalBackfill,
    },
    limitations: CANDIDATE_ASSESSMENT_LIMITATIONS,
    unassessed: CANDIDATE_ASSESSMENT_UNASSESSED,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — payloads that merely claim the version are malformed,
// and an assessment is ONLY valid next to the discovery it derives from.
// ---------------------------------------------------------------------------

export type CandidateAssessmentRead =
  | { readonly kind: 'candidate_assessment_v1'; readonly report: CandidateAssessmentReport }
  /** A pre-5C-2 draft (no assessment payload). Honest absence — no backfill. */
  | { readonly kind: 'absent' }
  /** An assessment-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly assessmentVersion: unknown }
  /** Not an assessment payload at all — including one that violates v1 or
   *  lacks a VALID sibling `candidateDiscovery` to derive from. */
  | { readonly kind: 'malformed' };

const OBSERVATIONS: ReadonlySet<string> = new Set([
  'no_candidates_observed',
  'candidates_observed',
]);
const VERDICTS: ReadonlySet<string> = new Set(CANDIDATE_ASSESSMENT_VERDICTS);

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

/**
 * Read the assessment payload from a PARSED `drafts.document_json` value.
 * Consumers must treat `absent`/`unsupported_version`/`malformed` as "no
 * current assessment result" — none of them validates anything, and NONE
 * of them ever means "unrelated".
 */
export function readCandidateAssessmentReport(document: unknown): CandidateAssessmentRead {
  if (typeof document !== 'object' || document === null) {
    return { kind: 'malformed' };
  }
  const assessment = (document as Record<string, unknown>)['candidateAssessment'];
  if (assessment === undefined) {
    return { kind: 'absent' };
  }
  if (typeof assessment !== 'object' || assessment === null) {
    return { kind: 'malformed' };
  }
  const a = assessment as Record<string, unknown>;
  if (a['assessmentVersion'] !== CANDIDATE_ASSESSMENT_VERSION) {
    return { kind: 'unsupported_version', assessmentVersion: a['assessmentVersion'] };
  }

  // ---- Sibling basis: a v1 assessment WITHOUT a valid v1 sibling
  //      discovery is not a current result (the assessment is a DERIVED
  //      view — a standalone copy could contradict its own basis).
  const sibling = readCandidateDiscoveryReport(document);
  if (sibling.kind !== 'candidate_discovery_v1') {
    return { kind: 'malformed' };
  }
  const discovery = sibling.report;

  const snapshot = a['snapshot'];
  const discoveryLimits = a['discoveryLimits'];
  const counts = a['counts'];
  const entries = a['entries'];
  if (
    a['basis'] !== CANDIDATE_ASSESSMENT_BASIS ||
    a['indexVersion'] !== CANDIDATE_ASSESSMENT_INDEX_VERSION ||
    typeof a['storyId'] !== 'string' ||
    a['storyId'].length === 0 ||
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    typeof a['observation'] !== 'string' ||
    !OBSERVATIONS.has(a['observation']) ||
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
  const fixedLimitations = CANDIDATE_ASSESSMENT_LIMITATIONS as readonly string[];
  const limitations = a['limitations'] as readonly string[];
  const unassessed = a['unassessed'] as readonly string[];
  const fixedUnassessed = CANDIDATE_ASSESSMENT_UNASSESSED as readonly string[];
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

  // ---- Identity mirrors: story, snapshot, observation.
  if (
    a['storyId'] !== discovery.storyId ||
    (snapshot as Record<string, unknown>)['sourceItemId'] !== discovery.snapshot.sourceItemId ||
    (snapshot as Record<string, unknown>)['contentHash'] !== discovery.snapshot.contentHash ||
    a['observation'] !== discovery.observation
  ) {
    return { kind: 'malformed' };
  }

  // ---- Entries: EXACTLY one per sibling candidate, same order, verdict
  //      re-derived from the sibling's matched signals, reasons equal.
  if (entries.length !== discovery.candidates.length) {
    return { kind: 'malformed' };
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const candidate = discovery.candidates[index]!;
    if (typeof entry !== 'object' || entry === null) {
      return { kind: 'malformed' };
    }
    const record = entry as Record<string, unknown>;
    const verdict = record['verdict'];
    const verdictReasons = record['verdictReasons'];
    if (
      record['storyId'] !== candidate.storyId ||
      typeof verdict !== 'string' ||
      !VERDICTS.has(verdict) ||
      !Array.isArray(verdictReasons) ||
      !isStringArray(verdictReasons)
    ) {
      return { kind: 'malformed' };
    }
    const observedKinds = candidate.matchedSignals.map((signal) => signal.kind);
    const observedReasons = candidate.matchedSignals.map((signal) => signal.reasonCode);
    if (
      verdict !== assessCandidateSignals(observedKinds) ||
      !sameStringSequence(verdictReasons as readonly string[], observedReasons)
    ) {
      return { kind: 'malformed' };
    }
  }

  // ---- Counts: the single count EXACTLY describes the payload.
  const assessed = (counts as Record<string, unknown>)['assessed'];
  if (
    !isNonNegativeInteger(assessed) ||
    (assessed as number) !== entries.length ||
    (assessed as number) !== discovery.counts.candidatesReported
  ) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'candidate_assessment_v1',
    report: assessment as unknown as CandidateAssessmentReport,
  };
}
