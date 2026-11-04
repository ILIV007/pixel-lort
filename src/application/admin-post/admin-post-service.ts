/**
 * R1.20-R — the admin post pipeline APPLICATION service.
 *
 * Executes the typed admin-post actions the command router emits, against
 * the durable store, following the R1.18 injection discipline: the router
 * NEVER queries D1; this service is wired ONLY while the fail-closed
 * ADMIN_POST_ENABLED gate is ON.
 *
 * Contract highlights (round requirements, all covered by tests):
 * - CAPTURE is explicit: media posts (including caption-only) are REJECTED
 *   with a stable reply — a caption is never treated as a complete post;
 *   malformed rich metadata, contract-invalid content, storage-oversize
 *   content and the version limit are all explicit rejections; nothing is
 *   ever silently dropped. A redelivered update (same update_id) can never
 *   create a duplicate version (durable source-update guard, on top of the
 *   telegram_updates claim).
 * - PREVIEW is faithful: the content message is the EXACT stored envelope
 *   (text byte-for-byte + validated entities, NO parse_mode) re-read from
 *   D1, re-validated, and fingerprint-verified; control information
 *   (buttons, labels) travels in a SEPARATE message so the content text and
 *   its UTF-16 offsets are never altered.
 * - APPROVAL is bound to the previewed content SERVER-SIDE: the callback
 *   token resolves through the durable preview-session row, whose
 *   fingerprint must equal the STORED version's fingerprint and whose
 *   version must be the draft's CURRENT version. The optional fingerprint
 *   field in the callback payload is an extra tamper check only — omitting
 *   it bypasses nothing (the binding lives server-side), and a foreign
 *   fingerprint is rejected. One ACTIVE approval per version; a duplicate
 *   approver gets an honest reply.
 * - PUBLICATION is safe and honest: only an ACTIVE approval for the CURRENT
 *   version can be consumed; the destination is the operator-configured
 *   TARGET_CHANNEL (never user input); the partial UNIQUE index admits one
 *   primary publication per version; the send is claimed (lease + owner
 *   fence), sent through the direct-entity transport (no parse_mode), and
 *   the outcome is recorded HONESTLY: sent / failed_definitive (proved
 *   non-delivery) / uncertain (timeout, network, 5xx, invalid response —
 *   the message MAY have arrived). Uncertain outcomes are NEVER auto-resent;
 *   the only re-send path is the explicit human-confirmed supersede flow
 *   offered by /post_status. NO exactly-once delivery claim is made anywhere.
 * - The LIVE publish flag gates only the send: while OFF the publish action
 *   stops BEFORE any publication row or Bot API call, the approval stays
 *   active, and the reply says so plainly.
 *
 * Logging: stable event names + outcome words + version numbers only. Never
 * message text, user ids, chat ids, tokens, or destinations.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  captureVersion,
  cancelOpenDraft,
  claimPublication,
  consumeApproval,
  createPublication,
  createPreviewSession,
  findOpenDraftByCreator,
  findPreviewSessionBySourceUpdate,
  findPrimaryPublication,
  findVersionBySourceUpdate,
  finishPublication,
  getApproval,
  getDraft,
  getPreviewSession,
  getPublication,
  getVersion,
  recordApproval,
  supersedePublication,
  type AdminPostPublicationRow,
} from '../../adapters/db/admin-post-store';
import { consumeActionToken, issueActionToken } from '../../adapters/telegram/action-tokens';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import { ADMIN_POST_STRINGS } from '../../admin/admin-post-strings';
import type { AdminRole } from '../../admin/roles';
import { roleHasPermission } from '../../admin/roles';
import type { AdminUiLanguage } from '../../admin/ui-language';
import type { ParsedRichTextExtraction } from '../../adapters/telegram/update-parser';
import {
  createRichTextEnvelope,
  readRichTextEnvelope,
  type RichTextEnvelope,
} from '../../domain/telegram/rich-text-envelope';
import { randomToken, serializeAndFingerprint } from '../../domain/admin-post/fingerprint';
import { AppError } from '../../shared/errors/app-error';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';

/** Preview session + action-token lifetime: conservative 30 minutes. */
export const ADMIN_POST_SESSION_TTL_MS = 30 * 60 * 1000;
/** Publication claim lease: the send is bounded (10s client timeout) — 60s is conservative. */
export const ADMIN_POST_PUBLISH_LEASE_MS = 60 * 1000;

