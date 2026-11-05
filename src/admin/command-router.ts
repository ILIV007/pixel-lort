/**
 * Command routing contracts (Phase 2A; admin UI language added by the
 * Phase 2B correction, v1.2.5 — ADR-0034; write ordering corrected in
 * v1.2.6 — ADR-0035).
 *
 * A small router SEPARATE from HTTP routing: input is a normalized Telegram
 * update plus an authorized actor and the actor's ADMIN UI LANGUAGE; output
 * is a TYPED action — never an immediate uncontrolled fetch. This keeps
 * webhook security independent of command behavior and lets
 * approval/scheduling/editor workflows attach without rewriting the ingress
 * (blueprint admin map).
 *
 * Command behavior:
 * - Allowlist: /start, /help, /status, /version, /language.
 * - ADMIN UI LANGUAGE (v1.2.5, ADR-0034): every response is rendered in the
 *   SENDER's persisted admin UI language (`uiLanguage` argument; English is
 *   the DEFAULT — the ingress resolves it from the durable per-admin
 *   preference before routing). This is presentation of the admin surface
 *   ONLY: it is NOT the editorial/channel language, and no editorial,
 *   publishing, or blueprint file is affected.
 * - /language (no argument) reports the current UI language and how to
 *   change it — explicit and discoverable. `/language en` / `/language fa`
 *   return a TYPED `set_admin_ui_language` action carrying the SENDER's own
 *   numeric user ID (never another admin's) plus PRE-COMPOSED honest
 *   confirmations; the ingress persists the preference FIRST (order-fenced
 *   by the message's Telegram-assigned `(date, message_id)` metadata — an
 *   older retried message can never overwrite a newer choice, ADR-0035)
 *   and only then sends the matching confirmation. A storage failure throws
 *   before any confirmation exists to send.
 * - LANGUAGE-CHANGE GUARDS: a language change requires an AUTHORIZED sender
 *   AND a private chat AND a fresh (non-edited) message AND validated
 *   Telegram message-ORDER metadata (`date` + `message_id`, ADR-0035). In
 *   group chats, edited messages, or messages without valid ordering
 *   metadata, /language is ignored with a stable noop reason (no feedback,
 *   no state change) — missing metadata must never invent an order.
 * - BOT TARGET SAFETY: Telegram commands may explicitly address another bot
 *   ("/status@some_bot"). A command with an explicit target executes ONLY
 *   when the routing context carries the expected bot username and it
 *   matches (case-insensitive); otherwise the command is ignored with a
 *   stable noop reason (`command_for_other_bot`). When no expected username
 *   is configured, EVERY explicitly-targeted command is ignored (fail
 *   closed) while unqualified commands keep working.
 * - Unauthorized senders of allowlisted commands receive a MINIMAL ENGLISH
 *   denial (v1.2.5: unauthorized users have no admin preference to consult,
 *   so the denial is fixed English regardless of any setting).
 * - Commands outside the allowlist are IGNORED (stable noop reason) — for
 *   authorized and unauthorized senders alike — so command probing gets no
 *   feedback.
 * - Callback queries are validated against the `a:<token>` contract and
 *   answered by the Phase 9 admin menu; they remain classified as not
 *   supported yet (durable dedup still applies).
 */
import type { ActorResolution } from './authorization';
import { parseCallbackData } from './callback-tokens';
import type { AdminRole } from './roles';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from './telegram-html';
import { roleHasPermission } from './roles';
import { parseDraftsArgument, type DraftsArgumentParse } from './review-command';
import { ADMIN_REVIEW_STRINGS, REVIEW_COMMAND } from './review-strings';
import type {
  ParsedMediaAttachment,
  ParsedRichTextExtraction,
  ParsedUpdate,
} from '../adapters/telegram/update-parser';
import { ADMIN_POST_STRINGS } from './admin-post-strings';
import {
  ADMIN_UI_DENIAL_TEXT,
  ADMIN_UI_STRINGS,
  DEFAULT_ADMIN_UI_LANGUAGE,
  LANGUAGE_SAVED_TEXT,
  LANGUAGE_STALE_TEXT,
  normalizeAdminUiLanguage,
  type AdminUiLanguage,
} from './ui-language';

export const INITIAL_ADMIN_COMMANDS = ['start', 'help', 'status', 'version', 'language'] as const;
export type InitialAdminCommand = (typeof INITIAL_ADMIN_COMMANDS)[number];

export function isInitialAdminCommand(command: string): command is InitialAdminCommand {
  return (INITIAL_ADMIN_COMMANDS as readonly string[]).includes(command);
}

export const ADMIN_POST_COMMANDS = [
  'post',
  'post_preview',
  'post_status',
  'post_cancel',
  'post_from_draft',
] as const;

