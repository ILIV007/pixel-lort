/**
 * `editorial.prepare_draft` handler (Phase 5A — ADR-0042 §5): the FIRST
 * integrated local source→draft path. ONE bounded handler execution:
 *
 *   load source_item → verify stored snapshot hash → reuse stable result
 *   → build traceable evidence → call the EXISTING `createAiDraftService`
 *   (real allowlist/budget/deadline/validation) → fenced atomic commit
 *   (story + source_report claim + mentions evidence + ai_runs row + ready
 *   draft + source_item→processed).
 *
 * Typed-outcome contract (Posidon R1.11 — stable execution; R1.11.1):
 * - unknown source item / missing source row → PERMANENT
 *   (`editorial_source_item_missing` / `editorial_source_missing`): retries
 *   cannot conjure a missing reference.
 * - stored-hash mismatch → PERMANENT `editorial_snapshot_mismatch`: the
 *   handler NEVER processes an imaginary snapshot.
 * - evidence input whose FULL defined text (title + body, BEFORE any
 *   truncation) exceeds the AI input byte bound → PERMANENT
 *   `editorial_input_invalid` (R1.11.1): a data property; truncation may
 *   never smuggle an oversized input past the AI limit. ZERO provider
 *   calls and ZERO AI charges for the rejection; the stored item text is
 *   never rewritten.
 * - a schema-valid draft with NO claim traceable to the request evidence
 *   → PERMANENT `editorial_no_traced_claim` (R1.11.1, editorial boundary
 *   only — the general AI schema is unchanged): never a ready draft, never
 *   a processed item; the REAL run is recorded as `invalid`; terminal
 *   because the identical input would deterministically repeat (no storm).
 * - provider SAFETY REFUSAL → PERMANENT `editorial_ai_refused`: terminal,
 *   no model/provider hopping (ADR-0041 contract preserved).
 * - the stored source snapshot changed between the identity-checked read
 *   and the commit → PERMANENT `editorial_snapshot_changed` (R1.11.1):
 *   the SQL snapshot predicate made the WHOLE atomic commit a no-op —
 *   zero editorial rows, zero processed flip. DISTINCT from a lost job
 *   fence; the consumed provider budget is NOT refunded; terminal because
 *   a retry would re-read the same stale identity (never a hot loop).
 * - typed AI deferrals (gate off, binding missing, budget denied, budget
 *   store failure, deadline, provider unavailable/auth, eligibility
 *   unverified, no free path, config invalid) → RECOVERABLE retry with the
 *   stable `job_handler_retryable_error` code; the engine's own bounded
 *   attempt budget and backoff own the schedule. Zero network happens
 *   behind the AI service's fail-closed gates.
 * - mid-commit storage failure → propagates: the engine classifies it as
 *   transient (`job_internal_error`) and reschedules; the atomic batch
 *   guarantees NO partial editorial state and NO fake processed.
 * - a stale generation that loses the SQL ownership fence reports a
 *   recoverable retry; it can never write over a newer generation's state.
 *
 * Replay discipline: the pre-AI stable-result lookup (deterministic story
 * key + ready draft) returns success WITHOUT any AI call or write —
 * re-execution after a successful commit is free. The at-least-once crash
 * window (provider answered, commit crashed) honestly re-calls the
 * provider on the next generation; every attempt was charged durably
 * BEFORE the call (ai-budget-store) and each generation records its own
 * ai_runs row. Exactly-once external behavior is NOT claimed.
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../domain/jobs/handler';
import type { EditorialPrepareDraftPayload } from '../../domain/jobs/payloads';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  commitEditorialResult,
  findEditorialSource,
  findEditorialSourceItem,
  findStableEditorialResult,
  recordEditorialAiRun,
  type EditorialSourceItemRow,
  type EditorialSourceRow,
} from '../../adapters/db/editorial-store';
import type { AiDraftService } from '../ai/draft-service';
import type { AiDeferredReason, AiOutcome } from '../../domain/ai/types';
import { AI_BOUNDS } from '../../domain/ai/policy';
import { canonicalizeJson } from '../../domain/jobs/payloads';
import {
  aiRunIdForAttempt,
  draftIdForStory,
  editorialAiInputHash,
  mentionsEvidenceId,
  sourceReportClaimId,
  storyIdForSnapshot,
  storyKeyForSnapshot,
  EDITORIAL_DRAFT_VERSION,
} from '../../domain/editorial/identity';
import {
  buildAiEvidenceInput,
  buildDraftDocument,
  buildFullEvidenceText,
  buildMentionsEvidence,
  buildSourceReportClaim,
  buildTraceableExcerpt,
  EDITORIAL_CREATED_BY,
} from '../../domain/editorial/mapper';
import type { Logger } from '../../observability/logger';

/** Deferred AI reasons that map onto the engine's recoverable retry path. */
const RETRYABLE_DEFERRED_REASONS: ReadonlySet<AiDeferredReason> = new Set([
  'ai_disabled',
  'config_invalid',
  'binding_missing',
  'key_missing',
  'eligibility_unverified',
  'budget_denied',
  'budget_store_error',
  'deadline_exceeded',
  'provider_unavailable',
  'provider_auth_failed',
  'no_free_path',
]);

