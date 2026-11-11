/**
 * Phase 8.4 — the EDIT/CORRECTION engine (the application composition). It
 * turns the pure ecl1 decision (the blueprint §15 scenarios) into durable,
 * at-most-once effects over the blueprint-approved tables (schema 6 —
 * consumed, ZERO DDL; ADR-0059):
 *
 *  - the supersede: the prior publication row goes to the machine-legal
 *    `superseded` state (pol1 authority — the conditional UPDATE covers
 *    exactly pending/retry_wait/published/failed), the prior draft goes to
 *    `superseded` (the crash-safe route for in-flight rows: the eligibility
 *    check dead-letters a still-claimed generation's publication without a
 *    send), and the deterministic LINK audit event is recorded once;
 *  - the edit: per recorded message (the `publication_messages` ledger is
 *    the edit target set — a message outside the ledger is skipped typed),
 *    the audit row is CLAIMED (deterministic caid1 id — the PK) BEFORE the
 *    transport call, so a re-invocation with the same revision can never
 *    re-apply an edit (at-most-once per revision); the outcome is finalized
 *    compare-and-set (a stale generation cannot overwrite another claim);
 *  - the honest outcomes (the sop1 classification reused for edits): 429 is
 *    a proved non-delivery of the EDIT — recorded retryable, NEVER
 *    auto-retried inside the engine (a parked edit is re-driven by a later
 *    correction pass or a human); timeout/network/5xx/unknown is the
 *    ambiguous window — the edit MAY have applied, recorded uncertain,
 *    never re-applied automatically;
 *  - the gate: OFF = decision-only (the plan is computed and reported, ZERO
 *    writes — the house observe pattern); ON with an edit disposition and
 *    NO transport = the LOUD misconfiguration refusal (zero writes). A
 *    follow-up-only disposition needs no transport (pure DB effects).
 *
 * The LIVE surfaces stay BLOCKED_LIVE (Posidon only): the edit transport is
 * injected by the caller — nothing in this module can reach the network by
 * itself, and no flag exists to enable it in production.
 */

import type { DbExecutor } from '../../adapters/db/db-executor';
import { AppError } from '../../shared/errors/app-error';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import {
  findPublicationById,
  listPublicationMessages,
  type PublicationRow,
} from '../../adapters/db/publication-outbox-store';
import {
  finalizeCorrectionAuditEvent,
  listActivePublicationsForStory,
  markDraftSuperseded,
  recordCorrectionAuditEvent,
  supersedePublicationById,
} from '../../adapters/db/publication-correction-store';
import {
  deriveCorrectionAuditEventId,
  planCorrectionDisposition,
  type CorrectionClass,
  type CorrectionDisposition,
} from '../../domain/publishing/edit-correction';
import { classifySendOutcome } from '../../domain/publishing/send-outcome';

/** The edit transport seam (the ONLY artificial piece in tests). */
export interface PublicationEditTransport {
  editMessageTextRich(input: {
    readonly chatId: number | string;
    readonly messageId: number;
    readonly content: {
      readonly kind: string;
      readonly text: string;
      readonly entities: readonly unknown[];
    };
  }): Promise<{ readonly messageId: number }>;
  editMessageCaptionRich(input: {
    readonly chatId: number | string;
    readonly messageId: number;
    readonly caption: {
      readonly kind: string;
      readonly text: string;
      readonly entities: readonly unknown[];
    };
  }): Promise<{ readonly messageId: number }>;
}

/** One planned in-place edit (the caller supplies the corrected content). */
export interface CorrectionEditMessage {
  readonly chatId: string;
  readonly messageId: number;
  readonly shape: 'text' | 'caption';
  readonly content: {
    readonly kind: string;
    readonly text: string;
    readonly entities: readonly unknown[];
  };
}

export type CorrectionEditOutcome =
  'applied' | 'already_recorded' | 'failed_proved' | 'uncertain' | 'not_recorded';

