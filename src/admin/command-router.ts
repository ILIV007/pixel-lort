/**
 * Command routing contracts (Phase 2A).
 *
 * A small router SEPARATE from HTTP routing: input is a normalized Telegram
 * update plus an authorized actor; output is a TYPED action — never an
 * immediate uncontrolled fetch. This keeps webhook security independent of
 * command behavior and lets approval/scheduling/editor workflows attach
 * without rewriting the ingress (blueprint admin map, Phase 2A allowlist).
 *
 * Phase 2A behavior:
 * - Allowlist: /start, /help, /status, /version.
 * - Authorized (owner or active admin) senders receive the admin response
 *   contract for allowlisted commands (static Persian texts, no user content
 *   interpolated except escaped build metadata).
 * - Unauthorized senders of allowlisted commands receive a MINIMAL denial.
 * - Commands outside the allowlist are IGNORED (stable noop reason) — for
 *   authorized and unauthorized senders alike — so command probing gets no
 *   feedback.
 * - Callback queries are validated against the `a:<token>` contract and
 *   answered by the Phase 9 admin menu; Phase 2A classifies them as not
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

export const INITIAL_ADMIN_COMMANDS = ['start', 'help', 'status', 'version'] as const;
export type InitialAdminCommand = (typeof INITIAL_ADMIN_COMMANDS)[number];

export function isInitialAdminCommand(command: string): command is InitialAdminCommand {
  return (INITIAL_ADMIN_COMMANDS as readonly string[]).includes(command);
}

export type NoopReason =
  | 'unsupported_update'
  | 'not_a_command'
  | 'command_not_allowlisted'
  | 'callback_not_supported'
  | 'malformed_callback_data'
  | 'unroutable_message';

export type DenialReason = 'unauthorized';

export type TelegramAction =
  | { readonly type: 'send_message'; readonly chatId: number; readonly text: TelegramSafeHtml }
  | { readonly type: 'answer_callback'; readonly callbackQueryId: string }
  | { readonly type: 'noop'; readonly reason: NoopReason }
  | { readonly type: 'denied'; readonly chatId: number; readonly reason: DenialReason };

export interface CommandRouteContext {
  /** Application build marker surfaced by /version and /status. */
  readonly applicationVersion: string;
}

export interface CommandRouter {
  route(update: ParsedUpdate, actor: ActorResolution): TelegramAction;
}

const DENIAL_TEXT = 'دسترسی مجاز نیست.';

function startResponse(): TelegramSafeHtml {
  return composeTelegramHtml([
    telegramBold('پیکسل'),
    escapeTelegramHtml('پنل مدیریت فعال است.'),
    escapeTelegramHtml('برای فهرست دستورها /help را بفرستید.'),
  ]);
}

function helpResponse(): TelegramSafeHtml {
  return composeTelegramHtml([
    telegramBold('دستورها'),
    escapeTelegramHtml('/start — شروع پنل'),
    escapeTelegramHtml('/help — راهنما'),
    escapeTelegramHtml('/status — وضعیت سیستم'),
    escapeTelegramHtml('/version — نسخه برنامه'),
  ]);
}

function statusResponse(applicationVersion: string): TelegramSafeHtml {
  return composeTelegramHtml([
    telegramBold('وضعیت'),
    escapeTelegramHtml('سیستم: فعال'),
    escapeTelegramHtml(`نسخه برنامه: ${applicationVersion}`),
  ]);
}

function versionResponse(applicationVersion: string): TelegramSafeHtml {
  return escapeTelegramHtml(`نسخه برنامه: ${applicationVersion}`);
}

export function createCommandRouter(context: CommandRouteContext): CommandRouter {
  const { applicationVersion } = context;

  function respond(command: InitialAdminCommand): TelegramSafeHtml {
    switch (command) {
      case 'start':
        return startResponse();
      case 'help':
        return helpResponse();
      case 'status':
        return statusResponse(applicationVersion);
      case 'version':
        return versionResponse(applicationVersion);
    }
  }

  function route(update: ParsedUpdate, actor: ActorResolution): TelegramAction {
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
      // the Phase 9 admin-menu feature. Nothing is consumed in Phase 2A.
      return { type: 'noop', reason: 'callback_not_supported' };
    }

    const { command, chatId } = update;
    if (command === undefined) {
      return { type: 'noop', reason: 'not_a_command' };
    }
    if (!isInitialAdminCommand(command)) {
      // Ignored for every sender — no feedback for command probing.
      return { type: 'noop', reason: 'command_not_allowlisted' };
    }
    if (actor.kind === 'unauthorized') {
      if (chatId === undefined) {
        return { type: 'noop', reason: 'unroutable_message' };
      }
      return { type: 'denied', chatId, reason: 'unauthorized' };
    }
    if (chatId === undefined) {
      return { type: 'noop', reason: 'unroutable_message' };
    }
    return { type: 'send_message', chatId, text: respond(command) };
  }

  return { route };
}
