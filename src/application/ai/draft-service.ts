/**
 * AI draft service (Phase 6 — ADR-0041 §4): the bounded application
 * service callable from application code. No new public AI endpoint, no
 * admin command, no cron/queue wiring in this round — the future durable
 * caller is responsible for persistence; this service itself keeps NO
 * queue/circuit-breaker state (honest scope, see ADR-0041).
 *
 * Free-only, fail-closed orchestration over the versioned policy:
 * 1. `AI_ENABLED` off/missing/invalid ⇒ typed deferred `ai_disabled` with
 *    ZERO provider calls, ZERO budget writes, ZERO binding access.
 * 2. The request is Zod-validated and byte-bounded (≤16 KiB evidence
 *    UTF-8) BEFORE anything else; violations ⇒ typed deferred
 *    `input_invalid`.
 * 3. EVERY provider attempt requires a SUCCESSFUL DURABLE authorization
 *    through the per-provider budget store BEFORE the call. Denied ⇒
 *    charged-as-denied attempt and the provider is skipped (a CF denial
 *    skips ALL remaining CF models — the same shared provider bucket);
 *    store failure ⇒ typed deferred `budget_store_error`, never mistaken
 *    for quota.
 * 4. Provider order: CF primary → CF alternate (only for suitable
 *    model-specific unavailable/retired/transient failures) → Gemini ONLY
 *    if its independent eligibility/budget/key are valid. A provider
 *    content/safety refusal is a TERMINAL typed refusal — no model or
 *    provider hopping to bypass safety.
 * 5. Bounds: ≤3 provider attempts, ≤768 output tokens, and a TOTAL wall
 *    deadline (injected clock) that stops further fallback work and
 *    prevents a late authorization from starting a new call. Workers AI
 *    binding calls cannot be natively cancelled — a timed-out attempt is
 *    still charged (conservative, documented).
 * 6. Provider output is Zod-validated (schema + evidenceIds ⊆ request
 *    evidence); malformed/truncated/oversized/unknown-reference output is
 *    a rejected attempt — never a successful empty draft.
 * 7. No free path remains ⇒ typed deferred with a stable reason and a
 *    known retry boundary when available. No silent drop, no paid
 *    fallback.
 *
 * Logging is sanitized by construction: only stable event names,
 * provider/model ids, prompt version, outcome kinds, attempt counts and
 * clearly-labelled usage metadata ever reach the logger.
 */
import { z } from 'zod';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import type { DbExecutor } from '../../adapters/db/db-executor';
import { authorizeAiRequestAttempt, recordAiUsage } from '../../adapters/db/ai-budget-store';
import {
  AI_BOUNDS,
  AI_DAILY_REQUEST_ATTEMPT_CAPS,
  AI_POLICY_VERSION,
  AI_PROMPT_VERSION,
  listModelsForProvider,
} from '../../domain/ai/policy';
import { buildNewsDraftSystemPrompt, buildNewsDraftUserPrompt } from '../../domain/ai/prompt';
import { parseAiSemanticDraftJson } from '../../domain/ai/schema';
import type {
  AiAttemptRecord,
  AiChatMessage,
  AiDeferredReason,
  AiOutcome,
  AiProvider,
  AiProviderPort,
} from '../../domain/ai/types';

/** Stable evidence identifier shape (same family as ingestion ids). */
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const evidenceSnippetSchema = z
  .object({
    id: z.string().regex(EVIDENCE_ID_PATTERN),
    text: z.string().min(1),
  })
  .strict();

const aiDraftRequestSchema = z
  .object({
    taskType: z.literal('news_draft'),
    locale: z.literal('fa'),
    evidence: z
      .array(evidenceSnippetSchema)
      .min(AI_BOUNDS.minEvidenceCount)
      .max(AI_BOUNDS.maxEvidenceCount),
  })
  .strict();

export interface AiDraftServiceConfig {
  /** Validated AI_ENABLED flag (parseAiConfig). */
  readonly aiEnabled: boolean;
  /** Validated AI_GEMINI_ENABLED operator gate (parseAiConfig). */
  readonly geminiEnabled: boolean;
  /** Whether the native Workers AI binding is present in the runtime. */
  readonly workersAiBindingPresent: boolean;
  /** Whether a Gemini API key is configured (presence only — never the value). */
  readonly geminiApiKeyPresent: boolean;
}