function isAdminPostCommand(command: string): boolean {
  return (ADMIN_POST_COMMANDS as readonly string[]).includes(command);
}

export type NoopReason =
  | 'unsupported_update'
  | 'not_a_command'
  | 'command_not_allowlisted'
  | 'command_for_other_bot'
  | 'callback_not_supported'
  | 'malformed_callback_data'
  | 'unroutable_message'
  | 'language_not_private_chat'
  | 'language_edited_message'
  | 'language_missing_ordering_metadata'
  | 'review_not_private_chat'
  | 'review_edited_message'
  | 'post_not_private_chat'
  | 'post_edited_message';

/**
 * Denial reasons. `unauthorized` keeps the FIXED minimal English text (the
 * sender has no admin preference to consult). `insufficient_permission`
 * (R1.18) addresses an AUTHORIZED actor whose role lacks the command's
 * permission — the honest localized denial for a known admin identity.
 */
export type DenialReason = 'unauthorized' | 'insufficient_permission';

export type TelegramAction =
  | { readonly type: 'send_message'; readonly chatId: number; readonly text: TelegramSafeHtml }
  | { readonly type: 'answer_callback'; readonly callbackQueryId: string }
  | { readonly type: 'noop'; readonly reason: NoopReason }
  | {
      readonly type: 'denied';
      readonly chatId: number;
      readonly reason: DenialReason;
      readonly text: TelegramSafeHtml;
    }
  | {
      /**
       * R1.18 read-only review: show the bounded FIRST PAGE of stored
       * `ready` drafts. Executed by the ingress through the injected
       * editorial-review service — the router NEVER queries D1.
       */
      readonly type: 'drafts_list';
      readonly chatId: number;
      readonly uiLanguage: AdminUiLanguage;
    }
  | {
      /**
       * R1.18 read-only review: show ONE stored draft by its EXACT id.
       * The id is already validated as a whole opaque token; the review
       * service binds it as a single parameter (never SQL structure).
       */
      readonly type: 'drafts_detail';
      readonly chatId: number;
      readonly draftId: string;
      readonly uiLanguage: AdminUiLanguage;
    }
  | {
      readonly type: 'set_admin_ui_language';
      readonly chatId: number;
      /** ALWAYS the sender's own numeric Telegram user ID — never another admin's. */
      readonly telegramUserId: number;
      /** The language the sender selected for THEIR OWN admin UI. */
      readonly language: AdminUiLanguage;
      /** update_id of the changing message — the DURABLE DEDUPLICATION boundary (ADR-0025); NOT the ordering fence (ADR-0035). */
      readonly updateId: number;
      /**
       * The changing message's Telegram SERVER-assigned time (epoch ms) —
       * the primary preference-ORDER key (ADR-0035). Never a local clock
       * reading: an old retry arrives later, so arrival time is no order.
       */
      readonly changedAtMs: number;
      /** The changing message's per-chat message_id — the same-second order tiebreak (ADR-0035). */
      readonly messageId: number;
      /** Confirmation sent ONLY after the fenced persistence succeeded. */
      readonly savedText: TelegramSafeHtml;
      /** Honest reply when an older retried message lost the write fence. */
      readonly staleText: TelegramSafeHtml;
    }
  | {
      /**
       * R1.20-R1: EXPLICITLY open the caller's capture session (`/post`).
       * The router has already gated: authorized + private chat + fresh
       * message + the `draft.create` permission. The service re-checks the
       * permission (defense in depth) and opens the durable session.
       */
      readonly type: 'admin_post_start';
      readonly chatId: number;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
      readonly updateId: number;
    }
  | {
      /**
       * R1.20-R: capture one authorized admin's plain (non-command) private
       * message as post content — ONLY while their EXPLICIT capture session
       * is open (R1.20-R1: the session gate lives in the SERVICE, which can
       * query D1; the router stays pure). The router only validated scope;
       * ALL content/session/shape decisions (media rejection, edited
       * messages, oversize, rich-text contract, dedup, persistence) happen
       * in the injected admin-post service — the router NEVER queries D1.
       */
      readonly type: 'admin_post_capture';
      readonly chatId: number;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
      readonly updateId: number;
      /** Fresh message vs edit — an edit NEVER enters the pipeline. */
      readonly kind: 'message' | 'edited_message';
      /** Bounded text when present; undefined = absent or beyond the 4096 bound. */
      readonly text: string | undefined;
      readonly hasText: boolean;
      readonly richText: ParsedRichTextExtraction | undefined;
      /**
       * R1.21: the typed SINGLE-media extraction (photo/video file_id or
       * 'unsupported'); undefined = no media on the message.
       */
      readonly media: ParsedMediaAttachment | undefined;
      /** R1.21: the FULL caption extraction, when a caption is present. */
      readonly richCaption: ParsedRichTextExtraction | undefined;
      /** R1.21: the message belongs to an album (media_group_id present). */
      readonly inMediaGroup: boolean;
      readonly hasMediaAttachment: boolean;
    }
  | {
      /** R1.20-R: faithful preview of the caller's open draft's current version.
       *  R1.20-R1: with an explicit draftId, previews ANOTHER admin's open
       *  draft (the caller must hold `draft.view`; enforced in the service). */
      readonly type: 'admin_post_preview';
      readonly chatId: number;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
      readonly updateId: number;
      readonly draftId?: string;
    }
  | {
      /**
       * R1.20-R: honest status of the caller's open draft (with the
       * confirm-resend button when applicable).
       * R1.21: with an explicit draftId, a `publication.publish` holder
       * views the publication state of ANY existing draft — the uncertain
       * recovery path is reachable for the publisher of a post they did not
       * create (enforced in the service).
       */
      readonly type: 'admin_post_status';
      readonly chatId: number;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
      readonly draftId?: string;
    }
  | {
      /** R1.20-R: cancel the caller's open draft and invalidate its approvals. */
      readonly type: 'admin_post_cancel';
      readonly chatId: number;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
    }
  | {
      /**
       * R1.22 Phase A: convert ONE stored READY editorial draft into a new
       * admin post version through the bridge (durable per-version
       * provenance, deterministic render, no fabrication). The router has
       * already gated: the editorial-bridge flag ON + authorized + private
       * chat + fresh message + the `draft.create` permission + a validated
       * whole-token argument. The service re-checks everything (fail
       * closed) and owns ALL content/store decisions.
       */
      readonly type: 'admin_post_from_editorial';
      readonly chatId: number;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
      readonly updateId: number;
      /** The validated opaque EDITORIAL draft id (from /drafts). */
      readonly editorialDraftId: string;
    }
  | {
      /**
       * R1.20-R: resolve an `a:<token>` callback through the admin-post
       * service (approve / publish / confirm-republish). The token is
       * consumed exactly once, bound to ONE user, and re-validated against
       * the SERVER-SIDE preview binding — never trusted from the payload.
       */
      readonly type: 'admin_post_callback';
      readonly callbackQueryId: string;
      readonly telegramUserId: number;
      readonly role: AdminRole;
      readonly uiLanguage: AdminUiLanguage;
      readonly token: string;
    };

