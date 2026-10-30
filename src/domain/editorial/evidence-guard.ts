/**
 * Evidence Guard v1 (Phase 5B — R1.12): a PURE, DETERMINISTIC, LIMITED
 * evaluator for the model claims already stored inside a draft. NO SQL, NO
 * network, NO SDK, NO model call, NO clock — the same offline purity as the
 * Phase 5A mapper (ADR-0042 §2), so every result is reproducible from its
 * inputs alone.
 *
 * WHAT IT DOES (and nothing more):
 * - For each model claim of a draft it checks, against the SAME traceable
 *   evidence excerpt that produced the draft:
 *     1. the claim text is non-empty;
 *     2. the claim references evidence, and every referenced id is the
 *        expected request-evidence id (the verified source_item snapshot);
 *     3. the evidence identity belongs to the expected snapshot;
 *     4. whether the claim text appears VERBATIM (after the single limited
 *        normalization below) inside the evidence excerpt.
 * - The result is a VERSIONED report (`guardVersion: 1`) that is stored
 *   together with the draft it describes (additive `evidenceGuard` field of
 *   `drafts.document_json`, written by the SAME fenced atomic commit — no
 *   new SQL, no migration).
 *
 * WHAT IT NEVER DOES (Posidon R1.12 honesty boundary):
 * - A match is NEVER `verified`/`confirmed`/`supported`/`auto_approved`.
 *   Direct text match proves only "this exact text exists in the source
 *   excerpt" — not that the claim is true.
 * - The ABSENCE of a direct match is NEVER `false`: a paraphrase, a Persian
 *   translation of an English source, or a quote beyond a truncated excerpt
 *   all yield `unresolved_requires_further_verification`.
 * - No fuzzy similarity, no multi-word heuristics, no semantic matching, no
 *   NER, no translator, no inference engine — those are future phases.
 * - headline/summary are OUTSIDE the evaluator's scope and are recorded as
 *   explicitly `unassessed` — never silently "checked".
 * - An OLD or unversioned guard payload is never surfaced as a current
 *   guard result (see `readEvidenceGuardReport`); pre-5B drafts honestly
 *   read as `absent` — no automatic backfill.
 *
 * THE ONE LIMITED NORMALIZATION (explicit, tested): Unicode NFC, Unicode
 * whitespace collapse to a single space, and trim. It deliberately does NOT
 * fold case, does NOT convert digits (Persian ۰-۹ never equals Latin 0-9),
 * does NOT unify Arabic/Persian letter variants, does NOT strip
 * punctuation, does NOT remove negations, and does NOT convert units. Two
 * different statements therefore can never become equal through it.
 */

import { EDITORIAL_EXCERPT_MAX_CHARS } from './mapper';

/** Report schema version — bump ONLY with a documented contract change. */
export const EVIDENCE_GUARD_VERSION = 1 as const;

/**
 * Per-claim status. The four values deliberately preserve the distinctions
 * Posidon R1.12 requires:
 * - `direct_text_observed` — the claim text was found VERBATIM in the
 *   evidence excerpt (an observation about text presence, NOT truth);
 * - `unresolved_requires_further_verification` — a valid reference and
 *   non-empty text, but no direct match (paraphrase/translation/truncation
 *   are possible reasons; the claim is NOT false);
 * - `invalid_reference_or_snapshot` — empty text, missing references, or a
 *   reference that is not the expected snapshot's evidence id;
 * - `not_evaluated_identity_invalid` — the report's snapshot identity did
 *   not hold, so NO textual evaluation was performed for any claim.
 */
export type EvidenceGuardClaimStatus =
  | 'direct_text_observed'
  | 'unresolved_requires_further_verification'
  | 'invalid_reference_or_snapshot'
  | 'not_evaluated_identity_invalid';

/** Report-level evaluation status (identity gate before any text work). */
export type EvidenceGuardEvaluationStatus = 'evaluated' | 'invalid_snapshot_identity';