export interface AiDraftServiceDeps {
  readonly executor: DbExecutor;
  /** Provider ports keyed by provider (missing port = provider unavailable). */
  readonly ports: Readonly<Partial<Record<AiProvider, AiProviderPort>>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AiDraftServiceConfig;
  /**
   * Eligibility view (per provider). Defaults to the versioned policy
   * (Gemini false — unverified Free tier); only a future round with
   * documented verification flips it. Injectable for deterministic tests.
   */
  readonly eligibility?: Readonly<Record<AiProvider, boolean>>;
}

export interface AiDraftService {
  generateNewsDraft(request: unknown): Promise<AiOutcome>;
}

interface Candidate {
  readonly provider: AiProvider;
  readonly modelId: string;
}

function defaultEligibility(): Record<AiProvider, boolean> {
  return { 'workers-ai': true, gemini: false };
}

export function createAiDraftService(deps: AiDraftServiceDeps): AiDraftService {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();
  const systemPrompt = buildNewsDraftSystemPrompt();

  async function generateNewsDraft(request: unknown): Promise<AiOutcome> {
    // ---- Gate 1: the master flag is the FIRST decision, before any work.
    if (!deps.config.aiEnabled) {
      return { kind: 'deferred', reason: 'ai_disabled', attempts: [] };
    }

    // ---- Gate 2: bounded request validation (fail closed, zero side effects).
    const parsedRequest = aiDraftRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }
    const evidence = parsedRequest.data.evidence;
    const evidenceIds = new Set(evidence.map((snippet) => snippet.id));
    const totalEvidenceBytes = evidence.reduce(
      (total, snippet) => total + encoder.encode(snippet.text).length,
      0,
    );
    if (totalEvidenceBytes > AI_BOUNDS.maxInputUtf8Bytes) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }

    const startedAt = deps.clock.now();
    const deadlineAtMs = startedAt + AI_BOUNDS.totalWallDeadlineMs;
    const attempts: AiAttemptRecord[] = [];
    const skippedProviders = new Set<AiProvider>();
    const sharedQuotaProviders = new Set<AiProvider>();
    const authFailedProviders = new Set<AiProvider>();
    let providerCalls = 0;
    let knownRetryAfterMs = 0;
    let geminiSkippedIneligible = false;

    const record = (
      candidate: Candidate,
      outcome: AiAttemptRecord['outcome'],
      durationMs: number,
    ): void => {
      attempts.push({
        provider: candidate.provider,
        modelId: candidate.modelId,
        promptVersion: AI_PROMPT_VERSION,
        outcome,
        durationMs,
      });
      deps.logger.info('ai.draft.attempt', {
        provider: candidate.provider,
        modelId: candidate.modelId,
        promptVersion: AI_PROMPT_VERSION,
        policyVersion: AI_POLICY_VERSION,
        outcome,
        durationMs,
      });
    };

    // ---- Candidate ladder (versioned allowlist order).
    const candidates: Candidate[] = [];
    for (const model of [
      ...listModelsForProvider('workers-ai'),
      ...listModelsForProvider('gemini'),
    ]) {
      if (skippedProviders.has(model.provider)) {
        continue;
      }
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
          // Unknown eligibility => typed unavailability, zero network.
          skippedProviders.add('gemini');
          geminiSkippedIneligible = true;
          continue;
        }
      }
      candidates.push({ provider: model.provider, modelId: model.modelId });
    }

    if (candidates.length === 0) {
      return {
        kind: 'deferred',
        reason: classifyZeroCandidates(deps.config, eligibility, geminiSkippedIneligible),
        attempts,
      };
    }

    const portFor = (provider: AiProvider): AiProviderPort => {
      const port = deps.ports[provider];
      if (port === undefined) {
        throw new Error('provider port missing after candidacy check');
      }
      return port;
    };

    for (const candidate of candidates) {
      // The ≤3 cap counts REAL provider calls; ledger skips do not.
      if (providerCalls >= AI_BOUNDS.maxProviderAttempts) {
        break;
      }
      // The wall deadline stops further fallback work — a late
      // authorization must never start a new provider call.
      if (deps.clock.now() >= deadlineAtMs) {
        record(candidate, 'skipped_deadline', 0);
        break;
      }
      // A shared provider-bucket quota denial (or a provider auth/config
      // failure) skips ALL remaining candidates of the SAME provider.
      if (sharedQuotaProviders.has(candidate.provider)) {
        record(candidate, 'skipped_shared_quota', 0);
        continue;
      }
      if (authFailedProviders.has(candidate.provider)) {
        record(candidate, 'skipped_provider_failed', 0);
        continue;
      }

      // ---- Durable authorization BEFORE the attempt (no grant, no call).
      let bucketDate: string;
      try {
        const authorization = await authorizeAiRequestAttempt(deps.executor, {
          provider: candidate.provider,
          cap: AI_DAILY_REQUEST_ATTEMPT_CAPS[candidate.provider],
          nowMs: deps.clock.now(),
        });
        if (authorization.kind === 'denied') {
          record(candidate, 'quota_denied', 0);
          // Same shared provider bucket: remaining same-provider candidates
          // are futile and are skipped (and LEDGERED) at the loop top.
          sharedQuotaProviders.add(candidate.provider);
          skippedProviders.add(candidate.provider);
          continue;
        }
        bucketDate = authorization.bucketDate;
      } catch {
        // Budget-store infrastructure failures are DISTINCT from quota
        // exhaustion: zero provider calls, typed deferred outcome.
        deps.logger.warn('ai.draft.budget_store_failed', { provider: candidate.provider });
        return { kind: 'deferred', reason: 'budget_store_error', attempts };
      }

      // ---- The authorized attempt (counted against the cap even if the
      // port throws — the attempt was made and stays charged).
      providerCalls += 1;
      const attemptStartedAt = deps.clock.now();
      const messages: AiChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildNewsDraftUserPrompt(evidence) },
      ];
      let callOutcome: Awaited<ReturnType<AiProviderPort['complete']>>;
      try {
        callOutcome = await portFor(candidate.provider).complete({
          modelId: candidate.modelId,
          messages,
          maxOutputTokens: AI_BOUNDS.maxOutputTokens,
          deadlineAtMs,
        });
      } catch {
        // A port throwing past its own mapping is a defensive transient.
        record(candidate, 'transient_failure', deps.clock.now() - attemptStartedAt);
        continue;
      }
      const durationMs = deps.clock.now() - attemptStartedAt;

      switch (callOutcome.kind) {
        case 'refused': {
          // TERMINAL typed refusal — never hop models/providers to bypass
          // a content/safety rejection.
          record(candidate, 'refused', durationMs);
          deps.logger.info('ai.draft.result', { kind: 'refusal', attempts: attempts.length });
          return {
            kind: 'refusal',
            provider: candidate.provider,
            modelId: candidate.modelId,
            reason: 'provider_safety_refusal',
            attempts,
          };
        }
        case 'deadline_exceeded': {
          record(candidate, 'deadline_exceeded', durationMs);
          deps.logger.info('ai.draft.result', { kind: 'deferred', reason: 'deadline_exceeded' });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        case 'ok': {
          const parsed = parseAiSemanticDraftJson(callOutcome.rawText);
          if (!parsed.ok) {
            record(candidate, 'invalid_output', durationMs);
            break;
          }
          // Cross-check: every referenced evidence id MUST exist in the
          // request evidence set (referenced ids alone do NOT prove the
          // generated claim is true — the fact guard stays downstream).
          const unknownReference = parsed.draft.claims.some((claim) =>
            claim.evidenceIds.some((id) => !evidenceIds.has(id)),
          );
          if (unknownReference) {
            record(candidate, 'invalid_output', durationMs);
            break;
          }
          const usageEntry: {
            provider: AiProvider;
            modelId: string;
            promptVersion: string;
            inputTokens?: number;
            outputTokens?: number;
          } = {
            provider: candidate.provider,
            modelId: candidate.modelId,
            promptVersion: AI_PROMPT_VERSION,
          };
          if (callOutcome.usage?.inputTokens !== undefined) {
            usageEntry.inputTokens = callOutcome.usage.inputTokens;
          }
          if (callOutcome.usage?.outputTokens !== undefined) {
            usageEntry.outputTokens = callOutcome.usage.outputTokens;
          }
          // Best-effort, non-authoritative usage recording; a storage
          // failure here never fails the successful result.
          try {
            await recordAiUsage(deps.executor, {
              provider: candidate.provider,
              bucketDate,
              inputTokens: callOutcome.usage?.inputTokens,
              outputTokens: callOutcome.usage?.outputTokens,
              nowMs: deps.clock.now(),
            });
          } catch {
            deps.logger.warn('ai.draft.usage_record_failed', { provider: candidate.provider });
          }
          record(candidate, 'succeeded', durationMs);
          deps.logger.info('ai.draft.result', {
            kind: 'draft',
            provider: candidate.provider,
            modelId: candidate.modelId,
            attempts: attempts.length,
            usage: {
              inputTokens: usageEntry.inputTokens ?? null,
              outputTokens: usageEntry.outputTokens ?? null,
            },
          });
          return { kind: 'draft', draft: parsed.draft, usage: [usageEntry], attempts };
        }
        case 'quota_denied': {
          record(candidate, 'quota_denied', durationMs);
          skippedProviders.add(candidate.provider);
          sharedQuotaProviders.add(candidate.provider);
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          break;
        }
        case 'auth_failed': {
          record(candidate, 'auth_failed', durationMs);
          skippedProviders.add(candidate.provider);
          authFailedProviders.add(candidate.provider);
          break;
        }
        case 'model_unavailable':
        case 'transient': {
          record(
            candidate,
            callOutcome.kind === 'model_unavailable' ? 'model_unavailable' : 'transient_failure',
            durationMs,
          );
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          break;
        }
      }
    }

    const reason = classifyExhausted(attempts, {
      skippedProviders,
      authFailedProviders,
      geminiSkippedIneligible,
      sawProviderAttempt: attempts.some((attempt) => isProviderOutcome(attempt.outcome)),
      sawQuotaDenial: attempts.some((attempt) => attempt.outcome === 'quota_denied'),
    });
    deps.logger.info('ai.draft.result', { kind: 'deferred', reason, attempts: attempts.length });
    return {
      kind: 'deferred',
      reason,
      retryAfterMs: knownRetryAfterMs > 0 ? knownRetryAfterMs : undefined,
      attempts,
    };
  }

  return { generateNewsDraft };
}

