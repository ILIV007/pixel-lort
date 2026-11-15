/**
 * Versioned AI model/prompt policy (Phase 6 — ADR-0041).
 *
 * IMMUTABLE, VERSIONED ALLOWLIST — application policy over explicit model
 * IDs only. The literal "auto" is never a model id and unknown models from
 * any provider catalog are never trusted. New candidates enter ONLY as a
 * new policy version after current public official model/pricing docs have
 * been verified (a public-doc fetch failure is NOT proof of eligibility).
 *
 * Candidate CF ids evaluated for this version (round 1.10.6 instruction):
 * @cf/meta/llama-3.1-8b-instruct-fp8, @cf/qwen/qwen3-30b-a3b-fp8,
 * @cf/meta/llama-3.3-70b-instruct-fp8-fast. Per the instruction's "small
 * verified compatible allowlist, preferably a lightweight default plus one
 * alternate", THIS version ships the lightweight 8B default plus the Qwen3
 * alternate; the 70B-fast candidate intentionally stays out of the active
 * list. Gemini: only gemini-2.5-flash-lite is listed, and its ELIGIBILITY
 * stays UNVERIFIED (see AI_PROVIDER_ELIGIBILITY_V1) — unsupported or
 * unverified candidates stay disabled rather than inventing a free
 * entitlement. gemini-3.1-flash-lite is NOT listed: its support status was
 * not verifiable in this round.
 */

import type { AiProvider } from './types';

/** Version marker for the shipped allowlist/eligibility set. */
export const AI_POLICY_VERSION = 'ai-policy-v1';

/** Version marker for the shipped prompt contract (see ./prompt.ts). */
export const AI_PROMPT_VERSION = 'pixel-news-draft-v1';

/** Validated, testable application bounds (round 1.10.6 instruction §3). */
export const AI_BOUNDS = {
  /** Public input bound (evidence text total, UTF-8 bytes). */
  maxInputUtf8Bytes: 16 * 1024,
  /** Output token bound passed to providers. */
  maxOutputTokens: 768,
  /** TOTAL wall deadline for one service invocation (all attempts/fallbacks). */
  totalWallDeadlineMs: 15_000,
  /** Maximum provider attempts per service invocation. */
  maxProviderAttempts: 3,
  /** Evidence snippet count bounds. */
  minEvidenceCount: 1,
  maxEvidenceCount: 8,
} as const;

/** Role of a model inside the fallback ladder. */
export type AiModelRole = 'primary' | 'alternate' | 'fallback';

/** One immutable allowlist entry. */
export interface AiModelRecord {
  readonly modelId: string;
  readonly provider: AiProvider;
  readonly role: AiModelRole;
  /**
   * Gemini entries additionally require verified Free-tier eligibility
   * (AI_PROVIDER_ELIGIBILITY_V1); `requiresEligibility` is false only for
   * the Workers-AI binding path, whose gate is the binding + flag itself.
   */
  readonly requiresEligibility: boolean;
}

/**
 * The ONLY models this policy version may call, in ladder order:
 * Workers AI primary → Workers AI alternate → (conditional) Gemini.
 */
export const AI_MODEL_ALLOWLIST_V1: readonly AiModelRecord[] = [
  {
    modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
    provider: 'workers-ai',
    role: 'primary',
    requiresEligibility: false,
  },
  {
    modelId: '@cf/qwen/qwen3-30b-a3b-fp8',
    provider: 'workers-ai',
    role: 'alternate',
    requiresEligibility: false,
  },
  {
    modelId: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    role: 'fallback',
    requiresEligibility: true,
  },
];

/**
 * Per-provider eligibility for THIS policy version.
 *
 * 'binding_gated' — usable iff the native binding/flag is present (Workers
 * AI; the binding itself is the account access proof for the binding path).
 * 'unverified_free_tier' — Gemini: documentation availability, account
 * access, Free-tier status and Persian quality are DISTINCT concerns; the
 * key/binding alone proves none of them, so the fallback stays OFF until an
 * operator round verifies current official Free-tier docs and records the
 * verification. Unknown eligibility => typed deferred, zero network.
 */
export const AI_PROVIDER_ELIGIBILITY_V1: Readonly<
  Record<AiProvider, 'binding_gated' | 'unverified_free_tier'>
> = {
  'workers-ai': 'binding_gated',
  gemini: 'unverified_free_tier',
};

/**
 * Conservative PER-PROVIDER app request-ATTEMPT caps per Tehran day,
 * charged through the EXISTING budgets table (scope 'ai') BEFORE every
 * call. Units are app request attempts — NOT Cloudflare Neurons, NOT
 * Google quota, NOT an account-wide billing meter. Workers AI free
 * Neurons are SHARED across its models: changing models does not
 * replenish quota, so a shared-quota denial on one CF model skips the
 * other CF model regardless of these app counters.
 */
export const AI_DAILY_REQUEST_ATTEMPT_CAPS: Readonly<Record<AiProvider, number>> = {
  'workers-ai': 40,
  gemini: 40,
};

/** All allowlist entries for one provider, in ladder order. */
export function listModelsForProvider(provider: AiProvider): readonly AiModelRecord[] {
  return AI_MODEL_ALLOWLIST_V1.filter((model) => model.provider === provider);
}

/** True iff the model id is in THIS policy version's allowlist. */
export function isAllowedModel(provider: AiProvider, modelId: string): boolean {
  return AI_MODEL_ALLOWLIST_V1.some(
    (model) => model.provider === provider && model.modelId === modelId,
  );
}
