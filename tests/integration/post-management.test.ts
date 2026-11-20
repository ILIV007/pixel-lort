import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createPostManagementService } from '../../src/application/publishing/post-management-service';
import type { PostManagementTransport } from '../../src/application/publishing/post-management-service';

/**
 * Slice 6 — post management over REAL D1 (pin/unpin + max-one-pin,
 * auto-pin toggle, retention settings, housekeeping filters, delete flow,
 * pin status, in-place edit). The Bot API is a fake transport (no real
 * network calls): it records every pin/unpin/delete/edit call.
 */

const db: D1Database = env.DB;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_770_000_000_000;
const OWNER_ID = 126679582;
const EDITOR_ID = 232514880;
const CHANNEL_ID = -1004402704217;

interface FakeTransport extends PostManagementTransport {
  readonly calls: string[];
}

function fakeTransport(): FakeTransport {
  const calls: string[] = [];
  return {
    calls,
    async pinChatMessage({ messageId }) {
      calls.push(`pin:${messageId}`);
      return true;
    },
    async unpinChatMessage({ messageId }) {
      calls.push(`unpin:${messageId}`);
      return true;
    },
    async deleteMessage({ messageId }) {
      calls.push(`delete:${messageId}`);
      return true;
    },
    async editMessageText({ messageId }) {
      calls.push(`edit:${messageId}`);
      return true;
    },
  };
}

async function seedInboundPost(input: {
  readonly id: string;
  readonly sourceMessageId: number;
  readonly channelMessageId: number;
  readonly category: string;
  readonly createdAtMs: number;
}): Promise<void> {
  const executor = createDbExecutor(db);
  await executor.run({
    sql: `INSERT INTO published_posts
            (id, source_chat_id, source_message_id, channel_message_ids,
             kind, media_file_id, category, presentation,
             created_by_user_id, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, 'text', NULL, ?, 'rich', ?, ?, ?)`,
    params: [
      input.id,
      111,
      input.sourceMessageId,
      JSON.stringify([input.channelMessageId]),
      input.category,
      OWNER_ID,
      input.createdAtMs,
      input.createdAtMs,
    ],
  });
}

beforeEach(async () => {
  await applyMigrations(db);
});

function service(transport?: FakeTransport) {
  return createPostManagementService({
    executor: createDbExecutor(db),
    clock: fixedClock(NOW),
    channelChatId: CHANNEL_ID,
    transport,
  });
}

