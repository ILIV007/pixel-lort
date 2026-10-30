/**
 * The BOUNDED event-relation adjudication service (Phase 5E-1 — R1.17,
 * ADR-0045): a THIN application service for the SEPARATE `event_relation`
 * task. The `news_draft` service contract (ADR-0041) is preserved
 * untouched — this is NOT a reshaped draft request and NOT a generic
 * framework: the SAME shared protections are reused minimally, primitive
 * by primitive:
 * - the SAME durable budget authority (`authorizeAiRequestAttempt`,
 *   scope 'ai', the SAME per-provider daily caps as drafting — there is NO
 *   separate bucket that bypasses the shared provider cap) charged BEFORE
 *   every provider call; usage is only reported;
 * - the SAME versioned model allowlist ladder and eligibility gates
 *   (Workers AI primary; Gemini stays UNVERIFIED and therefore unwired);
 * - the SAME wall-deadline primitive (`awaitWithDeadline`), absorbing late
 *   rejections — noncancellable charges stay recorded (conservative, no
 *   refunds);
 * - terminal safety refusal (per pair — no model/provider hopping for that
 *   pair), typed deferrals, no paid fallback.
 *
 * STEP BOUNDS (R1.17 §5): ≤2 pairs per request, ≤3 REAL provider attempts
 * for the WHOLE step (shared across pairs — never per pair), one 15 s wall
 * deadline bounding the whole step (budget waits, provider calls, output
 * validation). The independent fail-closed flag
 * (`EVENT_RELATION_ENABLED`) is checked FIRST: OFF ⇒ typed deferred with
 * ZERO calls, ZERO budget writes, ZERO binding access. No new daily cap,
 * eligibility, or allowlist entry is introduced by this task.
 *
 * Logging is sanitized by construction: stable event names, provider/model
 * ids, outcome kinds, attempt counts — never side text, never raw model
 * output, never reasons/conflicts (they travel only inside the ledger).
 */
import { z } from 'zod';
import type { Clock } from '../../shared/time/clock';
import { awaitWithDeadline, type DeadlineTimeoutScheduler } from '../../shared/time/deadline-wait';
import type { Logger } from '../../observability/logger';
import type { DbExecutor } from '../../adapters/db/db-executor';
import { authorizeAiRequestAttempt, recordAiUsage } from '../../adapters/db/ai-budget-store';
import { AI_DAILY_REQUEST_ATTEMPT_CAPS, listModelsForProvider } from '../../domain/ai/policy';
import {
  EVENT_RELATION_BOUNDS,
  EVENT_RELATION_PROMPT_VERSION,
} from '../../domain/ai/event-relation-policy';
import {
  buildEventRelationSystemPrompt,
  buildEventRelationUserPrompt,
} from '../../domain/ai/event-relation-prompt';
import { parseEventRelationDecisionJson } from '../../domain/ai/event-relation-schema';
import type {
  EventRelationAttemptRecord,
  EventRelationOutcome,
  EventRelationPairDeferredReason,
  EventRelationPairOutcome,
  EventRelationPairRequest,
} from '../../domain/ai/event-relation-types';
import type { AiProvider, AiProviderPort } from '../../domain/ai/types';

const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const relationSideSchema = z
  .object({
    evidenceId: z.string().regex(EVIDENCE_ID_PATTERN),
    text: z.string().min(1),
    storyId: z.string().regex(ID_PATTERN),
    sourceItemId: z.string().regex(ID_PATTERN),
    contentHash: z.string().min(1).max(128),
  })
  .strict();

const relationPairSchema = z
  .object({
    pairId: z.enum(['erp-1', 'erp-2']),
    sideA: relationSideSchema,
    sideB: relationSideSchema,
    canonicalInputHash: z.string().regex(HASH_PATTERN),
  })
  .strict();

const relationRequestSchema = z
  .object({
    pairs: z.array(relationPairSchema).max(EVENT_RELATION_BOUNDS.maxPairs),
  })
  .strict();

export interface EventRelationServiceConfig {
  /** Validated EVENT_RELATION_ENABLED flag (parseAiConfig). */
  readonly eventRelationEnabled: boolean;
  /** Whether the native Workers AI binding is present in the runtime. */
  readonly workersAiBindingPresent: boolean;
  /** Whether a Gemini API key is configured (presence only). */
  readonly geminiApiKeyPresent: boolean;
}

