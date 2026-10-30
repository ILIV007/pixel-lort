/**
 * The versioned event-relation DECISION ledger (Phase 5E-1 — R1.17,
 * ADR-0045). The durable, evidence-referenced record of ONE bounded
 * relation step, stored as the ADDITIVE `eventRelation` field of the SAME
 * fenced draft INSERT's `document_json` — never an old-draft UPDATE, never
 * a fake facts row, never a `source_items.raw_json` state bucket.
 *
 * WHAT THE LEDGER IS: pair identities, basis hashes/ids/versions, the
 * proposed verdict or a TYPED non-evaluation state, citations, prompt/
 * policy versions, the REAL provider/model of every attempt, the REAL
 * adjudication ai_runs ids, the honest caps/coverage and the candidates
 * beyond capacity. Deterministic metadata only — NO raw side text, NO
 * self-referential commit SHA.
 *
 * SEMANTIC BOUNDARY (Posidon R1.17 §1): a verdict is a MODEL PROPOSAL over
 * named evidence — never truth, never a calibrated probability, never a
 * merge/publish authorization. `same entity` alone is never a same-event
 * rule; `no candidate ≠ unrelated`; and a technical state (disabled/
 * refusal/invalid output/budget denial/deadline/basis unavailable) is
 * NEVER disguised as the model's semantic `insufficient_evidence`.
 *
 * The typed reader (R1.12.1 lesson applied from birth) validates the REAL
 * v1 invariants before surfacing `event_relation_v1` — a payload that
 * merely CLAIMS the version is `malformed`, never a current result.
 */

import { EVENT_RELATION_POLICY_VERSION } from './event-relation-candidates';
import { EVENT_RELATION_PROMPT_VERSION } from '../ai/event-relation-policy';
import {
  EVENT_RELATION_MAX_PAIR_EVALUATIONS,
  EVENT_RELATION_MAX_UNIQUE_CANDIDATES,
} from './event-relation-candidates';
import { EVENT_RELATION_BOUNDS } from '../ai/event-relation-policy';
import type { EventRelationVerdict } from '../ai/event-relation-types';
import { EVENT_RELATION_PAIR_IDS } from './event-relation-evidence';

/** Report schema version — bump ONLY with a documented contract change. */
export const EVENT_RELATION_DECISION_VERSION = 1 as const;

/**
 * Typed pair-level states. The two `*_proposed` verdicts and the model's
 * semantic `insufficient_evidence` live ONLY in `evaluated`; every other
 * state is a distinct, honest non-evaluation — never collapsed into a
 * semantic verdict.
 */
export type EventRelationPairState =
  | 'evaluated'
  | 'basis_unavailable'
  | 'bundle_invalid'
  | 'provider_refused'
  | 'provider_invalid_output'
  | 'provider_deferred'
  | 'skipped_deadline'
  | 'skipped_budget'
  | 'skipped_step_capacity';

/** The observations a report can honestly record (mutually exhaustive). */
export type EventRelationObservation =
  | 'disabled'
  | 'no_candidates_observed'
  | 'no_evaluable_basis'
  | 'pairs_evaluated'
  | 'evaluation_incomplete';

/** How the citations of an evaluated pair were actually reported. */
export type EventRelationCitationsMode = 'both_sides' | 'none_reported' | 'partial';

/** Basis identity of the SELF side (the snapshot this commit creates). */
export interface EventRelationSideALedger {
  readonly evidenceId: string;
  readonly sourceItemId: string;
  readonly contentHash: string;
}

/** Basis identity of the CANDIDATE side (durable draft record + bridge). */
export interface EventRelationSideBLedger {
  readonly storyId: string;
  readonly evidenceId?: string;
  readonly sourceItemId?: string;
  readonly contentHash?: string;
  readonly draftId?: string;
  readonly draftVersion?: number;
  /** Present ONLY for `basis_unavailable` pairs — the typed reason. */
  readonly basisUnavailableReason?: string;
}