export interface CommandRouteContext {
  /** Application build marker surfaced by /version and /status. */
  readonly applicationVersion: string;
  /**
   * Bot username this deployment answers to (compared case-insensitively
   * against an explicit "/cmd@target" suffix). When ABSENT, every
   * explicitly-targeted command is ignored — fail closed.
   */
  readonly expectedBotUsername?: string;
  /**
   * R1.18 (ADR-0046): whether the READ-ONLY admin review surface is enabled
   * (the `ADMIN_REVIEW_ENABLED` fail-closed flag, parsed by the caller).
   * Default/absent = DISABLED: `/drafts` keeps the exact unknown-command
   * noop semantics and /help never advertises it. Enabling this flag gates
   * ONLY the new read commands — it never widens any other behavior.
   */
  readonly reviewEnabled?: boolean;
  /**
   * R1.20-R: whether the admin post pipeline surface is enabled (the
   * `ADMIN_POST_ENABLED` fail-closed flag, parsed by the caller).
   * Default/absent = DISABLED: non-command text keeps the exact legacy
   * `not_a_command` noop and callback queries keep `callback_not_supported`.
   */
  readonly adminPostEnabled?: boolean;
  /**
   * R1.22 Phase A: whether the editorial→post bridge command is enabled
   * (the `EDITORIAL_TO_POST_ENABLED` fail-closed flag, parsed by the
   * caller). Default/absent = DISABLED: `/post_from_draft` keeps the exact
   * unknown-command noop semantics. It gates ONLY that command — it never
   * widens capture, preview, approval, or any send behavior.
   */
  readonly editorialToPostEnabled?: boolean;
}

export interface CommandRouter {
  /**
   * Route one parsed update. `uiLanguage` is the SENDER's persisted admin
   * UI language (already resolved by the ingress from the durable
   * preference); when absent (no preference stored, or the sender is
   * unauthorized) it defaults to ENGLISH.
   */
  route(update: ParsedUpdate, actor: ActorResolution, uiLanguage?: AdminUiLanguage): TelegramAction;
}

/** Minimal ENGLISH denial message for unauthorized senders (fixed, static). */
export function denialText(): TelegramSafeHtml {
  return escapeTelegramHtml(ADMIN_UI_DENIAL_TEXT);
}

