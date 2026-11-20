/**
 * Slice 4 — inbound AI rewriter (ai-policy-v2 ladder, plain-text rewrite).
 *
 * The bounded application service for the inbound rewrite step. It mirrors
 * the draft service's fail-closed discipline (ADR-0041) with a different
 * task: rewrite the owner's CLEANED text in Pixel's voice and return plain
 * text — never a structured draft, never a fabrication.
 *
 * 1. `AI_ENABLED` off/missing/invalid ⇒ typed deferred `ai_disabled` with
 *    ZERO provider calls, ZERO budget writes, ZERO binding access.
 * 2. The request is validated and byte-bounded (≤16 KiB UTF-8) BEFORE
 *    anything else; violations ⇒ typed deferred `input_invalid`.
 * 3. EVERY provider attempt requires a SUCCESSFUL DURABLE authorization
 *    through the per-provider budget store BEFORE the call (policy caps).
 *    Denied ⇒ the provider is skipped (a CF denial skips ALL remaining CF
 *    models — the same shared provider bucket); store failure ⇒ typed
 *    deferred `budget_store_error`, never mistaken for quota.
 * 4. Provider order: CF primary → CF alternate → Gemini ONLY if its
 *    independent eligibility is verified (default false — unverified Free
 *    tier stays OFF, zero network). A provider content/safety refusal is a
 *    TERMINAL typed refusal — no model or provider hopping to bypass it.
 * 5. Bounds: ≤3 provider calls, ≤768 output tokens, a TOTAL wall deadline
 *    of 15 s bounding the whole invocation. Output must be non-empty plain
 *    text (≤8192 chars); a fenced code block wrapper is stripped.
 * 6. No free path remains ⇒ typed deferred with a stable reason. The
 *    pipeline caller falls back to the cleaned text — NEVER fabricates.
 *
 * Logging is sanitized by construction: only stable event names,
 * provider/model ids, prompt version, outcome kinds and attempt counts.
 */
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import type { DbExecutor } from '../../adapters/db/db-executor';
import { authorizeAiRequestAttempt, recordAiUsage } from '../../adapters/db/ai-budget-store';
import {
  AI_BOUNDS,
  AI_DAILY_REQUEST_ATTEMPT_CAPS,
  AI_POLICY_VERSION,
  listModelsForProvider,
} from '../../domain/ai/policy';
import type {
  AiChatMessage,
  AiDeferredReason,
  AiProvider,
  AiProviderPort,
} from '../../domain/ai/types';
import type { GamingCategory } from '../../domain/inbound/classifier';
import {
  buildInboundRewriteSystemPrompt,
  INBOUND_REWRITE_PROMPT_VERSION,
} from '../../domain/inbound/rewrite-prompt';

export type InboundRewriteOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly attempts: number }
  | { readonly kind: 'deferred'; readonly reason: AiDeferredReason; readonly attempts: number }
  | {
      readonly kind: 'refused';
      readonly reason: 'provider_safety_refusal';
      readonly attempts: number;
    };

export interface InboundRewriter {
  rewrite(input: {
    readonly text: string;
    readonly category: GamingCategory;
    readonly isCaption: boolean;
  }): Promise<InboundRewriteOutcome>;
}

export interface AiInboundRewriterConfig {
  readonly aiEnabled: boolean;
  readonly geminiEnabled: boolean;
  readonly workersAiBindingPresent: boolean;
  readonly geminiApiKeyPresent: boolean;
}

export interface AiInboundRewriterDeps {
  readonly executor: DbExecutor;
  readonly ports: Readonly<Partial<Record<AiProvider, AiProviderPort>>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AiInboundRewriterConfig;
  readonly eligibility?: Readonly<Record<AiProvider, boolean>>;
}

/** Rewritten text bound: the formatter chunks it; this is the sanity cap. */
export const INBOUND_REWRITE_MAX_CHARS = 8192;

