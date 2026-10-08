import { describe, expect, it } from 'vitest';
import {
  createCommandRouter,
  isInitialAdminCommand,
  type TelegramAction,
} from '../../src/admin/command-router';
import type { ActorResolution } from '../../src/admin/authorization';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';

/** Command routing contract tests (Phase 2A; /language added in v1.2.5, order metadata guard v1.2.6). */

const OWNER: ActorResolution = { kind: 'authorized', role: 'owner' };
const VIEWER: ActorResolution = { kind: 'authorized', role: 'viewer' };
const UNAUTHORIZED: ActorResolution = { kind: 'unauthorized' };

const router = createCommandRouter({ applicationVersion: '1.2.6' });
const targetedRouter = createCommandRouter({
  applicationVersion: '1.2.6',
  expectedBotUsername: 'Pixel_Admin_Bot',
});

function message(overrides: Partial<ParsedUpdate> = {}): ParsedUpdate {
  return {
    kind: 'message',
    updateId: 1,
    messageId: 10,
    // Server-assigned order metadata (ADR-0035): present by default so the
    // set-action tests exercise the happy path; missing-metadata tests
    // override it to undefined.
    date: 1_700_000_000,
    chatId: 555,
    chatType: 'private',
    fromUserId: 1000000001,
    text: '/start',
    command: 'start',
    ...overrides,
  };
}

function asSent(action: TelegramAction): Extract<TelegramAction, { type: 'send_message' }> {
  if (action.type !== 'send_message') {
    throw new Error(`expected send_message, got ${action.type}`);
  }
  return action;
}

function asSet(action: TelegramAction): Extract<TelegramAction, { type: 'set_admin_ui_language' }> {
  if (action.type !== 'set_admin_ui_language') {
    throw new Error(`expected set_admin_ui_language, got ${action.type}`);
  }
  return action;
}

describe('allowlist behavior', () => {
  it('recognizes exactly the five initial commands', () => {
    expect(isInitialAdminCommand('start')).toBe(true);
    expect(isInitialAdminCommand('help')).toBe(true);
    expect(isInitialAdminCommand('status')).toBe(true);
    expect(isInitialAdminCommand('version')).toBe(true);
    expect(isInitialAdminCommand('language')).toBe(true);
    expect(isInitialAdminCommand('inbox')).toBe(false);
    expect(isInitialAdminCommand('publish')).toBe(false);
    expect(isInitialAdminCommand('admins')).toBe(false);
  });

  it('routes allowlisted commands for an authorized actor', () => {
    for (const command of ['start', 'help', 'status', 'version', 'language'] as const) {
      const action = router.route(message({ command, text: `/${command}` }), OWNER);
      expect(action.type).toBe('send_message');
    }
  });

  it('ignores commands outside the allowlist for authorized actors', () => {
    for (const command of ['inbox', 'publish', 'admins', 'emergency_stop']) {
      const action = router.route(message({ command, text: `/${command}` }), OWNER);
      expect(action).toEqual({ type: 'noop', reason: 'command_not_allowlisted' });
    }
  });

  it('ignores non-command messages', () => {
    expect(router.route(message({ command: undefined, text: 'سلام' }), OWNER)).toEqual({
      type: 'noop',
      reason: 'not_a_command',
    });
  });

  it('treats unsupported updates as a noop', () => {
    expect(router.route({ kind: 'unsupported', updateId: 2 }, OWNER)).toEqual({
      type: 'noop',
      reason: 'unsupported_update',
    });
  });
});

describe('authorization outcomes', () => {
  it('denies unauthorized senders of allowlisted commands with the minimal ENGLISH denial', () => {
    for (const command of ['start', 'help', 'status', 'version', 'language'] as const) {
      const action = router.route(message({ command, text: `/${command}` }), UNAUTHORIZED);
      expect(action.type).toBe('denied');
      if (action.type === 'denied') {
        expect(action.chatId).toBe(555);
        expect(action.reason).toBe('unauthorized');
        // The denial is the fixed minimal English string (v1.2.5).
        expect(action.text).toBe('Access denied.');
      }
    }
  });

  it('gives no feedback to unauthorized probing of non-allowlisted commands', () => {
    const action = router.route(message({ command: 'inbox', text: '/inbox' }), UNAUTHORIZED);
    expect(action).toEqual({ type: 'noop', reason: 'command_not_allowlisted' });
  });

  it('serves every authorized role the same initial command contract', () => {
    for (const actor of [OWNER, VIEWER]) {
      const action = asSent(router.route(message({ command: 'status' }), actor));
      expect(action.chatId).toBe(555);
      expect(action.text.length).toBeGreaterThan(0);
    }
  });
});