/** One model reference, validated against the pair's own evidence ids. */
export interface EventRelationReferenceLedger {
  readonly side: 'A' | 'B';
  readonly evidenceId: string;
}

/** One pair's ledger entry. */
export interface EventRelationPairLedger {
  readonly pairId: string;
  readonly state: EventRelationPairState;
  readonly sideA: EventRelationSideALedger;
  readonly sideB: EventRelationSideBLedger;
  /** Present from bundling onward (evaluated + provider states). */
  readonly canonicalInputHash?: string;
  /** Evaluated pairs ONLY — the model proposal. */
  readonly verdict?: EventRelationVerdict;
  readonly reasons?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly references?: readonly EventRelationReferenceLedger[];
  readonly citationsReported?: EventRelationCitationsMode;
  /** REAL adjudication ai_runs ids of THIS pair (may be empty — a pair
   * never attempted carries zero fabricated runs). */
  readonly aiRunIds: readonly string[];
  /** Typed non-evaluation detail (the stable deferred reason etc.). */
  readonly deferredReason?: string;
}

/** One union candidate's ledger entry (the explicit coverage record). */
export interface EventRelationCandidateLedger {
  readonly storyId: string;
  /** Deterministic canonical labels: `fingerprint:url|content_hash|title_key`
   * or `entity:<entityId>` (fingerprint signals first, then entities asc). */
  readonly origins: readonly string[];
  readonly basisState: 'ok' | 'basis_unavailable';
  readonly basisUnavailableReason?: string;
}

/** The versioned, deterministic ledger stored with the draft. */
export interface EventRelationDecisionReport {
  readonly eventRelationVersion: typeof EVENT_RELATION_DECISION_VERSION;
  readonly policyVersion: typeof EVENT_RELATION_POLICY_VERSION;
  readonly promptVersion: typeof EVENT_RELATION_PROMPT_VERSION;
  readonly observation: EventRelationObservation;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  readonly lookup: {
    readonly probedEntities: readonly string[];
    readonly unprobedEntityCount: number;
    readonly entityOverflow: boolean;
    readonly uniqueCandidatesObserved: number;
    readonly candidatesReported: number;
    readonly candidatesTruncated: boolean;
  };
  readonly candidates: readonly EventRelationCandidateLedger[];
  readonly pairs: readonly EventRelationPairLedger[];
  readonly counts: {
    readonly candidatesEvaluable: number;
    readonly pairsAttempted: number;
    readonly pairsEvaluated: number;
    readonly providerAttempts: number;
  };
  readonly caps: {
    readonly maxEntityProbes: 3;
    readonly maxRowsPerProbe: 9;
    readonly maxUniqueCandidates: typeof EVENT_RELATION_MAX_UNIQUE_CANDIDATES;
    readonly maxPairEvaluations: typeof EVENT_RELATION_MAX_PAIR_EVALUATIONS;
    readonly maxProviderAttemptsPerStep: typeof EVENT_RELATION_BOUNDS.maxProviderAttemptsPerStep;
    readonly stepDeadlineMs: typeof EVENT_RELATION_BOUNDS.stepWallDeadlineMs;
    readonly maxBundleUtf8Bytes: typeof EVENT_RELATION_BOUNDS.maxBundleUtf8Bytes;
  };
  readonly coverage: {
    readonly entityScope: 'story_entities_idx_only';
    readonly fingerprintScope: 'existing_discovery_report_only';
    readonly historicalBackfill: false;
    readonly reuseDraftsNotEnriched: true;
  };
  readonly limitations: readonly string[];
}

/** Fixed limitation labels (order is part of the deterministic output). */
export const EVENT_RELATION_LIMITATIONS = [
  'candidate_only_not_merge',
  'model_proposal_not_truth',
  'not_calibrated_probability',
  'shared_signal_not_confirmation',
  'no_candidate_not_unrelated',
  'technical_failure_not_insufficient_evidence',
  'conflict_not_different_event',
  'lookup_moment_visibility',
  'reuse_drafts_not_enriched',
  'bounded_probe_window',
] as const;

