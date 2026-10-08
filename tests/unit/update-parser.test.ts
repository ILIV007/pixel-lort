import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_UPDATE_LIMITS,
  extractBotCommand,
  parseTelegramUpdate,
} from '../../src/adapters/telegram/update-parser';

/**
 * Bounded Telegram Update parser tests (Phase 2A).
 * Unknown kinds must never crash; unsafe numerics are rejected; strings are
 * bounded by omission (never truncated); only fixed paths are read.
 */

function messageUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 101,
    message: {
      message_id: 7,
      chat: { id: -1001234567890, type: 'private' },
      from: { id: 1000000001, is_bot: false, first_name: 'Test' },
      text: '/status',
      ...overrides,
    },
  };
}

describe('parseTelegramUpdate — supported kinds', () => {
  it('parses a message with command text', () => {
    const result = parseTelegramUpdate(messageUpdate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.kind).toBe('message');
    if (result.update.kind !== 'message') return;
    expect(result.update.updateId).toBe(101);
    expect(result.update.messageId).toBe(7);
    expect(result.update.chatId).toBe(-1001234567890);
    expect(result.update.fromUserId).toBe(1000000001);
    expect(result.update.text).toBe('/status');
    expect(result.update.command).toBe('status');
    expect(result.update.commandTarget).toBeUndefined();
  });

  it('parses an explicitly targeted command with its target username', () => {
    const result = parseTelegramUpdate(
      messageUpdate({ text: '/status@Pixel_Admin_Bot extra args' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.command).toBe('status');
    expect(result.update.commandTarget).toBe('pixel_admin_bot');
  });

  it('parses an edited_message identically to a message', () => {
    const raw = { update_id: 102, edited_message: { message_id: 8, text: '/help' } };
    const result = parseTelegramUpdate(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.kind).toBe('edited_message');
    if (result.update.kind !== 'edited_message') return;
    expect(result.update.command).toBe('help');
    expect(result.update.chatId).toBeUndefined();
  });

  it('parses a callback_query with bounded fields', () => {
    const raw = {
      update_id: 103,
      callback_query: {
        id: 'callback-id-0001',
        from: { id: 1000000002 },
        data: 'a:AAAbbCCCdddEEE',
        message: { message_id: 9, chat: { id: -100999 } },
      },
    };
    const result = parseTelegramUpdate(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update.kind).toBe('callback_query');
    if (result.update.kind !== 'callback_query') return;
    expect(result.update.callbackQueryId).toBe('callback-id-0001');
    expect(result.update.fromUserId).toBe(1000000002);
    expect(result.update.callbackData).toBe('a:AAAbbCCCdddEEE');
    expect(result.update.callbackChatId).toBe(-100999);
    expect(result.update.callbackMessageId).toBe(9);
  });

  it('classifies unknown update kinds as unsupported while keeping update_id', () => {
    for (const raw of [
      { update_id: 104, channel_post: { message_id: 1 } },
      { update_id: 105, my_chat_member: { status: 'member' } },
      { update_id: 106, poll: { id: 'p' } },
      { update_id: 107 },
    ]) {
      const result = parseTelegramUpdate(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.update.kind).toBe('unsupported');
      if (result.update.kind !== 'unsupported') continue;
      expect(result.update.updateId).toBe(Number(raw['update_id']));
    }
  });
});

describe('parseTelegramUpdate — update_id validation', () => {
  it('rejects a missing update_id with a stable reason', () => {
    const result = parseTelegramUpdate({ message: {} });
    expect(result).toEqual({ ok: false, reason: 'missing_update_id' });
  });

  it('rejects unsafe update_id values (string, float, negative, oversized)', () => {
    for (const bad of ['101', 10.5, Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1, null, true]) {
      const result = parseTelegramUpdate({ update_id: bad, message: {} });
      expect(result).toEqual({ ok: false, reason: 'invalid_update_id' });
    }
  });

  it('rejects non-object roots', () => {
    for (const bad of [null, undefined, 42, 'update', []]) {
      expect(parseTelegramUpdate(bad)).toEqual({ ok: false, reason: 'root_not_object' });
    }
  });
});

describe('parseTelegramUpdate — numeric safety', () => {
  it('rejects numeric strings for identifiers (JSON numbers only)', () => {
    const result = parseTelegramUpdate(
      messageUpdate({ message_id: '7', chat: { id: '-100' }, from: { id: '1000000001' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.messageId).toBeUndefined();
    expect(result.update.chatId).toBeUndefined();
    expect(result.update.fromUserId).toBeUndefined();
  });

  it('rejects non-integer, NaN-like, and oversized numbers', () => {
    const result = parseTelegramUpdate(
      messageUpdate({
        message_id: 1.5,
        chat: { id: Number.NaN },
        from: { id: Number.MAX_SAFE_INTEGER + 2 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.messageId).toBeUndefined();
    expect(result.update.chatId).toBeUndefined();
    expect(result.update.fromUserId).toBeUndefined();
  });

  it('keeps negative chat IDs (groups/channels) but requires positive user IDs', () => {
    const negativeUser = parseTelegramUpdate(messageUpdate({ from: { id: -5 } }));
    expect(negativeUser.ok).toBe(true);
    if (!negativeUser.ok || negativeUser.update.kind !== 'message') return;
    expect(negativeUser.update.fromUserId).toBeUndefined();
  });
});

describe('parseTelegramUpdate — string bounds', () => {
  it('treats oversized text as absent (never truncated)', () => {
    const long = 'x'.repeat(TELEGRAM_UPDATE_LIMITS.maxTextLength + 1);
    const result = parseTelegramUpdate(messageUpdate({ text: long }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.text).toBeUndefined();
    expect(result.update.command).toBeUndefined();
  });

  it('treats callback data beyond the 64-byte Telegram limit as absent', () => {
    const exactly64 = 'a'.repeat(64);
    const bytes65 = 'a'.repeat(65);
    const multibyte = 'ا'.repeat(32); // 64 bytes — allowed
    const multibyte65 = 'ا'.repeat(33); // 66 bytes — rejected

    const ok = parseTelegramUpdate({
      update_id: 1,
      callback_query: { id: 'c', data: exactly64 },
    });
    expect(ok.ok && ok.update.kind === 'callback_query' && ok.update.callbackData).toBe(exactly64);

    const multi = parseTelegramUpdate({
      update_id: 2,
      callback_query: { id: 'c', data: multibyte },
    });
    expect(multi.ok && multi.update.kind === 'callback_query' && multi.update.callbackData).toBe(
      multibyte,
    );

    for (const bad of [bytes65, multibyte65]) {
      const result = parseTelegramUpdate({ update_id: 3, callback_query: { id: 'c', data: bad } });
      expect(
        result.ok && result.update.kind === 'callback_query' && result.update.callbackData,
      ).toBe(undefined);
    }
  });

  it('treats an oversized callback_query id as absent', () => {
    const result = parseTelegramUpdate({
      update_id: 4,
      callback_query: { id: 'i'.repeat(65), from: { id: 1 } },
    });
    expect(
      result.ok && result.update.kind === 'callback_query' && result.update.callbackQueryId,
    ).toBe(undefined);
  });
});

describe('parseTelegramUpdate — chat type extraction (v1.2.5)', () => {
  it('extracts the exact known chat types', () => {
    for (const type of ['private', 'group', 'supergroup', 'channel']) {
      const result = parseTelegramUpdate(messageUpdate({ chat: { id: 555, type } }));
      expect(result.ok).toBe(true);
      if (!result.ok || result.update.kind !== 'message') return;
      expect(result.update.chatType).toBe(type);
    }
  });

  it('treats unknown, non-string, and missing chat types as absent (fail closed)', () => {
    for (const type of ['secret_chat', 'Private', 7, null, undefined]) {
      const chat: Record<string, unknown> = { id: 555 };
      if (type !== undefined) chat['type'] = type;
      const result = parseTelegramUpdate(messageUpdate({ chat }));
      expect(result.ok).toBe(true);
      if (!result.ok || result.update.kind !== 'message') return;
      expect(result.update.chatType).toBeUndefined();
    }
  });

  it('keeps chatType absent when the chat object itself is missing', () => {
    const result = parseTelegramUpdate(messageUpdate({ chat: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.chatType).toBeUndefined();
    expect(result.update.chatId).toBeUndefined();
  });
});

describe('extractBotCommand', () => {
  it('extracts and lowercases the command word', () => {
    expect(extractBotCommand('/status')).toEqual({ command: 'status' });
    expect(extractBotCommand('/STATUS')).toEqual({ command: 'status' });
    expect(extractBotCommand('/Help text after')).toEqual({ command: 'help' });
  });

  it('preserves the @botname target suffix, lowercased', () => {
    expect(extractBotCommand('/status@pixel_admin_bot')).toEqual({
      command: 'status',
      targetUsername: 'pixel_admin_bot',
    });
    expect(extractBotCommand('/start@PixelBot extra')).toEqual({
      command: 'start',
      targetUsername: 'pixelbot',
    });
    expect(extractBotCommand('/STATUS@Pixel_Admin_Bot')).toEqual({
      command: 'status',
      targetUsername: 'pixel_admin_bot',
    });
  });

  it('omits the target for unqualified commands', () => {
    const parsed = extractBotCommand('/version');
    expect(parsed).toEqual({ command: 'version' });
    expect(parsed?.targetUsername).toBeUndefined();
  });

  it('returns undefined for non-commands and malformed commands', () => {
    expect(extractBotCommand('hello')).toBeUndefined();
    expect(extractBotCommand('/')).toBeUndefined();
    expect(extractBotCommand('/ spaced')).toBeUndefined();
    expect(extractBotCommand(`/${'x'.repeat(33)}`)).toBeUndefined();
    expect(extractBotCommand('')).toBeUndefined();
  });
});
