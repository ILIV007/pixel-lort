/**
 * Bounded event-relation candidate retrieval (Phase 5E-1 — R1.17, ADR-0045).
 * PURE, DETERMINISTIC, VERSIONED planning over the lookup outcomes —
 * NO SQL, NO network, NO model call, NO clock (the same offline purity as
 * the candidate discovery, the Evidence Guard and the mentions policy).
 *
 * WHAT THIS IS: the deterministic UNION of the existing fingerprint-based
 * discovery candidates (the `candidateDiscovery` report of THIS lookup
 * moment — zero new fingerprint probes) with candidates found through
 * SHARED RESOLVED ENTITIES (the R1.16 mentions resolution): two texts that
 * mention the same controlled entity are candidate-related EVEN WHEN their
 * texts are entirely different or translated. Every read is a bounded
 * indexed lookup the caller performed on
 * `idx_story_entities_entity(entity_id, story_id)` — never a full scan,
 * never an unbounded N+1, never a per-pair query.
 *
 * WHAT THIS NEVER CLAIMS:
 * - "the best candidate": entity selection is ascending entityId and the
 *   candidate order is ascending storyId — the smallest-ID tie-break is a
 *   COST CAP, never a semantic threshold and never a quality claim;
 * - completeness: overflow/unprobed entities/unevaluated candidates are
 *   RECORDED, never hidden — no candidate ≠ unrelated, and a normal
 * news item with no candidates still builds its own independent draft;
 * - a merge, a duplicate marker, or any truth claim — candidates are a
 *   PROPOSAL for the bounded pair evaluation, nothing more.
 */

/** Report schema version — bump ONLY with a documented contract change. */
export const EVENT_RELATION_CANDIDATES_VERSION = 1 as const;

/** The versioned retrieval/decision policy label recorded in every report. */
export const EVENT_RELATION_POLICY_VERSION = 'er1' as const;

/** Maximum distinct entity probes per job attempt (cost cap). */
export const EVENT_RELATION_MAX_ENTITY_PROBES = 3 as const;

/** Maximum rows probed per entity lookup (mirrors the fingerprint probe). */
export const EVENT_RELATION_MAX_ROWS_PER_PROBE = 9 as const;

/** Maximum unique candidates the union carries (explicit, tested cap). */
export const EVENT_RELATION_MAX_UNIQUE_CANDIDATES = 8 as const;

/** Maximum pairs evaluated in ONE job attempt (cost cap). */
export const EVENT_RELATION_MAX_PAIR_EVALUATIONS = 2 as const;

/** Deterministic origin labels — one per candidate source signal. */
export type EventRelationCandidateOrigin =
  | { readonly kind: 'fingerprint'; readonly signal: 'url' | 'content_hash' | 'title_key' }
  | { readonly kind: 'entity'; readonly entityId: string };

/** One union candidate: the candidate story + every origin observed. */
export interface EventRelationCandidate {
  readonly storyId: string;
  /** Deterministic origin order: fingerprint signals in priority order
   * (url → content_hash → title_key), then entity origins ascending. */
  readonly origins: readonly EventRelationCandidateOrigin[];
}

/** One performed entity probe's outcome (pure input to the planner). */
export interface EntityProbeOutcome {
  readonly entityId: string;
  readonly storyIds: readonly string[];
  /** True iff the lookup returned its FULL probe page (≥9 rows seen). */
  readonly overflow: boolean;
}

/** The deterministic retrieval plan/report for THIS lookup moment. */
export interface EventRelationCandidatesReport {
  readonly candidatesVersion: typeof EVENT_RELATION_CANDIDATES_VERSION;
  readonly policyVersion: typeof EVENT_RELATION_POLICY_VERSION;
  /** The CURRENT story — always excluded from the candidate list. */
  readonly storyId: string;
  readonly entityLookup: {
    /** The entities actually probed (≤3, ascending entityId). */
    readonly probed: readonly string[];
    /** Distinct resolved entities NOT probed because of the cap. */
    readonly unprobedCount: number;
    /** ANY probe returned its full page (≥9 rows seen). */
    readonly overflow: boolean;
  };
  /** Deterministic ascending storyId; self excluded; ≤8 unique. */
  readonly candidates: readonly EventRelationCandidate[];
  readonly counts: {
    readonly uniqueCandidatesObserved: number;
    readonly candidatesReported: number;
  };
  readonly candidatesTruncated: boolean;
  readonly caps: {
    readonly maxEntityProbes: typeof EVENT_RELATION_MAX_ENTITY_PROBES;
    readonly maxRowsPerProbe: typeof EVENT_RELATION_MAX_ROWS_PER_PROBE;
    readonly maxUniqueCandidates: typeof EVENT_RELATION_MAX_UNIQUE_CANDIDATES;
  };
}