/** One pair-attempt record the HANDLER assembles (pure input). */
export interface EventRelationPairAttempt {
  readonly storyId: string;
  readonly pairId: string | null;
  readonly state: EventRelationPairState;
  readonly basisUnavailableReason?: string;
  readonly deferredReason?: string;
  readonly sideA?: EventRelationSideALedger;
  readonly sideB?: EventRelationSideBLedger;
  readonly canonicalInputHash?: string;
  readonly verdict?: EventRelationVerdict;
  readonly reasons?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly references?: readonly EventRelationReferenceLedger[];
  readonly citationsReported?: EventRelationCitationsMode;
  readonly aiRunIds: readonly string[];
}

export interface BuildEventRelationDecisionInput {
  readonly disabled?: boolean;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The candidates report of THIS lookup moment (or null when the step
   * never ran — the disabled report). */
  readonly candidates: {
    readonly entityLookup: {
      readonly probed: readonly string[];
      readonly unprobedCount: number;
      readonly overflow: boolean;
    };
    readonly counts: {
      readonly uniqueCandidatesObserved: number;
      readonly candidatesReported: number;
    };
    readonly candidatesTruncated: boolean;
    readonly candidateEntries: readonly {
      readonly storyId: string;
      readonly origins: readonly string[];
      readonly basisState: 'ok' | 'basis_unavailable';
      readonly basisUnavailableReason?: string;
    }[];
  } | null;
  /** The pair attempts in deterministic slot order (≤2). */
  readonly pairAttempts: readonly EventRelationPairAttempt[];
}

/**
 * The honest `disabled` report: the versioned ledger a draft carries when
 * the relation feature is absent or its fail-closed flag is OFF — ZERO
 * retrieval, ZERO evaluation, ZERO runs, deterministic metadata only.
 */
export function disabledEventRelationReport(snapshot: {
  readonly sourceItemId: string;
  readonly contentHash: string;
}): EventRelationDecisionReport {
  return buildEventRelationDecisionReport({
    disabled: true,
    snapshot,
    candidates: null,
    pairAttempts: [],
  });
}

function citationsModeOf(
  references: readonly EventRelationReferenceLedger[] | undefined,
): EventRelationCitationsMode {
  if (references === undefined) {
    return 'none_reported';
  }
  const hasA = references.some((reference) => reference.side === 'A');
  const hasB = references.some((reference) => reference.side === 'B');
  if (hasA && hasB) {
    return 'both_sides';
  }
  return 'partial';
}

/**
 * Build the deterministic ledger. TOTAL: same input → byte-identical
 * report (fixed field order, explicit sorts, no timestamps, no randomness).
 */
