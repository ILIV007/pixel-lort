/**
 * Phase 8.2 — the DURABLE publication scheduler (the application
 * composition). The engine that turns the 8.1 pure policy layer (psp1) into
 * durable, reconciled sends over the blueprint-approved `publications`
 * outbox (schema 6 — consumed, zero DDL; ADR-0058).
 *
 * THE ADR-0032 GATE (the reason this slice exists): before autonomous
 * channel publishing is enabled, publishing needs a duplicate mitigation and
 * reconciliation layer with stronger at-most-once protection than raw
 * webhook responses. This engine delivers it:
 *
 *  - the per-candidate decision is made INSIDE the claimed section (fresh
 *    history every time — the policy always sees the current world);
 *  - the send is preceded by the EVIDENCE CHECK (`publication_messages`): a
 *    recorded delivery from a crashed earlier generation heals the row to
 *    `published` WITHOUT a second send — the recorded sub-window of the
 *    ambiguous window is CLOSED;
 *  - the message record (with the exact-bytes content hash) is written
 *    BEFORE the terminal — a crash between the two is healed by the next
 *    generation's evidence check;
 *  - the ledger's UNIQUE(chat_id, message_id) rejects a reused/forged
 *    message id — the honest outcome is `uncertain`, never a claimed
 *    published;
 *  - an uncertain outcome is NEVER auto-resent and never asserts
 *    proved-non-delivery (the machine has no such transition);
 *  - the retry family is bounded: only PROVED non-delivery with the
 *    server's retry_after (429) retries, on the SAME row with the SAME
 *    idempotency key, bounded by the blueprint §7 budget (3 normal / 5 P0)
 *    enforced AT the claim boundary.
 *
 * The LIVE surfaces stay BLOCKED_LIVE (Posidon only): the transport is
 * injected by the caller — nothing in this module can reach the network by
 * itself. A gate enabled WITHOUT a transport is a LOUD misconfiguration
 * (zero writes); a gate disabled makes the whole scan DECISION-ONLY
 * (zero durable writes — observation, not simulation).
 *
 * THE ALBUM WIRING (ADR-0060, the V4 carry): the send path consumes the
 * durable album content documents (the 7.3/7.4 contracts) through the
 * dedicated `PublicationMediaGroupTransport` seam — file_id-only (the
 * attachments array is always empty at send time), the send identity key
 * re-derived from the SAME shared derivation the upload path pins, the
 * ledger binding fail-closed BEFORE any send, the per-ordinal delivery +
 * usage records after the shape-gated reply. The gate carried over INTACT:
 * the evidence heal is shape-blind, the uncertain family is never
 * auto-resent, 429 retries on the same row through the same classifier.
 * The gate-ON scan WITHOUT the media seam is a LOUD misconfiguration
 * (zero writes) ONLY when an album is due — a text-only deployment keeps
 * working, and the text path's byte-level behavior is unchanged.
 *
 * The story-layer inputs (the same-game cooldown keys, the event-driven
 * bypass) are carried: no durable story-layer mapping exists yet, so the
 * context provider defaults them CONSERVATIVELY (no bypass, no cooldown
 * rule, relatedness derived from the durable story identity alone).
 */

import type { DbExecutor } from '../../adapters/db/db-executor';
import { AppError } from '../../shared/errors/app-error';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import {
  claimPublication,
  countDuePublications,
  listDuePublications,
  listFailedPublications,
  listPublicationMediaUsages,
  listPublicationMessages,
  listRecentPublishedHistory,
  markClaimedDeadLetter,
  markClaimedFailed,
  markClaimedPublished,
  markClaimedRetryWait,
  markClaimedSendStarted,
  markClaimedUncertain,
  markWaitingPublicationDeadLetter,
  parkExpiredPublishingUncertain,
  reclaimExpiredClaims,
  healFailedToPublished,
  healClaimedToPublished,
  recordPublicationMediaUsages,
  recordPublicationMessage,
  releaseClaimed,
  type PublicationRow,
} from '../../adapters/db/publication-outbox-store';
import { classifySendOutcome } from '../../domain/publishing/send-outcome';
import {
  planReleaseAfterScheduleDecision,
  planRetryAfterProvedFailure,
} from '../../domain/publishing/outbox-lifecycle';
import {
  classifyPriority,
  type PublicationPriorityClass,
} from '../../domain/publishing/priority-classes';
import { planPublicationTime } from '../../domain/publishing/publication-schedule';
import type { MixCategory } from '../../domain/publishing/anti-robot';
import { renderEditorialPostText } from '../../domain/admin-post/editorial-post-render';
import { contentTextHash } from '../../domain/publishing/publication-identity';
import {
  discriminateAlbumDocument,
  deriveAlbumSendPlan,
  evaluateAlbumDeliveryEvidence,
  type AlbumSendPlanV1,
} from '../../domain/media/album-send-plan';
import type { MediaAssetStore, MediaGroupSendInputV1 } from '../../domain/media/media-ports';
import { isPublishableRightsStatus } from '../../domain/media/media-usage';
import { mapContentTypeToMixCategory, scanJitterForCandidate } from './scheduler-policy';

/** The channel transport seam (the ONLY artificial piece in tests). */
export interface PublicationChannelTransport {
  sendMessageRich(input: {
    readonly chatId: number | string;
    readonly content: {
      readonly kind: string;
      readonly text: string;
      readonly entities: readonly unknown[];
    };
  }): Promise<{ readonly messageId: number }>;
}