describe('admin UI language localization (v1.2.5)', () => {
  it('defaults to ENGLISH responses when no preference is provided', () => {
    expect(asSent(router.route(message({ command: 'start' }), OWNER)).text).toContain(
      'Admin panel is active.',
    );
    expect(asSent(router.route(message({ command: 'help' }), OWNER)).text).toContain('Commands');
    expect(asSent(router.route(message({ command: 'status' }), OWNER)).text).toContain(
      'Application version:',
    );
    expect(asSent(router.route(message({ command: 'version' }), OWNER)).text).toBe(
      'Application version: 1.2.6',
    );
  });

  it('renders Persian responses for the fa preference', () => {
    expect(asSent(router.route(message({ command: 'start' }), OWNER, 'fa')).text).toContain(
      'پنل مدیریت فعال است.',
    );
    expect(asSent(router.route(message({ command: 'help' }), OWNER, 'fa')).text).toContain(
      'دستورها',
    );
    expect(asSent(router.route(message({ command: 'version' }), OWNER, 'fa')).text).toBe(
      'نسخه برنامه: 1.2.6',
    );
  });

  it('interpolates the escaped application version into /version and /status', () => {
    const versionAction = asSent(router.route(message({ command: 'version' }), OWNER));
    expect(versionAction.text).toContain('1.2.6');

    const statusAction = asSent(router.route(message({ command: 'status' }), OWNER));
    expect(statusAction.text).toContain('1.2.6');
  });

  it('lists /language in every help rendering', () => {
    expect(asSent(router.route(message({ command: 'help' }), OWNER)).text).toContain('/language');
    expect(asSent(router.route(message({ command: 'help' }), OWNER, 'fa')).text).toContain(
      '/language',
    );
  });

  it('does not echo sender-controlled content', () => {
    const action = asSent(router.route(message({ text: '/start hostile-content' }), OWNER));
    expect(action.text).not.toContain('hostile-content');
  });
});

describe('/language routing (v1.2.5)', () => {
  it('answers the bare /language with a status/usage message (no state change)', () => {
    const action = router.route(message({ command: 'language', text: '/language' }), OWNER);
    const sent = asSent(action);
    expect(sent.text).toContain('Admin UI language');
    expect(sent.text).toContain('Current: English');
    expect(sent.text).toContain('/language fa');
  });

  it('answers the bare /language in the current preference language', () => {
    const sent = asSent(
      router.route(message({ command: 'language', text: '/language' }), OWNER, 'fa'),
    );
    expect(sent.text).toContain('زبان رابط مدیریت');
    expect(sent.text).toContain('فارسی');
    expect(sent.text).toContain('/language en');
  });

  it('returns a typed set action for /language en targeting the SENDER only', () => {
    const action = asSet(
      router.route(message({ command: 'language', text: '/language en' }), OWNER),
    );
    expect(action.chatId).toBe(555);
    expect(action.telegramUserId).toBe(1000000001);
    expect(action.language).toBe('en');
    // update_id rides along as the durable dedup/audit value only.
    expect(action.updateId).toBe(1);
    // The ordering fence is Telegram's message metadata (ADR-0035):
    // server-assigned date in epoch ms + the per-chat message_id tiebreak.
    expect(action.changedAtMs).toBe(1_700_000_000_000);
    expect(action.messageId).toBe(10);
    expect(action.savedText).toBe('Admin UI language set to English.');
  });

  it('returns a typed set action for /language fa with a Persian confirmation', () => {
    const action = asSet(
      router.route(message({ command: 'language', text: '/language fa' }), OWNER),
    );
    expect(action.language).toBe('fa');
    expect(action.savedText).toBe('زبان رابط مدیریت به فارسی تغییر کرد.');
    // The stale reply is pre-composed in the admin's CURRENT language.
    expect(action.staleText).toBe('Not applied: a newer language choice is already saved.');
  });

  it('normalizes case and surrounding whitespace of the argument', () => {
    expect(
      asSet(router.route(message({ command: 'language', text: '/language  FA ' }), OWNER)).language,
    ).toBe('fa');
    expect(
      asSet(router.route(message({ command: 'language', text: '/language En' }), OWNER)).language,
    ).toBe('en');
  });

  it('accepts the /language@target argument form for THIS bot', () => {
    const action = asSet(
      targetedRouter.route(
        message({
          command: 'language',
          commandTarget: 'pixel_admin_bot',
          text: '/language@pixel_admin_bot fa',
        }),
        OWNER,
      ),
    );
    expect(action.language).toBe('fa');
  });

  it('rejects malformed arguments with the usage response and no state change', () => {
    for (const text of [
      '/language fr',
      '/language english',
      '/language fa extra',
      '/language <x>',
    ]) {
      const action = router.route(message({ command: 'language', text }), OWNER);
      expect(action.type).toBe('send_message');
      if (action.type === 'send_message') {
        expect(action.text).toContain('Admin UI language');
      }
    }
  });

  it('ignores /language outside private chats (no feedback, no state change)', () => {
    for (const chatType of ['group', 'supergroup', 'channel', undefined] as const) {
      const action = router.route(
        message({ command: 'language', text: '/language fa', chatType }),
        OWNER,
      );
      expect(action).toEqual({ type: 'noop', reason: 'language_not_private_chat' });
    }
  });

  it('ignores /language in edited messages (a change needs a fresh message)', () => {
    const action = router.route(
      message({ kind: 'edited_message', command: 'language', text: '/language fa' }),
      OWNER,
    );
    expect(action).toEqual({ type: 'noop', reason: 'language_edited_message' });
  });

  it('never allows changing another admin: the action targets the sender only', () => {
    const action = asSet(
      router.route(
        message({ command: 'language', text: '/language fa', fromUserId: 1000000001 }),
        OWNER,
      ),
    );
    // The target user id is exactly the sender's id — there is no syntax to
    // address another admin's preference.
    expect(action.telegramUserId).toBe(1000000001);
    expect(action.telegramUserId).not.toBe(2000000002);
  });

  it('ignores /language changes without validated order metadata (fail safe, ADR-0035)', () => {
    // Missing server date: there is no trustworthy message order, so the
    // change is a silent noop — never an order guessed from arrival time.
    expect(
      router.route(message({ command: 'language', text: '/language fa', date: undefined }), OWNER),
    ).toEqual({ type: 'noop', reason: 'language_missing_ordering_metadata' });
    // Missing message_id: the same-second tiebreak is unavailable — the
    // change is equally refused.
    expect(
      router.route(
        message({ command: 'language', text: '/language fa', messageId: undefined }),
        OWNER,
      ),
    ).toEqual({ type: 'noop', reason: 'language_missing_ordering_metadata' });
  });

  it('still answers the READ-ONLY bare /language when order metadata is missing', () => {
    // The status/usage response changes nothing, so it needs no ordering
    // metadata and keeps working for legitimate clients.
    const action = asSent(
      router.route(message({ command: 'language', text: '/language', date: undefined }), OWNER),
    );
    expect(action.text).toContain('Admin UI language');
  });

  it('denies unauthorized /language senders (minimal English denial)', () => {
    const action = router.route(
      message({ command: 'language', text: '/language fa' }),
      UNAUTHORIZED,
    );
    expect(action.type).toBe('denied');
    if (action.type === 'denied') {
      expect(action.text).toBe('Access denied.');
    }
  });
});