function defaultEligibility(): Record<AiProvider, boolean> {
  return { 'workers-ai': true, gemini: false };
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpen.replace(/\n?```\s*$/, '').trim();
  }
  return trimmed;
}

export function createAiInboundRewriter(deps: AiInboundRewriterDeps): InboundRewriter {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();

  return {
    async rewrite(input): Promise<InboundRewriteOutcome> {
      if (!deps.config.aiEnabled) {
        return { kind: 'deferred', reason: 'ai_disabled', attempts: 0 };
      }
      const text = input.text.trim();
      if (text === '' || encoder.encode(text).length > AI_BOUNDS.maxInputUtf8Bytes) {
        return { kind: 'deferred', reason: 'input_invalid', attempts: 0 };
      }

      const startedAt = deps.clock.now();
      const deadlineAtMs = startedAt + AI_BOUNDS.totalWallDeadlineMs;
      let attempts = 0;
      let providerCalls = 0;
      const skippedProviders = new Set<AiProvider>();
      const sharedQuotaProviders = new Set<AiProvider>();
      const authFailedProviders = new Set<AiProvider>();
      let geminiSkippedIneligible = false;
      let sawProviderAttempt = false;
      let sawQuotaDenial = false;

      const candidates: { readonly provider: AiProvider; readonly modelId: string }[] = [];
      for (const model of [
        ...listModelsForProvider('workers-ai'),
        ...listModelsForProvider('gemini'),
      ]) {
        if (model.provider === 'workers-ai') {
          if (!deps.config.workersAiBindingPresent || deps.ports['workers-ai'] === undefined) {
            skippedProviders.add('workers-ai');
            continue;
          }
        } else {
          if (!deps.config.geminiEnabled) {
            skippedProviders.add('gemini');
            continue;
          }
          if (!deps.config.geminiApiKeyPresent || deps.ports.gemini === undefined) {
            skippedProviders.add('gemini');
            continue;
          }
          if (!eligibility.gemini) {
            skippedProviders.add('gemini');
            geminiSkippedIneligible = true;
            continue;
          }
        }
        candidates.push({ provider: model.provider, modelId: model.modelId });
      }
      if (candidates.length === 0) {
        const reason: AiDeferredReason = !deps.config.workersAiBindingPresent
          ? 'binding_missing'
          : geminiSkippedIneligible
            ? 'eligibility_unverified'
            : 'no_free_path';
        return { kind: 'deferred', reason, attempts };
      }

      for (const candidate of candidates) {
        if (providerCalls >= AI_BOUNDS.maxProviderAttempts) {
          break;
        }
        if (deps.clock.now() >= deadlineAtMs) {
          break;
        }
        if (sharedQuotaProviders.has(candidate.provider)) {
          continue;
        }
        if (authFailedProviders.has(candidate.provider)) {
          continue;
        }

        let bucketDate: string;
        try {
          const authorization = await authorizeAiRequestAttempt(deps.executor, {
            provider: candidate.provider,
            cap: AI_DAILY_REQUEST_ATTEMPT_CAPS[candidate.provider],
            nowMs: deps.clock.now(),
          });
          if (authorization.kind === 'denied') {
            sharedQuotaProviders.add(candidate.provider);
            skippedProviders.add(candidate.provider);
            sawQuotaDenial = true;
            continue;
          }
          bucketDate = authorization.bucketDate;
        } catch {
          deps.logger.warn('ai.inbound_rewrite.budget_store_failed', {
            provider: candidate.provider,
          });
          return { kind: 'deferred', reason: 'budget_store_error', attempts };
        }
        if (deps.clock.now() >= deadlineAtMs) {
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }

        const port = deps.ports[candidate.provider];
        if (port === undefined) {
          continue;
        }
        providerCalls += 1;
        attempts += 1;
        sawProviderAttempt = true;
        const attemptStartedAt = deps.clock.now();
        const messages: AiChatMessage[] = [
          { role: 'system', content: buildInboundRewriteSystemPrompt(input.category) },
          { role: 'user', content: text },
        ];
        let callOutcome: Awaited<ReturnType<AiProviderPort['complete']>>;
        try {
          callOutcome = await port.complete({
            modelId: candidate.modelId,
            messages,
            maxOutputTokens: AI_BOUNDS.maxOutputTokens,
            deadlineAtMs,
          });
        } catch {
          deps.logger.info('ai.inbound_rewrite.attempt', {
            provider: candidate.provider,
            modelId: candidate.modelId,
            promptVersion: INBOUND_REWRITE_PROMPT_VERSION,
            policyVersion: AI_POLICY_VERSION,
            outcome: 'transient_failure',
            durationMs: deps.clock.now() - attemptStartedAt,
          });
          continue;
        }
        const durationMs = deps.clock.now() - attemptStartedAt;
        deps.logger.info('ai.inbound_rewrite.attempt', {
          provider: candidate.provider,
          modelId: candidate.modelId,
          promptVersion: INBOUND_REWRITE_PROMPT_VERSION,
          policyVersion: AI_POLICY_VERSION,
          outcome: callOutcome.kind,
          durationMs,
        });

        switch (callOutcome.kind) {
          case 'refused':
            return { kind: 'refused', reason: 'provider_safety_refusal', attempts };
          case 'deadline_exceeded':
            return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
          case 'quota_denied':
            sharedQuotaProviders.add(candidate.provider);
            skippedProviders.add(candidate.provider);
            sawQuotaDenial = true;
            break;
          case 'auth_failed':
            authFailedProviders.add(candidate.provider);
            skippedProviders.add(candidate.provider);
            break;
          case 'model_unavailable':
          case 'transient':
            break;
          case 'ok': {
            const rewritten = stripFence(callOutcome.rawText);
            if (rewritten === '' || rewritten.length > INBOUND_REWRITE_MAX_CHARS) {
              // Invalid output — a rejected attempt, never a successful
              // empty/oversized rewrite.
              break;
            }
            try {
              await recordAiUsage(deps.executor, {
                provider: candidate.provider,
                bucketDate,
                inputTokens: callOutcome.usage?.inputTokens,
                outputTokens: callOutcome.usage?.outputTokens,
                nowMs: deps.clock.now(),
              });
            } catch {
              deps.logger.warn('ai.inbound_rewrite.usage_record_failed', {
                provider: candidate.provider,
              });
            }
            return { kind: 'ok', text: rewritten, attempts };
          }
        }
      }

      const reason: AiDeferredReason =
        authFailedProviders.size > 0
          ? 'provider_auth_failed'
          : sawQuotaDenial
            ? 'budget_denied'
            : geminiSkippedIneligible && sawProviderAttempt
              ? 'eligibility_unverified'
              : sawProviderAttempt
                ? 'provider_unavailable'
                : 'no_free_path';
      deps.logger.info('ai.inbound_rewrite.result', { kind: 'deferred', reason, attempts });
      return { kind: 'deferred', reason, attempts };
    },
  };
}