/** ONE message of a media-group reply, IN ORDINAL ORDER (the ADR-0060 seam). */
export interface PublicationSentMediaGroupMessage {
  readonly messageId: number;
  /** The returned file_id when the reply carries one; the ledger never requires it. */
  readonly fileId?: string;
}

/**
 * THE ALBUM WIRING SEAM (ADR-0060): the media-group send the album send
 * path consumes. The input IS the A5 `MediaGroupSendInputV1` contract
 * (items + the fresh-bytes attachments — which the send-time album always
 * leaves EMPTY, the file_id-only rule) extended with the re-derived send
 * identity key (the A4 scaffold consumed at the send boundary). Failures
 * THROW — the album path classifies them through the SAME sop1 classifier
 * as the text path (one honest outcome vocabulary).
 */
export interface PublicationMediaGroupSendInputV1 extends MediaGroupSendInputV1 {
  /** The versioned send identity re-derived from the durable document. */
  readonly sendIdentityKey: string;
}

export interface PublicationMediaGroupTransport {
  sendMediaGroup(
    input: PublicationMediaGroupSendInputV1,
  ): Promise<readonly PublicationSentMediaGroupMessage[]>;
}

export interface StoryLayerContext {
  /** Is the candidate related to the previous send? (durable default: same story). */
  readonly related: boolean;
  /** The explicit story-layer event-driven flag (carried: default false). */
  readonly eventDriven: boolean;
  /** The same-game cooldown context (carried: no durable game-key mapping yet). */
  readonly sameGame: {
    readonly gameKey: string | null;
    readonly lastPublishMs: number | null;
    readonly meaningfulUpdate: boolean;
  } | null;
}

export type PolicyContextResult =
  | { readonly ok: true; readonly context: StoryLayerContext }
  | { readonly ok: false; readonly reason: 'provider_failed' };

/**
 * The story-layer context seam. The SHIPPED default derives `related` from
 * the durable story identity (the candidate's story is the last published
 * story) and defaults the carried inputs conservatively; the carried real
 * provider (the story-layer game keys and event flags) replaces it when the
 * producing pipeline exists.
 */
export interface PublicationPolicyContextProvider {
  buildContext(input: {
    readonly storyId: string;
    readonly nowMs: number;
  }): Promise<PolicyContextResult>;
}

export function createStoriesPolicyContextProvider(
  executor: DbExecutor,
): PublicationPolicyContextProvider {
  return {
    async buildContext(input) {
      try {
        const lastPublished = await executor.first<{
          readonly story_id: string;
        }>({
          sql: `SELECT story_id FROM publications
                WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= ?
                ORDER BY published_at DESC LIMIT 1`,
          params: [input.nowMs],
        });
        return {
          ok: true,
          context: {
            related: lastPublished !== null && lastPublished.story_id === input.storyId,
            eventDriven: false,
            sameGame: null,
          },
        };
      } catch {
        return { ok: false, reason: 'provider_failed' };
      }
    },
  };
}

const RECONCILIATION_LIMIT = 25;
const DEFAULT_SCAN_LIMIT = 10;
const MAX_LAYOUT_HISTORY = 64;
const MAX_CATEGORY_HISTORY = 512;
const MIX_WINDOW_MS = 168 * 3_600_000;
const PUBLISH_LEASE_MS = 60_000;
/**
 * THE IN-FLIGHT SEND LEASE (the independent review d65d811 P1-1 fix): the
 * lease EXTENSION written durably at the send-started marker — far longer
 * than any honest Bot API send, so a healthy in-flight send is never
 * reclaimed mid-flight; a generation that dies inside the window parks in
 * the ambiguous family after the extension expires (bounded recovery),
 * never an auto-resend.
 */
const SEND_IN_FLIGHT_LEASE_MS = 600_000;
const MAX_DESTINATION_LENGTH = 256;

export interface ScanDetail {
  readonly publicationId: string;
  readonly draftId: string;
  readonly outcome:
    | 'sent'
    | 'healed_from_evidence'
    | 'failed_unconfirmed'
    | 'retry_scheduled'
    | 'failed_hold'
    | 'dead_lettered'
    | 'deferred_time'
    | 'deferred_policy'
    | 'decision_only'
    | 'not_claimable'
    | 'fence_rejected'
    | 'policy_input_invalid';
  readonly dueAtMs?: number;
  readonly code?: string;
  readonly priorityClass?: string;
}

export interface SchedulerScanReport {
  readonly scannedAtMs: number;
  readonly gateEnabled: boolean;
  readonly decisionOnly: boolean;
  /**
   * The LOUD misconfiguration family: 'transport_absent' = the send gate
   * enabled without the text transport; 'media_transport_absent' = the gate
   * enabled, the text transport present, but an ALBUM publication is due
   * while the media-group seam is absent. Both write NOTHING.
   */
  readonly misconfigured: false | 'transport_absent' | 'media_transport_absent';
  readonly dueCount: number;
  readonly processed: number;
  readonly reclaimed: number;
  /**
   * The ambiguous in-flight windows parked this scan (the send-started
   * generations whose extended lease expired without a terminal — the
   * `send_may_have_started` family; NEVER auto-resent, healed only by
   * recorded evidence or the human dispositions).
   */
  readonly uncertainParked: number;
  readonly uncertaintyHealed: number;
  readonly details: readonly ScanDetail[];
}

interface DraftRead {
  readonly id: string;
  readonly status: string;
  readonly layout: string;
  readonly document_json: string;
}

function storyLayerOf(
  row: PublicationRow,
  provider: PublicationPolicyContextProvider,
  nowMs: number,
) {
  return provider.buildContext({ storyId: row.story_id, nowMs });
}

