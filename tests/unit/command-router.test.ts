import { describe, expect, it } from 'vitest';
import {
  createCommandRouter,
  isInitialAdminCommand,
  type TelegramAction,
} from '../../src/admin/command-router';
import type { ActorResolution } from '../../src/admin/authorization';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';

/** Command routing contract tests (Phase 2A). */

const OWNER: ActorResolution = { kind: 'authorized', role: 'owner' };
const VIEWER: ActorResolution = { kind: 'authorized', role: 'viewer' };
const UNAUTHORIZED: ActorResolution = { kind: 'unauthorized' };

const router = createCommandRouter({ applicationVersion: '1.2.0' });

function message(overrides: Partial<ParsedUpdate> = {}): ParsedUpdate {
  return {
    kind: 'message',
    updateId: 1,
    messageId: 10,
    chatId: 555,
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

describe('allowlist behavior', () => {
  it('recognizes exactly the four initial commands', () => {
    expect(isInitialAdminCommand('start')).toBe(true);
    expect(isInitialAdminCommand('help')).toBe(true);
    expect(isInitialAdminCommand('status')).toBe(true);
    expect(isInitialAdminCommand('version')).toBe(true);
    expect(isInitialAdminCommand('inbox')).toBe(false);
    expect(isInitialAdminCommand('publish')).toBe(false);
    expect(isInitialAdminCommand('admins')).toBe(false);
  });

  it('routes allowlisted commands for an authorized actor', () => {
    for (const command of ['start', 'help', 'status', 'version'] as const) {
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
  it('denies unauthorized senders of allowlisted commands minimally', () => {
    const action = router.route(message(), UNAUTHORIZED);
    expect(action).toEqual({ type: 'denied', chatId: 555, reason: 'unauthorized' });
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

describe('response content', () => {
  it('interpolates the escaped application version into /version and /status', () => {
    const versionAction = asSent(router.route(message({ command: 'version' }), OWNER));
    expect(versionAction.text).toContain('1.2.0');

    const statusAction = asSent(router.route(message({ command: 'status' }), OWNER));
    expect(statusAction.text).toContain('1.2.0');
  });

  it('does not echo sender-controlled content', () => {
    const action = asSent(router.route(message({ text: '/start hostile-content' }), OWNER));
    expect(action.text).not.toContain('hostile-content');
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