/**
 * Whole command remainder extraction (R1.18.1 — V1 correctness).
 *
 * THREE distinguishable states — never conflated:
 * - `none`: the command token IS the whole text (or there is no text) —
 *   the documented no-argument form;
 * - `remainder`: a `[ \t]+` separator followed by the WHOLE actual
 *   remaining text (which may still contain newlines/control characters —
 *   the command's own whole-value validator owns their rejection);
 * - `malformed`: something follows the command token that is NOT a
 *   `[ \t]` separator (e.g. a newline directly after `/drafts`) — an
 *   argument-grammar failure, NEVER the no-argument form.
 *
 * V1 root cause: the previous single-regex capture (`(?:[ \t]+(.*))?$`)
 * could not match newline-bearing input AT ALL, so a malformed whole
 * argument was indistinguishable from no argument and the review parser
 * mis-read the grammar failure as the list action (one editorial SELECT
 * for garbage). Extraction now slices the ACTUAL remainder — partial
 * matches are impossible — and the command-specific validators reject
 * newline/control/extra-token arguments BEFORE any editorial SQL.
 */
const COMMAND_TOKEN_PATTERN = /^\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z0-9_]{1,64})?/;

type CommandRemainder =
  | { readonly kind: 'none' }
  | { readonly kind: 'remainder'; readonly text: string }
  | { readonly kind: 'malformed' };

function commandRemainder(text: string | undefined): CommandRemainder {
  if (text === undefined) {
    return { kind: 'none' };
  }
  const match = COMMAND_TOKEN_PATTERN.exec(text);
  // extractBotCommand validated the command-token shape before routing, so
  // a no-match here is defensive-only — and NEVER the no-argument form.
  if (match === null) {
    return { kind: 'malformed' };
  }
  const rest = text.slice(match[0].length);
  if (rest.length === 0) {
    return { kind: 'none' };
  }
  const separator = rest[0];
  if (separator !== ' ' && separator !== '\t') {
    return { kind: 'malformed' };
  }
  return { kind: 'remainder', text: rest.replace(/^[ \t]+/u, '') };
}

function startResponse(ui: AdminUiLanguage): TelegramSafeHtml {
  const s = ADMIN_UI_STRINGS[ui];
  return composeTelegramHtml([
    telegramBold(s.startTitle),
    escapeTelegramHtml(s.startBody),
    escapeTelegramHtml(s.startHint),
  ]);
}

function helpResponse(ui: AdminUiLanguage, draftsLine: string | null): TelegramSafeHtml {
  const s = ADMIN_UI_STRINGS[ui];
  return composeTelegramHtml([
    telegramBold(s.helpTitle),
    escapeTelegramHtml(s.helpStart),
    escapeTelegramHtml(s.helpHelp),
    escapeTelegramHtml(s.helpStatus),
    escapeTelegramHtml(s.helpVersion),
    escapeTelegramHtml(s.helpLanguage),
    // R1.18: advertised ONLY when the review gate is ON and the actor's
    // role holds `draft.view` (the caller passes null otherwise).
    ...(draftsLine !== null ? [escapeTelegramHtml(draftsLine)] : []),
  ]);
}

function statusResponse(ui: AdminUiLanguage, applicationVersion: string): TelegramSafeHtml {
  const s = ADMIN_UI_STRINGS[ui];
  return composeTelegramHtml([
    telegramBold(s.statusTitle),
    escapeTelegramHtml(s.statusActive),
    escapeTelegramHtml(`${s.statusVersionLabel} ${applicationVersion}`),
  ]);
}

function versionResponse(ui: AdminUiLanguage, applicationVersion: string): TelegramSafeHtml {
  return escapeTelegramHtml(`${ADMIN_UI_STRINGS[ui].versionLabel} ${applicationVersion}`);
}

/**
 * The /language status response (no argument, or a malformed argument):
 * reports the CURRENT UI language and the explicit way to change it.
 */
function languageStatusResponse(ui: AdminUiLanguage): TelegramSafeHtml {
  const s = ADMIN_UI_STRINGS[ui];
  return composeTelegramHtml([
    telegramBold(s.languageTitle),
    escapeTelegramHtml(`${s.languageCurrentLabel} ${s.languageNames[ui]}`),
    escapeTelegramHtml(s.languageHint),
  ]);
}