describe('bot command target safety', () => {
  it('accepts an unqualified command', () => {
    const action = targetedRouter.route(message({ command: 'status', text: '/status' }), OWNER);
    expect(action.type).toBe('send_message');
  });

  it('accepts a command addressed to the configured bot (case-insensitive)', () => {
    const action = targetedRouter.route(
      message({
        command: 'status',
        commandTarget: 'PIXEL_admin_bot',
        text: '/status@PIXEL_admin_bot',
      }),
      OWNER,
    );
    expect(action.type).toBe('send_message');
  });

  it('ignores a command addressed to another bot', () => {
    const action = targetedRouter.route(
      message({
        command: 'status',
        commandTarget: 'some_other_bot',
        text: '/status@some_other_bot',
      }),
      OWNER,
    );
    expect(action).toEqual({ type: 'noop', reason: 'command_for_other_bot' });
  });

  it('ignores an explicitly targeted command when no expected username is configured', () => {
    // No username source: every explicit target is treated as another bot's
    // command (fail closed).
    const action = router.route(
      message({ command: 'status', commandTarget: 'pixel_admin_bot' }),
      OWNER,
    );
    expect(action).toEqual({ type: 'noop', reason: 'command_for_other_bot' });
  });

  it("gives no feedback for another bot's command regardless of authorization", () => {
    const update = message({
      command: 'status',
      commandTarget: 'some_other_bot',
      text: '/status@some_other_bot',
    });
    expect(targetedRouter.route(update, UNAUTHORIZED)).toEqual({
      type: 'noop',
      reason: 'command_for_other_bot',
    });
  });
});

describe('callback routing', () => {
  it('classifies contract-valid callback data as not supported yet', () => {
    const update: ParsedUpdate = {
      kind: 'callback_query',
      updateId: 3,
      callbackQueryId: 'cb-1',
      fromUserId: 1000000001,
      callbackData: 'a:AAAbbCCCdddEEEff',
    };
    expect(router.route(update, OWNER)).toEqual({ type: 'noop', reason: 'callback_not_supported' });
  });

  it('classifies malformed callback data as a noop (never a crash)', () => {
    for (const callbackData of ['', 'no-prefix-token-here', 'a:bad+chars', `a:${'x'.repeat(60)}`]) {
      const update: ParsedUpdate = {
        kind: 'callback_query',
        updateId: 4,
        callbackQueryId: 'cb-2',
        fromUserId: 1000000001,
        callbackData: callbackData === '' ? undefined : callbackData,
      };
      expect(router.route(update, OWNER).type).toBe('noop');
    }
  });
});
