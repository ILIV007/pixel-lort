/**
 * Versioned candidate-discovery report (Phase 5C-1 — R1.13): the HONEST,
 * DETERMINISTIC record of ONE limited lookup moment, stored inside
 * `drafts.document_json` next to `evidenceGuard` by the SAME fenced atomic
 * commit. NO SQL, NO network, NO model call, NO clock.
 *
 * WHAT THE REPORT IS:
 * - a PROPOSAL of previously-indexed stories whose fingerprints matched at
 *   the lookup moment — `candidateStoryId`s with the signals that matched
 *   and stable reason codes;
 * - explicitly `candidate_only_not_merge`: no merge, no duplicate marking,
 *   no supersede, no evidence-stance change, no confidence/trust raise,
 *   no truth verification, no auto-approval path;
 * - bounded and honest about coverage: at most 3 lookups (one per present
 *   signal), each probing at most 9 rows so overflow is DETECTABLE, and at
 *   most 8 unique candidates reported with an explicit truncation flag.
 *
 * WHAT THE REPORT NEVER CLAIMS:
 * - "all candidates" or "the definitive best candidate" when a lookup hit
 *   its limit — overflow is recorded, not hidden;
 * - `unique_story` or `no_related_story` when nothing was found — the
 *   honest observation is `no_candidates_observed`;
 * - global snapshot semantics: the report is the view at the LOOKUP
 *   MOMENT. Two stories stored simultaneously may not see each other —
 *   exactly-once discovery is NOT claimed (`lookup_moment_visibility`);
 * - coverage of historical stories: only `sc1`-indexed stories are in
   scope; historical stories are NOT backfilled.
 *
 * The typed reader (R1.12.1 lesson applied from birth) validates the REAL
 * v1 invariants before surfacing `candidate_discovery_v1` — a payload that
 * merely CLAIMS the version is `malformed`, never a current result.
 */

/**
 * Report schema version — bump ONLY with a documented contract change.
 */
export const CANDIDATE_DISCOVERY_VERSION = 1 as const;

/** The index namespace this report's lookups are scoped to. */
export const CANDIDATE_DISCOVERY_INDEX_VERSION = 'sc1' as const;

/** Per-lookup row probe (mirrors the fingerprint contract; tested). */
export const CANDIDATE_DISCOVERY_MAX_ROWS_PER_LOOKUP = 9;

/** Maximum unique candidates one report carries (explicit, tested cap). */
export const CANDIDATE_DISCOVERY_MAX_CANDIDATES = 8;

/** Matched-signal kinds of a candidate (same universe as the index). */
export type CandidateSignalKind = 'url' | 'content_hash' | 'title_key';

/** Stable reason codes — one per signal kind, never remapped. */
export const CANDIDATE_SIGNAL_REASON_CODES: Readonly<Record<CandidateSignalKind, string>> = {
  url: 'url_fingerprint_match',
  content_hash: 'content_hash_fingerprint_match',
  title_key: 'title_key_fingerprint_match',
};

/** Fixed limitation labels (order is part of the deterministic output). */
export const CANDIDATE_DISCOVERY_LIMITATIONS = [
  'candidate_only_not_merge',
  'not_truth_verification',
  'lookup_moment_visibility',
  'title_signal_is_weak',
] as const;

/** Fixed coverage labels — the honest scope statement of every report. */
export const CANDIDATE_DISCOVERY_COVERAGE = {
  maxCandidates: CANDIDATE_DISCOVERY_MAX_CANDIDATES,
  indexedScope: 'index_version_sc1_only',
  historicalBackfill: false,
} as const;

export interface CandidateMatchedSignal {
  readonly kind: CandidateSignalKind;
  readonly reasonCode: string;
}

export interface CandidateDiscoveryCandidate {
  readonly storyId: string;
  readonly matchedSignals: readonly CandidateMatchedSignal[];
}