/** Stable reason codes — additive-only across versions; never remapped. */
export type EvidenceGuardReasonCode =
  | 'direct_text_observed'
  | 'no_direct_text_match'
  | 'excerpt_truncated_coverage'
  | 'empty_claim_text'
  | 'empty_evidence_refs'
  | 'unknown_evidence_id'
  | 'evidence_id_identity_inconsistent'
  | 'draft_snapshot_identity_mismatch';

/** One evaluated claim: an index into the SAME draft document it rides with. */
export interface EvidenceGuardClaimResult {
  /** Index into `document_json.modelClaims` (and `facts_json`) — the
   * report NEVER duplicates the claim text; the document holds it. */
  readonly claimIndex: number;
  readonly status: EvidenceGuardClaimStatus;
  /** Sorted, deduplicated, stable — deterministic JSON by construction. */
  readonly reasonCodes: readonly EvidenceGuardReasonCode[];
}

/** The versioned, deterministic guard report stored with the draft. */
export interface EvidenceGuardReport {
  readonly guardVersion: typeof EVIDENCE_GUARD_VERSION;
  readonly evaluationStatus: EvidenceGuardEvaluationStatus;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  readonly evidence: {
    readonly evidenceId: string;
    readonly excerptTruncated: boolean;
    readonly excerptMaxChars: number;
  };
  /** Fixed, code-defined limitation labels (never success claims). */
  readonly limitations: readonly string[];
  /** Fields the evaluator explicitly did NOT assess. */
  readonly unassessedFields: readonly ['headlineFa', 'summaryFa'];
  readonly claims: readonly EvidenceGuardClaimResult[];
  readonly counts: {
    readonly total: number;
    readonly directTextObserved: number;
    readonly unresolvedRequiresFurtherVerification: number;
    readonly invalidReferenceOrSnapshot: number;
    readonly notEvaluatedIdentityInvalid: number;
  };
}

/** Fixed limitation labels (order is part of the deterministic output). */
export const EVIDENCE_GUARD_LIMITATIONS = [
  'excerpt_scope_only',
  'direct_text_is_not_truth',
  'no_semantic_analysis',
  'headline_summary_unassessed',
] as const;

/** The expected evidence/snapshot/draft identities and claims to evaluate. */
export interface EvidenceGuardInput {
  /** The verified source snapshot identity (checked against the STORED
   * hash by the caller before this evaluator ever runs). */
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The SAME traceable excerpt that produced the draft. */
  readonly evidence: {
    readonly evidenceId: string;
    readonly excerptText: string;
    readonly excerptTruncated: boolean;
  };
  /** Model claims exactly as they will be stored (`modelClaims` order). */
  readonly draftClaims: readonly {
    readonly text: string;
    readonly evidenceIds: readonly string[];
  }[];
  /** Draft headline/summary — passed for scope honesty, NEVER evaluated. */
  readonly draftHeadlineFa: string;
  readonly draftSummaryFa: string;
  /** The item id recorded INSIDE the draft document (identity cross-check). */
  readonly draftSourceItemId: string;
}

/**
 * THE one limited normalization (explicit, unit-tested): NFC + Unicode
 * whitespace collapse + trim. Everything else is left byte-faithful on
 * purpose — see the module honesty boundary.
 */