export interface EventRelationServiceDeps {
  readonly executor: DbExecutor;
  /** Provider ports keyed by provider (missing port = provider unavailable). */
  readonly ports: Readonly<Partial<Record<AiProvider, AiProviderPort>>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: EventRelationServiceConfig;
  /** Eligibility view (defaults to the versioned policy — Gemini false). */
  readonly eligibility?: Readonly<Record<AiProvider, boolean>>;
  readonly deadlineScheduler?: DeadlineTimeoutScheduler;
}

export interface EventRelationService {
  evaluateEventRelations(request: unknown): Promise<EventRelationOutcome>;
}

interface Candidate {
  readonly provider: AiProvider;
  readonly modelId: string;
}

function defaultEligibility(): Record<AiProvider, boolean> {
  return { 'workers-ai': true, gemini: false };
}

export function createEventRelationService(deps: EventRelationServiceDeps): EventRelationService {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();
  const systemPrompt = buildEventRelationSystemPrompt();

  async function evaluateEventRelations(request: unknown): Promise<EventRelationOutcome> {
    // ---- Gate 1: the independent task flag is the FIRST decision.
    if (!deps.config.eventRelationEnabled) {
      return { kind: 'deferred', reason: 'ai_disabled' };
    }
    // ---- Gate 2: bounded request validation (fail closed, zero side effects).
    const parsedRequest = relationRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { kind: 'deferred', reason: 'input_invalid' };
    }
    const pairs = parsedRequest.data.pairs as readonly EventRelationPairRequest[];
    const bundleBytes = (pair: EventRelationPairRequest): number =>
      encoder.encode(pair.sideA.text).length + encoder.encode(pair.sideB.text).length;
    if (pairs.some((pair) => bundleBytes(pair) > EVENT_RELATION_BOUNDS.maxBundleUtf8Bytes)) {
      return { kind: 'deferred', reason: 'input_invalid' };
    }

    if (pairs.length === 0) {
      // The bounded no-op: zero provider attempts, zero budget writes.
      return { kind: 'decisions', pairs: [] };
    }

    // ---- Candidate ladder (the versioned allowlist; eligibility gates).
    const candidates: Candidate[] = [];
    for (const model of [
      ...listModelsForProvider('workers-ai'),
      ...listModelsForProvider('gemini'),
    ]) {
      if (model.provider === 'workers-ai') {
        if (!deps.config.workersAiBindingPresent || deps.ports['workers-ai'] === undefined) {
          continue;
        }
      } else {
        if (!eligibility.gemini || deps.ports.gemini === undefined) {
          continue;
        }
        if (!deps.config.geminiApiKeyPresent) {
          continue;
        }
      }
      candidates.push({ provider: model.provider, modelId: model.modelId });
    }

    const startedAt = deps.clock.now();
    const deadlineAtMs = startedAt + EVENT_RELATION_BOUNDS.stepWallDeadlineMs;
    const skippedProviders = new Set<AiProvider>();
    let providerAttemptsUsed = 0;
    const pairOutcomes: EventRelationPairOutcome[] = [];

    for (const pair of pairs) {
      // The step deadline stops ALL further pairs — no new work starts
      // after expiry; the pair is typed, never a semantic verdict.
      if (deps.clock.now() >= deadlineAtMs) {
        pairOutcomes.push({
          pairId: pair.pairId,
          kind: 'deferred',
          reason: 'step_deadline',
          attempts: [],
        });
        continue;
      }
      // The ≤3 cap is the STEP cap (shared across pairs).
      if (providerAttemptsUsed >= EVENT_RELATION_BOUNDS.maxProviderAttemptsPerStep) {
        pairOutcomes.push({
          pairId: pair.pairId,
          kind: 'deferred',
          reason: 'step_attempt_cap',
          attempts: [],
        });
        continue;
      }

      const outcome = await evaluateOnePair(pair, {
        candidates,
        deadlineAtMs,
        startedAt,
        attemptsRemaining: EVENT_RELATION_BOUNDS.maxProviderAttemptsPerStep - providerAttemptsUsed,
        skippedProviders,
      });
      providerAttemptsUsed += outcome.attempts.length;
      pairOutcomes.push(outcome);
    }

    return { kind: 'decisions', pairs: pairOutcomes };
  }

  /** Evaluate ONE pair over the allowlist ladder under the shared caps. */
  async function evaluateOnePair(
    pair: EventRelationPairRequest,
    context: {
      readonly candidates: readonly Candidate[];
      readonly deadlineAtMs: number;
      readonly startedAt: number;
      readonly attemptsRemaining: number;
      /** Providers whose shared bucket already failed/denied — the SAME
       * skip state drafting uses, shared ACROSS the step's pairs. */
      readonly skippedProviders: Set<AiProvider>;
    },
  ): Promise<EventRelationPairOutcome> {
    const attempts: EventRelationAttemptRecord[] = [];
    const record = (
      candidate: Candidate,
      status: EventRelationAttemptRecord['status'],
      errorCode: string | null,
      durationMs: number,
      usage?: { inputTokens?: number; outputTokens?: number },
    ): void => {
      attempts.push({
        provider: candidate.provider,
        modelId: candidate.modelId,
        promptVersion: EVENT_RELATION_PROMPT_VERSION,
        status,
        latencyMs: durationMs,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        errorCode,
      });
      deps.logger.info('ai.event_relation.attempt', {
        provider: candidate.provider,
        modelId: candidate.modelId,
        promptVersion: EVENT_RELATION_PROMPT_VERSION,
        outcome: status,
        durationMs,
      });
    };

    const deferred = (reason: EventRelationPairDeferredReason): EventRelationPairOutcome => {
      deps.logger.info('ai.event_relation.result', { kind: 'deferred', reason });
      return { pairId: pair.pairId, kind: 'deferred', reason, attempts };
    };

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: buildEventRelationUserPrompt(pair) },
    ];

    for (const candidate of context.candidates) {
      if (attempts.length >= context.attemptsRemaining) {
        return deferred('step_attempt_cap');
      }
      if (deps.clock.now() >= context.deadlineAtMs) {
        return deferred('step_deadline');
      }
      if (context.skippedProviders.has(candidate.provider)) {
        continue; // same shared provider bucket — remaining same-provider
        // candidates are futile and are skipped (ledger-only, no run row).
      }

      // ---- Durable authorization BEFORE the attempt (no grant, no call).
      let bucketDate: string;
      try {
        const authWaitStartedAtMs = deps.clock.now();
        const authorizationWait = await awaitWithDeadline(
          authorizeAiRequestAttempt(deps.executor, {
            provider: candidate.provider,
            cap: AI_DAILY_REQUEST_ATTEMPT_CAPS[candidate.provider],
            nowMs: authWaitStartedAtMs,
          }),
          context.deadlineAtMs,
          authWaitStartedAtMs,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (authorizationWait.kind === 'timed_out') {
          return deferred('step_deadline');
        }
        const authorization = authorizationWait.value;
        if (authorization.kind === 'denied') {
          // Shared provider bucket: skip the remaining same-provider
          // candidates; the pair is typed `budget_denied` — NEVER the
          // model's semantic `insufficient_evidence`.
          context.skippedProviders.add(candidate.provider);
          return deferred('budget_denied');
        }
        bucketDate = authorization.bucketDate;
      } catch {
        return deferred('budget_store_error');
      }

      // ---- Post-authorization deadline guard (the granted charge stays).
      if (deps.clock.now() >= context.deadlineAtMs) {
        return deferred('step_deadline');
      }

      // ---- The authorized attempt (counted even if the port throws).
      const attemptStartedAt = deps.clock.now();
      let callOutcome: Awaited<ReturnType<AiProviderPort['complete']>>;
      try {
        const port = deps.ports[candidate.provider];
        if (port === undefined) {
          return deferred('provider_unavailable');
        }
        const callWait = await awaitWithDeadline(
          port.complete({
            modelId: candidate.modelId,
            messages,
            maxOutputTokens: EVENT_RELATION_BOUNDS.maxOutputTokens,
            deadlineAtMs: context.deadlineAtMs,
          }),
          context.deadlineAtMs,
          attemptStartedAt,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (callWait.kind === 'timed_out') {
          record(candidate, 'failed', 'deadline_exceeded', deps.clock.now() - attemptStartedAt);
          return deferred('step_deadline');
        }
        callOutcome = callWait.value;
      } catch {
        record(candidate, 'failed', 'transient_failure', deps.clock.now() - attemptStartedAt);
        continue;
      }
      const durationMs = deps.clock.now() - attemptStartedAt;

      switch (callOutcome.kind) {
        case 'refused': {
          // TERMINAL typed refusal for THIS pair — no model/provider hopping.
          record(candidate, 'failed', 'provider_safety_refusal', durationMs);
          deps.logger.info('ai.event_relation.result', {
            kind: 'refused',
            attempts: attempts.length,
          });
          return { pairId: pair.pairId, kind: 'refused', attempts };
        }
        case 'deadline_exceeded': {
          record(candidate, 'failed', 'deadline_exceeded', durationMs);
          return deferred('step_deadline');
        }
        case 'ok': {
          const parsed = parseEventRelationDecisionJson(callOutcome.rawText, {
            expectedPairId: pair.pairId,
            sideAEvidenceId: pair.sideA.evidenceId,
            sideBEvidenceId: pair.sideB.evidenceId,
          });
          if (!parsed.ok) {
            record(candidate, 'invalid', parsed.reason, durationMs);
            continue; // next allowlist candidate (attempts permitting)
          }
          // Best-effort usage recording, bounded by the SAME deadline; its
          // failure never revokes the authorization nor changes the result.
          try {
            const usageWaitStartedAtMs = deps.clock.now();
            const usageWait = await awaitWithDeadline(
              recordAiUsage(deps.executor, {
                provider: candidate.provider,
                bucketDate,
                inputTokens: callOutcome.usage?.inputTokens,
                outputTokens: callOutcome.usage?.outputTokens,
                nowMs: usageWaitStartedAtMs,
              }),
              context.deadlineAtMs,
              usageWaitStartedAtMs,
              { scheduleTimeout: deps.deadlineScheduler },
            );
            if (usageWait.kind === 'timed_out') {
              deps.logger.warn('ai.event_relation.usage_record_timeout', {
                provider: candidate.provider,
              });
            }
          } catch {
            deps.logger.warn('ai.event_relation.usage_record_failed', {
              provider: candidate.provider,
            });
          }
          record(candidate, 'succeeded', null, durationMs, {
            inputTokens: callOutcome.usage?.inputTokens,
            outputTokens: callOutcome.usage?.outputTokens,
          });
          deps.logger.info('ai.event_relation.result', {
            kind: 'evaluated',
            provider: candidate.provider,
            modelId: candidate.modelId,
            attempts: attempts.length,
          });
          return {
            pairId: pair.pairId,
            kind: 'evaluated',
            verdict: parsed.output.verdict,
            reasons: parsed.output.reasons,
            references: parsed.output.references,
            conflicts: parsed.output.conflicts,
            usage: {
              provider: candidate.provider,
              modelId: candidate.modelId,
              ...(callOutcome.usage?.inputTokens !== undefined
                ? { inputTokens: callOutcome.usage.inputTokens }
                : {}),
              ...(callOutcome.usage?.outputTokens !== undefined
                ? { outputTokens: callOutcome.usage.outputTokens }
                : {}),
            },
            attempts,
          };
        }
        case 'quota_denied': {
          record(candidate, 'failed', 'quota_denied', durationMs);
          context.skippedProviders.add(candidate.provider);
          return deferred('budget_denied');
        }
        case 'auth_failed': {
          record(candidate, 'failed', 'auth_failed', durationMs);
          context.skippedProviders.add(candidate.provider);
          return deferred('provider_auth_failed');
        }
        case 'model_unavailable':
        case 'transient': {
          record(
            candidate,
            'failed',
            callOutcome.kind === 'model_unavailable' ? 'model_unavailable' : 'transient',
            durationMs,
          );
          continue;
        }
      }
    }

    return deferred('no_free_path');
  }

  return { evaluateEventRelations };
}
