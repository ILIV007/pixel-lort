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
  closeCaptureSession,
  consumeApprovalAndCreatePublication,
  createPreviewSession,
  findOpenCaptureSession,
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
  openCaptureSession,
  recordApprovalFenced,
  supersedeAndCreatePublication,
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
import type {
  ParsedMediaAttachment,
  ParsedRichTextExtraction,
} from '../../adapters/telegram/update-parser';
import {
  createRichTextEnvelope,
  serializeRichTextEnvelope,
  type RichTextEnvelope,
} from '../../domain/telegram/rich-text-envelope';
import {
  createPostContentDocument,
  readPostContentDocument,
  serializeAndFingerprintPostContent,
  serializePostContentDocument,
  type PostContentDocument,
} from '../../domain/admin-post/post-content';
import { fingerprintOfSerializedEnvelope, randomToken } from '../../domain/admin-post/fingerprint';
import { AppError } from '../../shared/errors/app-error';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import type { AdminPostVersionRow } from '../../adapters/db/admin-post-store';

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
      /** R1.21: the complete stored version — media + text/caption envelope. */
      readonly content: PostContentDocument;
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
 * is marked terminal by the send path itself). R1.21: the transport carries
 * the FULL send capability of the real client — text, single photo, single
 * video — so a stored version can always be sent through the same client
 * shape it was previewed with.
 */
export interface AdminPostTransport {
  sendMessageRich(input: {
    readonly chatId: number | string;
    readonly content: RichTextEnvelope;
    readonly disableLinkPreview?: boolean;
    readonly customEmojiEligible?: boolean;
  }): Promise<{ readonly messageId: number }>;
  sendPhotoRich(input: {
    readonly chatId: number | string;
    readonly photo: string;
    readonly caption?: RichTextEnvelope;
    readonly customEmojiEligible?: boolean;
  }): Promise<{ readonly messageId: number }>;
  sendVideoRich(input: {
    readonly chatId: number | string;
    readonly video: string;
    readonly caption?: RichTextEnvelope;
    readonly customEmojiEligible?: boolean;
  }): Promise<{ readonly messageId: number }>;
}

