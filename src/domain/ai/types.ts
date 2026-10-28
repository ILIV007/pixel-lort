/**
 * AI domain types (Phase 6 — Workers-AI-first adapters, ADR-0041).
 *
 * Pure, provider-agnostic contracts. This module deliberately imports NO
 * Cloudflare/provider SDK types: native `Ai`/`fetch` details live at the
 * adapter boundaries (src/adapters/ai/) and are injected into the
 * application service for deterministic, fully offline tests.
 *
 * Free-only and fail-closed policy (owner round 1.10.6):
 * - Every potential paid/computational attempt requires a successful durable
 *   authorization BEFORE any provider call (see ai-budget-store).
 * - A provider content/safety refusal is a TERMINAL typed refusal — the
 *   service never hops models/providers to bypass safety.
 * - When no free path remains the outcome is a typed DEFERRED result with a
 *   stable reason and a known retry boundary when available. No silent drop,
 *   no paid fallback.
 */

/** Supported AI providers (Workers AI primary; Gemini secondary). */
export type AiProvider = 'workers-ai' | 'gemini';

/** Versioned task types. Exactly one exists in this round. */
export type AiTaskType = 'news_draft';

/** Output locale. Persian is the product requirement (blueprint §1). */
export type AiLocale = 'fa';

/**
 * One public evidence snippet handed to the model. News text is UNTRUSTED
 * DATA — never instructions (enforced by the prompt contract and re-checked
 * by output validation). IDs must be stable and match the ingestion-side
 * identifier shape.
 */
export interface AiEvidenceSnippet {
  /** Stable public evidence identifier (ingestion-side source_item id). */
  readonly id: string;
  /** Bounded public evidence text. Never private chats, secrets, or dumps. */
  readonly text: string;
}

/** Bounded draft request. Validated by the application service (Zod). */
export interface AiDraftRequest {
  readonly taskType: AiTaskType;
  readonly evidence: readonly AiEvidenceSnippet[];
  readonly locale: AiLocale;
}

/** Validated semantic draft the model must emit (Zod-validated). */
export interface AiSemanticDraft {
  readonly headlineFa: string;
  readonly summaryFa: string;
  readonly claims: readonly AiSemanticClaim[];
}

export interface AiSemanticClaim {
  readonly text: string;
  /** Every referenced id MUST exist in the request evidence set. */
  readonly evidenceIds: readonly string[];
}

/**
 * Clearly-labelled usage metadata. Tokens are reported ONLY when the
 * provider actually reported them; absence is honest. These numbers are
 * NOT Cloudflare Neuron accounting and NOT a Google quota meter.
 */
export interface AiUsageMetadata {
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Stable deferred reasons (typed, never silent). */
export type AiDeferredReason =
  | 'ai_disabled'
  | 'config_invalid'
  | 'input_invalid'
  | 'binding_missing'
  | 'key_missing'
  | 'eligibility_unverified'
  | 'budget_denied'
  | 'budget_store_error'
  | 'deadline_exceeded'
  | 'provider_unavailable'
  | 'provider_auth_failed'
  | 'no_free_path';

/** Sanitized attempt record — safe for logs and caller inspection. */
export interface AiAttemptRecord {
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly outcome:
    | 'succeeded'
    | 'refused'
    | 'transient_failure'
    | 'model_unavailable'
    | 'quota_denied'
    | 'auth_failed'
    | 'deadline_exceeded'
    | 'skipped_shared_quota'
    | 'skipped_ineligible'
    | 'skipped_deadline'
    | 'invalid_output';
  readonly durationMs: number;
}

/** Terminal provider safety refusal — never retried on another model. */
export interface AiRefusal {
  readonly kind: 'refusal';
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly reason: 'provider_safety_refusal';
  readonly attempts: readonly AiAttemptRecord[];
}

/** Typed deferred outcome — the free-only path is exhausted or gated OFF. */
export interface AiDeferred {
  readonly kind: 'deferred';
  readonly reason: AiDeferredReason;
  /** Known retry boundary in ms (e.g. provider Retry-After); undefined = unknown. */
  readonly retryAfterMs?: number;
  readonly attempts: readonly AiAttemptRecord[];
}

/** Successful validated draft with sanitized usage metadata. */
export interface AiDraftSuccess {
  readonly kind: 'draft';
  readonly draft: AiSemanticDraft;
  readonly usage: readonly AiUsageMetadata[];
  readonly attempts: readonly AiAttemptRecord[];
}

/** The complete outcome surface of the draft service. */
export type AiOutcome = AiDraftSuccess | AiRefusal | AiDeferred;

/**
 * Provider-agnostic call outcome returned by adapter ports. Adapters map
 * native errors/HTTP statuses into these stable kinds; raw provider
 * payloads, headers, URLs and credentials NEVER cross this boundary.
 */
export type AiCallOutcome =
  | { readonly kind: 'ok'; readonly rawText: string; readonly usage?: AiReportedUsage }
  | { readonly kind: 'refused' }
  | { readonly kind: 'model_unavailable'; readonly retryAfterMs?: number }
  | { readonly kind: 'quota_denied'; readonly retryAfterMs?: number }
  | { readonly kind: 'transient'; readonly retryAfterMs?: number }
  | { readonly kind: 'auth_failed' }
  | { readonly kind: 'deadline_exceeded' };

/** Provider-reported token usage (optional, clearly labelled, never invented). */
export interface AiReportedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Chat message passed to a provider port. The system message comes from the
 * versioned prompt contract; the user message carries bounded evidence
 * wrapped as UNTRUSTED DATA.
 */
export interface AiChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/**
 * Provider port implemented by native adapters (Workers AI binding, Gemini
 * HTTP). Implementations MUST honor the bounded wall deadline to the best
 * of the runtime's ability and MUST classify native failures into the
 * stable AiCallOutcome kinds without leaking raw payloads.
 */
export interface AiProviderPort {
  readonly provider: AiProvider;
  /**
   * Run one bounded chat completion. `deadlineAtMs` is an ABSOLUTE clock
   * deadline (injected clock domain); the adapter must not exceed it by its
   * own means and the service accounts conservatively for any in-flight
   * work a runtime cannot cancel (documented Workers AI limitation).
   */
  complete(input: {
    readonly modelId: string;
    readonly messages: readonly AiChatMessage[];
    readonly maxOutputTokens: number;
    readonly deadlineAtMs: number;
  }): Promise<AiCallOutcome>;
}