/** The versioned, deterministic report stored with the draft. */
export interface CandidateDiscoveryReport {
  readonly discoveryVersion: typeof CANDIDATE_DISCOVERY_VERSION;
  readonly indexVersion: typeof CANDIDATE_DISCOVERY_INDEX_VERSION;
  readonly observation: 'no_candidates_observed' | 'candidates_observed';
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The CURRENT story — always excluded from the candidate list. */
  readonly storyId: string;
  readonly lookup: {
    /** The signals actually looked up, in signal-priority order. */
    readonly signals: readonly CandidateSignalKind[];
    readonly maxRowsPerLookup: typeof CANDIDATE_DISCOVERY_MAX_ROWS_PER_LOOKUP;
    /** ANY of the lookups returned its full probe limit (≥9 rows seen). */
    readonly overflowObserved: boolean;
  };
  /** Deterministic: ascending storyId, explicit tie-break, self excluded. */
  readonly candidates: readonly CandidateDiscoveryCandidate[];
  readonly counts: {
    readonly lookupsPerformed: number;
    /** Unique candidates OBSERVED before the report cap. */
    readonly uniqueCandidatesObserved: number;
    /** Candidates actually carried (= candidates.length). */
    readonly candidatesReported: number;
  };
  /** True iff unique observed exceeded the cap (the report is truncated). */
  readonly candidatesTruncated: boolean;
  readonly coverage: {
    readonly maxCandidates: typeof CANDIDATE_DISCOVERY_MAX_CANDIDATES;
    readonly indexedScope: 'index_version_sc1_only';
    readonly historicalBackfill: false;
  };
  readonly limitations: readonly string[];
}

/** One performed lookup's outcome (pure input to the builder). */
export interface CandidateLookupOutcome {
  readonly kind: CandidateSignalKind;
  /** True iff the lookup returned its FULL probe limit of rows. */
  readonly overflow: boolean;
}

/** One raw per-signal match (pre-merge; the builder deduplicates). */
export interface CandidateRawMatch {
  readonly kind: CandidateSignalKind;
  readonly storyId: string;
}

export interface CandidateDiscoveryInput {
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The CURRENT story — excluded from candidates, recorded for honesty. */
  readonly storyId: string;
  /** The lookups actually performed, in signal-priority order (≤3). */
  readonly lookups: readonly CandidateLookupOutcome[];
  /** Raw per-signal matches (may contain duplicates across signals). */
  readonly matches: readonly CandidateRawMatch[];
}

/**
 * Build the versioned report. TOTAL and DETERMINISTIC: same input →
 * byte-identical output (fixed field order, ascending storyId sort,
 * priority-ordered signals, no timestamps, no randomness).
 */