export type ApplyCorrectionReport = {
  readonly applied: boolean;
  readonly disposition: CorrectionDisposition | null;
  readonly refusal?:
    | 'invalid_input'
    | 'not_supersedable'
    | 'no_edit_target'
    | 'edits_absent'
    | 'misconfigured_transport_absent';
  readonly planReasons: readonly string[];
  readonly supersededPublications: readonly string[];
  readonly draftSuperseded: boolean;
  readonly auditLinkEventId: string;
  readonly edits: readonly {
    readonly messageId: number;
    readonly outcome: CorrectionEditOutcome;
    readonly auditEventId: string;
    readonly code?: string;
  }[];
};

/** The bounded number of in-place edits per apply pass. */
const MAX_EDITS_PER_PASS = 16;

interface RecordedMessage {
  readonly chat_id: string;
  readonly message_id: number;
  readonly ordinal: number;
}

export function createEditCorrectionEngine(deps: {
  readonly executor: DbExecutor;
  readonly editTransport?: PublicationEditTransport;
  /** The correction apply gate (ships OFF — decision-only). */
  readonly applyGate: { readonly enabled: boolean };
  readonly clock: Clock;
  readonly logger: Logger;
}) {
  async function applyEditToMessage(input: {
    readonly revisionId: string;
    readonly prior: PublicationRow;
    readonly edit: CorrectionEditMessage;
    readonly recorded: ReadonlyMap<number, RecordedMessage>;
  }): Promise<ApplyCorrectionReport['edits'][number]> {
    const recorded = input.recorded.get(input.edit.messageId);
    if (
      !recorded ||
      recorded.chat_id !== input.edit.chatId ||
      !Number.isSafeInteger(input.edit.messageId) ||
      input.edit.messageId <= 0
    ) {
      return {
        messageId: input.edit.messageId,
        outcome: 'not_recorded',
        auditEventId: '',
        code: 'message_not_in_ledger',
      };
    }
    const derived = await deriveCorrectionAuditEventId({
      action: 'edit',
      revisionId: input.revisionId,
      chatId: input.edit.chatId,
      messageId: input.edit.messageId,
    });
    if (!derived.ok) {
      return {
        messageId: input.edit.messageId,
        outcome: 'not_recorded',
        auditEventId: '',
        code: 'invalid_revision_identity',
      };
    }
    // The CLAIM: the deterministic audit row exists BEFORE the transport
    // call — a duplicate revision can never re-apply an edit (the
    // at-most-once claim), and a crash after the send leaves the attempted
    // marker (the honest unknown, finalized by nobody else — the CAS).
    const attemptedMetadataJson = JSON.stringify({
      outcome: 'attempted',
      publicationId: input.prior.id,
      ordinal: recorded.ordinal,
    });
    const claim = await recordCorrectionAuditEvent(deps.executor, {
      eventId: derived.id,
      action: 'publication.edit',
      actorType: 'system',
      actorId: 'edit_correction_engine',
      targetType: 'publication_message',
      targetId: `${input.prior.id}:${input.edit.messageId}`,
      traceId: null,
      metadataJson: attemptedMetadataJson,
      nowMs: deps.clock.now(),
    });
    if (claim.kind === 'duplicate') {
      return {
        messageId: input.edit.messageId,
        outcome: 'already_recorded',
        auditEventId: derived.id,
      };
    }
    let finalMetadataJson: string;
    let outcome: CorrectionEditOutcome;
    let code: string | undefined;
    try {
      if (input.edit.shape === 'caption') {
        await deps.editTransport?.editMessageCaptionRich({
          chatId: input.edit.chatId,
          messageId: input.edit.messageId,
          caption: input.edit.content,
        });
      } else {
        await deps.editTransport?.editMessageTextRich({
          chatId: input.edit.chatId,
          messageId: input.edit.messageId,
          content: input.edit.content,
        });
      }
      outcome = 'applied';
      finalMetadataJson = JSON.stringify({
        outcome: 'applied',
        publicationId: input.prior.id,
        ordinal: recorded.ordinal,
      });
    } catch (error) {
      const classified = classifySendOutcome(error);
      if (classified.kind === 'failed_proved') {
        outcome = 'failed_proved';
        code = classified.code;
        finalMetadataJson = JSON.stringify({
          outcome: 'failed_proved',
          code: classified.code,
          retryable: classified.retryable,
          publicationId: input.prior.id,
          ordinal: recorded.ordinal,
        });
      } else {
        outcome = 'uncertain';
        code = classified.code;
        finalMetadataJson = JSON.stringify({
          outcome: 'uncertain',
          code: classified.code,
          publicationId: input.prior.id,
          ordinal: recorded.ordinal,
        });
      }
    }
    const finalized = await finalizeCorrectionAuditEvent(deps.executor, {
      eventId: derived.id,
      attemptedMetadataJson,
      finalMetadataJson,
    });
    if (finalized.kind === 'fenced') {
      // Another generation's claim owns the row — the honest outcome is
      // already_recorded, never an overwrite.
      return {
        messageId: input.edit.messageId,
        outcome: 'already_recorded',
        auditEventId: derived.id,
      };
    }
    return { messageId: input.edit.messageId, outcome, auditEventId: derived.id, code };
  }

  async function applyCorrection(input: {
    readonly storyId: string;
    readonly priorPublicationId: string;
    /** The correction revision identity (e.g. the new draft id + version). */
    readonly revisionId: string;
    readonly correctionClass: CorrectionClass;
    readonly followUpMaterial: boolean;
    readonly correctionFollowUpDesired: boolean;
    /** The planned in-place edits (bounded). */
    readonly edits?: readonly CorrectionEditMessage[];
  }): Promise<ApplyCorrectionReport> {
    const noopReport = (partial: Partial<ApplyCorrectionReport>): ApplyCorrectionReport => ({
      applied: false,
      disposition: null,
      planReasons: [],
      supersededPublications: [],
      draftSuperseded: false,
      auditLinkEventId: '',
      edits: [],
      ...partial,
    });

    const prior = await findPublicationById(deps.executor, input.priorPublicationId);
    if (!prior || prior.story_id !== input.storyId) {
      return noopReport({ refusal: 'invalid_input' });
    }
    const messages = await listPublicationMessages(deps.executor, prior.id);
    const plan = planCorrectionDisposition({
      correctionClass: input.correctionClass,
      prior: {
        status: prior.status,
        recordedMessages: messages.length,
        publishedAtMs: prior.published_at,
      },
      followUpMaterial: input.followUpMaterial,
      correctionFollowUpDesired: input.correctionFollowUpDesired,
      nowMs: deps.clock.now(),
    });
    if (!plan.ok) {
      return noopReport({ refusal: plan.reason });
    }

    const editRequests = input.edits ?? [];
    if (editRequests.length > MAX_EDITS_PER_PASS) {
      throw new AppError('config_invalid');
    }
    const editDisposition =
      plan.disposition === 'edit' || plan.disposition === 'edit_and_follow_up';
    if (deps.applyGate.enabled === false) {
      // Decision-only: the plan is the deliverable, zero durable writes
      // (the house observe pattern).
      return noopReport({
        disposition: plan.disposition,
        planReasons: plan.reasons,
      });
    }
    if (editDisposition && !deps.editTransport) {
      // The LOUD misconfiguration: zero writes, the gate cannot stand.
      deps.logger.error('correction_engine.misconfigured_transport_absent', {
        publicationId: prior.id,
      });
      return noopReport({
        disposition: plan.disposition,
        planReasons: plan.reasons,
        refusal: 'misconfigured_transport_absent',
      });
    }
    if (editDisposition && editRequests.length === 0) {
      // The plan demands an in-place edit; without the payloads it cannot
      // be honored — zero writes, the caller supplies the corrected content.
      return noopReport({
        disposition: plan.disposition,
        planReasons: plan.reasons,
        refusal: 'edits_absent',
      });
    }

    const recorded = new Map<number, RecordedMessage>(
      messages.map((message) => [message.message_id, message]),
    );

    // --- the supersede half (follow_up / edit_and_follow_up) ---
    // An EDIT-ONLY correction keeps the row `published`: the delivery is
    // corrected in place, the ledger records the original delivery, and the
    // supersede is reserved for rows a NEWER publication replaces.
    const supersededPublications: string[] = [];
    let draftSuperseded = false;
    if (plan.disposition === 'follow_up' || plan.disposition === 'edit_and_follow_up') {
      const supersede = await supersedePublicationById(deps.executor, {
        publicationId: prior.id,
        nowMs: deps.clock.now(),
      });
      if (supersede.kind === 'superseded') {
        supersededPublications.push(prior.id);
        const draftOutcome = await markDraftSuperseded(deps.executor, {
          draftId: prior.draft_id,
          nowMs: deps.clock.now(),
        });
        draftSuperseded = draftOutcome.kind === 'superseded';
      }
      // not_found/not_supersedable: the prior row moved under us — the
      // honest report carries the empty supersede list; the link audit
      // below still records the correction intent once.
    }

    // --- the deterministic link audit (recorded once) ---
    // A `none` disposition performs no channel effect and no row action —
    // the honest audit trail stays empty for it.
    let auditLinkEventId = '';
    if (plan.disposition !== 'none') {
      const linkDerived = await deriveCorrectionAuditEventId({
        action: 'link',
        revisionId: input.revisionId,
        chatId: prior.id,
        messageId: 1,
      });
      if (linkDerived.ok) {
        const link = await recordCorrectionAuditEvent(deps.executor, {
          eventId: linkDerived.id,
          action: 'publication.correction_link',
          actorType: 'system',
          actorId: 'edit_correction_engine',
          targetType: 'publication',
          targetId: prior.id,
          traceId: null,
          metadataJson: JSON.stringify({
            disposition: plan.disposition,
            revisionId: input.revisionId,
            superseded: supersededPublications,
          }),
          nowMs: deps.clock.now(),
        });
        if (link.kind === 'recorded' || link.kind === 'duplicate') {
          auditLinkEventId = linkDerived.id;
        }
      }
    }

    // --- the edit half ---
    const editResults: {
      readonly messageId: number;
      readonly outcome: CorrectionEditOutcome;
      readonly auditEventId: string;
      readonly code?: string;
    }[] = [];
    if (editDisposition) {
      const transport = deps.editTransport;
      if (!transport) {
        // Unreachable by construction (the refusal gate above) — defense in
        // depth: never record an applied outcome without a transport.
        throw new AppError('config_invalid');
      }
      for (const edit of editRequests) {
        editResults.push(
          await applyEditToMessage({ revisionId: input.revisionId, prior, edit, recorded }),
        );
      }
    }

    // The other active rows of the story are REPORTED (the whole-story
    // correction drives them one prior at a time).
    const others = await listActivePublicationsForStory(deps.executor, {
      storyId: input.storyId,
      excludePublicationId: prior.id,
    });
    if (others.length > 0) {
      deps.logger.info('correction_engine.other_active_priors', {
        storyId: input.storyId,
        count: others.length,
      });
    }

    deps.logger.info('correction_engine.applied', {
      publicationId: prior.id,
      disposition: plan.disposition,
      superseded: supersededPublications.length,
      edits: editResults.length,
    });

    return {
      applied: true,
      disposition: plan.disposition,
      planReasons: plan.reasons,
      supersededPublications,
      draftSuperseded,
      auditLinkEventId,
      edits: editResults,
    };
  }

  return { applyCorrection };
}