export function createCommandRouter(context: CommandRouteContext): CommandRouter {
  const { applicationVersion, expectedBotUsername } = context;
  const normalizedExpectedBot = expectedBotUsername?.toLowerCase();
  // R1.18: the review gate is fail-closed — absent/false both DISABLE.
  const reviewEnabled = context.reviewEnabled === true;
  // R1.20-R: the admin post gate is fail-closed — absent/false both DISABLE.
  const adminPostEnabled = context.adminPostEnabled === true;
  // R1.22 Phase A: the editorial→post bridge gate is fail-closed —
  // absent/false both DISABLE the /post_from_draft command only.
  const editorialToPostEnabled = context.editorialToPostEnabled === true;

  function respond(
    command: InitialAdminCommand,
    ui: AdminUiLanguage,
    draftsHelpLine: string | null = null,
  ): TelegramSafeHtml {
    switch (command) {
      case 'start':
        return startResponse(ui);
      case 'help':
        return helpResponse(ui, draftsHelpLine);
      case 'status':
        return statusResponse(ui, applicationVersion);
      case 'version':
        return versionResponse(ui, applicationVersion);
      case 'language':
        return languageStatusResponse(ui);
    }
  }

  function route(
    update: ParsedUpdate,
    actor: ActorResolution,
    uiLanguage?: AdminUiLanguage,
  ): TelegramAction {
    if (update.kind === 'unsupported') {
      return { type: 'noop', reason: 'unsupported_update' };
    }

    if (update.kind === 'callback_query') {
      if (update.callbackData === undefined) {
        return { type: 'noop', reason: 'malformed_callback_data' };
      }
      const callback = parseCallbackData(update.callbackData);
      if (!callback.ok) {
        return { type: 'noop', reason: 'malformed_callback_data' };
      }
      // ---- R1.20-R admin post callbacks --------------------------------
      // Enabled ONLY while the fail-closed gate is ON and the actor is
      // AUTHORIZED (no feedback — and no token resolution — for anyone
      // else; unauthorized senders keep the exact legacy noop). The token
      // is opaque here; ALL binding/validation happens in the service.
      if (adminPostEnabled) {
        if (actor.kind === 'unauthorized') {
          return { type: 'noop', reason: 'callback_not_supported' };
        }
        if (update.callbackQueryId === undefined || update.fromUserId === undefined) {
          return { type: 'noop', reason: 'malformed_callback_data' };
        }
        return {
          type: 'admin_post_callback',
          callbackQueryId: update.callbackQueryId,
          telegramUserId: update.fromUserId,
          role: actor.role,
          uiLanguage: uiLanguage ?? DEFAULT_ADMIN_UI_LANGUAGE,
          token: callback.token,
        };
      }
      // Token contract verified; menu resolution (admin_action_tokens) is
      // the Phase 9 admin-menu feature. Nothing is consumed here.
      return { type: 'noop', reason: 'callback_not_supported' };
    }

    const { command, chatId } = update;
    if (update.commandTarget !== undefined) {
      // Explicitly addressed command: execute ONLY when it targets THIS bot.
      // No expected username configured -> every explicit target is another
      // bot's command and is ignored. (Non-command content never carries a
      // target, so this check is order-safe.)
      if (
        normalizedExpectedBot === undefined ||
        update.commandTarget.toLowerCase() !== normalizedExpectedBot
      ) {
        return { type: 'noop', reason: 'command_for_other_bot' };
      }
    }

    // ---- R1.20-R admin post surface --------------------------------------
    // Handled ONLY while the fail-closed gate is ON, BEFORE the legacy
    // `not_a_command` early return: non-command text (and media) from an
    // authorized admin in a private chat is the CAPTURE surface. While OFF
    // the whole block is unreachable and the exact legacy behavior applies
    // (non-command text -> `not_a_command` noop; /post_* ->
    // `command_not_allowlisted`).
    if (adminPostEnabled) {
      if (command !== undefined && isAdminPostCommand(command)) {
        if (actor.kind === 'unauthorized') {
          if (chatId === undefined) {
            return { type: 'noop', reason: 'unroutable_message' };
          }
          return { type: 'denied', chatId, reason: 'unauthorized', text: denialText() };
        }
        if (update.chatType !== 'private') {
          return { type: 'noop', reason: 'post_not_private_chat' };
        }
        if (update.kind !== 'message') {
          return { type: 'noop', reason: 'post_edited_message' };
        }
        if (chatId === undefined || update.fromUserId === undefined) {
          return { type: 'noop', reason: 'unroutable_message' };
        }
        const postUi = uiLanguage ?? DEFAULT_ADMIN_UI_LANGUAGE;
        switch (command) {
          case 'post_from_draft': {
            // R1.22 Phase A — the editorial→post bridge. Gated FIRST by its
            // OWN fail-closed flag: while OFF the command is an unknown
            // command (the exact legacy noop) even though the admin post
            // surface around it is active. It never widens any other
            // behavior.
            if (!editorialToPostEnabled) {
              return { type: 'noop', reason: 'command_not_allowlisted' };
            }
            // The conversion CREATES an admin post draft version — the same
            // `draft.create` permission as the capture start (pure gate, no
            // D1; the service re-checks fail-closed).
            if (!roleHasPermission(actor.role, 'draft.create')) {
              return {
                type: 'denied',
                chatId,
                reason: 'insufficient_permission',
                text: escapeTelegramHtml(ADMIN_POST_STRINGS.capturePermissionDenied[postUi]),
              };
            }
            // Whole-token argument grammar, validated BEFORE any service or
            // store could exist (the same discipline as /post_preview).
            const remainder = commandRemainder(update.text);
            if (remainder.kind === 'malformed') {
              return {
                type: 'send_message',
                chatId,
                text: escapeTelegramHtml(ADMIN_POST_STRINGS.editorialInvalidUsage[postUi]),
              };
            }
            const parsedArgument = parseDraftsArgument(
              remainder.kind === 'remainder' ? remainder.text : undefined,
            );
            if (parsedArgument.kind !== 'detail') {
              // `/post_from_draft` with NO argument has no documented
              // meaning — there is no implicit draft to convert.
              return {
                type: 'send_message',
                chatId,
                text: escapeTelegramHtml(ADMIN_POST_STRINGS.editorialInvalidUsage[postUi]),
              };
            }
            return {
              type: 'admin_post_from_editorial',
              chatId,
              telegramUserId: update.fromUserId,
              role: actor.role,
              uiLanguage: postUi,
              updateId: update.updateId,
              editorialDraftId: parsedArgument.draftId,
            };
          }
          case 'post': {
            // R1.20-R1: the EXPLICIT capture-session start. A pure
            // permission gate (no D1): roles without `draft.create` get the
            // honest localized denial; the service re-checks fail-closed.
            if (!roleHasPermission(actor.role, 'draft.create')) {
              return {
                type: 'denied',
                chatId,
                reason: 'insufficient_permission',
                text: escapeTelegramHtml(ADMIN_POST_STRINGS.capturePermissionDenied[postUi]),
              };
            }
            return {
              type: 'admin_post_start',
              chatId,
              telegramUserId: update.fromUserId,
              role: actor.role,
              uiLanguage: postUi,
              updateId: update.updateId,
            };
          }
          case 'post_preview': {
            // R1.20-R1: `/post_preview` previews the caller's OWN open
            // draft; `/post_preview <draftId>` previews ANOTHER admin's
            // open draft (the `draft.view` permission is enforced in the
            // service — the router only validates the ARGUMENT grammar,
            // whole-token, before any service could exist).
            const remainder = commandRemainder(update.text);
            let draftId: string | undefined;
            if (remainder.kind === 'malformed') {
              return {
                type: 'send_message',
                chatId,
                text: escapeTelegramHtml(ADMIN_POST_STRINGS.previewInvalidUsage[postUi]),
              };
            }
            if (remainder.kind === 'remainder') {
              const parsedArgument = parseDraftsArgument(remainder.text);
              if (parsedArgument.kind !== 'detail') {
                return {
                  type: 'send_message',
                  chatId,
                  text: escapeTelegramHtml(ADMIN_POST_STRINGS.previewInvalidUsage[postUi]),
                };
              }
              draftId = parsedArgument.draftId;
            }
            return {
              type: 'admin_post_preview',
              chatId,
              telegramUserId: update.fromUserId,
              role: actor.role,
              uiLanguage: postUi,
              updateId: update.updateId,
              ...(draftId !== undefined ? { draftId } : {}),
            };
          }
          case 'post_status': {
            // R1.21: `/post_status` is the caller's OWN open draft;
            // `/post_status <draftId>` lets a publication.publish holder
            // inspect any existing draft's publication state (the same
            // whole-token argument grammar as /post_preview, validated
            // BEFORE any service could exist).
            const remainder = commandRemainder(update.text);
            let draftId: string | undefined;
            if (remainder.kind === 'malformed') {
              return {
                type: 'send_message',
                chatId,
                text: escapeTelegramHtml(ADMIN_POST_STRINGS.statusInvalidUsage[postUi]),
              };
            }
            if (remainder.kind === 'remainder') {
              const parsedArgument = parseDraftsArgument(remainder.text);
              if (parsedArgument.kind !== 'detail') {
                return {
                  type: 'send_message',
                  chatId,
                  text: escapeTelegramHtml(ADMIN_POST_STRINGS.statusInvalidUsage[postUi]),
                };
              }
              draftId = parsedArgument.draftId;
            }
            return {
              type: 'admin_post_status',
              chatId,
              telegramUserId: update.fromUserId,
              role: actor.role,
              uiLanguage: postUi,
              ...(draftId !== undefined ? { draftId } : {}),
            };
          }
          case 'post_cancel':
            return {
              type: 'admin_post_cancel',
              chatId,
              telegramUserId: update.fromUserId,
              role: actor.role,
              uiLanguage: postUi,
            };
        }
      }
      // Capture: plain (non-command) content from an AUTHORIZED admin in a
      // PRIVATE chat is routed to the service, which FIRST checks the
      // EXPLICIT capture session (R1.20-R1): with no open session every
      // ordinary admin message stays an ordinary message — silent legacy
      // behavior, no reply, no state. The session/shape/content decisions
      // (edited rejection, media rejection, oversize, permissions, rich
      // contract) all live in the service because the session gate must be
      // consulted first — and the router NEVER queries D1.
      if (command === undefined) {
        if (update.chatType !== 'private') {
          return { type: 'noop', reason: 'post_not_private_chat' };
        }
        if (actor.kind === 'unauthorized') {
          // Legacy behavior for unauthorized senders — no feedback.
          return { type: 'noop', reason: 'not_a_command' };
        }
        if (update.kind === 'edited_message') {
          if (chatId === undefined || update.fromUserId === undefined) {
            return { type: 'noop', reason: 'unroutable_message' };
          }
          // R1.20-R1: the edit-vs-capture decision is session-gated in the
          // service — outside a session an edit stays SILENT (legacy), and
          // inside one it gets the explicit rejection there.
          return {
            type: 'admin_post_capture',
            chatId,
            telegramUserId: update.fromUserId,
            role: actor.role,
            uiLanguage: uiLanguage ?? DEFAULT_ADMIN_UI_LANGUAGE,
            updateId: update.updateId,
            kind: 'edited_message',
            text: update.text,
            hasText: update.hasText === true,
            richText: update.richText,
            media: update.media,
            richCaption: update.richCaption,
            inMediaGroup: update.inMediaGroup === true,
            hasMediaAttachment: update.hasMediaAttachment === true,
          };
        }
        if (update.kind !== 'message') {
          return { type: 'noop', reason: 'unsupported_update' };
        }
        if (chatId === undefined || update.fromUserId === undefined) {
          return { type: 'noop', reason: 'unroutable_message' };
        }
        return {
          type: 'admin_post_capture',
          chatId,
          telegramUserId: update.fromUserId,
          role: actor.role,
          uiLanguage: uiLanguage ?? DEFAULT_ADMIN_UI_LANGUAGE,
          updateId: update.updateId,
          kind: 'message',
          text: update.text,
          hasText: update.hasText === true,
          richText: update.richText,
          media: update.media,
          richCaption: update.richCaption,
          inMediaGroup: update.inMediaGroup === true,
          hasMediaAttachment: update.hasMediaAttachment === true,
        };
      }
    }

    if (command === undefined) {
      return { type: 'noop', reason: 'not_a_command' };
    }
    // ---- R1.18 read-only review (`/drafts`) -------------------------------
    // Handled when (and ONLY when) the fail-closed gate is ON. While OFF the
    // command falls through to the SAME unknown-command noop as before —
    // zero feedback for every sender and ZERO editorial queries. The router
    // stays PURE and SYNCHRONOUS: it validates the argument and emits typed
    // actions; the query itself happens in the injected review service.
    if (command === REVIEW_COMMAND) {
      if (!reviewEnabled) {
        return { type: 'noop', reason: 'command_not_allowlisted' };
      }
      if (actor.kind === 'unauthorized') {
        if (chatId === undefined) {
          return { type: 'noop', reason: 'unroutable_message' };
        }
        return { type: 'denied', chatId, reason: 'unauthorized', text: denialText() };
      }
      const reviewUi = uiLanguage ?? DEFAULT_ADMIN_UI_LANGUAGE;
      if (!roleHasPermission(actor.role, 'draft.view')) {
        if (chatId === undefined) {
          return { type: 'noop', reason: 'unroutable_message' };
        }
        return {
          type: 'denied',
          chatId,
          reason: 'insufficient_permission',
          text: escapeTelegramHtml(ADMIN_REVIEW_STRINGS[reviewUi].permissionDenied),
        };
      }
      if (update.chatType !== 'private') {
        return { type: 'noop', reason: 'review_not_private_chat' };
      }
      if (update.kind !== 'message') {
        return { type: 'noop', reason: 'review_edited_message' };
      }
      if (chatId === undefined) {
        return { type: 'noop', reason: 'unroutable_message' };
      }
      // R1.18.1 (V1): argument-grammar failure is NEVER the list action.
      // Only `none` is the documented no-argument list form; a captured
      // remainder is validated as a WHOLE (newlines, control characters,
      // extra tokens and oversize ids are all rejected BEFORE any editorial
      // SQL could exist); an unsupported separator is honest invalid usage.
      const remainder = commandRemainder(update.text);
      const parsedArgument: DraftsArgumentParse =
        remainder.kind === 'malformed'
          ? { kind: 'invalid' }
          : parseDraftsArgument(remainder.kind === 'none' ? undefined : remainder.text);
      if (parsedArgument.kind === 'list') {
        return { type: 'drafts_list', chatId, uiLanguage: reviewUi };
      }
      if (parsedArgument.kind === 'detail') {
        return {
          type: 'drafts_detail',
          chatId,
          draftId: parsedArgument.draftId,
          uiLanguage: reviewUi,
        };
      }
      // Honest localized usage/invalid-argument response — BEFORE any
      // editorial query could ever exist.
      return {
        type: 'send_message',
        chatId,
        text: escapeTelegramHtml(ADMIN_REVIEW_STRINGS[reviewUi].invalidUsage),
      };
    }

    if (!isInitialAdminCommand(command)) {
      // Ignored for every sender — no feedback for command probing.
      return { type: 'noop', reason: 'command_not_allowlisted' };
    }
    if (actor.kind === 'unauthorized') {
      if (chatId === undefined) {
        return { type: 'noop', reason: 'unroutable_message' };
      }
      return { type: 'denied', chatId, reason: 'unauthorized', text: denialText() };
    }
    if (chatId === undefined) {
      return { type: 'noop', reason: 'unroutable_message' };
    }

    // Authorized: render in the sender's OWN admin UI language (English
    // default when no preference is stored).
    const ui = uiLanguage ?? DEFAULT_ADMIN_UI_LANGUAGE;

    if (command !== 'language') {
      // /help advertises the review surface ONLY when the gate is ON AND the
      // actor's role holds `draft.view` (blueprint permission — unchanged).
      const draftsHelpLine =
        reviewEnabled && roleHasPermission(actor.role, 'draft.view')
          ? ADMIN_REVIEW_STRINGS[ui].helpDraftsLine
          : null;
      return { type: 'send_message', chatId, text: respond(command, ui, draftsHelpLine) };
    }

    // /language — the whole command (status AND change) is a per-admin
    // personal surface: it answers only in a PRIVATE chat with a fresh
    // (non-edited) message. In groups and edited messages it is ignored
    // with a stable noop reason — no feedback, no state change, and no
    // preference disclosure to group members.
    if (update.chatType !== 'private') {
      return { type: 'noop', reason: 'language_not_private_chat' };
    }
    if (update.kind !== 'message') {
      return { type: 'noop', reason: 'language_edited_message' };
    }
    const fromUserId = update.fromUserId;
    if (fromUserId === undefined) {
      // Unreachable for an authorized actor (authorization requires a sender
      // id), but typed defensively — never invent an identity.
      return { type: 'noop', reason: 'unroutable_message' };
    }
    // R1.18.1: the language command keeps its EXACT existing behavior —
    // no argument AND an unparsable argument both fall through to the
    // status response (a grammar failure was and stays a status response
    // here, never a state change).
    const languageRemainder = commandRemainder(update.text);
    const argument = languageRemainder.kind === 'remainder' ? languageRemainder.text : undefined;
    const language = argument === undefined ? undefined : normalizeAdminUiLanguage(argument);
    if (language === undefined) {
      // No argument or malformed argument: honest localized status/usage
      // response, NO state change. (Read-only — needs no ordering metadata.)
      return { type: 'send_message', chatId, text: languageStatusResponse(ui) };
    }
    // ORDER METADATA GUARD (v1.2.6, ADR-0035): a language CHANGE is fenced
    // by Telegram's SERVER-assigned message order — `(date, message_id)`.
    // If either validated field is missing, there is no trustworthy order,
    // so the change is ignored (no feedback, NO state change): a guess must
    // never overwrite a real preference, and local arrival time is
    // deliberately NOT a substitute (an old retry arrives later).
    if (update.date === undefined || update.messageId === undefined) {
      return { type: 'noop', reason: 'language_missing_ordering_metadata' };
    }
    return {
      type: 'set_admin_ui_language',
      chatId,
      telegramUserId: fromUserId,
      language,
      updateId: update.updateId,
      // Telegram's own chronology for the changing message (ADR-0035):
      // server-assigned date (seconds -> ms) plus the per-chat message_id
      // tiebreak. update_id rides along ONLY as the dedup/audit value.
      changedAtMs: update.date * 1000,
      messageId: update.messageId,
      // Confirmation in the language the sender switched TO; the stale reply
      // in their CURRENT (stored) language. Both are pre-composed here; the
      // ingress sends exactly one of them — and only AFTER the fenced write.
      savedText: escapeTelegramHtml(LANGUAGE_SAVED_TEXT[language]),
      staleText: escapeTelegramHtml(LANGUAGE_STALE_TEXT[ui]),
    };
  }

  return { route };
}