export interface EditorialPrepareDraftHandlerOptions {
  readonly executor: DbExecutor;
  /** The EXISTING AI draft service (ADR-0041) — never a new orchestration. */
  readonly aiService: AiDraftService;
  readonly nowMs: () => number;
  readonly logger?: Logger;
}

/** Pure classification of one AI outcome into the handler's next step. */
export type EditorialAiStep =
  | { readonly kind: 'commit' }
  | { readonly kind: 'retry' }
  | {
      readonly kind: 'permanent';
      readonly reasonCode: 'editorial_input_invalid' | 'editorial_ai_refused';
    };

export function classifyAiOutcome(outcome: AiOutcome): EditorialAiStep {
  switch (outcome.kind) {
    case 'draft':
      return { kind: 'commit' };
    case 'refusal':
      return { kind: 'permanent', reasonCode: 'editorial_ai_refused' };
    case 'deferred':
      if (outcome.reason === 'input_invalid') {
        return { kind: 'permanent', reasonCode: 'editorial_input_invalid' };
      }
      if (RETRYABLE_DEFERRED_REASONS.has(outcome.reason)) {
        return { kind: 'retry' };
      }
      return { kind: 'retry' };
  }
}

/** One real AI invocation observed by the handler (for ai_runs honesty). */
interface ObservedAiRun {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly status: 'succeeded' | 'failed' | 'invalid';
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly errorCode: string | null;
}

/** Derive the real ai_runs fields from the outcome (never invent usage). */
export function observeAiRun(
  outcome: AiOutcome,
  startedAtMs: number,
  finishedAtMs: number,
): ObservedAiRun | null {
  if (outcome.kind === 'draft') {
    const usage = outcome.usage[0];
    const succeededAttempt = [...outcome.attempts]
      .reverse()
      .find((attempt) => attempt.outcome === 'succeeded');
    return {
      provider: usage?.provider ?? succeededAttempt?.provider ?? 'workers-ai',
      model: usage?.modelId ?? succeededAttempt?.modelId ?? '',
      promptVersion: usage?.promptVersion ?? succeededAttempt?.promptVersion ?? '',
      status: 'succeeded',
      latencyMs: succeededAttempt?.durationMs ?? finishedAtMs - startedAtMs,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      errorCode: null,
    };
  }
  const lastAttempt = outcome.attempts.at(-1);
  if (lastAttempt === undefined) {
    // Zero real provider involvement (e.g. ai_disabled / pre-AI input
    // rejection): NO ai_runs row — a provider that never ran is never
    // fabricated (Posidon R1.11: provider انجام‌نشده جعل نشود).
    return null;
  }
  if (outcome.kind === 'refusal') {
    return {
      provider: outcome.provider,
      model: outcome.modelId,
      promptVersion: lastAttempt.promptVersion,
      status: 'failed',
      latencyMs: lastAttempt.durationMs,
      inputTokens: null,
      outputTokens: null,
      errorCode: 'provider_safety_refusal',
    };
  }
  return {
    provider: lastAttempt.provider,
    model: lastAttempt.modelId,
    promptVersion: lastAttempt.promptVersion,
    status: 'failed',
    latencyMs: lastAttempt.durationMs,
    inputTokens: null,
    outputTokens: null,
    errorCode: outcome.reason,
  };
}