export interface AdminPostService {
  /** R1.20-R1: open (or re-open) the caller's EXPLICIT capture session. */
  startSession(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly updateId: number;
  }): Promise<AdminPostExecutionResult>;
  capture(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly updateId: number;
    /** R1.20-R1: the session gate distinguishes fresh messages from edits. */
    readonly kind: 'message' | 'edited_message';
    readonly text: string | undefined;
    readonly hasText: boolean;
    readonly richText: ParsedRichTextExtraction | undefined;
    /**
     * R1.21: the typed SINGLE-media extraction (photo/video file_id, or
     * 'unsupported' for every other media shape). undefined = no media.
     */
    readonly media: ParsedMediaAttachment | undefined;
    /** R1.21: the FULL caption extraction (kind 'caption'), when present. */
    readonly richCaption: ParsedRichTextExtraction | undefined;
    /** R1.21: the message belongs to an album (media_group_id present). */
    readonly inMediaGroup: boolean;
    readonly hasMediaAttachment: boolean;
  }): Promise<AdminPostExecutionResult>;
  preview(input: {
    readonly chatId: number;
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly updateId: number;
    /**
     * R1.20-R1: an explicit draft id previews ANOTHER admin's open draft
     * (the caller must hold `draft.view`); absent = the caller's OWN open
     * draft. The previewed version is server-side bound either way.
     */
    readonly draftId?: string;
  }): Promise<AdminPostExecutionResult>;
  status(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    /**
     * R1.21: an explicit draft id views ANOTHER admin's draft publication
     * state (the caller must hold `publication.publish`); absent = the
     * caller's OWN open draft. The one not-found answer never distinguishes
     * a nonexistent id from a visible-but-closed draft.
     */
    readonly draftId?: string;
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
 * R1.21 — the stored-content verification gate shared by PREVIEW and SEND:
 * re-reads the stored document (defensively, with the documented legacy
 * fallback), fully re-validates it, and RE-DERIVES the fingerprint from the
 * canonical serialization of the re-read content. Outcomes:
 * - 'corrupt': the stored bytes are not a valid post-content document
 *   (malformed JSON, unknown version, invalid envelope/fileId/media).
 * - 'changed': the content re-serializes to a DIFFERENT fingerprint than
 *   the stored column claims — the stored document was altered after its
 *   fingerprint was written (corruption or tampering). The approved and
 *   stored content are no longer provably the same; nothing may be sent.
 * The re-derivation is what makes the approval binding honest end-to-end:
 * a matching fingerprint COLUMN alone can never prove the content intact.
 */
async function readAndVerifyStoredContent(
  versionRow: AdminPostVersionRow,
): Promise<
  | { readonly ok: true; readonly content: PostContentDocument }
  | { readonly ok: false; readonly reason: 'corrupt' | 'changed' }
> {
  const read = readPostContentDocument(versionRow.envelope_json);
  if (!read.ok) {
    return { ok: false, reason: 'corrupt' };
  }
  let recomputed: string;
  if (read.kind === 'legacy') {
    // Legacy R1.20-R1 bare-envelope row: the fingerprint was written over
    // the bare envelope's canonical bytes — re-derive EXACTLY that way.
    const serialized = serializeRichTextEnvelope(read.envelope);
    if (!serialized.ok) {
      return { ok: false, reason: 'corrupt' };
    }
    recomputed = await fingerprintOfSerializedEnvelope(serialized.json);
  } else {
    const serialized = serializePostContentDocument(read.document);
    if (!serialized.ok) {
      return { ok: false, reason: 'corrupt' };
    }
    recomputed = await fingerprintOfSerializedEnvelope(serialized.json);
  }
  if (recomputed !== versionRow.fingerprint) {
    return { ok: false, reason: 'changed' };
  }
  return { ok: true, content: read.document };
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
   * R1.21: dispatch ONE stored version to the transport in its EXACT stored
   * shape — text posts as direct-entity sendMessage, single photo/video as
   * sendPhoto/sendVideo with the caption envelope (or NO caption field when
   * the media post has none). There is no conversion, no truncation, and no
   * media-without-caption degradation anywhere on this path.
   */
  async function sendStoredContent(
    transport: NonNullable<typeof deps.transport>,
    document: PostContentDocument,
  ): Promise<{ readonly messageId: number }> {
    const chatId = destinationChatId(config.destination ?? '');
    if (document.media === 'photo' || document.media === 'video') {
      // Unreachable through the document validator (media REQUIRES a
      // fileId); the typed guard keeps the send honest under any cast.
      if (document.fileId === undefined) {
        throw new AppError('internal_error');
      }
      if (document.media === 'photo') {
        return await transport.sendPhotoRich({
          chatId,
          photo: document.fileId,
          ...(document.caption !== undefined ? { caption: document.caption } : {}),
        });
      }
      return await transport.sendVideoRich({
        chatId,
        video: document.fileId,
        ...(document.caption !== undefined ? { caption: document.caption } : {}),
      });
    }
    if (document.text === undefined) {
      throw new AppError('internal_error');
    }
    return await transport.sendMessageRich({ chatId, content: document.text });
  }

  /**
   * The guarded send + honest outcome recording (publish and the confirmed
   * re-send): claim (queued -> claimed, lease + owner fence) -> read + verify
   * the stored content (R1.21: fingerprint RE-DERIVED from the re-read
   * document — a fingerprint column alone can no longer pass the gate) ->
   * send through the direct-entity transport -> record the outcome FENCED by
   * the claim owner. A late response whose lease expired or whose claim was
   * superseded can never overwrite newer state.
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
    // R1.21 SEND-INTEGRITY GATE: the stored document is re-read, fully
    // re-validated, and its fingerprint RE-DERIVED. If the stored content
    // was altered after approval — even while the fingerprint column stayed
    // untouched — the send is BLOCKED and the outcome is recorded honestly.
    const verified = await readAndVerifyStoredContent(versionRow);
    if (!verified.ok) {
      const isTampered = verified.reason === 'changed';
      await finishPublication(executor, {
        publicationId: input.publicationId,
        claimedBy,
        state: 'failed_definitive',
        errorCode: isTampered ? 'content_changed_after_approval' : 'stored_content_invalid',
        nowMs: clock.now(),
      });
      logger.warn('admin_post.publish.send_integrity_blocked', {
        reason: verified.reason,
        version: input.version,
      });
      return answer(
        input.ui,
        isTampered
          ? localize(input.ui, S.publishContentChanged)
          : localize(input.ui, S.storedContentCorrupt),
      );
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
    const transport = deps.transport;

    try {
      const sent = await sendStoredContent(transport, verified.content);
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
      if (definitive && verified.content.media !== 'none') {
        // R1.21: a definitive failure on a media version most commonly means
        // the file reference was rejected (invalid/expired/unusable) — the
        // honest answer names that possibility explicitly.
        return answer(input.ui, localize(input.ui, S.publishMediaFileFailed));
      }
      return answer(
        input.ui,
        definitive
          ? localize(input.ui, S.publishFailedDefinitive)
          : localize(input.ui, S.publishUncertain),
      );
    }
  }

  /**
   * R1.21: the shared status renderer for BOTH views — the creator's own
   * open draft and the publisher's by-id view of any existing draft. The
   * draft id line is ALWAYS present (the id is how the roles find the same
   * post); the capture-session line belongs to the caller and appears only
   * on the own-draft view. The confirm-resend button follows the SAME
   * resendable-state rules as before, minted for the CALLER (the by-id
   * publisher included — the token carries the caller's own identity and
   * the caller's permission is re-checked on the callback).
   */
  async function renderStatus(
    ui: AdminUiLanguage,
    caller: { readonly telegramUserId: number; readonly role: AdminRole },
    draft: { readonly id: string; readonly status: string; readonly current_version: number },
    options: { readonly byId: boolean; readonly captureSessionLine: boolean },
  ): Promise<AdminPostExecutionResult> {
    const lines: string[] = [];
    if (options.captureSessionLine) {
      // R1.20-R1: the capture session state is always visible on the
      // own-draft view — a session left open is discoverable here (plain
      // texts are being captured!).
      const captureSession = await findOpenCaptureSession(executor, caller.telegramUserId);
      lines.push(
        captureSession !== null
          ? localize(ui, S.statusSessionOpen)
          : localize(ui, S.statusSessionClosed),
      );
    }
    lines.push(localize(ui, S.statusDraftId(draft.id)));
    if (options.byId) {
      // The by-id view can reach drafts in ANY lifecycle state — the state
      // is shown honestly instead of silently filtering it away.
      lines.push(localize(ui, S.statusDraftStatus(draft.status)));
    }
    lines.push(localize(ui, S.statusVersion(draft.current_version)));
    const approval = await getApproval(executor, draft.id, draft.current_version);
    const publication = await findPrimaryPublication(executor, draft.id, draft.current_version);

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
          if (publication.lease_expires_at_ms !== null && publication.lease_expires_at_ms < nowMs) {
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
    if (resendablePublication !== null && roleHasPermission(caller.role, 'publication.publish')) {
      const token = await mintToken({
        telegramUserId: caller.telegramUserId,
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
  }

  return {
    async startSession(input) {
      const ui = input.uiLanguage;
      // Defense in depth: the router already denies callers whose role lacks
      // the permission, but the SERVICE re-checks (fail closed) before any
      // state change — a session can never be opened without draft.create.
      if (!roleHasPermission(input.role, 'draft.create')) {
        logger.warn('admin_post.session.denied', { reason: 'missing_permission' });
        return reply(ui, S.capturePermissionDenied);
      }
      const nowMs = clock.now();
      const existing = await findOpenCaptureSession(executor, input.telegramUserId);
      await openCaptureSession(executor, {
        telegramUserId: input.telegramUserId,
        startedAtMs: nowMs,
        updateId: input.updateId,
      });
      logger.info('admin_post.session', { outcome: existing !== null ? 'already_open' : 'opened' });
      return reply(ui, existing !== null ? S.sessionAlreadyOpen : S.sessionStarted);
    },

    async capture(input) {
      const ui = input.uiLanguage;
      // R1.20-R1 SESSION GATE — FIRST, before any feedback: outside an
      // explicitly opened capture session every plain admin message is an
      // ORDINARY message — silent legacy behavior, no reply, no state, no
      // post data created or changed. (A redelivered update of a message
      // that WAS captured re-enters the duplicate-source-update guard only
      // while the session is open; a closed session has nothing to change.)
      const session = await findOpenCaptureSession(executor, input.telegramUserId);
      if (session === null) {
        return { kind: 'none' };
      }
      // Explicit rejections next — nothing is ever silently dropped WHILE a
      // session is open. An edited message NEVER enters the pipeline.
      if (input.kind === 'edited_message') {
        return reply(ui, S.editedMessageRejected);
      }
      // Authorization (defense in depth): the router denies the /post start
      // without draft.create; the service re-checks on EVERY capture so a
      // role revoked mid-session can never write post data.
      if (!roleHasPermission(input.role, 'draft.create')) {
        logger.warn('admin_post.capture.denied', { reason: 'missing_permission' });
        return reply(ui, S.capturePermissionDenied);
      }
      if (input.hasMediaAttachment || input.media !== undefined) {
        // R1.21 SINGLE-MEDIA PATH: exactly one photo or one video (with an
        // optional faithful caption) is captured as a complete post. Every
        // other media shape — albums, documents, audio, stickers, conflicting
        // or malformed media fields — is REJECTED EXPLICITLY here; nothing is
        // ever degraded into a partial post, and a caption is never stored
        // without its media.
        if (input.media === undefined || input.media.kind === 'unsupported') {
          return reply(ui, S.captureMediaRejected);
        }
        if (input.inMediaGroup) {
          return reply(ui, S.captureAlbumRejected);
        }
        // A media message never carries message text or text entities in
        // Telegram's model; a payload with both is malformed — explicit.
        if (input.hasText || input.richText !== undefined) {
          return reply(ui, S.captureInvalidContent);
        }
        const fileId = input.media.fileId;
        if (fileId === undefined) {
          return reply(ui, S.captureMediaFileInvalid);
        }
        if (input.richCaption !== undefined && !input.richCaption.ok) {
          // Beyond the 1024-unit application cap, or malformed caption
          // metadata — an explicit rejection, never a silent drop.
          logger.warn('admin_post.capture.rejected', {
            reason: `media_caption_${input.richCaption.reason}`,
          });
          return reply(ui, S.captureMediaCaptionRejected);
        }
        let captionEnvelope: RichTextEnvelope | undefined;
        if (input.richCaption !== undefined) {
          const captionOutcome = createRichTextEnvelope({
            kind: 'caption',
            text: input.richCaption.text,
            entities: input.richCaption.entities,
          });
          if (!captionOutcome.ok) {
            logger.warn('admin_post.capture.rejected', { reason: captionOutcome.reason });
            return reply(ui, S.captureInvalidContent);
          }
          captionEnvelope = captionOutcome.envelope;
        }
        const documentOutcome = createPostContentDocument({
          media: input.media.kind,
          fileId,
          ...(captionEnvelope !== undefined ? { caption: captionEnvelope } : {}),
        });
        if (!documentOutcome.ok) {
          logger.warn('admin_post.capture.rejected', { reason: documentOutcome.reason });
          return reply(
            ui,
            documentOutcome.reason === 'file_id_invalid'
              ? S.captureMediaFileInvalid
              : S.captureInvalidContent,
          );
        }
        const serialized = await serializeAndFingerprintPostContent(documentOutcome.document);
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
        logger.info('admin_post.capture', {
          outcome: outcome.kind,
          version: outcome.version,
          media: input.media.kind,
        });
        return {
          kind: 'reply',
          text: escapeTelegramHtml(
            outcome.kind === 'created'
              ? localize(ui, S.captureSaved(outcome.draftId, outcome.version))
              : localize(ui, S.captureUpdated(outcome.draftId, outcome.version)),
          ),
        };
      }
      // TEXT PATH (no media anywhere on the message): a caption field on a
      // text message is a contradiction — never captured.
      if (input.richCaption !== undefined) {
        return reply(ui, S.captureInvalidContent);
      }
      if (input.hasText !== true) {
        return reply(ui, S.noTextContent);
      }
      if (input.text === undefined) {
        // hasText with no bounded text => beyond the 4096 bound.
        return reply(ui, S.textTooLong);
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
      const documentOutcome = createPostContentDocument({
        media: 'none',
        text: envelopeOutcome.envelope,
      });
      if (!documentOutcome.ok) {
        logger.warn('admin_post.capture.rejected', { reason: documentOutcome.reason });
        return reply(ui, S.captureInvalidContent);
      }
      const serialized = await serializeAndFingerprintPostContent(documentOutcome.document);
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
            ? localize(ui, S.captureSaved(outcome.draftId, outcome.version))
            : localize(ui, S.captureUpdated(outcome.draftId, outcome.version)),
        ),
      };
    },

    async preview(input) {
      const ui = input.uiLanguage;
      // R1.20-R1: an explicit draft id previews ANOTHER admin's open draft —
      // the caller must hold `draft.view` (the same blueprint permission the
      // read-only review surface requires to see drafts). The ONE honest
      // not-found answer never distinguishes a nonexistent id from a closed
      // draft (no existence disclosure beyond the draft.view grant).
      let draft: Awaited<ReturnType<typeof findOpenDraftByCreator>>;
      if (input.draftId !== undefined) {
        if (!roleHasPermission(input.role, 'draft.view')) {
          logger.warn('admin_post.preview.denied', { reason: 'missing_permission' });
          return reply(ui, S.previewPermissionDenied);
        }
        const target = await getDraft(executor, input.draftId);
        if (target === null || target.status !== 'open') {
          return reply(ui, S.draftNotFound);
        }
        draft = target;
      } else {
        draft = await findOpenDraftByCreator(executor, input.telegramUserId);
        if (draft === null) {
          return reply(ui, S.noOpenDraft);
        }
      }
      const versionRow = await getVersion(executor, draft.id, draft.current_version);
      if (versionRow === null) {
        return reply(ui, S.storedContentCorrupt);
      }
      // R1.21: the stored document is re-read (with the legacy fallback),
      // fully re-validated, and its fingerprint RE-DERIVED from the re-read
      // content — a mismatch means the stored document was corrupted or
      // tampered with after its fingerprint was written. Never previewed
      // from, never approved from, never sent from.
      const verified = await readAndVerifyStoredContent(versionRow);
      if (!verified.ok) {
        logger.warn('admin_post.preview.fingerprint_mismatch', {
          reason: verified.reason,
          version: draft.current_version,
        });
        return reply(ui, S.storedContentCorrupt);
      }
      const document = verified.content;

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
        content: document,
        control: composeTelegramHtml([
          telegramBold(localize(ui, S.previewControlHeader(draft.current_version))),
        ]),
        buttons,
      };
    },

    async status(input) {
      const ui = input.uiLanguage;
      // R1.21 BY-ID VIEW: a publisher may inspect the publication state of
      // ANY existing draft by id — including one they did not create — so
      // the uncertain-outcome recovery path is reachable for the person
      // holding `publication.publish`, not only for the creator. Non-holders
      // get one honest denial; nonexistent ids get the same not-found answer
      // as everything else (no existence disclosure).
      if (input.draftId !== undefined) {
        if (!roleHasPermission(input.role, 'publication.publish')) {
          logger.warn('admin_post.status.denied', { reason: 'missing_permission' });
          return reply(ui, S.statusPermissionDenied);
        }
        const target = await getDraft(executor, input.draftId);
        if (target === null) {
          return reply(ui, S.draftNotFound);
        }
        return renderStatus(
          ui,
          { telegramUserId: input.telegramUserId, role: input.role },
          target,
          { byId: true, captureSessionLine: false },
        );
      }
      const draft = await findOpenDraftByCreator(executor, input.telegramUserId);
      if (draft === null) {
        const lines: string[] = [];
        // R1.20-R1: the capture session state is always visible — a session
        // left open is discoverable here (plain texts are being captured!).
        const captureSession = await findOpenCaptureSession(executor, input.telegramUserId);
        lines.push(
          captureSession !== null
            ? localize(ui, S.statusSessionOpen)
            : localize(ui, S.statusSessionClosed),
        );
        lines.push(localize(ui, S.statusNoDraft));
        return {
          kind: 'reply',
          text: composeTelegramHtml(lines.map((line) => escapeTelegramHtml(line))),
        };
      }
      return renderStatus(ui, { telegramUserId: input.telegramUserId, role: input.role }, draft, {
        byId: false,
        captureSessionLine: true,
      });
    },

    async cancel(input) {
      const ui = input.uiLanguage;
      // R1.20-R1: cancelling ALWAYS closes the capture session (even when no
      // open draft exists) — the admin is never left silently capturing.
      await closeCaptureSession(executor, input.telegramUserId);
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
        const outcome = await recordApprovalFenced(executor, {
          draftId,
          version: bound.version,
          fingerprint: bound.fingerprint,
          telegramUserId: input.telegramUserId,
          sessionId: bound.sessionId,
          nowMs,
        });
        logger.info('admin_post.approve', { outcome: outcome.kind, version: bound.version });
        if (outcome.kind === 'stale') {
          // R1.20-R1: the head-fence caught a capture that committed between
          // the bind and the write — the version is no longer current.
          return answer(ui, localize(ui, S.staleVersion));
        }
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
        // Fast-path honesty: an already-attempted version gets the honest
        // answer (sent / in progress / safe re-send path) without touching
        // the approval. The race-safe work happens in the ATOMIC transition
        // below.
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
        // R1.20-R1 ATOMIC transition: consuming the approval and creating
        // the publication are ONE batch — a crash between them is
        // impossible (and the transition doubles as the honest recovery
        // path for a legitimately-consumed approval whose publication never
        // got created). A losing race rolls the whole batch back: the
        // approval stays with the winner.
        const created = await consumeApprovalAndCreatePublication(executor, {
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
        if (created.kind === 'not_active') {
          return answer(ui, localize(ui, S.publishNoApproval));
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
        // R1.20-R1 ATOMIC transition: the guarded supersede and the
        // replacement insert are ONE batch — the insert happens ONLY when
        // the old row is already superseded inside the same transaction, so
        // a crash or a losing race can never leave a superseded publication
        // without its replacement (or create a second publication for a
        // version whose primary is not resendable).
        const created = await supersedeAndCreatePublication(executor, {
          id: randomToken(),
          draftId,
          version,
          fingerprint,
          destination: config.destination ?? '',
          supersedeOf: publicationId,
          attempt: publication.attempt + 1,
          // Batch-unique marker: the replacement insert is bound to THIS
          // batch's supersede (a second confirm can never ride a previous
          // batch's superseded state).
          supersedeMarker: randomToken(),
          nowMs: clock.now(),
        });
        if (created.kind === 'not_resendable') {
          return answer(ui, localize(ui, S.publishUseStatus));
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
