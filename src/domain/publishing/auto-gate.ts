import { readFactGuardReport, type FactGuardClaimResult } from '../editorial/fact-guard';
import {
  renderEditorialPostText,
  type EditorialPostRenderFailureReason,
} from '../admin-post/editorial-post-render';

/**
 * THE AUTO-PUBLISH CANDIDATE GATE (`ag1`) — plan slice 3's measurable,
 * fail-closed AUTO gate for the final AUTO stage's per-candidate decision.
 *
 * WHAT IT DECIDES (from the STORED data only, never prose): whether a ready
 * editorial draft may ride AUTOMATED publishing — the `auto`/`safe_auto`
 * outbox modes the schema-6 matrix already knows — without a human reading
 * THIS candidate first.
 *
 * THE MEASURABLE INPUTS (all-or-nothing, every one required):
 *  1. THE DOCUMENT RE-READ: the stored bytes are re-validated through the
 *     SAME strict reader discipline the send path uses
 *     (`renderEditorialPostText`). A document whose shape the renderer
 *     refuses (a laundered claim status, an unsupported schemaVersion, a
 *     malformed shape) can never be AUTO-approved, and a composition the
 *     renderer refuses on its caps is a DOOMED publication — never created
 *     quietly (the album producer's lesson, applied to AUTO).
 *  2. THE FACT-GUARD REPORT: the report MUST be present (its absence — the
 *     flag-off historical shape — is the fail-closed refusal, never a
 *     pass), well-formed, version-supported, and evaluated over a
 *     CONSISTENT snapshot identity.
 *  3. THE TOTALITY: the report must cover EXACTLY the document's own model
 *     claims — one result per claim index, no gaps, no strangers. A report
 *     that evaluated a different claim set is not a measurable basis.
 *  4. THE GROUNDING: ANY non-benign finding on ANY claim (the report's own
 *     `reviewRequired`) ⇒ the HUMAN review path with the per-claim finding
 *     codes as the reason. A claim the guard could not ground in the stored
 *     excerpt is exactly the unsupported-claim family (and the measurable
 *     containment for injection-shaped content: injection text is INERT
 *     DATA — it is never interpreted or obeyed; a claim it generated has no
 *     lexical basis in the stored excerpt and refuses here by CODE, not by
 *     any semantic detection claim).
 *
 * WHAT THE VERDICT CARRIES: the report's own limitation labels ride EVERY
 * verdict verbatim — the machine never claims semantic proof; the labels
 * (`lexical_presence_not_truth`, `marker_lists_are_not_exhaustive`, …) are
 * the honest boundary of what "grounded" means here.
 *
 * WHAT THE GATE NEVER DOES: no database access, no provider call, no
 * publish, no approval minted. The verdict is DATA; the DURABLE transition
 * (`approveDraftForAutoPublication`) is a separate, independently-gated
 * step — eligibility is NOT activation, and a non-eligible verdict can
 * never flip a row (the transition refuses it before any write).
 *
 * TOTAL and JSON-equal deterministic over the stored bytes (the house
 * pattern): the same bytes always yield the same verdict shape.
 */

/** The gate's own version — bump ONLY with a documented contract change. */
export const AUTO_GATE_VERSION = 'ag1' as const;

/**
 * The typed refusal family: the gate found the stored basis UNUSABLE —
 * these are NOT review outcomes, they are the fail-closed "no measurable
 * basis" refusals. The detail carries the underlying typed reason verbatim
 * where one exists (bounded, stable — never free text).
 */
export type AutoGateRefusalReason =
  | 'document_unreadable'
  | 'composition_not_sendable'
  | 'report_absent'
  | 'report_malformed'
  | 'report_version_unsupported'
  | 'snapshot_identity_invalid'
  | 'no_claims'
  | 'report_claims_incomplete';

/** One per-claim review entry: the index + the guard's OWN finding codes. */
export interface AutoGateReviewClaim {
  readonly claimIndex: number;
  readonly findings: readonly string[];
}

export type AutoGateVerdict =
  | {
      readonly kind: 'refused';
      readonly reason: AutoGateRefusalReason;
      readonly detail: string;
    }
  | {
      readonly kind: 'requires_review';
      readonly reason: 'fact_guard_findings';
      readonly claims: readonly AutoGateReviewClaim[];
      readonly limitationLabels: readonly string[];
    }
  | {
      readonly kind: 'eligible_auto';
      readonly claimCount: number;
      readonly factGuardVersion: number;
      readonly limitationLabels: readonly string[];
    };

