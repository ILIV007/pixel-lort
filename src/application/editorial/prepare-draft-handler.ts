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
 * R1.13 (Phase 5C-1 — candidate discovery, AFTER validation/reuse and
 * BEFORE any provider work): the handler derives the snapshot's ≤3 durable
 * fingerprints (url / content_hash / title_key — pure, versioned `sc1`
 * namespace) and performs AT MOST THREE parameterized prefix lookups
 * (≤9-row probe each) against the multi-owner `story_fingerprints` index.
 * The outcome is a versioned `candidateDiscovery` report — a PROPOSAL of
 * possibly-related previously-indexed stories at the lookup moment: NEVER
 * a merge, never truth verification, no confidence or trust raise. The
 * report and the NEW story's fingerprints travel inside the SAME fenced
 * atomic batch as the draft (≤3 extra INSERT statements, same fence AND
 * snapshot predicates): a lost fence or changed snapshot writes NO draft
 * AND NO fingerprint. A lookup DB error is NEVER a fabricated empty
 * success — it maps onto the engine's typed bounded retry with ZERO
 * provider calls and ZERO AI charges (the lookup runs before the AI).
 * Replay/reuse happens BEFORE the lookup: no backfill, no rewritten
 * report, no repeated AI spend. Exactly-once cross-story visibility is
 * NOT claimed: two stories committed simultaneously may not see each
 * other at their lookup moments.
 *
 * R1.15 (Phase 5C-3 — exact-content draft reuse with preserved
 * provenance): AFTER the input gates and BEFORE any provider work, the
 * handler reuses the SAME content_hash lookup outcome the discovery already
 * produced (NO extra probe) and attempts a VERIFIED reuse of one existing
 * stable result for the EXACT same full composed text:
 *
 *  1. REPLAY FAST-PATH: one indexed read proves whether THIS item already
 *     carries a durable source_report attachment (its claim + evidence +
 *     processed flip landed atomically in an earlier generation) — success
 *     with ZERO writes and ZERO provider involvement. R1.15.1 (Posidon P1):
 *     the relation answers ONLY when it is PROVABLY the CURRENT snapshot's
 *     — its story must still own a ready draft whose IMMUTABLE document
 *     basis (sourceReport + evidenceGuard.snapshot) byte-verifies THIS
 *     snapshot's full composed text. An OLD relation of a DIFFERENT
 *     snapshot (the item's text changed underneath it) is NEVER a success:
 *     it falls through and the new text takes its own honest path; the old
 *     provenance is never rewritten, reattributed, or presented as the new
 *     snapshot's result.
 *  2. VERIFIED TARGET: each candidate (the DIRECTLY-resolved group-anchor
 *     owner FIRST, then the probe page) must BOTH still own a usable ready
 *     draft at the pipeline's draft version AND REALLY equal the current
 *     full composed text through the draft's IMMUTABLE document basis
 *     (R1.15.1 — Posidon P2: the equality basis is the draft's own
 *     document record, never a mutable source_items row alone). The
 *     fingerprint is the LOCATOR; the DECISION is the byte-exact
 *     comparison — stale, corrupt, or foreign fingerprints can never cause
 *     a wrong reuse, and numbers, negations, units, and Persian/Latin
 *     digits are never equated.
 *  3. FENCED REUSE COMMIT: the reusing item's OWN deterministic
 *     source_report claim + mentions evidence + its processed flip — ONE
 *     atomic batch under the job fence, the item's snapshot predicate, AND
 *     the extended target-validity predicate (R1.15.1: the EXACT verified
 *     document bytes AND the compared original reference-row identity are
 *     re-evaluated INSIDE the batch). The reused draft/story/report
 *     documents are NEVER rewritten; the second provenance is added, never
 *     substituted; confidence/trust stay untouched; NO ai_runs row exists
 *     because NO provider call happens (a provider that never ran is never
 *     fabricated).
 *  4. GROUP UNIQUENESS UNDER CONCURRENCY: every NORMAL commit now also
 *     writes the group-unique exact-content anchor (`sc1:<digest>`, no
 *     story suffix). A concurrent second commit of the same full content
 *     collides on the anchor's PRIMARY KEY and its WHOLE batch rolls back
 *     with ZERO effects (typed `contentTaken`): the loser records its REAL
 *     provider run (it happened and stays charged — never presented as
 *     used in any final output) and retries into the verified reuse path.
 *     Exactly-once provider behavior is NOT claimed; one stable result
 *     per exact content IS enforced in SQL.
 *  5. DIRECT ANCHOR RESOLUTION (R1.15.1 — Posidon P3): the group anchor's
 *     owner is resolved by ONE parameterized PRIMARY-KEY point read
 *     (`kind = ? AND value = ?`) — INDEPENDENT of the ≤9-row discovery
 *     probe page (no LIMIT growth, no unbounded scan). A valid, ready
 *     owner outside the probe page is therefore STILL reusable with ZERO
 *     new provider calls/charges. When the anchor EXISTS and NO candidate
 *     verifies (an invalid/unusable owner), the handler returns the typed
 *     PERMANENT `editorial_exact_content_blocked` BEFORE any provider
 *     work: the paid provider→conflict→retry cycle is never entered, the
 *     outcome is honest and bounded, and no anchor is ever taken over or
 *     deleted. Two providers in a REAL race may still both run (their REAL
 *     costs stay recorded); the anchor rollback contract is unchanged.
 *
 * Honest scope limits (recorded, never hidden): the reuse probe is bounded
 * by the SAME ≤9-row discovery probe page PLUS the directly-resolved anchor
 * owner (R1.15.1) — stories beyond both are not consulted this round
 * (overflow is logged); historical stories WITHOUT sc1 content fingerprints
 * are not consulted (NO backfill); historical/seeded drafts WITHOUT a
 * coherent immutable document basis are NOT verifiable and therefore NOT
 * reusable targets (documented conservative limit — R1.15.1 makes the
 * draft's own document record the equality basis); a reuse target whose
 * draft died between lookup and commit is a typed bounded retry that
 * re-decides honestly; a replay whose existing relation cannot be re-proven
 * against a usable draft falls through conservatively (never a fake
 * success claim for an unprovable attachment).
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../domain/jobs/handler';
import type { EditorialPrepareDraftPayload } from '../../domain/jobs/payloads';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  commitEditorialResult,
  commitEditorialReuse,
  findDraftForStory,
  findEditorialSource,
  findEditorialSourceAttachment,
  findEditorialSourceItem,
  findEntityMentionMatches,
  findStoryCandidatesByFingerprints,
  findStoryIdByExactContentAnchor,
  findStableEditorialResult,
  recordEditorialAiRun,
  type EditorialSourceAttachmentRow,
  type EditorialSourceItemRow,
  type EditorialSourceRow,
  type StoryCandidateLookupOutcome,
} from '../../adapters/db/editorial-store';
import type { AiDraftService } from '../ai/draft-service';
import type { AiDeferredReason, AiOutcome } from '../../domain/ai/types';
import { AI_BOUNDS } from '../../domain/ai/policy';
import { canonicalizeJson } from '../../domain/jobs/payloads';
import {
  aiRunIdForAttempt,
  draftIdForStory,
  editorialAiInputHash,
  exactContentReuseClaimId,
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
import { buildEvidenceGuardReport } from '../../domain/editorial/evidence-guard';
import {
  FINGERPRINT_LOOKUP_ROW_LIMIT,
  buildStoryFingerprints,
  planFingerprintLookups,
} from '../../domain/editorial/story-fingerprints';
import {
  exactContentAnchorValue,
  exactContentDigest,
  readReuseDocumentBasis,
  selectExactContentReuseTarget,
  verifyExactContentReuseCandidate,
  type ReuseCandidateVerification,
} from '../../domain/editorial/exact-content';
import { buildCandidateDiscoveryReport } from '../../domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../domain/editorial/candidate-assessment';
import {
  buildEntityMentionPhrases,
  buildEntityMentionsReport,
  type EntityMentionsReport,
} from '../../domain/editorial/entity-mentions';
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

    // ---- 5.4 R1.15 REPLAY FAST-PATH (one indexed read, BEFORE any
    //          provider work): does THIS item already carry a durable
    //          source_report attachment? The atomic reuse commit guarantees
    //          claim + evidence + processed flip landed TOGETHER, so the
    //          claim's existence IS the relation's existence.
    //          R1.15.1 (Posidon P1): the relation answers with success ONLY
    //          when it is PROVABLY the CURRENT snapshot's — its story must
    //          still own a ready draft at the pipeline version whose
    //          IMMUTABLE document basis (sourceReport + evidenceGuard
    //          snapshot identity) byte-verifies THIS snapshot's full
    //          composed text. An old relation of a DIFFERENT snapshot (the
    //          item's text changed underneath it) NEVER succeeds here: it
    //          falls through and the new text takes its own honest path —
    //          the old provenance stays untouched and unclaimed.
    let attachment: EditorialSourceAttachmentRow | null = null;
    try {
      attachment = await findEditorialSourceAttachment(executor, item.id);
    } catch (error) {
      // A DB error here is NEVER a fabricated "not attached": typed,
      // bounded retry with ZERO provider calls and ZERO charges.
      logger?.warn('editorial.prepare_draft.attachment_check_failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }
    if (attachment !== null) {
      try {
        // R1.15.2 (Posidon snapshot-identity boundary): the stored relation
        // answers for the CURRENT snapshot ONLY when its durable claim
        // identity IS the versioned reuse identity of (target story, item
        // id, CURRENT snapshot hash). Composed-text equality of the old
        // draft's immutable basis is necessary but NEVER sufficient: a NEW
        // raw snapshot (a different content hash — e.g. an edge-space title
        // change under the pre-existing trim contract) must NOT be silently
        // acknowledged by the OLD snapshot's relation. The check is a pure
        // READ-side comparison of two authoritative identities (the stored
        // claim row vs the derived identity); every WRITE keeps its fenced
        // atomic path, and a relation whose identity does not name THIS
        // snapshot falls through — the old relation stays intact and the
        // new snapshot takes its own honest path below.
        const expectedReuseClaimId = await exactContentReuseClaimId(
          attachment.story_id,
          item.id,
          item.content_hash,
        );
        if (attachment.claim_id === expectedReuseClaimId) {
          const replayDraft = await findDraftForStory(
            executor,
            attachment.story_id,
            EDITORIAL_DRAFT_VERSION,
          );
          if (replayDraft !== null && replayDraft.status === 'ready') {
            const replayBasis = readReuseDocumentBasis(replayDraft.document_json);
            const replayReference =
              replayBasis === null
                ? null
                : await findEditorialSourceItem(executor, replayBasis.sourceItemId);
            const replayDecision = verifyExactContentReuseCandidate({
              basis: replayBasis,
              referenceRow: replayReference,
              fullText: fullEvidenceText,
            });
            if (replayDecision.verified) {
              logger?.info('editorial.prepare_draft.provenance_already_attached', {
                storyId: attachment.story_id,
                claimId: attachment.claim_id,
              });
              // The durable work IS provably done for THIS snapshot (the
              // versioned relation names THIS item's CURRENT snapshot hash
              // AND the draft's immutable basis byte-verifies its text):
              // success with ZERO writes and ZERO provider involvement.
              return { kind: 'success' };
            }
          }
        }
      } catch (error) {
        // A DB error in the replay verification is NEVER a fabricated
        // "unprovable": typed, bounded retry, zero provider involvement.
        logger?.warn('editorial.prepare_draft.replay_verification_failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
        return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
      }
      // The relation exists but is NOT provably this snapshot's (a NEW
      // snapshot under an OLD attachment — P1 — or an unusable target
      // draft): CONSERVATIVE fall-through, honestly logged. The new text
      // takes its own path; the old relation is never claimed, rewritten,
      // or reattributed.
      logger?.warn('editorial.prepare_draft.attachment_not_proven_for_current_snapshot', {
        storyId: attachment.story_id,
      });
    }

    // ---- 5.5 R1.13 (Phase 5C-1) LIMITED candidate discovery — strictly
    //          AFTER early validation/reuse and BEFORE any provider work:
    //          the ≤3 durable fingerprints of THIS snapshot, then at most
    //          one ≤9-row prefix lookup per present signal. The current
    //          story is excluded by id; the outcome is a versioned,
    //          honest report — candidate discovery ONLY (no merge, no
    //          trust change, no truth claim), scoped to `sc1`-indexed
    //          stories (historical stories are NOT backfilled).
    const storyId = await storyIdForSnapshot(item.id, item.content_hash);
    const fingerprintSignals = {
      canonicalUrl: item.canonical_url,
      fullEvidenceText,
      title: item.title,
    };
    const fingerprints = await buildStoryFingerprints({ ...fingerprintSignals, storyId });
    // R1.15: the versioned exact-content digest of THIS item's own composed
    // text — the group anchor value the normal commit will claim (derived
    // from the item's OWN text, never from any stored fingerprint).
    const exactContentAnchor = {
      kind: 'content_hash' as const,
      value: exactContentAnchorValue(await exactContentDigest(fullEvidenceText)),
    };
    let lookupOutcomes: readonly StoryCandidateLookupOutcome[];
    try {
      const lookupPlans = await planFingerprintLookups(fingerprintSignals);
      lookupOutcomes = await findStoryCandidatesByFingerprints(
        executor,
        lookupPlans,
        storyId,
        FINGERPRINT_LOOKUP_ROW_LIMIT,
      );
    } catch (error) {
      // A DB error in discovery is NEVER a fabricated successful empty
      // report. Typed, bounded retry via the engine's own attempt budget;
      // ZERO provider calls and ZERO AI charges were made — the lookup
      // runs strictly BEFORE the provider.
      logger?.warn('editorial.prepare_draft.candidate_lookup_failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }
    const candidateDiscovery = buildCandidateDiscoveryReport({
      snapshot: { sourceItemId: item.id, contentHash: item.content_hash },
      storyId,
      lookups: lookupOutcomes.map((outcome) => ({
        kind: outcome.kind,
        overflow: outcome.overflow,
      })),
      matches: lookupOutcomes.flatMap((outcome) =>
        outcome.storyIds.map((candidateStoryId) => ({
          kind: outcome.kind,
          storyId: candidateStoryId,
        })),
      ),
    });
    logger?.debug('editorial.prepare_draft.candidates_observed', {
      observation: candidateDiscovery.observation,
      candidates: candidateDiscovery.counts.candidatesReported,
      overflow: candidateDiscovery.lookup.overflowObserved,
    });

    // ---- 5.55 R1.15 (Phase 5C-3) VERIFIED EXACT-CONTENT REUSE — BEFORE
    //          any provider work. R1.15.1 (Posidon P3): the candidate set
    //          is the DIRECTLY-resolved group-anchor owner (ONE parameterized
    //          PK point read on (kind,value) — independent of the ≤9-row
    //          discovery probe page) FIRST, then the probe page's
    //          content_hash outcome (NO extra probe). Each candidate must
    //          BOTH still own a usable ready draft AND REALLY equal this
    //          item's full composed text through the draft's IMMUTABLE
    //          document basis (R1.15.1 — Posidon P2: the equality basis is
    //          the draft's own document record + the bridged original
    //          reference row — never a mutable source_items row alone; the
    //          fingerprint is only the locator). On a verified target: the
    //          item's OWN deterministic source_report claim + mentions
    //          evidence + processed flip land in ONE fenced atomic batch
    //          (fence + snapshot + the EXTENDED target-validity predicate:
    //          the exact verified document bytes AND the compared reference
    //          identity are re-evaluated INSIDE the batch) — the second
    //          provenance is ADDED, the reused draft/story/report documents
    //          are NEVER rewritten, confidence/trust stay untouched, and
    //          ZERO provider calls happen (NO ai_runs row — a provider that
    //          never ran is never fabricated). If the anchor EXISTS but NO
    //          candidate verifies (an invalid/unusable owner), the typed
    //          PERMANENT `editorial_exact_content_blocked` is returned
    //          BEFORE any provider work: the paid
    //          provider→conflict→retry cycle is never entered. Any other
    //          verification miss proceeds to the honest independent path.
    const contentOutcome = lookupOutcomes.find((outcome) => outcome.kind === 'content_hash');
    let anchorOwnerStoryId: string | null = null;
    try {
      anchorOwnerStoryId = await findStoryIdByExactContentAnchor(executor, exactContentAnchor);
    } catch (error) {
      // A DB error in the anchor resolution is NEVER a fabricated "no
      // anchor": typed bounded retry, zero provider calls, zero charges.
      logger?.warn('editorial.prepare_draft.anchor_resolution_failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }
    const reuseCandidateStoryIds = [
      ...new Set(
        [
          ...(anchorOwnerStoryId !== null ? [anchorOwnerStoryId] : []),
          ...(contentOutcome?.storyIds ?? []),
        ].filter((candidateStoryId) => candidateStoryId !== storyId),
      ),
    ];
    if (reuseCandidateStoryIds.length > 0) {
      try {
        const verifications: ReuseCandidateVerification[] = [];
        const documentJsonByStoryId = new Map<string, string>();
        for (const candidateStoryId of reuseCandidateStoryIds) {
          const candidateDraft = await findDraftForStory(
            executor,
            candidateStoryId,
            EDITORIAL_DRAFT_VERSION,
          );
          const hasUsableDraft = candidateDraft !== null && candidateDraft.status === 'ready';
          let contentVerified = false;
          let fence: ReuseCandidateVerification['fence'];
          if (hasUsableDraft && candidateDraft !== null) {
            documentJsonByStoryId.set(candidateStoryId, candidateDraft.document_json);
            // R1.15.1: the immutable document basis of the candidate's OWN
            // ready draft — plus the candidate's ORIGINAL reference row
            // (located by the document, bridged by the guard's recorded
            // snapshot identity when the excerpt is truncated).
            const basis = readReuseDocumentBasis(candidateDraft.document_json);
            const referenceRow =
              basis === null ? null : await findEditorialSourceItem(executor, basis.sourceItemId);
            const decision = verifyExactContentReuseCandidate({
              basis,
              referenceRow,
              fullText: fullEvidenceText,
            });
            contentVerified = decision.verified;
            fence = decision.fence;
          }
          verifications.push({ storyId: candidateStoryId, hasUsableDraft, contentVerified, fence });
        }
        const target = selectExactContentReuseTarget(verifications);
        if (target === null) {
          if (anchorOwnerStoryId !== null) {
            // R1.15.1 (Posidon P3): the exact content is ALREADY OWNED (the
            // group anchor exists) but NO candidate — including the anchor's
            // own owner — is a verifiable usable reuse target. The fenced
            // normal commit would deterministically collide on the anchor
            // and roll back, so the PAID provider→conflict→retry cycle is
            // never entered: typed PERMANENT, BEFORE any provider work —
            // zero charges, zero writes, zero fake success, and no anchor
            // is ever taken over or deleted. A later re-enqueue after the
            // owner heals decides again honestly.
            logger?.warn('editorial.prepare_draft.exact_content_group_blocked', {
              anchorOwnerStoryId,
              candidatesProbed: verifications.length,
              overflow: contentOutcome?.overflow ?? false,
            });
            return { kind: 'permanent', reasonCode: 'editorial_exact_content_blocked' };
          }
          // Honest miss: no anchor and none of the probed candidates is
          // BOTH usable and really content-equal (includes stale/corrupt
          // fingerprints — scenario: the fingerprint said equal, the text
          // says NO). The item proceeds independently; the overflow flag
          // stays honest.
          logger?.info('editorial.prepare_draft.exact_content_no_verified_target', {
            candidatesProbed: verifications.length,
            overflow: contentOutcome?.overflow ?? false,
          });
        } else {
          if (target.fence === undefined) {
            // Unreachable by construction (a selected target always carries
            // its verified fence identity); the conservative guard keeps
            // the commit input total.
            logger?.error('editorial.prepare_draft.exact_content_missing_fence');
            return { kind: 'retry', reasonCode: 'job_internal_error' };
          }
          const reuseNowMs = nowMs();
          // R1.15.2: the reuse relation's durable claim identity is the
          // VERSIONED reuse identity — (target story, item id, CURRENT
          // snapshot hash) — so the committed relation demonstrably names
          // the snapshot it processed. The fenced atomic batch (fence +
          // snapshot + target predicates) guarantees the identity can only
          // land while the item IS the snapshot the verification compared.
          const reuseClaimId = await exactContentReuseClaimId(
            target.storyId,
            item.id,
            item.content_hash,
          );
          const reuseClaim = buildSourceReportClaim({ sourceName: source.name, excerpt });
          const reuseEvidence = buildMentionsEvidence({ excerpt });
          const reuse = await commitEditorialReuse(executor, {
            jobId,
            generation,
            fenceNowMs: reuseNowMs,
            snapshot: {
              sourceItemId: item.id,
              sourceId: item.source_id,
              contentHash: item.content_hash,
            },
            target: {
              storyId: target.storyId,
              draftVersion: EDITORIAL_DRAFT_VERSION,
              // R1.15.1: the verified comparison basis, carried INTO the
              // SQL predicate — the exact document bytes AND the original
              // reference-row identity as read at verification time.
              documentJson: documentJsonByStoryId.get(target.storyId)!,
              referenceItemId: target.fence.referenceItemId,
              referenceContentHash: target.fence.referenceContentHash,
            },
            claim: {
              id: reuseClaimId,
              storyId: target.storyId,
              claimType: reuseClaim.claimType,
              subject: reuseClaim.subject,
              predicate: reuseClaim.predicate,
              objectText: reuseClaim.objectText,
              confidence: reuseClaim.confidence,
              status: reuseClaim.status,
              createdAt: reuseNowMs,
            },
            evidence: {
              id: await mentionsEvidenceId(reuseClaimId, item.id),
              claimId: reuseClaimId,
              sourceItemId: item.id,
              stance: reuseEvidence.stance,
              confidence: reuseEvidence.confidence,
              excerpt: reuseEvidence.excerpt,
              createdAt: reuseNowMs,
            },
          });
          if (reuse.attached || reuse.alreadyAttached) {
            logger?.info('editorial.prepare_draft.exact_content_reused', {
              storyId: target.storyId,
              claimId: reuseClaimId,
              sourceItemProcessed: reuse.sourceItemProcessed,
            });
            return { kind: 'success' };
          }
          if (reuse.snapshotChanged) {
            logger?.warn('editorial.prepare_draft.reuse_snapshot_changed');
            return { kind: 'permanent', reasonCode: 'editorial_snapshot_changed' };
          }
          if (reuse.targetInvalid) {
            // The verified target died between the lookup and the commit:
            // ZERO effects; the next generation's lookup re-decides
            // honestly (bounded by the engine's attempt budget).
            logger?.warn('editorial.prepare_draft.reuse_target_invalid');
            return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
          }
          logger?.warn('editorial.prepare_draft.reuse_ownership_fence_lost');
          return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
        }
      } catch (error) {
        // A DB error in verification/reuse is NEVER a fabricated miss and
        // NEVER a fake attach: typed bounded retry with ZERO provider
        // calls and ZERO charges (the reuse runs strictly BEFORE the AI).
        logger?.warn('editorial.prepare_draft.exact_content_reuse_failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
        return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
      }
    }

    // ---- 5.6 R1.14 (Phase 5C-2) CONSERVATIVE candidate assessment — a
    //          PURE, deterministic derivation of the discovery report
    //          above (same lookup moment, zero new lookups, zero new SQL,
    //          zero provider involvement): what was ACTUALLY OBSERVED
    //          about each candidate's relation (full content composite
    //          equality / shared URL / shared weak title / several
    //          signals), with every real reason kept, correlated signals
    //          never counted as independent confirmations, no confidence
    //          or threshold, and `unrelatednessConcluded` fixed false —
    //          absence of signals is NEVER a negative proof. It rides
    //          INSIDE document_json of the SAME fenced commit.
    const candidateAssessment = buildCandidateAssessmentReport({
      discovery: candidateDiscovery,
    });

    // ---- 5.7 R1.16 (Phase 5D) CONTROLLED entity-alias mentions —
    //          strictly AFTER the input gates and the early-reuse
    //          decisions (replay/reuse never reach this point — their
    //          contracts stay untouched and their drafts are NEVER
    //          enriched) and BEFORE any provider work: the bounded `em1`
    //          phrase scan over THIS snapshot's OWN full composed text,
    //          ONE parameterized indexed lookup against
    //          `entity_aliases(normalized_alias)`, ambiguity = ZERO
    //          links (no first-row-wins), and a versioned report that
    //          travels INSIDE document_json of the SAME fenced commit.
    //          A DB error is NEVER a fabricated empty result: typed,
    //          bounded retry with ZERO provider calls and ZERO charges
    //          (the lookup runs strictly before the AI).
    const entityMentionScan = buildEntityMentionPhrases(fullEvidenceText);
    let entityMentionRows: readonly { normalized_alias: string; entity_id: string }[] = [];
    let entityMentionOverflow = false;
    if (entityMentionScan.phrases.length > 0) {
      try {
        const aliasLookup = await findEntityMentionMatches(executor, entityMentionScan.phrases);
        entityMentionRows = aliasLookup.rows;
        entityMentionOverflow = aliasLookup.overflow;
      } catch (error) {
        logger?.warn('editorial.prepare_draft.entity_alias_lookup_failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
        return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
      }
    }
    const entityMentionResolution = buildEntityMentionsReport({
      snapshot: { sourceItemId: item.id, contentHash: item.content_hash },
      scan: entityMentionScan,
      matches: entityMentionRows,
      resultOverflow: entityMentionOverflow,
    });
    const entityMentions: EntityMentionsReport = entityMentionResolution.report;
    logger?.debug('editorial.prepare_draft.entity_mentions_observed', {
      observation: entityMentions.observation,
      matched: entityMentions.counts.uniqueAliasesMatched,
      ambiguous: entityMentions.counts.ambiguousAliasesObserved,
      overflow: entityMentions.scan.resultOverflow,
    });

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
    //
    //          R1.12 (Phase 5B): BEFORE building the document, the PURE
    //          Evidence Guard v1 evaluator judges EVERY model claim of the
    //          validated draft against the SAME verified snapshot identity
    //          and the SAME traceable excerpt that produced it. The report
    //          is deterministic, versioned, honest (direct-text observation
    //          is never "verified"; paraphrase/translation stay unresolved;
    //          headline/summary are recorded unassessed) and travels INSIDE
    //          document_json of the SAME fenced commit — zero new SQL
    //          statements, zero extra rounds, and it can never outlive the
    //          draft it describes (a lost fence/snapshot writes nothing).
    const evidenceGuard = buildEvidenceGuardReport({
      snapshot: {
        sourceItemId: item.id,
        contentHash: item.content_hash,
      },
      evidence: {
        evidenceId: snippet.id,
        excerptText: excerpt.text,
        excerptTruncated: excerpt.truncated,
      },
      draftClaims: outcome.draft.claims,
      draftHeadlineFa: outcome.draft.headlineFa,
      draftSummaryFa: outcome.draft.summaryFa,
      draftSourceItemId: item.id,
    });
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
      evidenceGuard,
      candidateDiscovery,
      candidateAssessment,
      entityMentions,
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
      // R1.13: the NEW story's ≤3 durable fingerprints ride in the SAME
      // fenced batch — a lost fence or changed snapshot writes NO draft
      // AND NO fingerprint row.
      fingerprints: fingerprints.map((plan) => ({ kind: plan.kind, value: plan.value })),
      // R1.15: the exact-content GROUP anchor — the group-unique value
      // derived from THIS item's own composed text. A live cross-story
      // owner trips the PRIMARY KEY inside this batch and rolls the WHOLE
      // commit back (typed contentTaken below).
      exactContentAnchor,
      // R1.16: the deterministic unique controlled-alias mention pairs —
      // written by the SAME fenced batch; each link's SQL predicate
      // re-checks its alias mapping INSIDE the transaction.
      entityMentions: entityMentionResolution.resolved,
    });

    if (commit.contentTaken) {
      // The exact-content anchor collided: ANOTHER story already owns this
      // exact full content (the concurrent-commit race). The WHOLE batch
      // rolled back — ZERO editorial rows, ZERO processed flip. The REAL
      // provider run above is recorded honestly (it happened and stays
      // charged; it is referenced by NO draft — never presented as used in
      // any final output), then a bounded recoverable retry: the next
      // generation's lookup sees the winner and takes the verified reuse
      // path. No overwrite, no second stable result, no fake free lunch.
      if (observed !== null) {
        await recordRealAiRun(executor, jobId, generation, observed, inputHash, nowMs());
      }
      logger?.warn('editorial.prepare_draft.content_result_exists');
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }

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
      fingerprintsInserted: commit.fingerprintsInserted,
      entityMentionsInserted: commit.entityMentionsInserted,
    });
    if (commit.entityMentionsInserted < entityMentionResolution.resolved.length) {
      // The lookup→commit alias-mutation window: at least one mapping
      // changed before the fenced insert — THAT link alone no-oped (in
      // SQL), the draft/report stay coherent. Honest, bounded, typed.
      logger?.warn('editorial.prepare_draft.entity_mention_link_suppressed', {
        resolved: entityMentionResolution.resolved.length,
        inserted: commit.entityMentionsInserted,
      });
    }
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