describe('slice 6 — post management over REAL D1', () => {
  it('pins a post, then unpins it (ledger + fake Bot API agree)', async () => {
    const transport = fakeTransport();
    const pm = service(transport);
    const pinned = await pm.pinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-pin-1',
      channelMessageId: 1001,
    });
    expect(pinned).toEqual({ kind: 'pinned', releasedPrevious: false });
    expect(transport.calls).toEqual(['pin:1001']);
    expect(await pm.activePin()).toMatchObject({ channelMessageId: 1001, status: 'active' });

    const again = await pm.pinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-pin-1',
      channelMessageId: 1001,
    });
    expect(again).toEqual({ kind: 'already_pinned' });
    expect(transport.calls).toEqual(['pin:1001']);

    const unpinned = await pm.unpinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      channelMessageId: 1001,
    });
    expect(unpinned).toEqual({ kind: 'unpinned' });
    expect(transport.calls).toEqual(['pin:1001', 'unpin:1001']);
    expect(await pm.activePin()).toBeNull();

    const notPinned = await pm.unpinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      channelMessageId: 1001,
    });
    expect(notPinned).toEqual({ kind: 'not_pinned' });
  });

  it('a second pin releases the first (max one active pin)', async () => {
    const transport = fakeTransport();
    const pm = service(transport);
    await pm.pinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-pin-2a',
      channelMessageId: 1002,
    });
    const second = await pm.pinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-pin-2b',
      channelMessageId: 1003,
    });
    expect(second).toEqual({ kind: 'pinned', releasedPrevious: true });
    // The ledger releases the previous pin; Telegram auto-unpins on a new
    // pin, so the service never sends an explicit unpin for it.
    expect(transport.calls).toEqual(['pin:1002', 'pin:1003']);
    expect(await pm.activePin()).toMatchObject({ channelMessageId: 1003 });
    // Cleanup: no active pin may leak into later tests in this file.
    expect(
      await pm.unpinPost({ telegramUserId: OWNER_ID, role: 'owner', channelMessageId: 1003 }),
    ).toEqual({ kind: 'unpinned' });
  });

  it('a non-owner, non-chief-editor cannot pin', async () => {
    const pm = service(fakeTransport());
    const denied = await pm.pinPost({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      refType: 'inbound',
      refId: 'inb-pin-3',
      channelMessageId: 1004,
    });
    expect(denied).toEqual({ kind: 'denied' });
  });

  it('auto-pin is OFF by default; the toggle gates autoPinForP0', async () => {
    const transport = fakeTransport();
    const pm = service(transport);
    expect(await pm.autoPinEnabled()).toBe(false);
    expect(
      await pm.autoPinForP0({
        refType: 'inbound',
        refId: 'inb-auto-1',
        channelMessageId: 1005,
      }),
    ).toEqual({ kind: 'skipped_disabled' });
    expect(transport.calls).toEqual([]);

    const toggled = await pm.setAutoPin({
      telegramUserId: OWNER_ID,
      role: 'owner',
      enabled: true,
    });
    expect(toggled).toEqual({ kind: 'applied', enabled: true });
    expect(await pm.autoPinEnabled()).toBe(true);
    expect(
      await pm.autoPinForP0({
        refType: 'inbound',
        refId: 'inb-auto-1',
        channelMessageId: 1005,
      }),
    ).toEqual({ kind: 'pinned', releasedPrevious: false });
    expect(transport.calls).toEqual(['pin:1005']);

    const off = await pm.setAutoPin({
      telegramUserId: OWNER_ID,
      role: 'owner',
      enabled: false,
    });
    expect(off).toEqual({ kind: 'applied', enabled: false });
    // Cleanup: the auto-pin left 1005 active; later tests must see no pin.
    expect(
      await pm.unpinPost({ telegramUserId: OWNER_ID, role: 'owner', channelMessageId: 1005 }),
    ).toEqual({ kind: 'unpinned' });
  });

  it('retention settings: invalid days refused, valid rule applied', async () => {
    const pm = service();
    expect(await pm.retentionRule()).toEqual({
      enabled: true,
      defaultDays: 90,
      freeGameDays: 7,
    });
    expect(
      await pm.setRetention({
        telegramUserId: OWNER_ID,
        role: 'owner',
        rule: { enabled: true, defaultDays: 0, freeGameDays: 7 },
      }),
    ).toEqual({ kind: 'invalid' });
    expect(
      await pm.setRetention({
        telegramUserId: OWNER_ID,
        role: 'owner',
        rule: { enabled: true, defaultDays: 30, freeGameDays: 3 },
      }),
    ).toEqual({
      kind: 'applied',
      rule: { enabled: true, defaultDays: 30, freeGameDays: 3 },
    });
    expect(await pm.retentionRule()).toEqual({
      enabled: true,
      defaultDays: 30,
      freeGameDays: 3,
    });
    // Restore the default so later tests in this file see the default rule.
    await pm.setRetention({
      telegramUserId: OWNER_ID,
      role: 'owner',
      rule: { enabled: true, defaultDays: 90, freeGameDays: 7 },
    });
  });

  it('housekeeping filters: date, category, status (incl. expired)', async () => {
    const pm = service();
    await seedInboundPost({
      id: 'inb-list-1',
      sourceMessageId: 201,
      channelMessageId: 2001,
      category: 'news',
      createdAtMs: NOW - 10 * DAY_MS,
    });
    await seedInboundPost({
      id: 'inb-list-2',
      sourceMessageId: 202,
      channelMessageId: 2002,
      category: 'free_game',
      createdAtMs: NOW - 8 * DAY_MS,
    });
    await seedInboundPost({
      id: 'inb-list-3',
      sourceMessageId: 203,
      channelMessageId: 2003,
      category: 'news',
      createdAtMs: NOW - 100 * DAY_MS,
    });

    const all = await pm.listPosts({
      telegramUserId: OWNER_ID,
      role: 'owner',
      filters: { limit: 50 },
    });
    const ids = all.map((row) => row.refId);
    expect(ids).toContain('inb-list-1');
    expect(ids).toContain('inb-list-2');
    expect(ids).toContain('inb-list-3');

    const freeGames = await pm.listPosts({
      telegramUserId: OWNER_ID,
      role: 'owner',
      filters: { limit: 50, category: 'free_game' },
    });
    expect(freeGames.map((row) => row.refId)).toEqual(['inb-list-2']);
    expect(freeGames[0]!.expired).toBe(true);

    const expired = await pm.listPosts({
      telegramUserId: OWNER_ID,
      role: 'owner',
      filters: { limit: 50, status: 'expired' },
    });
    expect(expired.map((row) => row.refId)).toContain('inb-list-2');
    expect(expired.map((row) => row.refId)).toContain('inb-list-3');
    expect(expired.map((row) => row.refId)).not.toContain('inb-list-1');

    // fromMs is the inclusive LOWER bound: the 8-day-old free game is
    // inside the last 9 days, the 10- and 100-day-old posts are outside.
    const recent = await pm.listPosts({
      telegramUserId: OWNER_ID,
      role: 'owner',
      filters: { limit: 50, fromMs: NOW - 9 * DAY_MS },
    });
    expect(recent.map((row) => row.refId)).toContain('inb-list-2');
    expect(recent.map((row) => row.refId)).not.toContain('inb-list-1');
    expect(recent.map((row) => row.refId)).not.toContain('inb-list-3');
  });

  it('delete flow: the Bot API deletes, the ledger records, the list excludes', async () => {
    const transport = fakeTransport();
    const pm = service(transport);
    await seedInboundPost({
      id: 'inb-del-1',
      sourceMessageId: 204,
      channelMessageId: 2004,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    const deleted = await pm.deletePost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-del-1',
      channelMessageId: 2004,
    });
    expect(deleted).toEqual({ kind: 'deleted' });
    expect(transport.calls).toEqual(['delete:2004']);
    const after = await pm.listPosts({
      telegramUserId: OWNER_ID,
      role: 'owner',
      filters: { limit: 50 },
    });
    expect(after.map((row) => row.refId)).not.toContain('inb-del-1');
  });

  it('pin status is visible in the housekeeping list', async () => {
    const transport = fakeTransport();
    const pm = service(transport);
    await seedInboundPost({
      id: 'inb-pinlist-1',
      sourceMessageId: 205,
      channelMessageId: 2005,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    await pm.pinPost({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-pinlist-1',
      channelMessageId: 2005,
    });
    const rows = await pm.listPosts({
      telegramUserId: OWNER_ID,
      role: 'owner',
      filters: { limit: 50, category: 'news' },
    });
    const row = rows.find((candidate) => candidate.refId === 'inb-pinlist-1');
    expect(row?.pinned).toBe(true);
    expect(row?.expired).toBe(false);
    // Cleanup: unpin so no active pin leaks into later tests in this file.
    expect(
      await pm.unpinPost({ telegramUserId: OWNER_ID, role: 'owner', channelMessageId: 2005 }),
    ).toEqual({ kind: 'unpinned' });
  });

  it('in-place edit: capture, then the new text edits the channel message', async () => {
    const transport = fakeTransport();
    const pm = service(transport);
    await seedInboundPost({
      id: 'inb-edit-1',
      sourceMessageId: 206,
      channelMessageId: 2006,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    const started = await pm.startEdit({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-edit-1',
      channelMessageId: 2006,
    });
    expect(started).toEqual({ kind: 'capture_open' });
    expect(await pm.peekEditCapture({ telegramUserId: OWNER_ID })).toMatchObject({
      postRefId: 'inb-edit-1',
      channelMessageId: 2006,
    });
    const edited = await pm.completeEdit({
      telegramUserId: OWNER_ID,
      role: 'owner',
      text: 'Corrected headline — the trailer is Friday, not Thursday.',
    });
    expect(edited).toEqual({ kind: 'edited' });
    expect(transport.calls).toEqual(['edit:2006']);
    // The capture is consumed: a second completion finds nothing open.
    expect(
      await pm.completeEdit({
        telegramUserId: OWNER_ID,
        role: 'owner',
        text: 'Another edit.',
      }),
    ).toEqual({ kind: 'no_capture' });
  });

  it('completeEdit refuses empty and oversized text', async () => {
    const pm = service(fakeTransport());
    await pm.startEdit({
      telegramUserId: OWNER_ID,
      role: 'owner',
      refType: 'inbound',
      refId: 'inb-edit-2',
      channelMessageId: 2007,
    });
    expect(
      await pm.completeEdit({
        telegramUserId: OWNER_ID,
        role: 'owner',
        text: '   ',
      }),
    ).toEqual({ kind: 'invalid_text' });
    // The capture stays open after an invalid text.
    expect(await pm.peekEditCapture({ telegramUserId: OWNER_ID })).not.toBeNull();
    expect(
      await pm.completeEdit({
        telegramUserId: OWNER_ID,
        role: 'owner',
        text: 'x'.repeat(4097),
      }),
    ).toEqual({ kind: 'invalid_text' });
  });
});