/** Stable action descriptors stored in admin_action_tokens rows. */
export const ADMIN_POST_ACTION_APPROVE = 'admin_post.approve';
export const ADMIN_POST_ACTION_PUBLISH = 'admin_post.publish';
export const ADMIN_POST_ACTION_CONFIRM_REPUBLISH = 'admin_post.confirm_republish';

export interface AdminPostButton {
  readonly text: string;
  readonly callbackData: string;
}

export type AdminPostButtons = readonly (readonly AdminPostButton[])[];

export type AdminPostExecutionResult =
  | { readonly kind: 'reply'; readonly text: TelegramSafeHtml; readonly buttons?: AdminPostButtons }
  | {
      readonly kind: 'preview';
      readonly content: RichTextEnvelope;
      readonly control: TelegramSafeHtml;
      readonly buttons: AdminPostButtons;
    }
  | { readonly kind: 'answer'; readonly callbackText: string }
  | { readonly kind: 'none' };

export interface AdminPostServiceConfig {
  /** The live-publication gate (ships OFF). */
  readonly livePublishEnabled: boolean;
  /**
   * The operator-configured destination (ADR-0009, TARGET_CHANNEL): an
   * @username or a numeric chat id. NEVER user input; consumed only by the
   * send path while the live gate is ON.
   */
  readonly destination?: string;
}

/**
 * The direct-entity transport used for the actual channel send. Injected;
 * absent = publishing temporarily unavailable (nothing is ever sent, nothing
 * is marked terminal by the send path itself).
 */
export interface AdminPostTransport {
  sendMessageRich(input: {
    readonly chatId: number | string;
    readonly content: RichTextEnvelope;
    readonly disableLinkPreview?: boolean;
    readonly customEmojiEligible?: boolean;
  }): Promise<{ readonly messageId: number }>;
}

export interface AdminPostService {
  capture(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly updateId: number;
    readonly text: string;
    readonly richText: ParsedRichTextExtraction | undefined;
    readonly richCaptionPresent: boolean;
    readonly hasMediaAttachment: boolean;
  }): Promise<AdminPostExecutionResult>;
  preview(input: {
    readonly chatId: number;
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly updateId: number;
  }): Promise<AdminPostExecutionResult>;
  status(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AdminPostExecutionResult>;
  cancel(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AdminPostExecutionResult>;
  handleCallback(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly token: string;
  }): Promise<AdminPostExecutionResult>;
}

interface ActionTokenPayload {
  readonly version?: unknown;
  readonly fingerprint?: unknown;
  readonly sessionId?: unknown;
  readonly publicationId?: unknown;
}

const S = ADMIN_POST_STRINGS;

function localize(ui: AdminUiLanguage, entry: Readonly<Record<AdminUiLanguage, string>>): string {
  return entry[ui];
}

function parsePayload(payloadJson: string): ActionTokenPayload {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ActionTokenPayload;
    }
  } catch {
    // fall through — an unreadable payload fails the binding checks below
  }
  return {};
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function asFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function asTokenId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
}

/**
 * The @username / numeric-id destination goes to the Bot API as the chat_id
 * value verbatim (Telegram resolves @username targets server-side; numeric
 * ids parse here so the type stays honest). The value is operator
 * configuration validated upstream — never user input.
 */
function destinationChatId(destination: string): number | string {
  if (/^-?[0-9]+$/.test(destination)) {
    return Number.parseInt(destination, 10);
  }
  return destination;
}

function toStableErrorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unknown_send_error';
}