export function createEditorialPrepareDraftHandler(
  options: EditorialPrepareDraftHandlerOptions,
): JobHandler<EditorialPrepareDraftPayload> {
  const { executor, aiService, nowMs, logger } = options;

  async function execute(
    context: JobExecutionContext<EditorialPrepareDraftPayload>,
  ): Promise<HandlerOutcome> {
    const { jobId, generation, payload } = context;

    // ---- 1. The referenced source item must exist (typed, terminal).
    const item = await findEditorialSourceItem(executor, payload.sourceItemId);
    if (item === null) {
      logger?.warn('editorial.prepare_draft.source_item_missing');
      return { kind: 'permanent', reasonCode: 'editorial_source_item_missing' };
    }

    // ---- 2. Snapshot identity: the payload hash must equal the STORED
    //         content hash — never process an imaginary snapshot.
    if (item.content_hash !== payload.snapshotHash) {
      logger?.warn('editorial.prepare_draft.snapshot_mismatch');
      return { kind: 'permanent', reasonCode: 'editorial_snapshot_mismatch' };
    }

    // ---- 3. The owning source row (attribution) must exist.
    const source = await findEditorialSource(executor, item.source_id);
    if (source === null) {
      logger?.warn('editorial.prepare_draft.source_missing');
      return { kind: 'permanent', reasonCode: 'editorial_source_missing' };
    }

    // ---- 4. Pre-AI stable-result reuse: retry after a successful commit
    //         finds the SAME story + ready draft and calls NO provider.
    const storyKey = await storyKeyForSnapshot(item.id, item.content_hash);
    const stable = await findStableEditorialResult(executor, storyKey, EDITORIAL_DRAFT_VERSION);
    if (stable !== null) {
      logger?.debug('editorial.prepare_draft.stable_result_reused', {
        storyId: stable.story.id,
        draftId: stable.draft.id,
      });
      return { kind: 'success' };
    }

    // ---- 5. Traceable evidence from the item's OWN fields; byte-bounded
    //          on the FULL defined evidence input BEFORE any truncation
    //          (R1.11.1): the 16 KiB AI input limit is checked against
    //          title + body as stored — truncating first would let an
    //          oversized item reach the provider. The rejection happens
    //          BEFORE any provider work: ZERO provider calls, ZERO AI
    //          charges, ZERO ai_runs rows; the stored item is not touched.
    const fullEvidenceText = buildFullEvidenceText(item);
    const fullEvidenceBytes = new TextEncoder().encode(fullEvidenceText).length;
    if (fullEvidenceBytes > AI_BOUNDS.maxInputUtf8Bytes || fullEvidenceText.length === 0) {
      logger?.warn('editorial.prepare_draft.input_oversized');
      return { kind: 'permanent', reasonCode: 'editorial_input_invalid' };
    }
    const excerpt = buildTraceableExcerpt(item);
    const { snippet } = buildAiEvidenceInput(item.id, excerpt);
    const snippetBytes = new TextEncoder().encode(snippet.text).length;
    if (snippetBytes > AI_BOUNDS.maxInputUtf8Bytes || snippet.text.length === 0) {
      // Defensive second layer (unreachable while the full-input gate
      // above holds: an allowed input's excerpt is always smaller).
      logger?.warn('editorial.prepare_draft.input_oversized');
      return { kind: 'permanent', reasonCode: 'editorial_input_invalid' };
    }
    const inputHash = await editorialAiInputHash([snippet]);

    // ---- 6. The EXISTING AI service (real gates: flag, budget authority,
    //         allowlist ladder, wall deadline, output validation).
    const aiStartedAtMs = nowMs();
    const outcome = await aiService.generateNewsDraft({
      taskType: 'news_draft',
      locale: 'fa',
      evidence: [snippet],
    });
    const aiFinishedAtMs = nowMs();
    const observed = observeAiRun(outcome, aiStartedAtMs, aiFinishedAtMs);
    const step = classifyAiOutcome(outcome);

    // ---- 7a. Deferred/refusal paths: record the REAL run when one happened,
    //          then map onto the engine's durable outcomes (no fake success,
    //          no disappearance, no retry storm).
    if (step.kind === 'retry') {
      if (observed !== null) {
        await recordRealAiRun(executor, jobId, generation, observed, inputHash, nowMs());
      }
      logger?.info('editorial.prepare_draft.ai_deferred', { outcome: outcome.kind });
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }
    if (step.kind === 'permanent') {
      if (observed !== null) {
        await recordRealAiRun(executor, jobId, generation, observed, inputHash, nowMs());
      }
      logger?.warn('editorial.prepare_draft.ai_terminal', { reasonCode: step.reasonCode });
      return { kind: 'permanent', reasonCode: step.reasonCode };
    }

    if (outcome.kind !== 'draft') {
      // Unreachable (classifyAiOutcome returned 'commit' only for drafts).
      return { kind: 'retry', reasonCode: 'job_internal_error' };
    }

    // ---- 7a'. Editorial acceptance guard (R1.11.1): at least ONE model
    //          claim must reference the request evidence. A schema-valid
    //          draft with empty claims (or none pointing at THIS input) is
    //          NOT a success of this path: it never becomes a ready draft
    //          and never processes the item. The general AI schema and
    //          other callers' contract stay unchanged. The REAL run is
    //          recorded as `invalid` (the provider DID run and stays
    //          charged — no refund); the outcome is TERMINAL because the
    //          identical input would deterministically repeat (no storm).
    const hasTracedClaim = outcome.draft.claims.some((claim) =>
      claim.evidenceIds.includes(snippet.id),
    );
    if (!hasTracedClaim) {
      if (observed !== null) {
        await recordRealAiRun(
          executor,
          jobId,
          generation,
          { ...observed, status: 'invalid', errorCode: 'editorial_no_traced_claim' },
          inputHash,
          nowMs(),
        );
      }
      logger?.warn('editorial.prepare_draft.no_traced_claim', {
        claims: outcome.draft.claims.length,
      });
      return { kind: 'permanent', reasonCode: 'editorial_no_traced_claim' };
    }

    // ---- 7b. Commit path: conservative story + source_report claim +
    //          mentions evidence + real ai_runs row + READY draft +
    //          source_item→processed — ONE fenced atomic batch.
    const storyId = await storyIdForSnapshot(item.id, item.content_hash);
    const claimId = await sourceReportClaimId(storyId, item.id);
    const evidenceId = await mentionsEvidenceId(claimId, item.id);
    const draftId = await draftIdForStory(storyId);
    const aiRunId = await aiRunIdForAttempt(jobId, generation);
    const sourceReportClaim = buildSourceReportClaim({
      sourceName: source.name,
      excerpt,
    });
    const mentionsEvidence = buildMentionsEvidence({ excerpt });
    const document = buildDraftDocument({
      sourceItemId: item.id,
      sourceName: source.name,
      excerpt,
      semanticDraft: outcome.draft,
    });
    const now = nowMs();

    const commit = await commitEditorialResult(executor, {
      jobId,
      generation,
      fenceNowMs: now,
      // The snapshot identity the handler READ and verified: re-checked
      // INSIDE the atomic batch (R1.11.1) so a source item that changed
      // mid-flight produces zero effects with a distinct typed outcome.
      snapshot: {
        sourceItemId: item.id,
        sourceId: item.source_id,
        contentHash: item.content_hash,
      },
      story: {
        id: storyId,
        storyKey,
        workingHeadline: null,
        createdAt: now,
      },
      claim: {
        id: claimId,
        storyId,
        claimType: sourceReportClaim.claimType,
        subject: sourceReportClaim.subject,
        predicate: sourceReportClaim.predicate,
        objectText: sourceReportClaim.objectText,
        confidence: sourceReportClaim.confidence,
        status: sourceReportClaim.status,
        createdAt: now,
      },
      evidence: {
        id: evidenceId,
        claimId,
        sourceItemId: item.id,
        stance: mentionsEvidence.stance,
        confidence: mentionsEvidence.confidence,
        excerpt: mentionsEvidence.excerpt,
        createdAt: now,
      },
      aiRun: {
        id: aiRunId,
        task: 'news_draft',
        provider: observed?.provider ?? '',
        model: observed?.model ?? '',
        promptVersion: observed?.promptVersion ?? '',
        inputHash,
        status: observed?.status ?? 'succeeded',
        latencyMs: observed?.latencyMs ?? null,
        inputTokens: observed?.inputTokens ?? null,
        outputTokens: observed?.outputTokens ?? null,
        errorCode: observed?.errorCode ?? null,
        errorMessage: null,
        createdAt: aiStartedAtMs,
        completedAt: aiFinishedAtMs,
      },
      draft: {
        id: draftId,
        storyId,
        status: 'ready',
        language: 'fa',
        layout: document.layout,
        title: document.title,
        documentJson: canonicalizeJson(document.document),
        factsJson: canonicalizeJson(document.facts),
        warningsJson: canonicalizeJson(document.warnings),
        aiRunId,
        version: EDITORIAL_DRAFT_VERSION,
        createdBy: EDITORIAL_CREATED_BY,
        createdAt: now,
      },
    });

    if (commit.snapshotChanged) {
      // The source snapshot changed between the read and the atomic
      // commit (R1.11.1): ZERO editorial rows and ZERO processed flips
      // landed — the SQL snapshot predicate no-oped the whole batch. A
      // DISTINCT terminal outcome — never conflated with a lost fence.
      // The provider call happened and stays charged (no refund); the
      // real run is recorded honestly as failed with the editorial code.
      if (observed !== null) {
        await recordRealAiRun(
          executor,
          jobId,
          generation,
          { ...observed, status: 'failed', errorCode: 'editorial_snapshot_changed' },
          inputHash,
          nowMs(),
        );
      }
      logger?.warn('editorial.prepare_draft.source_snapshot_changed');
      return { kind: 'permanent', reasonCode: 'editorial_snapshot_changed' };
    }

    if (commit.fenceLost) {
      // Zero fenced effects landed — a newer generation owns the work.
      // The engine's own fenced terminal write will also fail; report a
      // recoverable retry and never touch the newer generation's state.
      logger?.warn('editorial.prepare_draft.ownership_fence_lost');
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }

    logger?.info('editorial.prepare_draft.committed', {
      storyInserted: commit.storyInserted,
      draftId,
      sourceItemProcessed: commit.sourceItemProcessed,
    });
    return { kind: 'success' };
  }

  return { type: 'editorial.prepare_draft', execute };
}