export function buildEventRelationDecisionReport(
  input: BuildEventRelationDecisionInput,
): EventRelationDecisionReport {
  const pairAttempts = input.pairAttempts;
  const evaluatedPairs = pairAttempts.filter((pair) => pair.state === 'evaluated');
  const providerAttempts = pairAttempts.reduce((total, pair) => total + pair.aiRunIds.length, 0);

  let observation: EventRelationObservation;
  if (input.disabled || input.candidates === null) {
    observation = 'disabled';
  } else if (input.candidates.counts.candidatesReported === 0) {
    observation = 'no_candidates_observed';
  } else if (
    input.candidates.candidateEntries.every((entry) => entry.basisState !== 'ok') &&
    pairAttempts.every(
      (pair) => pair.state === 'basis_unavailable' || pair.state === 'bundle_invalid',
    )
  ) {
    observation = 'no_evaluable_basis';
  } else if (evaluatedPairs.length > 0) {
    observation = 'pairs_evaluated';
  } else {
    observation = 'evaluation_incomplete';
  }

  const candidates = input.candidates === null ? [] : input.candidates.candidateEntries;
  const candidatesEvaluable = candidates.filter((entry) => entry.basisState === 'ok').length;

  return {
    eventRelationVersion: EVENT_RELATION_DECISION_VERSION,
    policyVersion: EVENT_RELATION_POLICY_VERSION,
    promptVersion: EVENT_RELATION_PROMPT_VERSION,
    observation,
    snapshot: {
      sourceItemId: input.snapshot.sourceItemId,
      contentHash: input.snapshot.contentHash,
    },
    lookup: {
      probedEntities: input.candidates?.entityLookup.probed ?? [],
      unprobedEntityCount: input.candidates?.entityLookup.unprobedCount ?? 0,
      entityOverflow: input.candidates?.entityLookup.overflow ?? false,
      uniqueCandidatesObserved: input.candidates?.counts.uniqueCandidatesObserved ?? 0,
      candidatesReported: input.candidates?.counts.candidatesReported ?? 0,
      candidatesTruncated: input.candidates?.candidatesTruncated ?? false,
    },
    candidates,
    pairs: pairAttempts.map((pair) => ({
      pairId: pair.pairId ?? '',
      state: pair.state,
      sideA: pair.sideA ?? {
        evidenceId: '',
        sourceItemId: input.snapshot.sourceItemId,
        contentHash: input.snapshot.contentHash,
      },
      sideB: pair.sideB ?? { storyId: pair.storyId },
      ...(pair.canonicalInputHash !== undefined
        ? { canonicalInputHash: pair.canonicalInputHash }
        : {}),
      ...(pair.state === 'evaluated'
        ? {
            verdict: pair.verdict,
            reasons: pair.reasons ?? [],
            conflicts: pair.conflicts ?? [],
            references: pair.references ?? [],
            citationsReported: citationsModeOf(pair.references),
          }
        : {}),
      aiRunIds: pair.aiRunIds,
      ...(pair.basisUnavailableReason !== undefined
        ? { basisUnavailableReason: pair.basisUnavailableReason }
        : {}),
      ...(pair.deferredReason !== undefined ? { deferredReason: pair.deferredReason } : {}),
    })),
    counts: {
      candidatesEvaluable,
      pairsAttempted: pairAttempts.length,
      pairsEvaluated: evaluatedPairs.length,
      providerAttempts,
    },
    caps: {
      maxEntityProbes: 3,
      maxRowsPerProbe: 9,
      maxUniqueCandidates: EVENT_RELATION_MAX_UNIQUE_CANDIDATES,
      maxPairEvaluations: EVENT_RELATION_MAX_PAIR_EVALUATIONS,
      maxProviderAttemptsPerStep: EVENT_RELATION_BOUNDS.maxProviderAttemptsPerStep,
      stepDeadlineMs: EVENT_RELATION_BOUNDS.stepWallDeadlineMs,
      maxBundleUtf8Bytes: EVENT_RELATION_BOUNDS.maxBundleUtf8Bytes,
    },
    coverage: {
      entityScope: 'story_entities_idx_only',
      fingerprintScope: 'existing_discovery_report_only',
      historicalBackfill: false,
      reuseDraftsNotEnriched: true,
    },
    limitations: EVENT_RELATION_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — payloads that merely claim the version are malformed.
// ---------------------------------------------------------------------------

export type EventRelationRead =
  | { readonly kind: 'event_relation_v1'; readonly report: EventRelationDecisionReport }
  /** A pre-5E draft (no eventRelation payload). Honest absence. */
  | { readonly kind: 'absent' }
  /** An eventRelation-shaped payload with a different (future) version. */
  | { readonly kind: 'unsupported_version'; readonly eventRelationVersion: unknown }
  /** Not an eventRelation payload at all — or one violating v1. */
  | { readonly kind: 'malformed' };

const PAIR_STATES: ReadonlySet<string> = new Set([
  'evaluated',
  'basis_unavailable',
  'bundle_invalid',
  'provider_refused',
  'provider_invalid_output',
  'provider_deferred',
  'skipped_deadline',
  'skipped_budget',
  'skipped_step_capacity',
]);

const OBSERVATIONS: ReadonlySet<string> = new Set([
  'disabled',
  'no_candidates_observed',
  'no_evaluable_basis',
  'pairs_evaluated',
  'evaluation_incomplete',
]);

const VERDICTS: ReadonlySet<string> = new Set([
  'same_event_proposed',
  'different_event_proposed',
  'insufficient_evidence',
]);

const CITATIONS_MODES: ReadonlySet<string> = new Set(['both_sides', 'none_reported', 'partial']);

const ORIGIN_PATTERN = /^(fingerprint:(url|content_hash|title_key)|entity:[A-Za-z0-9_.:-]{1,64})$/;
const AI_RUN_ID_PATTERN = /^edai_[0-9a-f]{32}$/;
const PAIR_ID_VALUES: ReadonlySet<string> = new Set(EVENT_RELATION_PAIR_IDS);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= maxChars)
  );
}