export function normalizeForDirectTextMatch(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function sortedCodes(codes: EvidenceGuardReasonCode[]): EvidenceGuardReasonCode[] {
  return [...new Set(codes)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build the versioned guard report. TOTAL and DETERMINISTIC: the same
 * input always yields a byte-identical report (fixed field order, sorted
 * reason codes, no timestamps, no randomness).
 */
export function buildEvidenceGuardReport(input: EvidenceGuardInput): EvidenceGuardReport {
  // ---- Identity gate (before ANY textual evaluation): the evidence id,
  //      the verified snapshot, and the draft's own recorded item identity
  //      must all name the SAME snapshot. On the real path all three are
  //      the verified source_item id; a mismatch means the caller tried to
  //      evaluate a draft against a foreign snapshot — nothing is matched,
  //      nothing is observed, every claim is `not_evaluated...`.
  const identityFailures: EvidenceGuardReasonCode[] = [];
  if (input.evidence.evidenceId !== input.snapshot.sourceItemId) {
    identityFailures.push('evidence_id_identity_inconsistent');
  }
  if (input.draftSourceItemId !== input.snapshot.sourceItemId) {
    identityFailures.push('draft_snapshot_identity_mismatch');
  }
  const identityValid = identityFailures.length === 0;

  const claims = input.draftClaims.map((claim, claimIndex): EvidenceGuardClaimResult => {
    if (!identityValid) {
      return {
        claimIndex,
        status: 'not_evaluated_identity_invalid',
        reasonCodes: sortedCodes(identityFailures),
      };
    }
    const failures: EvidenceGuardReasonCode[] = [];
    if (claim.text.trim().length === 0) {
      failures.push('empty_claim_text');
    }
    if (claim.evidenceIds.length === 0) {
      failures.push('empty_evidence_refs');
    } else if (claim.evidenceIds.some((id) => id !== input.evidence.evidenceId)) {
      // The request evidence set of this path is EXACTLY ONE snippet (the
      // verified source_item itself): any other id is unknown HERE.
      failures.push('unknown_evidence_id');
    }
    if (failures.length > 0) {
      return {
        claimIndex,
        status: 'invalid_reference_or_snapshot',
        reasonCodes: sortedCodes(failures),
      };
    }
    const observed = normalizeForDirectTextMatch(input.evidence.excerptText).includes(
      normalizeForDirectTextMatch(claim.text),
    );
    if (observed) {
      // A text-presence observation ONLY — never verified/confirmed.
      return { claimIndex, status: 'direct_text_observed', reasonCodes: ['direct_text_observed'] };
    }
    return {
      claimIndex,
      status: 'unresolved_requires_further_verification',
      reasonCodes: sortedCodes([
        'no_direct_text_match',
        // A truncated excerpt covers less than the source: the absence of
        // the text in the excerpt must never read as absence in the source.
        ...(input.evidence.excerptTruncated ? (['excerpt_truncated_coverage'] as const) : []),
      ]),
    };
  });

  const counts = {
    total: claims.length,
    directTextObserved: claims.filter((c) => c.status === 'direct_text_observed').length,
    unresolvedRequiresFurtherVerification: claims.filter(
      (c) => c.status === 'unresolved_requires_further_verification',
    ).length,
    invalidReferenceOrSnapshot: claims.filter((c) => c.status === 'invalid_reference_or_snapshot')
      .length,
    notEvaluatedIdentityInvalid: claims.filter((c) => c.status === 'not_evaluated_identity_invalid')
      .length,
  };

  return {
    guardVersion: EVIDENCE_GUARD_VERSION,
    evaluationStatus: identityValid ? 'evaluated' : 'invalid_snapshot_identity',
    snapshot: {
      sourceItemId: input.snapshot.sourceItemId,
      contentHash: input.snapshot.contentHash,
    },
    evidence: {
      evidenceId: input.evidence.evidenceId,
      excerptTruncated: input.evidence.excerptTruncated,
      excerptMaxChars: EDITORIAL_EXCERPT_MAX_CHARS,
    },
    limitations: EVIDENCE_GUARD_LIMITATIONS,
    unassessedFields: ['headlineFa', 'summaryFa'],
    claims,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — old/unversioned payloads are never "current results".
// R1.12.1: the reader validates the REAL v1 contract (shape AND invariants)
// before surfacing guard_v1; it is a shape/invariant validator, NOT a
// cryptographic authenticity proof and NOT semantic support.
// ---------------------------------------------------------------------------

export type EvidenceGuardReportRead =
  | { readonly kind: 'guard_v1'; readonly report: EvidenceGuardReport }
  /** A pre-5B draft (no guard payload). Honest absence — never a pass. */
  | { readonly kind: 'absent' }
  /** A guard-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly guardVersion: unknown }
  /** Not a guard payload at all — including a payload that CLAIMS version 1
   * while violating the v1 contract below. */
  | { readonly kind: 'malformed' };

const GUARD_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  'direct_text_observed',
  'unresolved_requires_further_verification',
  'invalid_reference_or_snapshot',
  'not_evaluated_identity_invalid',
]);

const GUARD_EVALUATION_STATUSES: ReadonlySet<string> = new Set([
  'evaluated',
  'invalid_snapshot_identity',
]);

/** Every reason code v1 can ever carry (the union over all claim statuses). */
const GUARD_REASON_CODES: ReadonlySet<string> = new Set([
  'direct_text_observed',
  'no_direct_text_match',
  'excerpt_truncated_coverage',
  'empty_claim_text',
  'empty_evidence_refs',
  'unknown_evidence_id',
  'evidence_id_identity_inconsistent',
  'draft_snapshot_identity_mismatch',
]);

/** Codes the builder emits ONLY for `not_evaluated_identity_invalid`. */
const GUARD_IDENTITY_REASON_CODES: ReadonlySet<string> = new Set([
  'evidence_id_identity_inconsistent',
  'draft_snapshot_identity_mismatch',
]);

/** Codes the builder emits ONLY for `invalid_reference_or_snapshot`. */
const GUARD_REFERENCE_REASON_CODES: ReadonlySet<string> = new Set([
  'empty_claim_text',
  'empty_evidence_refs',
  'unknown_evidence_id',
]);

/** Codes the builder emits ONLY for `unresolved_requires_further_verification`. */
const GUARD_UNRESOLVED_REASON_CODES: ReadonlySet<string> = new Set([
  'no_direct_text_match',
  'excerpt_truncated_coverage',
]);

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Exact string-array equality (order included) — for the fixed tuple. */
function isExactStringArray(value: readonly string[], expected: readonly string[]): boolean {
  return value.length === expected.length && expected.every((item, index) => value[index] === item);
}

/**
 * v1 limitations are the FIXED code-defined label set: every label present,
 * no duplicates, no extras. Removing or adding any label is not a v1 report.
 */
function isFixedLimitationSet(value: readonly string[]): boolean {
  const fixed = EVIDENCE_GUARD_LIMITATIONS as readonly string[];
  return (
    value.length === fixed.length &&
    new Set(value).size === value.length &&
    value.every((label) => fixed.includes(label))
  );
}

/**
 * Per-claim v1 reason-code contract: the builder emits non-empty, duplicate-
 * free codes from the allowed set, consistent with the claim status and with
 * the report's own evidence record.
 */
function claimReasonCodesAreConsistent(
  status: string,
  codes: readonly string[],
  excerptTruncated: boolean,
): boolean {
  if (codes.length === 0 || new Set(codes).size !== codes.length) {
    return false;
  }
  if (!codes.every((code) => GUARD_REASON_CODES.has(code))) {
    return false;
  }
  switch (status) {
    case 'direct_text_observed':
      // The builder emits exactly this single code for an observed claim.
      return codes.length === 1 && codes[0] === 'direct_text_observed';
    case 'unresolved_requires_further_verification':
      // Must cite the absence; the coverage warning may appear ONLY when the
      // report itself records a truncated excerpt.
      return (
        codes.every((code) => GUARD_UNRESOLVED_REASON_CODES.has(code)) &&
        codes.includes('no_direct_text_match') &&
        (!codes.includes('excerpt_truncated_coverage') || excerptTruncated)
      );
    case 'invalid_reference_or_snapshot':
      return codes.every((code) => GUARD_REFERENCE_REASON_CODES.has(code));
    case 'not_evaluated_identity_invalid':
      return codes.every((code) => GUARD_IDENTITY_REASON_CODES.has(code));
    default:
      return false;
  }
}

/**
 * Read the guard payload from a PARSED `drafts.document_json` value.
 * Consumers must treat `absent`/`unsupported_version`/`malformed` as "no
 * current guard result" — none of them is ever a validation of the draft.
 *
 * R1.12.1 contract (what `guard_v1` promises — nothing more):
 * - the payload satisfies the REAL v1 invariants of `buildEvidenceGuardReport`:
 *   the fixed limitation set, the exact unassessed tuple, `excerptMaxChars`
 *   equal to the builder constant, per-claim indexes that are non-negative
 *   integers naming their own array position, non-negative integer counts
 *   that EXACTLY describe the claims, per-status-consistent reason codes,
 *   and an evaluationStatus consistent with the claims and with the report's
 *   OWN stored identity fields;
 * - identity fields stay pass-through strings (the pure builder guarantees
 *   no hash format — none is invented here; no new caps, no business limits);
 * - `absent`, `unsupported_version` and `malformed` keep their distinct
 *   meanings; an unknown/different version is never treated as supported;
 * - every report the builder can currently produce (including identity-
 *   invalid ones and empty claim lists) remains readable as `guard_v1`.
 */
export function readEvidenceGuardReport(document: unknown): EvidenceGuardReportRead {
  if (typeof document !== 'object' || document === null) {
    return { kind: 'malformed' };
  }
  const guard = (document as Record<string, unknown>)['evidenceGuard'];
  if (guard === undefined) {
    return { kind: 'absent' };
  }
  if (typeof guard !== 'object' || guard === null) {
    return { kind: 'malformed' };
  }
  const g = guard as Record<string, unknown>;
  if (g['guardVersion'] !== EVIDENCE_GUARD_VERSION) {
    return { kind: 'unsupported_version', guardVersion: g['guardVersion'] };
  }

  const evaluationStatus = g['evaluationStatus'];
  const snapshot = g['snapshot'];
  const evidence = g['evidence'];
  const limitations = g['limitations'];
  const unassessedFields = g['unassessedFields'];
  if (
    typeof evaluationStatus !== 'string' ||
    !GUARD_EVALUATION_STATUSES.has(evaluationStatus) ||
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    typeof evidence !== 'object' ||
    evidence === null ||
    typeof (evidence as Record<string, unknown>)['evidenceId'] !== 'string' ||
    typeof (evidence as Record<string, unknown>)['excerptTruncated'] !== 'boolean' ||
    // The builder ALWAYS emits this constant — drift is not a v1 report.
    (evidence as Record<string, unknown>)['excerptMaxChars'] !== EDITORIAL_EXCERPT_MAX_CHARS ||
    !Array.isArray(limitations) ||
    !isStringArray(limitations) ||
    !isFixedLimitationSet(limitations) ||
    !Array.isArray(unassessedFields) ||
    !isStringArray(unassessedFields) ||
    // v1 assesses NO headline/summary: exactly the fixed two-field tuple.
    !isExactStringArray(unassessedFields, ['headlineFa', 'summaryFa']) ||
    !Array.isArray(g['claims'])
  ) {
    return { kind: 'malformed' };
  }

  const sourceItemId = (snapshot as Record<string, unknown>)['sourceItemId'] as string;
  const evidenceId = (evidence as Record<string, unknown>)['evidenceId'] as string;
  const excerptTruncated = (evidence as Record<string, unknown>)['excerptTruncated'] as boolean;

  // ---- Claims: shape, index/order invariants, per-status code contract.
  const claims = g['claims'] as unknown[];
  for (let position = 0; position < claims.length; position++) {
    const claim = claims[position];
    if (typeof claim !== 'object' || claim === null) {
      return { kind: 'malformed' };
    }
    const record = claim as Record<string, unknown>;
    const status = record['status'];
    const codes = record['reasonCodes'];
    if (
      // claimIndex: a non-negative INTEGER naming its own array position —
      // duplicates and out-of-order indexes are impossible from the builder.
      !isNonNegativeInteger(record['claimIndex']) ||
      record['claimIndex'] !== position ||
      typeof status !== 'string' ||
      !GUARD_CLAIM_STATUSES.has(status) ||
      !Array.isArray(codes) ||
      !isStringArray(codes) ||
      !claimReasonCodesAreConsistent(status, codes, excerptTruncated)
    ) {
      return { kind: 'malformed' };
    }
  }

  // ---- Counts: non-negative integers that EXACTLY describe the claims.
  const counts = g['counts'];
  if (
    typeof counts !== 'object' ||
    counts === null ||
    !isNonNegativeInteger((counts as Record<string, unknown>)['total']) ||
    !isNonNegativeInteger((counts as Record<string, unknown>)['directTextObserved']) ||
    !isNonNegativeInteger(
      (counts as Record<string, unknown>)['unresolvedRequiresFurtherVerification'],
    ) ||
    !isNonNegativeInteger((counts as Record<string, unknown>)['invalidReferenceOrSnapshot']) ||
    !isNonNegativeInteger((counts as Record<string, unknown>)['notEvaluatedIdentityInvalid'])
  ) {
    return { kind: 'malformed' };
  }
  const countsRecord = counts as Record<string, number>;
  if (countsRecord['total'] !== claims.length) {
    return { kind: 'malformed' };
  }
  const byStatus = (status: string): number =>
    claims.filter((claim) => (claim as Record<string, unknown>)['status'] === status).length;
  if (
    countsRecord['directTextObserved'] !== byStatus('direct_text_observed') ||
    countsRecord['unresolvedRequiresFurtherVerification'] !==
      byStatus('unresolved_requires_further_verification') ||
    countsRecord['invalidReferenceOrSnapshot'] !== byStatus('invalid_reference_or_snapshot') ||
    countsRecord['notEvaluatedIdentityInvalid'] !== byStatus('not_evaluated_identity_invalid')
  ) {
    return { kind: 'malformed' };
  }

  // ---- Evaluation status vs claims vs the report's OWN stored identity.
  const citesCode = (claim: unknown, code: string): boolean =>
    ((claim as Record<string, unknown>)['reasonCodes'] as readonly string[]).includes(code);
  if (evaluationStatus === 'evaluated') {
    // An evaluated report must not carry identity-invalid claims or identity
    // failure codes, and its OWN stored identity fields must actually hold.
    if (
      evidenceId !== sourceItemId ||
      claims.some(
        (claim) =>
          (claim as Record<string, unknown>)['status'] === 'not_evaluated_identity_invalid',
      ) ||
      claims.some((claim) => citesCode(claim, 'evidence_id_identity_inconsistent')) ||
      claims.some((claim) => citesCode(claim, 'draft_snapshot_identity_mismatch'))
    ) {
      return { kind: 'malformed' };
    }
  } else {
    // invalid_snapshot_identity: EVERY claim is not_evaluated and cites the
    // identity failure. When the visible fields disagree, the visible code
    // is mandatory on every claim; otherwise the only possible cause is the
    // draft-side mismatch (the draft id itself is not stored in the report).
    const expectedCode =
      evidenceId !== sourceItemId
        ? 'evidence_id_identity_inconsistent'
        : 'draft_snapshot_identity_mismatch';
    if (
      claims.some(
        (claim) =>
          (claim as Record<string, unknown>)['status'] !== 'not_evaluated_identity_invalid',
      ) ||
      claims.some((claim) => !citesCode(claim, expectedCode))
    ) {
      return { kind: 'malformed' };
    }
  }

  return { kind: 'guard_v1', report: guard as unknown as EvidenceGuardReport };
}