function isProviderOutcome(outcome: AiAttemptRecord['outcome']): boolean {
  return (
    outcome === 'succeeded' ||
    outcome === 'refused' ||
    outcome === 'transient_failure' ||
    outcome === 'model_unavailable' ||
    outcome === 'deadline_exceeded' ||
    outcome === 'invalid_output'
  );
}

function classifyZeroCandidates(
  config: AiDraftServiceConfig,
  eligibility: Readonly<Record<AiProvider, boolean>>,
  geminiSkippedIneligible: boolean,
): AiDeferredReason {
  if (!config.workersAiBindingPresent) {
    return 'binding_missing';
  }
  if (geminiSkippedIneligible) {
    return 'eligibility_unverified';
  }
  if (config.geminiEnabled && !config.geminiApiKeyPresent) {
    return 'key_missing';
  }
  if (!eligibility.gemini) {
    return 'eligibility_unverified';
  }
  return 'no_free_path';
}

function classifyExhausted(
  attempts: readonly AiAttemptRecord[],
  state: {
    readonly skippedProviders: ReadonlySet<AiProvider>;
    readonly authFailedProviders: ReadonlySet<AiProvider>;
    readonly geminiSkippedIneligible: boolean;
    readonly sawProviderAttempt: boolean;
    readonly sawQuotaDenial: boolean;
  },
): AiDeferredReason {
  if (attempts.some((attempt) => attempt.outcome === 'skipped_deadline')) {
    // The wall deadline stopped the ladder before an authorized attempt.
    return 'deadline_exceeded';
  }
  if (state.authFailedProviders.size > 0) {
    return 'provider_auth_failed';
  }
  if (state.sawQuotaDenial) {
    return 'budget_denied';
  }
  if (state.geminiSkippedIneligible && state.sawProviderAttempt) {
    // CF attempts failed AND the Gemini fallback stayed OFF for unverified
    // eligibility — surface the eligibility gate, not a generic failure.
    return 'eligibility_unverified';
  }
  if (state.sawProviderAttempt) {
    return 'provider_unavailable';
  }
  return 'no_free_path';
}