export function createPublicationScheduler(deps: {
  readonly executor: DbExecutor;
  readonly destination: string;
  readonly transport?: PublicationChannelTransport;
  /**
   * The album send seam (ADR-0060). OPTIONAL so a text-only deployment
   * keeps working, but the pair rule below makes it impossible to hold a
   * send-capable media seam without the ledger it binds to.
   */
  readonly mediaTransport?: PublicationMediaGroupTransport;
  /** The ledger the album binding is verified against — REQUIRED with the media seam. */
  readonly mediaAssets?: Pick<MediaAssetStore, 'findAssetsByUrls'>;
  readonly sendGate: { readonly enabled: boolean };
  readonly contextProvider: PublicationPolicyContextProvider;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly scanLimit?: number;
}) {
  const destination = deps.destination;
  if (
    typeof destination !== 'string' ||
    destination.length === 0 ||
    destination.length > MAX_DESTINATION_LENGTH
  ) {
    throw new AppError('config_invalid');
  }
  // THE PAIR RULE (fail-closed): a media-group seam without the ledger it
  // binds to (or the reverse) is a construction-time misconfiguration —
  // the wiring can never half-exist.
  if ((deps.mediaTransport === undefined) !== (deps.mediaAssets === undefined)) {
    throw new AppError('config_invalid');
  }
  const scanLimit = Math.max(1, Math.min(64, Math.floor(deps.scanLimit ?? DEFAULT_SCAN_LIMIT)));

  /**
   * THE LEDGER BINDING + THE SEND-TIME RIGHTS GATE (the ADR-0060 binding,
   * extended by the independent review d65d811 P1-3 fix): every plan item
   * must resolve to an UPLOADED ledger asset whose telegram_file_id matches
   * the document AND whose DURABLE rights echo is an affirmative clearance
   * (PUBLICATION_MEDIA_RIGHTS_V1). The rights are re-read from the ledger
   * HERE — at the moment of use and publication: a `blocked` revocation or
   * a never-cleared `unknown` fails closed BEFORE any transport effect (a
   * source being "official" was never, by itself, a republish license —
   * the gate trusts the honest durable echo, never the source's name).
   */
  async function resolveAlbumLedgerBindings(plan: AlbumSendPlanV1): Promise<
    | {
        readonly ok: true;
        readonly bindings: readonly { readonly ordinal: number; readonly mediaAssetId: string }[];
      }
    | {
        readonly ok: false;
        readonly reason: 'ledger_binding_unresolved' | 'media_rights_not_publishable';
      }
  > {
    if (deps.mediaAssets === undefined) {
      // Unreachable on the gate-ON album path (the LOUD per-shape
      // misconfiguration check runs before any claim); typed for safety.
      return { ok: false, reason: 'ledger_binding_unresolved' };
    }
    const assets = await deps.mediaAssets.findAssetsByUrls(
      plan.items.map((item) => item.canonicalUrl),
    );
    const bindings: { readonly ordinal: number; readonly mediaAssetId: string }[] = [];
    for (const item of plan.items) {
      const match = assets.find(
        (asset) =>
          asset.canonicalUrl === item.canonicalUrl &&
          asset.telegramFileId === item.media &&
          asset.status === 'uploaded',
      );
      if (match === undefined) {
        return { ok: false, reason: 'ledger_binding_unresolved' };
      }
      if (!isPublishableRightsStatus(match.rightsStatus)) {
        return { ok: false, reason: 'media_rights_not_publishable' };
      }
      bindings.push({ ordinal: item.ordinal, mediaAssetId: match.id });
    }
    return { ok: true, bindings };
  }

  /**
   * The album binding dead-letter shared by the send and evidence paths —
   * a document the ledger cannot vouch for (or the rights gate refuses)
   * never reaches a transport.
   */
  async function deadLetterAlbumBinding(
    row: PublicationRow,
    generation: number,
    code: 'ledger_binding_unresolved' | 'media_rights_not_publishable',
    nowMs: number,
  ): Promise<ScanDetail> {
    const deadLetter = await markClaimedDeadLetter(deps.executor, {
      publicationId: row.id,
      generation,
      errorCode: code,
      nowMs,
    });
    return deadLetter.kind === 'written'
      ? { publicationId: row.id, draftId: row.draft_id, outcome: 'dead_lettered', code }
      : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
  }

  /** The bounded PK draft read (the shape discriminator's input). */
  async function readDraftOf(draftId: string): Promise<DraftRead | null> {
    return deps.executor.first<DraftRead>({
      sql: `SELECT id, status, layout, document_json FROM drafts WHERE id = ?`,
      params: [draftId],
    });
  }

  /**
   * THE ALBUM EVIDENCE VERDICT (the independent review d65d811 P1-2 fix):
   * the completeness proof is evaluated over the PLAN's ordinal count — a
   * partial witness parks uncertain and NEVER heals, NEVER re-sends.
   * Returns the action the caller must take.
   */
  async function evaluateAlbumEvidenceAction(
    row: PublicationRow,
    plan: AlbumSendPlanV1,
    messages: readonly { readonly ordinal: number; readonly chat_id: string }[],
    nowMs: number,
  ): Promise<
    | { readonly action: 'heal' }
    | { readonly action: 'park'; readonly code: string }
    | {
        readonly action: 'dead_letter';
        readonly code: 'ledger_binding_unresolved' | 'media_rights_not_publishable';
      }
  > {
    const usages = await listPublicationMediaUsages(deps.executor, row.id);
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: plan.items.length,
      destination,
      messages: messages.map((message) => ({ ordinal: message.ordinal, chatId: message.chat_id })),
      boundUsageOrdinals: usages.map((usage) => usage.ordinal),
    });
    if (verdict.kind === 'complete') {
      return { action: 'heal' };
    }
    if (verdict.reason === 'unbound_usages') {
      // Every ordinal is PROVEN — the missing piece is the durable usage
      // binding. Reconcile it from the ledger (the honest rebinding); a
      // binding the ledger can no longer vouch for parks uncertain.
      const binding = await resolveAlbumLedgerBindings(plan);
      if (!binding.ok) {
        return { action: 'dead_letter', code: binding.reason };
      }
      try {
        const written = await recordPublicationMediaUsages(deps.executor, {
          publicationId: row.id,
          usages: binding.bindings,
          nowMs,
        });
        if (written.kind !== 'recorded') {
          return { action: 'park', code: 'usage_record_rejected' };
        }
      } catch {
        return { action: 'park', code: 'usage_record_failed' };
      }
      return { action: 'heal' };
    }
    // A PARTIAL or foreign-destination proof: the ambiguous family — the
    // recorded ordinals may already be in the channel; a re-send would
    // duplicate them. Park for the human dispositions, records intact.
    return { action: 'park', code: 'album_evidence_incomplete' };
  }

  async function reconcileFailedWithEvidence(nowMs: number): Promise<number> {
    const parked = await listFailedPublications(deps.executor, {
      limit: RECONCILIATION_LIMIT,
    });
    let healed = 0;
    for (const row of parked) {
      const messages = await listPublicationMessages(deps.executor, row.id);
      if (messages.length === 0) {
        continue;
      }
      // THE SHAPE-AWARE HEAL (the d65d811 P1-2 fix): the proof must match
      // the content shape — a text publication proves with its ONE record
      // to THIS destination; an album proves only with EVERY ordinal to
      // THIS destination AND the usages bound (the unbound-usages family
      // reconciles its binding here, then heals). Anything else stays
      // parked for the human dispositions (never auto-resent).
      const draft = await readDraftOf(row.draft_id);
      if (!draft) {
        continue;
      }
      if (discriminateAlbumDocument(draft.document_json) === 'album') {
        const planned = await deriveAlbumSendPlan({
          documentJson: draft.document_json,
          destination,
        });
        if (!planned.ok) {
          continue;
        }
        const action = await evaluateAlbumEvidenceAction(row, planned.plan, messages, nowMs);
        if (action.action !== 'heal') {
          continue;
        }
      } else if (messages.length !== 1 || messages[0]!.chat_id !== destination) {
        continue;
      }
      const outcome = await healFailedToPublished(deps.executor, {
        publicationId: row.id,
        nowMs,
      });
      if (outcome.kind === 'healed') {
        healed += 1;
        deps.logger.info('publication_scheduler.evidence_healed', { publicationId: row.id });
      }
    }
    return healed;
  }

  async function buildPolicyDecision(
    row: PublicationRow,
    draft: DraftRead,
    nowMs: number,
  ): Promise<
    | {
        readonly ok: true;
        readonly decision: ReturnType<typeof planPublicationTime>;
        readonly priorityClass: string;
      }
    | { readonly ok: false; readonly code: string }
  > {
    const contentRow = await deps.executor.first<{ readonly content_type: string }>({
      sql: `SELECT content_type FROM stories WHERE id = ?`,
      params: [row.story_id],
    });
    if (!contentRow || typeof contentRow.content_type !== 'string') {
      return { ok: false, code: 'policy_input_invalid' };
    }
    const mapped = mapContentTypeToMixCategory(contentRow.content_type);
    if (!mapped.ok) {
      return { ok: false, code: 'unknown_content_type' };
    }
    const layer = await storyLayerOf(row, deps.contextProvider, nowMs);
    if (!layer.ok) {
      return { ok: false, code: 'policy_provider_failed' };
    }
    const history = await listRecentPublishedHistory(deps.executor, {
      nowMs,
      limit: MAX_CATEGORY_HISTORY,
    });
    const trail = history.slice(-MAX_LAYOUT_HISTORY);
    const recentLayouts = trail.map((entry) => entry.layout);
    const recentCategories: { readonly category: MixCategory; readonly atMs: number }[] = [];
    for (const entry of history) {
      if (entry.publishedAtMs < nowMs - MIX_WINDOW_MS) {
        continue;
      }
      const entryMapped = mapContentTypeToMixCategory(entry.contentType);
      if (entryMapped.ok) {
        recentCategories.push({ category: entryMapped.category, atMs: entry.publishedAtMs });
      }
      // A history row of an unknown future content type is skipped: the
      // trail stays usable; the candidate's own unknown type fails loud.
    }
    const lastEntry = trail.length > 0 ? trail[trail.length - 1] : undefined;
    let previousSend: {
      readonly atMs: number;
      readonly related: boolean;
      readonly priorityClass: PublicationPriorityClass;
    } | null = null;
    if (lastEntry) {
      const classified = classifyPriority(lastEntry.priority);
      if (classified.ok) {
        previousSend = {
          atMs: lastEntry.publishedAtMs,
          related: layer.context.related,
          priorityClass: classified.value.class,
        };
      }
    }
    const jitter = scanJitterForCandidate({
      candidateId: row.id,
      priorityScore: row.priority,
      hasPreviousSend: previousSend !== null,
      related: layer.context.related,
    });
    if (!jitter.ok) {
      return { ok: false, code: 'invalid_score' };
    }
    const decision = planPublicationTime({
      schemaVersion: 1,
      nowMs,
      category: mapped.category,
      candidateLayout: draft.layout,
      priorityScore: row.priority,
      jitterMs: jitter.jitterMs,
      previousSend,
      recentLayouts,
      recentCategories,
      sameGame: layer.context.sameGame,
      eventDriven: layer.context.eventDriven,
    });
    return { ok: true, decision, priorityClass: jitter.priorityClass };
  }

  async function sendClaimed(
    row: PublicationRow,
    generation: number,
    draft: DraftRead,
    nowMs: number,
  ): Promise<ScanDetail> {
    if (deps.transport === undefined) {
      // Unreachable: the gate-ON path validated the transport before any
      // claim. The typed guard keeps the send honest under any cast.
      throw new AppError('config_invalid');
    }
    // The pre-send evidence check: a recorded delivery from a crashed
    // earlier generation heals WITHOUT a second send (the ADR-0032 gate).
    // THE SHAPE-AWARE PROOF (the d65d811 P1-2 fix): the heal asserts the
    // COMPLETE delivery — a text publication proves with its ONE record to
    // THIS destination; an album proves only with EVERY ordinal recorded
    // here AND the usages bound. A partial album witness parks uncertain
    // (the recorded ordinals may already be in the channel — a re-send
    // would duplicate them); it is NEVER healed on a non-empty ledger and
    // NEVER auto-resent.
    const messages = await listPublicationMessages(deps.executor, row.id);
    if (messages.length > 0) {
      if (discriminateAlbumDocument(draft.document_json) === 'album') {
        const planned = await deriveAlbumSendPlan({
          documentJson: draft.document_json,
          destination,
        });
        if (!planned.ok) {
          const code = `album_content_invalid:${planned.reason}`;
          const deadLetter = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: code,
            nowMs,
          });
          return deadLetter.kind === 'written'
            ? { publicationId: row.id, draftId: row.draft_id, outcome: 'dead_lettered', code }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const action = await evaluateAlbumEvidenceAction(row, planned.plan, messages, nowMs);
        if (action.action === 'dead_letter') {
          return deadLetterAlbumBinding(row, generation, action.code, nowMs);
        }
        if (action.action === 'park') {
          const marked = await markClaimedUncertain(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: action.code,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'failed_unconfirmed',
                code: action.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
      } else if (messages.length !== 1 || messages[0]!.chat_id !== destination) {
        // A text publication's ledger shows more than its single record (or
        // a record to another chat): a ledger anomaly is never a proof —
        // park uncertain for the human reconciliation, never re-send.
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'evidence_shape_anomalous',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'evidence_shape_anomalous',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const healed = await healClaimedToPublished(deps.executor, {
        publicationId: row.id,
        generation,
        nowMs,
      });
      return healed.kind === 'written'
        ? { publicationId: row.id, draftId: row.draft_id, outcome: 'healed_from_evidence' }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // THE ALBUM BRANCH (ADR-0060): a durable album content document routes
    // to the media-group send path; EVERYTHING else (a text document, an
    // unparseable string, an oversized string) keeps the text path's exact
    // prior-phase behavior — the discriminator never guesses.
    if (discriminateAlbumDocument(draft.document_json) === 'album') {
      const planned = await deriveAlbumSendPlan({
        documentJson: draft.document_json,
        destination,
      });
      if (!planned.ok) {
        const code = `album_content_invalid:${planned.reason}`;
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: code,
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? { publicationId: row.id, draftId: row.draft_id, outcome: 'dead_lettered', code }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      return sendClaimedAlbum(row, generation, draft, nowMs, planned.plan);
    }
    const render = renderEditorialPostText(draft.document_json);
    if (!render.ok) {
      const deadLetter = await markClaimedDeadLetter(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: `render_failed:${render.reason}`,
        nowMs,
      });
      return deadLetter.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'dead_lettered',
            code: `render_failed:${render.reason}`,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    const hash = await contentTextHash(render.text);
    if (!hash.ok) {
      const deadLetter = await markClaimedDeadLetter(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'content_hash_failed',
        nowMs,
      });
      return deadLetter.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'dead_lettered',
            code: 'content_hash_failed',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // THE DURABLE SEND-STARTED MARKER (the d65d811 P1-1 fix): the last
    // write BEFORE any network effect — the machine's `mark_send_started`
    // (claimed -> publishing) with the in-flight lease extension. From
    // here the row can only exit through THIS generation's fenced
    // terminals: a concurrent scan can neither claim nor reclaim it, so a
    // lease expiry mid-flight can never become a second send. A generation
    // that dies inside the window parks in the `send_may_have_started`
    // family (the ambiguous window — held for the human dispositions,
    // healed only by recorded evidence).
    const started = await markClaimedSendStarted(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
      leaseMs: SEND_IN_FLIGHT_LEASE_MS,
    });
    if (started.kind !== 'marked') {
      return { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    try {
      const sent = await deps.transport.sendMessageRich({
        chatId: destination,
        content: render.envelope,
      });
      if (!Number.isInteger(sent.messageId) || sent.messageId <= 0) {
        // A response without a usable message id proves nothing: uncertain,
        // and NOTHING is recorded (the ledger never records a guess).
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'response_message_id_invalid',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'response_message_id_invalid',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const recorded = await recordPublicationMessage(deps.executor, {
        publicationId: row.id,
        chatId: destination,
        messageId: sent.messageId,
        textHash: hash.hash,
        nowMs,
      });
      if (recorded.kind === 'duplicate_message') {
        // The ledger rejected the response's message id (reused/forged or a
        // racing generation): the honest outcome is uncertain — never a
        // claimed published, never a re-send.
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'delivery_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'delivery_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const terminal = await markClaimedPublished(deps.executor, {
        publicationId: row.id,
        generation,
        nowMs,
      });
      return terminal.kind === 'written'
        ? { publicationId: row.id, draftId: row.draft_id, outcome: 'sent' }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    } catch (error) {
      const outcome = classifySendOutcome(error);
      if (outcome.kind === 'uncertain') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: outcome.code,
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: outcome.code,
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      if (outcome.retryable) {
        const plan = planRetryAfterProvedFailure({
          attempts: generation,
          maxAttempts: row.max_attempts,
          retryAfterMs: outcome.retryAfterMs,
          nowMs,
        });
        if (plan.ok && plan.action === 'retry_wait') {
          const marked = await markClaimedRetryWait(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: outcome.code,
            runAfterMs: plan.runAfterMs,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'retry_scheduled',
                code: outcome.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'attempt_budget_spent',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'attempt_budget_spent',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const marked = await markClaimedFailed(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: outcome.code,
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_hold',
            code: outcome.code,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
  }

  /**
   * THE ALBUM SEND PATH (ADR-0060): the outbox claim consumes the durable
   * album content document through the media-group seam, with the ADR-0032
   * gate carried over INTACT:
   *  - the plan derivation is typed and BEFORE any effect — a document the
   *    strict reader refuses dead-letters with ZERO transport calls;
   *  - the LEDGER BINDING is fail-closed: every item must resolve to an
   *    UPLOADED asset whose telegram_file_id matches the document — a
   *    document the ledger cannot vouch for is dead-lettered BEFORE any
   *    send (the send identity is never accepted on faith);
   *  - the send is file_id-only (the attachments array is empty by
   *    construction — the fresh-bytes contract belongs to the upload path);
   *  - the response shape gate runs BEFORE any ledger write (the A2
   *    lesson): one message per item, in ordinal order, each id usable;
   *  - the delivery records land per ordinal with the caption hash on
   *    ordinal 0 ONLY; a rejected record parks the row uncertain — never a
   *    claimed published, never a re-send;
   *  - the usage binding lands AFTER the delivery proof: a failure parks
   *    uncertain and the NEXT scan's evidence check heals from the
   *    recorded messages — a binding failure can never orphan a proof;
   *  - transport failures classify through the SAME sop1 classifier as the
   *    text path (429 retryable with the 60s floor, 4xx hold, the rest
   *    uncertain and never auto-resent).
   */
  async function sendClaimedAlbum(
    row: PublicationRow,
    generation: number,
    draft: DraftRead,
    nowMs: number,
    plan: AlbumSendPlanV1,
  ): Promise<ScanDetail> {
    if (deps.mediaTransport === undefined || deps.mediaAssets === undefined) {
      // Unreachable: the gate-ON path validated the media seam before any
      // claim (and derived the plan), and the constructor pair rule keeps
      // the seam + ledger tied.
      throw new AppError('config_invalid');
    }
    // 2. The caption hash — the ordinal-0 delivery record's content anchor.
    let captionHash: string | null = null;
    if (plan.caption !== undefined) {
      const hash = await contentTextHash(plan.caption.text);
      if (!hash.ok) {
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'album_caption_hash_failed',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'album_caption_hash_failed',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      captionHash = hash.hash;
    }
    // 3. THE LEDGER BINDING + THE SEND-TIME RIGHTS GATE — before ANY
    // transport effect. The rights are re-read from the ledger HERE (the
    // d65d811 P1-3 fix): a blocked revocation or an unknown never-cleared
    // state dead-letters typed with ZERO transport calls.
    const binding = await resolveAlbumLedgerBindings(plan);
    if (!binding.ok) {
      return deadLetterAlbumBinding(row, generation, binding.reason, nowMs);
    }
    const bindings = binding.bindings;
    // 4. THE DURABLE SEND-STARTED MARKER (the d65d811 P1-1 fix) — the same
    // in-flight guard as the text path: claimed -> publishing, the lease
    // extended; a mid-flight lease expiry can never become a second send.
    const started = await markClaimedSendStarted(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
      leaseMs: SEND_IN_FLIGHT_LEASE_MS,
    });
    if (started.kind !== 'marked') {
      return { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 5. THE SEND — one media group, file_id-only, identity consumed.
    let sentMessages: readonly PublicationSentMediaGroupMessage[];
    try {
      sentMessages = await deps.mediaTransport.sendMediaGroup({
        chatId: destination,
        items: plan.items.map((item) => ({
          type: item.type,
          media: item.media,
          ...(item.ordinal === 0 && plan.caption !== undefined ? { caption: plan.caption } : {}),
        })),
        attachments: plan.attachments,
        sendIdentityKey: plan.sendIdentityKey,
      });
    } catch (error) {
      const outcome = classifySendOutcome(error);
      if (outcome.kind === 'uncertain') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: outcome.code,
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: outcome.code,
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      if (outcome.retryable) {
        const retryPlan = planRetryAfterProvedFailure({
          attempts: generation,
          maxAttempts: row.max_attempts,
          retryAfterMs: outcome.retryAfterMs,
          nowMs,
        });
        if (retryPlan.ok && retryPlan.action === 'retry_wait') {
          const marked = await markClaimedRetryWait(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: outcome.code,
            runAfterMs: retryPlan.runAfterMs,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'retry_scheduled',
                code: outcome.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'attempt_budget_spent',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'attempt_budget_spent',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const marked = await markClaimedFailed(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: outcome.code,
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_hold',
            code: outcome.code,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 6. THE RESPONSE SHAPE GATE — before ANY ledger write (the A2 lesson).
    const shapeValid =
      Array.isArray(sentMessages) &&
      sentMessages.length === plan.items.length &&
      sentMessages.every(
        (message) => Number.isInteger(message?.messageId) && message.messageId > 0,
      );
    if (!shapeValid) {
      // A reply without one usable id per ordinal proves nothing: uncertain,
      // and NOTHING is recorded (the ledger never records a guess).
      const marked = await markClaimedUncertain(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'response_media_group_shape_invalid',
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_unconfirmed',
            code: 'response_media_group_shape_invalid',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 7. THE PER-ORDINAL DELIVERY RECORDS — the at-most-once ledger.
    for (let ordinal = 0; ordinal < sentMessages.length; ordinal += 1) {
      const message = sentMessages[ordinal]!;
      const recorded = await recordPublicationMessage(deps.executor, {
        publicationId: row.id,
        chatId: destination,
        messageId: message.messageId,
        textHash: ordinal === 0 ? captionHash : null,
        nowMs,
        ordinal,
      });
      if (recorded.kind === 'duplicate_message') {
        // The ledger rejected the response's message id (reused/forged or a
        // racing generation): the honest outcome is uncertain — the records
        // already written stay (the evidence heal governs), never a re-send.
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'delivery_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'delivery_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
    }
    // 8. THE USAGE BINDING — after the delivery proof; a failure parks the
    // row uncertain and the NEXT scan's evidence check heals from the
    // recorded messages (the binding can never orphan a proof).
    try {
      const usages = await recordPublicationMediaUsages(deps.executor, {
        publicationId: row.id,
        usages: bindings,
        nowMs,
      });
      if (usages.kind === 'duplicate_usage') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'usage_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'usage_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
    } catch {
      const marked = await markClaimedUncertain(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'usage_record_failed',
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_unconfirmed',
            code: 'usage_record_failed',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 9. THE TERMINAL — fenced by the claim's attempts generation.
    const terminal = await markClaimedPublished(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
    });
    return terminal.kind === 'written'
      ? { publicationId: row.id, draftId: row.draft_id, outcome: 'sent' }
      : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
  }

  /** The claim plus the boundary budget dead-letter (the ADR-0037 lesson). */
  async function claimPublicationSafe(
    row: PublicationRow,
    nowMs: number,
  ): Promise<
    | { readonly kind: 'claimed'; readonly generation: number }
    | { readonly kind: 'not_claimable' }
    | { readonly kind: 'dead_lettered' }
  > {
    const claimed = await claimPublication(deps.executor, {
      publicationId: row.id,
      nowMs,
      leaseMs: PUBLISH_LEASE_MS,
    });
    if (claimed.kind === 'claimed') {
      return claimed;
    }
    // Not claimable: either a raced winner or the budget is spent. A
    // waiting row with a spent budget dead-letters AT the boundary —
    // without re-execution, without burning anything.
    const boundary = await markWaitingPublicationDeadLetter(deps.executor, {
      publicationId: row.id,
      nowMs,
    });
    return boundary.kind === 'dead_lettered'
      ? { kind: 'dead_lettered' }
      : { kind: 'not_claimable' };
  }

  return {
    /** One bounded scan round: reconcile, reclaim, decide, (maybe) send. */
    async scanDuePublications(): Promise<SchedulerScanReport> {
      const nowMs = deps.clock.now();
      const gateEnabled = deps.sendGate.enabled === true;

      // The misconfiguration is LOUD and writes NOTHING: an enablement
      // without a transport can never silently stand in for a real send.
      if (gateEnabled && deps.transport === undefined) {
        deps.logger.error('publication_scheduler.misconfigured', {
          reason: 'transport_absent',
        });
        return {
          scannedAtMs: nowMs,
          gateEnabled: true,
          decisionOnly: false,
          misconfigured: 'transport_absent',
          dueCount: 0,
          processed: 0,
          reclaimed: 0,
          uncertainParked: 0,
          uncertaintyHealed: 0,
          details: [],
        };
      }

      // THE MEDIA MISCONFIGURATION CHECK (ADR-0060, the same LOUD
      // zero-write class): a due ALBUM publication with no media-group seam
      // can never silently stand in for a real send. The probe is a bounded
      // read of the due drafts' documents; a text-only deployment (no album
      // due) is unaffected — the text path keeps working without the media
      // seam. Nothing has been written at this point: zero writes.
      if (gateEnabled && deps.mediaTransport === undefined) {
        const dueProbe = await listDuePublications(deps.executor, { nowMs, limit: scanLimit });
        let albumDue = false;
        for (const row of dueProbe) {
          const document = await deps.executor.first<{ readonly document_json: string }>({
            sql: `SELECT document_json FROM drafts WHERE id = ?`,
            params: [row.draft_id],
          });
          if (document && discriminateAlbumDocument(document.document_json) === 'album') {
            albumDue = true;
            break;
          }
        }
        if (albumDue) {
          deps.logger.error('publication_scheduler.misconfigured', {
            reason: 'media_transport_absent',
          });
          return {
            scannedAtMs: nowMs,
            gateEnabled: true,
            decisionOnly: false,
            misconfigured: 'media_transport_absent',
            dueCount: await countDuePublications(deps.executor, { nowMs }),
            processed: 0,
            reclaimed: 0,
            uncertainParked: 0,
            uncertaintyHealed: 0,
            details: [],
          };
        }
      }

      // Phase A (the d65d811 P1-1 fix, ORDER MATTERS): the ambiguous
      // in-flight windows park FIRST — the send-started generations whose
      // EXTENDED lease expired without a terminal become failed
      // (`send_may_have_started`) for the human dispositions. The same
      // reconciliation family as the heal below: it asserts the honest
      // UNKNOWN, never a send decision; the parked rows are NEVER
      // auto-resent (a parked 'failed' row is outside the claim WHERE
      // forever), and their recorded evidence heals in Phase A2 — the SAME
      // scan, the honest sequence.
      const uncertainParked = (await parkExpiredPublishingUncertain(deps.executor, { nowMs }))
        .parked;

      // Phase A2: the evidence reconciliation — runs in BOTH modes: the
      // heal asserts a recorded PROOF (the delivery happened), never a
      // send decision; an observe-only scan still reconciles the ledger's
      // facts.
      const uncertaintyHealed = await reconcileFailedWithEvidence(nowMs);

      if (!gateEnabled) {
        // DECISION-ONLY observation: zero SEND-path durable writes. The due
        // rows are read and the policy decisions computed and reported —
        // nothing is claimed, nothing is sent, no deferral is recorded.
        const due = await listDuePublications(deps.executor, { nowMs, limit: scanLimit });
        const dueCount = await countDuePublications(deps.executor, { nowMs });
        const details: ScanDetail[] = [];
        for (const row of due) {
          const draft = await deps.executor.first<DraftRead>({
            sql: `SELECT id, status, layout, document_json FROM drafts WHERE id = ?`,
            params: [row.draft_id],
          });
          if (!draft) {
            details.push({
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'decision_only',
              code: 'draft_not_found',
            });
            continue;
          }
          const decision = await buildPolicyDecision(row, draft, nowMs);
          if (!decision.ok) {
            details.push({
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'decision_only',
              code: decision.code,
            });
            continue;
          }
          if (!decision.decision.ok) {
            details.push({
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'decision_only',
              code: decision.decision.reason,
              priorityClass: decision.priorityClass,
            });
            continue;
          }
          details.push({
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'decision_only',
            dueAtMs:
              decision.decision.outcome === 'schedule' ? decision.decision.dueAtMs : undefined,
            priorityClass: decision.priorityClass,
          });
        }
        return {
          scannedAtMs: nowMs,
          gateEnabled: false,
          decisionOnly: true,
          misconfigured: false,
          dueCount,
          processed: details.length,
          reclaimed: 0,
          uncertainParked,
          uncertaintyHealed,
          details,
        };
      }

      // Phase B: the stale-lease reclaim (attempts preserved; the next
      // generation's evidence check closes the recorded window).
      const reclaimed = (await reclaimExpiredClaims(deps.executor, { nowMs })).reclaimed;
      // Phase C: the due scan.
      const dueCount = await countDuePublications(deps.executor, { nowMs });
      const due = await listDuePublications(deps.executor, { nowMs, limit: scanLimit });
      const details: ScanDetail[] = [];
      for (const row of due) {
        const claim = await claimPublicationSafe(row, nowMs);
        if (claim.kind === 'dead_lettered') {
          details.push({
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'dead_lettered',
            code: 'attempt_budget_spent',
          });
          continue;
        }
        if (claim.kind === 'not_claimable') {
          details.push({
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'not_claimable',
          });
          continue;
        }
        const generation = claim.generation;
        const draft = await deps.executor.first<DraftRead>({
          sql: `SELECT id, status, layout, document_json FROM drafts WHERE id = ?`,
          params: [row.draft_id],
        });
        if (!draft) {
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: 'eligibility_lost',
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: 'eligibility_lost',
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (draft.status !== 'approved' && draft.status !== 'auto_approved') {
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: 'eligibility_lost',
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: 'eligibility_lost',
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        const decision = await buildPolicyDecision(row, draft, nowMs);
        if (!decision.ok) {
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: decision.code,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: decision.code,
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (!decision.decision.ok) {
          // A typed psp1 input failure on a validated score is a policy
          // data bug: loud, terminal, never a silent release loop.
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: decision.decision.reason,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: decision.decision.reason,
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (decision.decision.outcome === 'defer') {
          const release = planReleaseAfterScheduleDecision({ dueAtMs: null, nowMs });
          if (!release.ok) {
            throw new AppError('internal_error');
          }
          const written = await releaseClaimed(deps.executor, {
            publicationId: row.id,
            generation,
            runAfterMs: release.runAfterMs,
            scheduledAtMs: release.scheduledAtMs,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? { publicationId: row.id, draftId: row.draft_id, outcome: 'deferred_policy' }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (decision.decision.dueAtMs > nowMs) {
          const release = planReleaseAfterScheduleDecision({
            dueAtMs: decision.decision.dueAtMs,
            nowMs,
          });
          if (!release.ok) {
            throw new AppError('internal_error');
          }
          const written = await releaseClaimed(deps.executor, {
            publicationId: row.id,
            generation,
            runAfterMs: release.runAfterMs,
            scheduledAtMs: release.scheduledAtMs,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'deferred_time',
                  dueAtMs: decision.decision.dueAtMs,
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        details.push(await sendClaimed(row, generation, draft, nowMs));
      }
      return {
        scannedAtMs: nowMs,
        gateEnabled: true,
        decisionOnly: false,
        misconfigured: false,
        dueCount,
        processed: details.length,
        reclaimed,
        uncertainParked,
        uncertaintyHealed,
        details,
      };
    },
  };
}
