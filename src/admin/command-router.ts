/**
 * Command routing contracts (Phase 2A; admin UI language added by the
 * Phase 2B correction, v1.2.5 — ADR-0034).
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
 *   confirmations; the ingress persists the preference FIRST (fenced by the
 *   update_id — an older retried message can never overwrite a newer choice)
 *   and only then sends the matching confirmation. A storage failure throws
 *   before any confirmation exists to send.
 * - LANGUAGE-CHANGE GUARDS: a language change requires an AUTHORIZED sender
 *   AND a private chat AND a fresh (non-edited) message. In group chats or
 *   edited messages /language is ignored with a stable noop reason (no
 *   feedback, no state change).
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
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from './telegram-html';
import type { ParsedUpdate } from '../adapters/telegram/update-parser';
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

export type NoopReason =
  | 'unsupported_update'
  | 'not_a_command'
  | 'command_not_allowlisted'
  | 'command_for_other_bot'
  | 'callback_not_supported'
  | 'malformed_callback_data'
  | 'unroutable_message'
  | 'language_not_private_chat'
  | 'language_edited_message';

export type DenialReason = 'unauthorized';

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
      readonly type: 'set_admin_ui_language';
      readonly chatId: number;
      /** ALWAYS the sender's own numeric Telegram user ID — never another admin's. */
      readonly telegramUserId: number;
      /** The language the sender selected for THEIR OWN admin UI. */
      readonly language: AdminUiLanguage;
      /** update_id of the changing message — the durable write-fencing token. */
      readonly updateId: number;
      /** Confirmation sent ONLY after the fenced persistence succeeded. */
      readonly savedText: TelegramSafeHtml;
      /** Honest reply when an older retried message lost the write fence. */
      readonly staleText: TelegramSafeHtml;
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
 * Extract the WHOLE remainder after the command token ("/language fa",
 * "/language@bot fa extra") — bounded by the command-shape grammar. The
 * result is passed through `normalizeAdminUiLanguage`: a single-token
 * "en"/"fa" (case/space-insensitive) is accepted, while multi-token or
 * unknown remainders are rejected as malformed — a strict admin-facing
 * config command never silently ignores trailing input.
 */
const COMMAND_ARGUMENT_PATTERN = /^\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z0-9_]{1,64})?(?:[ \t]+(.*))?$/;

function commandArgumentRemainder(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return COMMAND_ARGUMENT_PATTERN.exec(text)?.[1];
}

function startResponse(ui: AdminUiLanguage): TelegramSafeHtml {
  const s = ADMIN_UI_STRINGS[ui];
  return composeTelegramHtml([
    telegramBold(s.startTitle),
    escapeTelegramHtml(s.startBody),
    escapeTelegramHtml(s.startHint),
  ]);
}

function helpResponse(ui: AdminUiLanguage): TelegramSafeHtml {
  const s = ADMIN_UI_STRINGS[ui];
  return composeTelegramHtml([
    telegramBold(s.helpTitle),
    escapeTelegramHtml(s.helpStart),
    escapeTelegramHtml(s.helpHelp),
    escapeTelegramHtml(s.helpStatus),
    escapeTelegramHtml(s.helpVersion),
    escapeTelegramHtml(s.helpLanguage),
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

  function respond(command: InitialAdminCommand, ui: AdminUiLanguage): TelegramSafeHtml {
    switch (command) {
      case 'start':
        return startResponse(ui);
      case 'help':
        return helpResponse(ui);
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
      // Token contract verified; menu resolution (admin_action_tokens) is
      // the Phase 9 admin-menu feature. Nothing is consumed here.
      return { type: 'noop', reason: 'callback_not_supported' };
    }

    const { command, chatId } = update;
    if (command === undefined) {
      return { type: 'noop', reason: 'not_a_command' };
    }
    if (update.commandTarget !== undefined) {
      // Explicitly addressed command: execute ONLY when it targets THIS bot.
      // No expected username configured -> every explicit target is another
      // bot's command and is ignored.
      if (
        normalizedExpectedBot === undefined ||
        update.commandTarget.toLowerCase() !== normalizedExpectedBot
      ) {
        return { type: 'noop', reason: 'command_for_other_bot' };
      }
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
      return { type: 'send_message', chatId, text: respond(command, ui) };
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
    const argument = commandArgumentRemainder(update.text);
    const language = argument === undefined ? undefined : normalizeAdminUiLanguage(argument);
    if (language === undefined) {
      // No argument or malformed argument: honest localized status/usage
      // response, NO state change.
      return { type: 'send_message', chatId, text: languageStatusResponse(ui) };
    }
    return {
      type: 'set_admin_ui_language',
      chatId,
      telegramUserId: fromUserId,
      language,
      updateId: update.updateId,
      // Confirmation in the language the sender switched TO; the stale reply
      // in their CURRENT (stored) language. Both are pre-composed here; the
      // ingress sends exactly one of them — and only AFTER the fenced write.
      savedText: escapeTelegramHtml(LANGUAGE_SAVED_TEXT[language]),
      staleText: escapeTelegramHtml(LANGUAGE_STALE_TEXT[ui]),
    };
  }

  return { route };
}