const SIGNAL_PRIORITY: Readonly<Record<'url' | 'content_hash' | 'title_key', number>> = {
  url: 0,
  content_hash: 1,
  title_key: 2,
};

/**
 * Select which resolved entities to probe: ascending entityId, ≤3, smallest
 * ID tie-break (a COST CAP — never "the best entities"). Returns the honest
 * unprobed count.
 */
export function planEntityProbes(resolvedEntityIds: readonly string[]): {
  readonly selected: readonly string[];
  readonly unprobedCount: number;
} {
  const unique = [...new Set(resolvedEntityIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const selected = unique.slice(0, EVENT_RELATION_MAX_ENTITY_PROBES);
  return { selected, unprobedCount: unique.length - selected.length };
}

export interface EventRelationCandidatesInput {
  readonly storyId: string;
  /** The performed entity probes (ANY order — the planner sorts). */
  readonly entityProbes: readonly EntityProbeOutcome[];
  /** The honest unprobed count from `planEntityProbes` (the cap's cost
   * truth — recorded, never hidden). */
  readonly unprobedEntityCount: number;
  /** The fingerprint-discovery candidates of THIS lookup moment (already
   * self-excluded and capped by the discovery report). */
  readonly fingerprintCandidates: readonly {
    readonly storyId: string;
    readonly matchedSignalKinds: readonly ('url' | 'content_hash' | 'title_key')[];
  }[];
}

/**
 * Build the deterministic union. TOTAL: same input → byte-identical report.
 * A candidate produced by MULTIPLE signals is ONE candidate with all its
 * origins (multi-signal is recorded, never counted as independent
 * confirmation).
 */
export function buildEventRelationCandidatesReport(
  input: EventRelationCandidatesInput,
): EventRelationCandidatesReport {
  const { storyId, entityProbes, fingerprintCandidates } = input;

  // ---- Deterministic per-story origin merge.
  const byStory = new Map<string, EventRelationCandidateOrigin[]>();
  const addOrigin = (candidateStoryId: string, origin: EventRelationCandidateOrigin): void => {
    if (candidateStoryId === storyId) {
      return; // the current story is NEVER its own candidate
    }
    const origins = byStory.get(candidateStoryId) ?? [];
    const duplicate = origins.some(
      (existing) =>
        existing.kind === origin.kind &&
        (existing.kind !== 'entity' ||
          origin.kind !== 'entity' ||
          existing.entityId === origin.entityId),
    );
    if (!duplicate) {
      origins.push(origin);
    }
    byStory.set(candidateStoryId, origins);
  };

  for (const fingerprint of fingerprintCandidates) {
    for (const signal of fingerprint.matchedSignalKinds) {
      addOrigin(fingerprint.storyId, { kind: 'fingerprint', signal });
    }
  }
  for (const probe of entityProbes) {
    for (const candidateStoryId of probe.storyIds) {
      addOrigin(candidateStoryId, { kind: 'entity', entityId: probe.entityId });
    }
  }

  const originOrder = (
    a: EventRelationCandidateOrigin,
    b: EventRelationCandidateOrigin,
  ): number => {
    const rankOf = (origin: EventRelationCandidateOrigin): number =>
      origin.kind === 'fingerprint' ? SIGNAL_PRIORITY[origin.signal] : 3;
    const rankA = rankOf(a);
    const rankB = rankOf(b);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    if (a.kind === 'entity' && b.kind === 'entity') {
      return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
    }
    return 0;
  };

  const uniqueCandidatesObserved = byStory.size;
  const allCandidates = [...byStory.entries()]
    .map(([candidateStoryId, origins]) => ({
      storyId: candidateStoryId,
      origins: [...origins].sort(originOrder),
    }))
    .sort((a, b) => (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0));
  const candidates = allCandidates.slice(0, EVENT_RELATION_MAX_UNIQUE_CANDIDATES);
  const candidatesTruncated = uniqueCandidatesObserved > EVENT_RELATION_MAX_UNIQUE_CANDIDATES;

  const probed = entityProbes
    .map((probe) => probe.entityId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    candidatesVersion: EVENT_RELATION_CANDIDATES_VERSION,
    policyVersion: EVENT_RELATION_POLICY_VERSION,
    storyId,
    entityLookup: {
      probed,
      unprobedCount: input.unprobedEntityCount,
      overflow: entityProbes.some((probe) => probe.overflow),
    },
    candidates,
    counts: {
      uniqueCandidatesObserved,
      candidatesReported: candidates.length,
    },
    candidatesTruncated,
    caps: {
      maxEntityProbes: EVENT_RELATION_MAX_ENTITY_PROBES,
      maxRowsPerProbe: EVENT_RELATION_MAX_ROWS_PER_PROBE,
      maxUniqueCandidates: EVENT_RELATION_MAX_UNIQUE_CANDIDATES,
    },
  };
}