/** The document-shape failure reasons (the strict reader's own family). */
const DOCUMENT_SHAPE_FAILURES: ReadonlySet<string> = new Set([
  'malformed_json',
  'unsupported_version',
  'malformed_document',
  'empty_headline',
] as const);

/**
 * The gate order is FAIL-CLOSED and fixed: the document basis first (the
 * send path's own discipline), then the report basis, then the totality,
 * then the per-claim grounding. The first failure wins — nothing is
 * repaired, guessed or partially evaluated.
 */
export function evaluateAutoPublishGate(documentJson: string): AutoGateVerdict {
  // 1. THE DOCUMENT RE-READ through the send path's strict reader: the
  //    renderer validates the shape AND the claim-status discipline AND
  //    the composition caps in ONE pass — a draft that cannot be rendered
  //    can never be AUTO-approved (a doomed publication is never created
  //    quietly).
  const rendered = renderEditorialPostText(documentJson);
  if (!rendered.ok) {
    const reason = rendered.reason as EditorialPostRenderFailureReason;
    if (DOCUMENT_SHAPE_FAILURES.has(reason)) {
      return {
        kind: 'refused',
        reason: 'document_unreadable',
        detail: reason,
      };
    }
    return {
      kind: 'refused',
      reason: 'composition_not_sendable',
      detail: reason,
    };
  }

  // 2. THE STORED DOCUMENT, parsed once more for the claim/report reading
  //    (the renderer already proved the shape parseable and validated).
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson);
  } catch {
    // Unreachable after the renderer's ok — kept for the TOTAL contract.
    return { kind: 'refused', reason: 'document_unreadable', detail: 'malformed_json' };
  }
  const document = parsed as Record<string, unknown>;
  const modelClaims = Array.isArray(document['modelClaims']) ? document['modelClaims'] : [];
  if (modelClaims.length === 0) {
    return { kind: 'refused', reason: 'no_claims', detail: 'document_has_zero_model_claims' };
  }

  // 3. THE FACT-GUARD REPORT BASIS: absent/malformed/unsupported/identity.
  const read = readFactGuardReport(parsed);
  if (read.kind === 'absent') {
    return { kind: 'refused', reason: 'report_absent', detail: 'fact_guard_key_not_written' };
  }
  if (read.kind === 'malformed') {
    return { kind: 'refused', reason: 'report_malformed', detail: 'fact_guard_v1_shape_refused' };
  }
  if (read.kind === 'unsupported_version') {
    return {
      kind: 'refused',
      reason: 'report_version_unsupported',
      detail: 'fact_guard_version_not_v1',
    };
  }
  const report = read.report;
  if (report.evaluationStatus === 'invalid_snapshot_identity') {
    return {
      kind: 'refused',
      reason: 'snapshot_identity_invalid',
      detail: 'fact_guard_could_not_bind_the_snapshot',
    };
  }

  // 4. THE TOTALITY: the report must cover EXACTLY the document's own
  //    claim indices — 0..n-1, each once, no strangers.
  const claimResults: readonly FactGuardClaimResult[] = report.claims;
  const expectedIndices = modelClaims.length;
  const seen = new Set<number>();
  for (const result of claimResults) {
    const index = result.claimIndex;
    if (!Number.isInteger(index) || index < 0 || index >= expectedIndices || seen.has(index)) {
      return {
        kind: 'refused',
        reason: 'report_claims_incomplete',
        detail: 'report_does_not_cover_the_document_claims_exactly',
      };
    }
    seen.add(index);
  }
  if (seen.size !== expectedIndices) {
    return {
      kind: 'refused',
      reason: 'report_claims_incomplete',
      detail: 'report_does_not_cover_the_document_claims_exactly',
    };
  }

  // 5. THE GROUNDING: the report's OWN reviewRequired per claim — the
  //    machine never publishes a claim it cannot ground in the stored
  //    excerpt (references alone are not semantic proof; the limitation
  //    labels ride the verdict verbatim).
  const reviewClaims = claimResults
    .filter((result) => result.reviewRequired === true)
    .map((result) => ({
      claimIndex: result.claimIndex,
      findings: result.findings.map((finding) => finding.code),
    }));
  if (reviewClaims.length > 0) {
    return {
      kind: 'requires_review',
      reason: 'fact_guard_findings',
      claims: reviewClaims,
      limitationLabels: report.limitations,
    };
  }

  return {
    kind: 'eligible_auto',
    claimCount: expectedIndices,
    factGuardVersion: report.factGuardVersion,
    limitationLabels: report.limitations,
  };
}