/**
 * Definitive send failure = PROVED non-delivery: Telegram 4xx client errors
 * (including 429 rate limiting — the request was NOT accepted) and pre-fetch
 * typed rejections. Ambiguous failures (timeout, network, 5xx, and an
 * unreadable response envelope — the send may have succeeded) are UNCERTAIN.
 */
function isDefinitiveSendFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    return true; // pre-fetch typed rejection — the fetch never happened
  }
  if (error instanceof Error && error.name === 'TelegramApiError') {
    if ((error as { code?: unknown }).code === 'telegram_response_invalid') {
      return false;
    }
    return (error as { retryable?: unknown }).retryable === false;
  }
  return false; // unknown throw shapes stay UNCERTAIN (fail-safe)
}

export function createAdminPostService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AdminPostServiceConfig;
  readonly transport?: AdminPostTransport;
}): AdminPostService {
  const { executor, clock, logger, config } = deps;

  function reply(
    ui: AdminUiLanguage,
    entry: Readonly<Record<AdminUiLanguage, string>>,
  ): AdminPostExecutionResult {
    return { kind: 'reply', text: escapeTelegramHtml(localize(ui, entry)) };
  }

  function answer(ui: AdminUiLanguage, text: string): AdminPostExecutionResult {
    return { kind: 'answer', callbackText: text };
  }

  async function mintToken(input: {
    readonly telegramUserId: number;
    readonly permission: string;
    readonly action: string;
    readonly draftId: string;
    readonly payload: Record<string, unknown>;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): Promise<string> {
    const token = randomToken();
    // AWAITED: the tokens must be durable BEFORE the message carrying them
    // is sent — a fast click can otherwise hit a missing token row.
    await issueActionToken(executor, {
      token,
      telegramUserId: input.telegramUserId,
      permission: input.permission,
      action: input.action,
      targetType: 'admin_post_draft',
      targetId: input.draftId,
      payloadJson: JSON.stringify(input.payload),
      expiresAtMs: input.expiresAtMs,
      nowMs: input.nowMs,
    });
    return token;
  }

  /**
   * The SERVER-SIDE preview binding check shared by approve and publish:
   * resolves the session, verifies the optional payload fingerprint against
   * it, verifies the session's fingerprint against the STORED version, and
   * verifies the version is still the draft's current head. Omitting the
   * payload fingerprint bypasses NOTHING; a foreign payload fingerprint or
   * version is rejected as tampered.
   */
  async function resolveBoundVersion(
    draftId: string,
    payload: ActionTokenPayload,
    nowMs: number,
  ): Promise<
    | {
        readonly kind: 'ok';
        readonly version: number;
        readonly fingerprint: string;
        readonly sessionId: string;
      }
    | { readonly kind: 'rejected'; readonly reason: 'session' | 'tampered' | 'stale' | 'corrupt' }
  > {
    const sessionId = asTokenId(payload.sessionId);
    if (sessionId === undefined) {
      return { kind: 'rejected', reason: 'session' };
    }
    const session = await getPreviewSession(executor, sessionId);
    if (session === null || session.expires_at_ms <= nowMs || session.draft_id !== draftId) {
      return { kind: 'rejected', reason: 'session' };
    }
    const payloadFingerprint = asFingerprint(payload.fingerprint);
    if (payloadFingerprint !== undefined && payloadFingerprint !== session.fingerprint) {
      return { kind: 'rejected', reason: 'tampered' };
    }
    const payloadVersion = asPositiveInteger(payload.version);
    if (payloadVersion !== undefined && payloadVersion !== session.version) {
      return { kind: 'rejected', reason: 'tampered' };
    }
    const versionRow = await getVersion(executor, draftId, session.version);
    if (versionRow === null) {
      return { kind: 'rejected', reason: 'corrupt' };
    }
    if (versionRow.fingerprint !== session.fingerprint) {
      // Stored content changed or was corrupted after the preview — the
      // previewed content no longer exists; never approve or send from it.
      return { kind: 'rejected', reason: 'stale' };
    }
    const draft = await getDraft(executor, draftId);
    if (draft === null || draft.status !== 'open' || draft.current_version !== session.version) {
      return { kind: 'rejected', reason: 'stale' };
    }
    return { kind: 'ok', version: session.version, fingerprint: versionRow.fingerprint, sessionId };
  }

  function rejectionAnswer(
    ui: AdminUiLanguage,
    reason: 'session' | 'tampered' | 'stale' | 'corrupt',
  ): AdminPostExecutionResult {
    switch (reason) {
      case 'session':
        return answer(ui, localize(ui, S.sessionUnknownOrExpired));
      case 'tampered':
        return answer(ui, localize(ui, S.fingerprintTampered));
      case 'stale':
        return answer(ui, localize(ui, S.staleVersion));
      case 'corrupt':
        return answer(ui, localize(ui, S.storedContentCorrupt));
    }
  }

  /**
   * The guarded send + honest outcome recording (publish and the confirmed
   * re-send): claim (queued -> claimed, lease + owner fence) -> read + verify
   * the stored content -> send through the direct-entity transport -> record
   * the outcome FENCED by the claim owner. A late response whose lease
   * expired or whose claim was superseded can never overwrite newer state.
   */
  async function claimSendAndRecord(input: {
    readonly publicationId: string;
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly ui: AdminUiLanguage;
  }): Promise<AdminPostExecutionResult> {
    const nowMs = clock.now();
    const claimedBy = randomToken();
    const claim = await claimPublication(executor, {
      publicationId: input.publicationId,
      claimedBy,
      leaseMs: ADMIN_POST_PUBLISH_LEASE_MS,
      nowMs,
    });
    if (claim.kind === 'not_queued') {
      return answer(input.ui, localize(input.ui, S.publishAlreadyInProgress));
    }

    const versionRow = await getVersion(executor, input.draftId, input.version);
    if (versionRow === null || versionRow.fingerprint !== input.fingerprint) {
      // Defensive: the content is not verifiably the approved bytes — never
      // send. Definitive failure, fenced.
      await finishPublication(executor, {
        publicationId: input.publicationId,
        claimedBy,
        state: 'failed_definitive',
        errorCode: 'content_unverified',
        nowMs: clock.now(),
      });
      return answer(input.ui, localize(input.ui, S.publishFailedDefinitive));
    }
    const read = readRichTextEnvelope(versionRow.envelope_json);
    if (!read.ok) {
      await finishPublication(executor, {
        publicationId: input.publicationId,
        claimedBy,
        state: 'failed_definitive',
        errorCode: 'stored_content_invalid',
        nowMs: clock.now(),
      });
      return answer(input.ui, localize(input.ui, S.storedContentCorrupt));
    }

    if (config.destination === undefined || config.destination === '') {
      await finishPublication(executor, {
        publicationId: input.publicationId,
        claimedBy,
        state: 'failed_definitive',
        errorCode: 'destination_missing',
        nowMs: clock.now(),
      });
      return answer(input.ui, localize(input.ui, S.publishMissingDestination));
    }
    if (deps.transport === undefined) {
      // Nothing was sent; the row stays `claimed` under its lease and the
      // status view turns it into the honest stale-unknown + confirm path
      // after expiry. The consumed approval is not needed again (the confirm
      // re-send path re-verifies the fingerprint instead).
      logger.warn('admin_post.publish.transport_unavailable', { version: input.version });
      return answer(input.ui, localize(input.ui, S.publishTransportUnavailable));
    }

    try {
      const sent = await deps.transport.sendMessageRich({
        chatId: destinationChatId(config.destination),
        content: read.envelope,
      });
      const recorded = await finishPublication(executor, {
        publicationId: input.publicationId,
        claimedBy,
        state: 'sent',
        botMessageId: sent.messageId,
        nowMs: clock.now(),
      });
      logger.info('admin_post.publish.outcome', {
        outcome: 'sent',
        version: input.version,
        fenced: recorded.kind === 'recorded',
      });
      if (recorded.kind === 'fence_rejected') {
        // A late resolution racing a superseded claim: the durable state
        // stays owned by the newer path; report honestly.
        return answer(input.ui, localize(input.ui, S.publishSentButStateUnknown));
      }
      return answer(input.ui, localize(input.ui, S.publishDone(input.version)));
    } catch (error) {
      const errorCode = toStableErrorCode(error);
      const definitive = isDefinitiveSendFailure(error);
      const recorded = await finishPublication(executor, {
        publicationId: input.publicationId,
        claimedBy,
        state: definitive ? 'failed_definitive' : 'uncertain',
        errorCode,
        nowMs: clock.now(),
      });
      logger.warn('admin_post.publish.outcome', {
        outcome: definitive ? 'failed_definitive' : 'uncertain',
        errorCode,
        version: input.version,
        fenced: recorded.kind === 'recorded',
      });
      if (recorded.kind === 'fence_rejected') {
        return answer(input.ui, localize(input.ui, S.publishSentButStateUnknown));
      }
      return answer(
        input.ui,
        definitive
          ? localize(input.ui, S.publishFailedDefinitive)
          : localize(input.ui, S.publishUncertain),
      );
    }
  }

  return {
    async capture(input) {
      const ui = input.uiLanguage;
      // Explicit rejections first — nothing is ever silently dropped.
      if (input.hasMediaAttachment || input.richCaptionPresent) {
        return reply(ui, S.captureMediaRejected);
      }
      if (input.richText !== undefined && !input.richText.ok) {
        logger.warn('admin_post.capture.rejected', { reason: 'rich_metadata_malformed' });
        return reply(ui, S.captureRichMalformed);
      }
      const envelopeOutcome = createRichTextEnvelope({
        kind: 'text',
        text: input.text,
        entities: input.richText?.entities ?? [],
      });
      if (!envelopeOutcome.ok) {
        logger.warn('admin_post.capture.rejected', { reason: envelopeOutcome.reason });
        return reply(ui, S.captureInvalidContent);
      }
      const serialized = await serializeAndFingerprint(envelopeOutcome.envelope);
      if (!serialized.ok) {
        return reply(ui, S.captureSerializedTooLarge);
      }

      const duplicate = await findVersionBySourceUpdate(
        executor,
        input.updateId,
        input.telegramUserId,
      );
      if (duplicate !== null) {
        logger.info('admin_post.capture.duplicate_source_update', { version: duplicate.version });
        return reply(ui, S.captureAlreadyCaptured);
      }

      const existing = await findOpenDraftByCreator(executor, input.telegramUserId);
      const nowMs = clock.now();
      const outcome = await captureVersion(executor, {
        draftId: randomToken(),
        existingDraftId: existing?.id,
        envelopeJson: serialized.json,
        fingerprint: serialized.fingerprint,
        sourceUpdateId: input.updateId,
        telegramUserId: input.telegramUserId,
        nowMs,
      });
      if (outcome.kind === 'limit_reached') {
        return reply(ui, S.captureVersionLimit);
      }
      logger.info('admin_post.capture', { outcome: outcome.kind, version: outcome.version });
      return {
        kind: 'reply',
        text: escapeTelegramHtml(
          outcome.kind === 'created'
            ? localize(ui, S.captureSaved(outcome.version))
            : localize(ui, S.captureUpdated(outcome.version)),
        ),
      };
    },

    async preview(input) {
      const ui = input.uiLanguage;
      const draft = await findOpenDraftByCreator(executor, input.telegramUserId);
      if (draft === null) {
        return reply(ui, S.noOpenDraft);
      }
      const versionRow = await getVersion(executor, draft.id, draft.current_version);
      if (versionRow === null) {
        return reply(ui, S.storedContentCorrupt);
      }
      const read = readRichTextEnvelope(versionRow.envelope_json);
      if (!read.ok || read.envelope.kind !== 'text') {
        return reply(ui, S.storedContentCorrupt);
      }
      // Integrity: re-derive the fingerprint from the stored bytes — a
      // mismatch means the stored document was corrupted/tampered with.
      const recomputed = await serializeAndFingerprint(read.envelope);
      if (!recomputed.ok || recomputed.fingerprint !== versionRow.fingerprint) {
        logger.warn('admin_post.preview.fingerprint_mismatch', { version: draft.current_version });
        return reply(ui, S.storedContentCorrupt);
      }

      const nowMs = clock.now();
      // Redelivery idempotency: the same source update reuses its session
      // (a retry of the same preview request never mints fresh tokens).
      const existingSession = await findPreviewSessionBySourceUpdate(executor, input.updateId);
      const sessionMatches =
        existingSession !== null &&
        existingSession.draft_id === draft.id &&
        existingSession.version === draft.current_version &&
        existingSession.fingerprint === versionRow.fingerprint &&
        existingSession.expires_at_ms > nowMs;
      const sessionId =
        sessionMatches && existingSession !== null ? existingSession.id : randomToken();
      if (!sessionMatches) {
        await createPreviewSession(executor, {
          id: sessionId,
          draftId: draft.id,
          version: draft.current_version,
          fingerprint: versionRow.fingerprint,
          previewChatId: input.chatId,
          sourceUpdateId: input.updateId,
          expiresAtMs: nowMs + ADMIN_POST_SESSION_TTL_MS,
          nowMs,
        });
      }

      const payload = {
        version: draft.current_version,
        fingerprint: versionRow.fingerprint,
        sessionId,
      };
      const row: AdminPostButton[] = [];
      if (roleHasPermission(input.role, 'draft.approve')) {
        const token = await mintToken({
          telegramUserId: input.telegramUserId,
          permission: 'draft.approve',
          action: ADMIN_POST_ACTION_APPROVE,
          draftId: draft.id,
          payload,
          expiresAtMs: nowMs + ADMIN_POST_SESSION_TTL_MS,
          nowMs,
        });
        row.push({ text: localize(ui, S.approveButton), callbackData: `a:${token}` });
      }
      if (roleHasPermission(input.role, 'publication.publish')) {
        const token = await mintToken({
          telegramUserId: input.telegramUserId,
          permission: 'publication.publish',
          action: ADMIN_POST_ACTION_PUBLISH,
          draftId: draft.id,
          payload,
          expiresAtMs: nowMs + ADMIN_POST_SESSION_TTL_MS,
          nowMs,
        });
        row.push({ text: localize(ui, S.publishButton), callbackData: `a:${token}` });
      }
      const buttons: AdminPostButtons = row.length > 0 ? [row] : [];

      logger.info('admin_post.preview', { version: draft.current_version });
      return {
        kind: 'preview',
        content: read.envelope,
        control: composeTelegramHtml([
          telegramBold(localize(ui, S.previewControlHeader(draft.current_version))),
        ]),
        buttons,
      };
    },

    async status(input) {
      const ui = input.uiLanguage;
      const draft = await findOpenDraftByCreator(executor, input.telegramUserId);
      if (draft === null) {
        return reply(ui, S.statusNoDraft);
      }
      const approval = await getApproval(executor, draft.id, draft.current_version);
      const publication = await findPrimaryPublication(executor, draft.id, draft.current_version);

      const lines: string[] = [localize(ui, S.statusVersion(draft.current_version))];
      lines.push(
        approval !== null && approval.state === 'active'
          ? localize(ui, S.statusApprovalActive)
          : localize(ui, S.statusApprovalNone),
      );

      const nowMs = clock.now();
      let resendablePublication: AdminPostPublicationRow | null = null;
      if (publication !== null) {
        switch (publication.state) {
          case 'queued':
            lines.push(localize(ui, S.statusPublishQueued));
            break;
          case 'claimed':
            if (
              publication.lease_expires_at_ms !== null &&
              publication.lease_expires_at_ms < nowMs
            ) {
              lines.push(localize(ui, S.statusPublishUncertain(true)));
              resendablePublication = publication;
            } else {
              lines.push(localize(ui, S.statusPublishQueued));
            }
            break;
          case 'sent':
            lines.push(localize(ui, S.statusPublishSent));
            break;
          case 'failed_definitive':
            lines.push(localize(ui, S.statusPublishFailed));
            resendablePublication = publication;
            break;
          case 'uncertain':
            lines.push(localize(ui, S.statusPublishUncertain(false)));
            resendablePublication = publication;
            break;
          case 'superseded':
            break;
        }
      }

      let buttons: AdminPostButtons | undefined;
      if (resendablePublication !== null && roleHasPermission(input.role, 'publication.publish')) {
        const token = await mintToken({
          telegramUserId: input.telegramUserId,
          permission: 'publication.publish',
          action: ADMIN_POST_ACTION_CONFIRM_REPUBLISH,
          draftId: draft.id,
          payload: {
            publicationId: resendablePublication.id,
            version: resendablePublication.version,
            fingerprint: resendablePublication.fingerprint,
          },
          expiresAtMs: nowMs + ADMIN_POST_SESSION_TTL_MS,
          nowMs,
        });
        buttons = [[{ text: localize(ui, S.confirmResendButton), callbackData: `a:${token}` }]];
      }

      return {
        kind: 'reply',
        text: composeTelegramHtml(lines.map((line) => escapeTelegramHtml(line))),
        buttons,
      };
    },

    async cancel(input) {
      const ui = input.uiLanguage;
      const draft = await findOpenDraftByCreator(executor, input.telegramUserId);
      if (draft === null) {
        return reply(ui, S.cancelNone);
      }
      const outcome = await cancelOpenDraft(executor, {
        draftId: draft.id,
        telegramUserId: input.telegramUserId,
        nowMs: clock.now(),
      });
      logger.info('admin_post.cancel', { outcome: outcome.kind });
      return reply(ui, outcome.kind === 'cancelled' ? S.cancelDone : S.cancelNone);
    },

    async handleCallback(input) {
      const ui = input.uiLanguage;
      const nowMs = clock.now();
      const consumed = await consumeActionToken(executor, {
        token: input.token,
        telegramUserId: input.telegramUserId,
        nowMs,
      });
      if (consumed.kind === 'invalid') {
        return answer(ui, localize(ui, S.callbackInvalidToken));
      }
      const record = consumed.record;
      // Defense in depth: the role must STILL hold the token's permission.
      if (!roleHasPermission(input.role, record.permission)) {
        logger.warn('admin_post.callback.permission_revoked', { action: record.action });
        return answer(ui, localize(ui, S.permissionRevoked));
      }
      const payload = parsePayload(record.payloadJson);
      const draftId = record.targetId ?? '';

      if (record.action === ADMIN_POST_ACTION_APPROVE) {
        const bound = await resolveBoundVersion(draftId, payload, nowMs);
        if (bound.kind === 'rejected') {
          logger.warn('admin_post.approve.rejected', { reason: bound.reason });
          return rejectionAnswer(ui, bound.reason);
        }
        const outcome = await recordApproval(executor, {
          draftId,
          version: bound.version,
          fingerprint: bound.fingerprint,
          telegramUserId: input.telegramUserId,
          sessionId: bound.sessionId,
          nowMs,
        });
        logger.info('admin_post.approve', { outcome: outcome.kind, version: bound.version });
        return answer(
          ui,
          outcome.kind === 'approved'
            ? localize(ui, S.approveDone(bound.version))
            : localize(ui, S.approveAlreadyActive),
        );
      }

      if (record.action === ADMIN_POST_ACTION_PUBLISH) {
        const bound = await resolveBoundVersion(draftId, payload, nowMs);
        if (bound.kind === 'rejected') {
          logger.warn('admin_post.publish.rejected', { reason: bound.reason });
          return rejectionAnswer(ui, bound.reason);
        }
        if (!config.livePublishEnabled) {
          // The live gate stops BEFORE any publication row or Bot API call;
          // the approval stays active for a later enabled publish.
          logger.info('admin_post.publish.blocked_flag_off', { version: bound.version });
          return answer(ui, localize(ui, S.publishDisabled));
        }
        // Publication-state check FIRST so an already-attempted version gets
        // the honest answer (sent / in progress / safe re-send path) instead
        // of a misleading approval error.
        const existing = await findPrimaryPublication(executor, draftId, bound.version);
        if (existing !== null) {
          if (existing.state === 'sent') {
            return answer(ui, localize(ui, S.publishAlreadySent));
          }
          if (existing.state === 'queued' || existing.state === 'claimed') {
            return answer(ui, localize(ui, S.publishAlreadyInProgress));
          }
          return answer(ui, localize(ui, S.publishUseStatus));
        }
        const approval = await consumeApproval(executor, {
          draftId,
          version: bound.version,
          fingerprint: bound.fingerprint,
        });
        if (approval.kind === 'not_active') {
          return answer(ui, localize(ui, S.publishNoApproval));
        }
        const created = await createPublication(executor, {
          id: randomToken(),
          draftId,
          version: bound.version,
          fingerprint: bound.fingerprint,
          destination: config.destination ?? '',
          attempt: 1,
          nowMs,
        });
        if (created.kind === 'already_exists') {
          return answer(ui, localize(ui, S.publishAlreadyInProgress));
        }
        logger.info('admin_post.publish.queued', { version: bound.version });
        return claimSendAndRecord({
          publicationId: created.publicationId,
          draftId,
          version: bound.version,
          fingerprint: bound.fingerprint,
          ui,
        });
      }

      if (record.action === ADMIN_POST_ACTION_CONFIRM_REPUBLISH) {
        const publicationId = asTokenId(payload.publicationId);
        const version = asPositiveInteger(payload.version);
        const fingerprint = asFingerprint(payload.fingerprint);
        if (publicationId === undefined || version === undefined || fingerprint === undefined) {
          return answer(ui, localize(ui, S.fingerprintTampered));
        }
        const publication = await getPublication(executor, publicationId);
        if (
          publication === null ||
          publication.draft_id !== draftId ||
          publication.version !== version ||
          publication.fingerprint !== fingerprint
        ) {
          return answer(ui, localize(ui, S.fingerprintTampered));
        }
        const now = clock.now();
        const staleLease =
          publication.state === 'claimed' &&
          publication.lease_expires_at_ms !== null &&
          publication.lease_expires_at_ms < now;
        const resendable =
          publication.state === 'failed_definitive' ||
          publication.state === 'uncertain' ||
          staleLease;
        if (!resendable) {
          return answer(
            ui,
            publication.state === 'sent'
              ? localize(ui, S.publishAlreadySent)
              : localize(ui, S.publishUseStatus),
          );
        }
        if (!config.livePublishEnabled) {
          return answer(ui, localize(ui, S.publishDisabled));
        }
        const superseded = await supersedePublication(executor, {
          publicationId,
          nowMs: now,
        });
        if (superseded.kind === 'not_resendable') {
          return answer(ui, localize(ui, S.publishUseStatus));
        }
        const created = await createPublication(executor, {
          id: randomToken(),
          draftId,
          version,
          fingerprint,
          destination: config.destination ?? '',
          supersedeOf: publicationId,
          attempt: publication.attempt + 1,
          nowMs: clock.now(),
        });
        if (created.kind === 'already_exists') {
          return answer(ui, localize(ui, S.publishAlreadyInProgress));
        }
        logger.info('admin_post.republish.queued', {
          version,
          attempt: publication.attempt + 1,
        });
        return claimSendAndRecord({
          publicationId: created.publicationId,
          draftId,
          version,
          fingerprint,
          ui,
        });
      }

      // Unknown action descriptor: the token was consumed — honest invalid.
      return answer(ui, localize(ui, S.callbackInvalidToken));
    },
  };
}
