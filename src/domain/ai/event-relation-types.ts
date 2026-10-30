/**
 * Event-relation AI task types (Phase 5E-1 — R1.17, ADR-0045).
 *
 * A SEPARATE versioned task beside `news_draft` — the existing draft
 * request/contract and its fixed prompt are NEVER reused or reshaped into
 * adjudication. Pure, provider-agnostic contracts: the provider port stays
 * `AiProviderPort.complete`; the free-only fail-closed policy (ADR-0041)
 * applies unchanged (durable per-attempt budget authorization BEFORE any
 * call, safety refusal terminal, typed deferrals, no paid fallback).
 *
 * Semantics boundary (Posidon R1.17 §1): every verdict below is a MODEL
 * PROPOSAL over named evidence — `*_proposed`, never truth, never a
 * calibrated probability, never a merge/publish authorization. A shared
 * entity/URL/title alone is NOT a same-event decision, correlated signals
 * are NOT independent confirmation, `no candidate ≠ unrelated`, and a
 * technical failure (disabled/refusal/budget denial/invalid output/
 * deadline) is NEVER the model's semantic `insufficient_evidence` — those
 * states stay separate and typed (editorial side, event-relation-decision).
 */

import type { AiDeferredReason } from './types';

/** The proposed verdicts a model may return (enum — nothing else parses). */
export type EventRelationVerdict =
  'same_event_proposed' | 'different_event_proposed' | 'insufficient_evidence';

/** One valid model reference: the side + the EXACT evidence id given for
 * that side in the request. Any other id is a fabricated reference. */
export interface EventRelationReference {
  readonly side: 'A' | 'B';
  readonly evidenceId: string;
}

/** The validated model output for ONE pair (strict schema output). */
export interface EventRelationModelOutput {
  readonly pairId: string;
  readonly verdict: EventRelationVerdict;
  /** Short, bounded, traceable reasons (Persian free text, no commands). */
  readonly reasons: readonly string[];
  /** Valid references from BOTH sides (required for the two `*_proposed`
   * verdicts; explicitly contracted for `insufficient_evidence`). */
  readonly references: readonly EventRelationReference[];
  /** Recorded conflicting details (numbers/times/negations) when reported. */
  readonly conflicts: readonly string[];
}

/** One side of a pair request — public identity metadata + the bounded
 * real text basis. IDs are never mixed, even on name collisions. */
export interface EventRelationSideRequest {
  /** Stable public evidence id (the side's source_item id). */
  readonly evidenceId: string;
  /** Bounded real title/body text (excerpt basis; full vs truncated is
   * recorded by the caller, never silently cut here). */
  readonly text: string;
  /** The story/draft identity the text belongs to (side A: the story the
   * commit is about to create — identity fields, not a read row). */
  readonly storyId: string;
  readonly sourceItemId: string;
  readonly contentHash: string;
}

/** One bounded pair request. */
export interface EventRelationPairRequest {
  readonly pairId: string;
  readonly sideA: EventRelationSideRequest;
  readonly sideB: EventRelationSideRequest;
  /** Canonical input hash over BOTH bases + prompt/policy version. */
  readonly canonicalInputHash: string;
}

/** One REAL provider attempt observed for one pair (ai_runs honesty — a
 * never-attempted provider is never fabricated into a run row). */
export interface EventRelationAttemptRecord {
  readonly provider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly status: 'succeeded' | 'failed' | 'invalid';
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly errorCode: string | null;
}

/**
 * R1.17.2 (A2): the OBSERVATION of one REAL provider attempt, surfaced by
 * the service at the moment the attempt is recorded — BEFORE any later
 * result-mapping (and before any observability sink that may itself fail).
 * The caller's audit collector therefore does not depend on the step
 * RETURNING: an invocation that happened is observable even when the step
 * never completes its outcome mapping. Trusted internal context — the
 * observer is the caller's own collector, never a model-settable field.
 */
export interface EventRelationAttemptObservation {
  readonly pairId: string;
  /** The attempt's index WITHIN its pair (the deterministic run-id input). */
  readonly attemptIndex: number;
  /** The pair's canonical input hash (the run row's input_hash). */
  readonly canonicalInputHash: string;
  readonly attempt: EventRelationAttemptRecord;
}

/** Typed outcome of ONE pair inside the step. */
export type EventRelationPairOutcome =
  | {
      readonly pairId: string;
      readonly kind: 'evaluated';
      readonly verdict: EventRelationVerdict;
      readonly reasons: readonly string[];
      readonly references: readonly EventRelationReference[];
      readonly conflicts: readonly string[];
      readonly usage: {
        readonly provider: string;
        readonly modelId: string;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
      };
      readonly attempts: readonly EventRelationAttemptRecord[];
    }
  | {
      readonly pairId: string;
      readonly kind: 'refused';
      readonly attempts: readonly EventRelationAttemptRecord[];
    }
  | {
      readonly pairId: string;
      readonly kind: 'invalid_output';
      readonly attempts: readonly EventRelationAttemptRecord[];
    }
  | {
      readonly pairId: string;
      readonly kind: 'deferred';
      /** The stable typed reason — NEVER a semantic verdict. */
      readonly reason: AiDeferredReason | 'step_attempt_cap' | 'step_deadline';
      readonly attempts: readonly EventRelationAttemptRecord[];
    };

/** Typed pair-level deferral reasons (technical — never a semantic verdict). */
export type EventRelationPairDeferredReason = Extract<
  EventRelationPairOutcome,
  { kind: 'deferred' }
>['reason'];

/** The complete outcome surface of the event-relation service. */
export type EventRelationOutcome =
  | {
      readonly kind: 'decisions';
      readonly pairs: readonly EventRelationPairOutcome[];
    }
  | {
      readonly kind: 'deferred';
      /** Step-level typed deferral (input invalid / disabled): zero calls. */
      readonly reason: AiDeferredReason;
    };