/**
 * Read the `eventRelation` additive field from a draft's `document_json`.
 * TOTAL: never throws; every structural violation is a typed `malformed`.
 * The reader enforces the REAL builder invariants — ascending candidate
 * order, ≤2 evaluated pairs with the full evaluated shape, non-evaluated
 * pairs carrying NO verdict, ai_runs id shape, counts consistency
 * (providerAttempts ≡ Σ pair aiRunIds, pairsEvaluated ≡ #evaluated) — a
 * payload that merely claims the version is never a current result.
 */
export function readEventRelationDecision(documentJson: string): EventRelationRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return { kind: 'malformed' };
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'malformed' };
  }
  if (!('eventRelation' in parsed)) {
    return { kind: 'absent' };
  }
  const payload: unknown = parsed.eventRelation;
  if (!isPlainObject(payload)) {
    return { kind: 'malformed' };
  }
  const version: unknown = payload.eventRelationVersion;
  if (version !== EVENT_RELATION_DECISION_VERSION) {
    return { kind: 'unsupported_version', eventRelationVersion: version };
  }

  // ---- Fixed identity labels.
  if (
    payload.policyVersion !== EVENT_RELATION_POLICY_VERSION ||
    payload.promptVersion !== EVENT_RELATION_PROMPT_VERSION
  ) {
    return { kind: 'malformed' };
  }
  const observation: unknown = payload.observation;
  if (typeof observation !== 'string' || !OBSERVATIONS.has(observation)) {
    return { kind: 'malformed' };
  }
  const snapshot = payload.snapshot;
  if (
    !isPlainObject(snapshot) ||
    typeof snapshot.sourceItemId !== 'string' ||
    snapshot.sourceItemId.length === 0 ||
    typeof snapshot.contentHash !== 'string' ||
    snapshot.contentHash.length === 0
  ) {
    return { kind: 'malformed' };
  }

  // ---- Lookup metadata (honest non-negative integers, ascending probes).
  const lookup = payload.lookup;
  if (!isPlainObject(lookup)) {
    return { kind: 'malformed' };
  }
  const numericFields: [string, number][] = [
    ['unprobedEntityCount', 3],
    ['uniqueCandidatesObserved', EVENT_RELATION_MAX_UNIQUE_CANDIDATES],
    ['candidatesReported', EVENT_RELATION_MAX_UNIQUE_CANDIDATES],
  ];
  for (const [field] of numericFields) {
    const value: unknown = lookup[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { kind: 'malformed' };
    }
  }
  if (
    typeof lookup.entityOverflow !== 'boolean' ||
    typeof lookup.candidatesTruncated !== 'boolean'
  ) {
    return { kind: 'malformed' };
  }
  const probedEntities: unknown = lookup.probedEntities;
  if (
    !Array.isArray(probedEntities) ||
    probedEntities.length > 3 ||
    probedEntities.some((id) => typeof id !== 'string' || id.length === 0) ||
    !isAscendingUnique(probedEntities as string[])
  ) {
    return { kind: 'malformed' };
  }

  // ---- Candidates (ascending unique storyIds, ≤8, valid origin labels).
  const candidates: unknown = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length > EVENT_RELATION_MAX_UNIQUE_CANDIDATES) {
    return { kind: 'malformed' };
  }
  const candidateStoryIds: string[] = [];
  for (const entry of candidates) {
    if (!isPlainObject(entry)) {
      return { kind: 'malformed' };
    }
    if (typeof entry.storyId !== 'string' || entry.storyId.length === 0) {
      return { kind: 'malformed' };
    }
    const origins: unknown = entry.origins;
    if (
      !Array.isArray(origins) ||
      origins.length === 0 ||
      origins.some((origin) => typeof origin !== 'string' || !ORIGIN_PATTERN.test(origin))
    ) {
      return { kind: 'malformed' };
    }
    if (entry.basisState !== 'ok' && entry.basisState !== 'basis_unavailable') {
      return { kind: 'malformed' };
    }
    if (entry.basisState === 'basis_unavailable') {
      if (
        typeof entry.basisUnavailableReason !== 'string' ||
        entry.basisUnavailableReason.length === 0
      ) {
        return { kind: 'malformed' };
      }
    } else if (entry.basisUnavailableReason !== undefined) {
      return { kind: 'malformed' };
    }
    candidateStoryIds.push(entry.storyId);
  }
  if (!isAscendingUnique(candidateStoryIds)) {
    return { kind: 'malformed' };
  }

  // ---- Pairs (≤2, valid ids/states, evaluated shape, run-id shape).
  const pairs: unknown = payload.pairs;
  if (!Array.isArray(pairs) || pairs.length > EVENT_RELATION_MAX_PAIR_EVALUATIONS) {
    return { kind: 'malformed' };
  }
  const seenPairIds = new Set<string>();
  let evaluatedCount = 0;
  let providerAttemptsSum = 0;
  for (const pair of pairs) {
    if (!isPlainObject(pair)) {
      return { kind: 'malformed' };
    }
    const pairId: unknown = pair.pairId;
    if (typeof pairId !== 'string' || !PAIR_ID_VALUES.has(pairId) || seenPairIds.has(pairId)) {
      return { kind: 'malformed' };
    }
    seenPairIds.add(pairId);
    const state: unknown = pair.state;
    if (typeof state !== 'string' || !PAIR_STATES.has(state)) {
      return { kind: 'malformed' };
    }
    const sideA = pair.sideA;
    if (
      !isPlainObject(sideA) ||
      typeof sideA.evidenceId !== 'string' ||
      sideA.evidenceId.length === 0 ||
      typeof sideA.sourceItemId !== 'string' ||
      sideA.sourceItemId.length === 0 ||
      typeof sideA.contentHash !== 'string' ||
      sideA.contentHash.length === 0
    ) {
      return { kind: 'malformed' };
    }
    const sideB = pair.sideB;
    if (!isPlainObject(sideB) || typeof sideB.storyId !== 'string' || sideB.storyId.length === 0) {
      return { kind: 'malformed' };
    }
    for (const optionalString of [
      'evidenceId',
      'sourceItemId',
      'contentHash',
      'draftId',
      'basisUnavailableReason',
      'deferredReason',
    ] as const) {
      const value: unknown = sideB[optionalString];
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        return { kind: 'malformed' };
      }
    }
    if (
      sideB.draftVersion !== undefined &&
      (typeof sideB.draftVersion !== 'number' || !Number.isInteger(sideB.draftVersion))
    ) {
      return { kind: 'malformed' };
    }
    // Evaluated pairs carry the FULL proposal shape; every other state
    // carries NONE of it (a verdict can never hide inside a failure).
    if (state === 'evaluated') {
      evaluatedCount += 1;
      if (
        typeof pair.verdict !== 'string' ||
        !VERDICTS.has(pair.verdict) ||
        !isBoundedStringArray(pair.reasons, 4, 200) ||
        (pair.reasons as string[]).length < 1 ||
        !isBoundedStringArray(pair.conflicts, 4, 200) ||
        typeof pair.canonicalInputHash !== 'string' ||
        !HASH_PATTERN.test(pair.canonicalInputHash)
      ) {
        return { kind: 'malformed' };
      }
      const references: unknown = pair.references;
      if (!Array.isArray(references) || references.length > 8) {
        return { kind: 'malformed' };
      }
      const referenceKeys = new Set<string>();
      for (const reference of references) {
        if (
          !isPlainObject(reference) ||
          (reference.side !== 'A' && reference.side !== 'B') ||
          typeof reference.evidenceId !== 'string' ||
          reference.evidenceId.length === 0
        ) {
          return { kind: 'malformed' };
        }
        const key = `${reference.side}\u001f${reference.evidenceId}`;
        if (referenceKeys.has(key)) {
          return { kind: 'malformed' };
        }
        referenceKeys.add(key);
      }
      const citationsReported: unknown = pair.citationsReported;
      if (typeof citationsReported !== 'string' || !CITATIONS_MODES.has(citationsReported)) {
        return { kind: 'malformed' };
      }
    } else {
      for (const forbidden of [
        'verdict',
        'reasons',
        'conflicts',
        'references',
        'citationsReported',
      ]) {
        if (forbidden in pair) {
          return { kind: 'malformed' };
        }
      }
    }
    const aiRunIds: unknown = pair.aiRunIds;
    if (
      !Array.isArray(aiRunIds) ||
      aiRunIds.length > EVENT_RELATION_BOUNDS.maxProviderAttemptsPerStep ||
      aiRunIds.some((id) => typeof id !== 'string' || !AI_RUN_ID_PATTERN.test(id))
    ) {
      return { kind: 'malformed' };
    }
    providerAttemptsSum += aiRunIds.length;
  }

  // ---- Counts consistency (the ledger is auditable, not decorative).
  const counts = payload.counts;
  if (
    !isPlainObject(counts) ||
    typeof counts.candidatesEvaluable !== 'number' ||
    typeof counts.pairsAttempted !== 'number' ||
    typeof counts.pairsEvaluated !== 'number' ||
    typeof counts.providerAttempts !== 'number' ||
    counts.pairsEvaluated !== evaluatedCount ||
    counts.pairsAttempted !== pairs.length ||
    counts.providerAttempts !== providerAttemptsSum
  ) {
    return { kind: 'malformed' };
  }

  // ---- Caps / coverage / limitations are the FIXED versioned labels.
  const caps = payload.caps;
  const expectedCaps = {
    maxEntityProbes: 3,
    maxRowsPerProbe: 9,
    maxUniqueCandidates: EVENT_RELATION_MAX_UNIQUE_CANDIDATES,
    maxPairEvaluations: EVENT_RELATION_MAX_PAIR_EVALUATIONS,
    maxProviderAttemptsPerStep: EVENT_RELATION_BOUNDS.maxProviderAttemptsPerStep,
    stepDeadlineMs: EVENT_RELATION_BOUNDS.stepWallDeadlineMs,
    maxBundleUtf8Bytes: EVENT_RELATION_BOUNDS.maxBundleUtf8Bytes,
  };
  if (
    !isPlainObject(caps) ||
    Object.entries(expectedCaps).some(
      ([key, value]) => (caps as Record<string, unknown>)[key] !== value,
    )
  ) {
    return { kind: 'malformed' };
  }
  const coverage = payload.coverage;
  if (
    !isPlainObject(coverage) ||
    coverage.entityScope !== 'story_entities_idx_only' ||
    coverage.fingerprintScope !== 'existing_discovery_report_only' ||
    coverage.historicalBackfill !== false ||
    coverage.reuseDraftsNotEnriched !== true
  ) {
    return { kind: 'malformed' };
  }
  if (
    !Array.isArray(payload.limitations) ||
    (payload.limitations as unknown[]).length !== EVENT_RELATION_LIMITATIONS.length ||
    (payload.limitations as unknown[]).some(
      (label, index) => label !== EVENT_RELATION_LIMITATIONS[index],
    )
  ) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'event_relation_v1',
    report: payload as unknown as EventRelationDecisionReport,
  };
}

function isAscendingUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if (previous >= current) {
      return false;
    }
  }
  return true;
}