/** Record the REAL ai_run row for deferred/refusal paths (fenced insert). */
async function recordRealAiRun(
  executor: DbExecutor,
  jobId: string,
  generation: number,
  observed: ObservedAiRun,
  inputHash: string,
  fenceNowMs: number,
): Promise<void> {
  const id = await aiRunIdForAttempt(jobId, generation);
  const now = fenceNowMs;
  try {
    await recordEditorialAiRun(executor, {
      jobId,
      generation,
      fenceNowMs,
      aiRun: {
        id,
        task: 'news_draft',
        provider: observed.provider,
        model: observed.model,
        promptVersion: observed.promptVersion,
        inputHash,
        status: observed.status,
        latencyMs: observed.latencyMs,
        inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens,
        errorCode: observed.errorCode,
        errorMessage: null,
        createdAt: now,
        completedAt: now,
      },
    });
  } catch {
    // The ai_runs row for a NON-success path is observability, not the
    // durable outcome: its failure never changes the handler's typed
    // result (the engine's own bookkeeping carries the reason code).
  }
}

/**
 * Type-level assertion kept close to the handler: the handler deps accept
 * the exact AiDraftServiceDeps-derived service contract (structural).
 */
export type EditorialAiService = AiDraftService;
export type { EditorialSourceItemRow, EditorialSourceRow };