export function buildCandidateDiscoveryReport(
  input: CandidateDiscoveryInput,
): CandidateDiscoveryReport {
  const signals = input.lookups.map((lookup) => lookup.kind);
  const overflowObserved = input.lookups.some((lookup) => lookup.overflow);

  // ---- Merge raw matches per candidate story: deduplicated signals in
  //      signal-priority order (display order ONLY — never confidence).
  const priority = new Map<CandidateSignalKind, number>([
    ['url', 0],
    ['content_hash', 1],
    ['title_key', 2],
  ]);
  const byStory = new Map<string, Map<CandidateSignalKind, CandidateMatchedSignal>>();
  for (const match of input.matches) {
    if (match.storyId === input.storyId) {
      continue; // the current story is NEVER its own candidate
    }
    const signals_ =
      byStory.get(match.storyId) ?? new Map<CandidateSignalKind, CandidateMatchedSignal>();
    if (!signals_.has(match.kind)) {
      signals_.set(match.kind, {
        kind: match.kind,
        reasonCode: CANDIDATE_SIGNAL_REASON_CODES[match.kind],
      });
    }
    byStory.set(match.storyId, signals_);
  }
  const uniqueCandidatesObserved = byStory.size;
  const allCandidates = [...byStory.entries()]
    .map(([storyId, signalMap]) => ({
      storyId,
      matchedSignals: [...signalMap.values()].sort(
        (a, b) => (priority.get(a.kind) ?? 0) - (priority.get(b.kind) ?? 0),
      ),
    }))
    // Deterministic order: ascending storyId — an explicit, stable
    // tie-break; SQL row order is never relied upon.
    .sort((a, b) => (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0));
  const candidates = allCandidates.slice(0, CANDIDATE_DISCOVERY_MAX_CANDIDATES);
  const candidatesTruncated = uniqueCandidatesObserved > CANDIDATE_DISCOVERY_MAX_CANDIDATES;

  return {
    discoveryVersion: CANDIDATE_DISCOVERY_VERSION,
    indexVersion: CANDIDATE_DISCOVERY_INDEX_VERSION,
    observation: candidates.length > 0 ? 'candidates_observed' : 'no_candidates_observed',
    snapshot: {
      sourceItemId: input.snapshot.sourceItemId,
      contentHash: input.snapshot.contentHash,
    },
    storyId: input.storyId,
    lookup: {
      signals,
      maxRowsPerLookup: CANDIDATE_DISCOVERY_MAX_ROWS_PER_LOOKUP,
      overflowObserved,
    },
    candidates,
    counts: {
      lookupsPerformed: input.lookups.length,
      uniqueCandidatesObserved,
      candidatesReported: candidates.length,
    },
    candidatesTruncated,
    coverage: {
      maxCandidates: CANDIDATE_DISCOVERY_MAX_CANDIDATES,
      indexedScope: 'index_version_sc1_only',
      historicalBackfill: false,
    },
    limitations: CANDIDATE_DISCOVERY_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — payloads that merely claim the version are malformed.
// ---------------------------------------------------------------------------

export type CandidateDiscoveryRead =
  | { readonly kind: 'candidate_discovery_v1'; readonly report: CandidateDiscoveryReport }
  /** A pre-5C draft (no discovery payload). Honest absence — never a pass. */
  | { readonly kind: 'absent' }
  /** A discovery-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly discoveryVersion: unknown }
  /** Not a discovery payload at all — including one that violates v1. */
  | { readonly kind: 'malformed' };

const SIGNAL_KINDS: ReadonlySet<string> = new Set(['url', 'content_hash', 'title_key']);
const OBSERVATIONS: ReadonlySet<string> = new Set([
  'no_candidates_observed',
  'candidates_observed',
]);
const SIGNAL_ORDER: readonly CandidateSignalKind[] = ['url', 'content_hash', 'title_key'];

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The signals list contract: a duplicate-free subsequence of the fixed
 * priority order (url, content_hash, title_key) — deterministic output
 * shape, ≤3 entries, only kinds this round looks up.
 */
function signalsAreCanonicalOrder(
  values: readonly string[],
): values is readonly CandidateSignalKind[] {
  if (values.length > SIGNAL_ORDER.length || new Set(values).size !== values.length) {
    return false;
  }
  let cursor = 0;
  for (const value of values) {
    if (!SIGNAL_KINDS.has(value)) {
      return false;
    }
    const at = SIGNAL_ORDER.indexOf(value as CandidateSignalKind);
    if (at < cursor) {
      return false;
    }
    cursor = at + 1;
  }
  return true;
}

/**
 * Read the discovery payload from a PARSED `drafts.document_json` value.
 * Consumers must treat `absent`/`unsupported_version`/`malformed` as "no
 * current discovery result" — none of them validates anything.
 */
export function readCandidateDiscoveryReport(document: unknown): CandidateDiscoveryRead {
  if (typeof document !== 'object' || document === null) {
    return { kind: 'malformed' };
  }
  const discovery = (document as Record<string, unknown>)['candidateDiscovery'];
  if (discovery === undefined) {
    return { kind: 'absent' };
  }
  if (typeof discovery !== 'object' || discovery === null) {
    return { kind: 'malformed' };
  }
  const d = discovery as Record<string, unknown>;
  if (d['discoveryVersion'] !== CANDIDATE_DISCOVERY_VERSION) {
    return { kind: 'unsupported_version', discoveryVersion: d['discoveryVersion'] };
  }

  const snapshot = d['snapshot'];
  const lookup = d['lookup'];
  const counts = d['counts'];
  const coverage = d['coverage'];
  const limitations = d['limitations'];
  const observation = d['observation'];
  const candidates = d['candidates'];
  if (
    d['indexVersion'] !== CANDIDATE_DISCOVERY_INDEX_VERSION ||
    typeof observation !== 'string' ||
    !OBSERVATIONS.has(observation) ||
    typeof d['storyId'] !== 'string' ||
    d['storyId'].length === 0 ||
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    typeof lookup !== 'object' ||
    lookup === null ||
    !Array.isArray((lookup as Record<string, unknown>)['signals']) ||
    !isStringArray((lookup as Record<string, unknown>)['signals']) ||
    !signalsAreCanonicalOrder(
      (lookup as Record<string, unknown>)['signals'] as readonly string[],
    ) ||
    (lookup as Record<string, unknown>)['maxRowsPerLookup'] !==
      CANDIDATE_DISCOVERY_MAX_ROWS_PER_LOOKUP ||
    typeof (lookup as Record<string, unknown>)['overflowObserved'] !== 'boolean' ||
    !Array.isArray(candidates) ||
    typeof counts !== 'object' ||
    counts === null ||
    typeof coverage !== 'object' ||
    coverage === null ||
    !Array.isArray(limitations) ||
    !isStringArray(limitations)
  ) {
    return { kind: 'malformed' };
  }

  // ---- Coverage: the fixed, honest scope statement (removal = malformed).
  if (
    (coverage as Record<string, unknown>)['maxCandidates'] !== CANDIDATE_DISCOVERY_MAX_CANDIDATES ||
    (coverage as Record<string, unknown>)['indexedScope'] !== 'index_version_sc1_only' ||
    (coverage as Record<string, unknown>)['historicalBackfill'] !== false
  ) {
    return { kind: 'malformed' };
  }

  // ---- Limitations: exactly the fixed v1 label set, each once.
  const fixed = CANDIDATE_DISCOVERY_LIMITATIONS as readonly string[];
  if (
    limitations.length !== fixed.length ||
    new Set(limitations).size !== limitations.length ||
    !limitations.every((label) => fixed.includes(label))
  ) {
    return { kind: 'malformed' };
  }

  // ---- Candidates: deterministic ascending storyId (strict — duplicates
  //      and disorder are impossible from the builder), self excluded,
  //      signals deduplicated and consistent with the lookup scope.
  const storyId = d['storyId'] as string;
  const signals = (lookup as Record<string, unknown>)['signals'] as readonly CandidateSignalKind[];
  let previousStoryId: string | null = null;
  for (const candidate of candidates as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) {
      return { kind: 'malformed' };
    }
    const record = candidate as Record<string, unknown>;
    const candidateStoryId = record['storyId'];
    const matched = record['matchedSignals'];
    if (
      typeof candidateStoryId !== 'string' ||
      candidateStoryId.length === 0 ||
      candidateStoryId === storyId ||
      (previousStoryId !== null && !(previousStoryId < candidateStoryId)) ||
      !Array.isArray(matched) ||
      matched.length === 0
    ) {
      return { kind: 'malformed' };
    }
    previousStoryId = candidateStoryId;
    const seenKinds = new Set<string>();
    for (const signal of matched as unknown[]) {
      if (typeof signal !== 'object' || signal === null) {
        return { kind: 'malformed' };
      }
      const signalRecord = signal as Record<string, unknown>;
      const kind = signalRecord['kind'];
      const reasonCode = signalRecord['reasonCode'];
      if (
        typeof kind !== 'string' ||
        !SIGNAL_KINDS.has(kind) ||
        !signals.includes(kind as CandidateSignalKind) ||
        seenKinds.has(kind) ||
        reasonCode !== CANDIDATE_SIGNAL_REASON_CODES[kind as CandidateSignalKind]
      ) {
        return { kind: 'malformed' };
      }
      seenKinds.add(kind);
    }
  }

  // ---- Counts: non-negative integers that EXACTLY describe the payload.
  if (
    !isNonNegativeInteger((counts as Record<string, unknown>)['lookupsPerformed']) ||
    !isNonNegativeInteger((counts as Record<string, unknown>)['uniqueCandidatesObserved']) ||
    !isNonNegativeInteger((counts as Record<string, unknown>)['candidatesReported'])
  ) {
    return { kind: 'malformed' };
  }
  const countsRecord = counts as Record<string, number>;
  const lookupsPerformed = countsRecord['lookupsPerformed'] as number;
  const uniqueCandidatesObserved = countsRecord['uniqueCandidatesObserved'] as number;
  const candidatesReported = countsRecord['candidatesReported'] as number;
  const candidateList = candidates as readonly CandidateDiscoveryCandidate[];
  if (
    lookupsPerformed !== signals.length ||
    signals.length > SIGNAL_ORDER.length ||
    candidatesReported !== candidateList.length ||
    candidatesReported > CANDIDATE_DISCOVERY_MAX_CANDIDATES ||
    uniqueCandidatesObserved < candidatesReported
  ) {
    return { kind: 'malformed' };
  }

  // ---- Observation and truncation must match the payload they describe.
  const candidatesTruncated = d['candidatesTruncated'];
  if (
    typeof candidatesTruncated !== 'boolean' ||
    candidatesTruncated !== uniqueCandidatesObserved > CANDIDATE_DISCOVERY_MAX_CANDIDATES ||
    observation !== (candidateList.length > 0 ? 'candidates_observed' : 'no_candidates_observed')
  ) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'candidate_discovery_v1',
    report: discovery as unknown as CandidateDiscoveryReport,
  };
}
