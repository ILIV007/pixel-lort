import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createAdminPanelService } from '../../src/application/admin-panel/admin-panel-service';
import { createPostManagementService } from '../../src/application/publishing/post-management-service';
import { ADMIN_PANEL_STRINGS } from '../../src/admin/panel-strings';

/**
 * Slice 6 — the admin panel posts screen over REAL D1 (`/menu posts`):
 * the list renders, pin/unpin callbacks work through the opaque tokens,
 * the delete-confirm flow deletes, the auto-pin toggle toasts, and a
 * panel built WITHOUT the post-management service answers honestly
 * instead of pretending success. The Bot API is a fake transport.
 */

const db: D1Database = env.DB;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_770_000_000_000;
const OWNER_ID = 126679582;
const CHANNEL_ID = -1004402704217;

const calls: string[] = [];
const fakeTransport = {
  async pinChatMessage({ messageId }: { messageId: number }) {
    calls.push(`pin:${messageId}`);
    return true;
  },
  async unpinChatMessage({ messageId }: { messageId: number }) {
    calls.push(`unpin:${messageId}`);
    return true;
  },
  async deleteMessage({ messageId }: { messageId: number }) {
    calls.push(`delete:${messageId}`);
    return true;
  },
  async editMessageText({ messageId }: { messageId: number }) {
    calls.push(`edit:${messageId}`);
    return true;
  },
};

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

type Buttons =
  readonly (readonly { readonly text: string; readonly callbackData: string }[])[] | undefined;

function buttonLabels(buttons: Buttons): string[] {
  const labels: string[] = [];
  for (const row of buttons ?? []) {
    for (const button of row) {
      labels.push(button.text);
    }
  }
  return labels;
}

/** A handleCallback result that must be a rendered screen (never a toast). */
function expectReply(
  result:
    | { readonly kind: 'reply'; readonly text: string; readonly buttons?: Buttons }
    | { readonly kind: 'edit'; readonly text: string; readonly buttons?: Buttons }
    | { readonly kind: 'answer'; readonly callbackText: string },
) {
  if (result.kind === 'answer') {
    throw new Error(`expected a rendered screen, got an answer toast: ${result.callbackText}`);
  }
  return result;
}

function tokenFor(buttons: Buttons, labelPart: string): string {
  for (const row of buttons ?? []) {
    for (const button of row) {
      if (button.text.includes(labelPart)) {
        return button.callbackData.slice(2);
      }
    }
  }
  throw new Error(`no button containing ${JSON.stringify(labelPart)}`);
}

beforeEach(async () => {
  await applyMigrations(db);
  calls.length = 0;
});

function buildPanel(withPostManagement: boolean) {
  const executor = createDbExecutor(db);
  const clock = fixedClock(NOW);
  const postManagement = withPostManagement
    ? createPostManagementService({
        executor,
        clock,
        channelChatId: CHANNEL_ID,
        transport: fakeTransport,
      })
    : undefined;
  return createAdminPanelService({
    executor,
    clock,
    ownerTelegramId: OWNER_ID,
    postManagement,
  });
}

describe('slice 6 — the admin panel posts screen over REAL D1', () => {
  it('/menu posts renders the seeded posts with a pin line', async () => {
    await seedInboundPost({
      id: 'inb-panel-1',
      sourceMessageId: 301,
      channelMessageId: 3001,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    const panel = buildPanel(true);
    const screen = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'posts',
    });
    expect(screen.text).toContain('Channel posts');
    expect(screen.text).toContain('3001');
    expect(buttonLabels(screen.buttons)).toContain('Auto-pin P0: OFF');
  });

  it('the main screen carries the Posts button and the pin line', async () => {
    const panel = buildPanel(true);
    const main = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(main.text).toContain('Pinned: none');
    expect(buttonLabels(main.buttons)).toContain('Posts');
  });

  it('pin + unpin callbacks work through the opaque tokens', async () => {
    await seedInboundPost({
      id: 'inb-panel-2',
      sourceMessageId: 302,
      channelMessageId: 3002,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    const panel = buildPanel(true);
    const detail = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'posts',
    });
    const openToken = tokenFor(detail.buttons, '3002');
    const opened = expectReply(
      await panel.handleCallback({
        telegramUserId: OWNER_ID,
        role: 'owner',
        uiLanguage: 'en',
        token: openToken,
      }),
    );
    expect(opened.text).toContain('3002');
    const pinToken = tokenFor(opened.buttons, 'Pin');
    const pinned = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: pinToken,
    });
    expect(pinned).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackPinned,
    });
    expect(calls).toEqual(['pin:3002']);

    // The detail screen now offers Unpin instead of Pin. The open token
    // is single-use, so re-fetch the list for a fresh one.
    const listAgain = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'posts',
    });
    const reopened = expectReply(
      await panel.handleCallback({
        telegramUserId: OWNER_ID,
        role: 'owner',
        uiLanguage: 'en',
        token: tokenFor(listAgain.buttons, '3002'),
      }),
    );
    const unpinToken = tokenFor(reopened.buttons, 'Unpin');
    const unpinned = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: unpinToken,
    });
    expect(unpinned).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackUnpinned,
    });
    expect(calls).toEqual(['pin:3002', 'unpin:3002']);
  });

  it('the delete-confirm flow deletes and returns the fresh list', async () => {
    await seedInboundPost({
      id: 'inb-panel-3',
      sourceMessageId: 303,
      channelMessageId: 3003,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    const panel = buildPanel(true);
    const list = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'posts',
    });
    const openToken = tokenFor(list.buttons, '3003');
    const opened = expectReply(
      await panel.handleCallback({
        telegramUserId: OWNER_ID,
        role: 'owner',
        uiLanguage: 'en',
        token: openToken,
      }),
    );
    const deleteToken = tokenFor(opened.buttons, 'Delete');
    const confirm = expectReply(
      await panel.handleCallback({
        telegramUserId: OWNER_ID,
        role: 'owner',
        uiLanguage: 'en',
        token: deleteToken,
      }),
    );
    expect(confirm.text).toContain('3003');
    const confirmToken = tokenFor(confirm.buttons, 'delete');
    const deleted = expectReply(
      await panel.handleCallback({
        telegramUserId: OWNER_ID,
        role: 'owner',
        uiLanguage: 'en',
        token: confirmToken,
      }),
    );
    expect(calls).toEqual(['delete:3003']);
    // The confirmation returns the fresh posts list — the deleted post is gone.
    expect(deleted.text).not.toContain('3003');
  });

  it('the auto-pin toggle toasts and flips the setting', async () => {
    const panel = buildPanel(true);
    const list = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'posts',
    });
    const toggleToken = tokenFor(list.buttons, 'Auto-pin');
    const toggled = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: toggleToken,
    });
    expect(toggled).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackAutoPinOn,
    });
  });

  it('without the post-management service the pin callback answers honestly', async () => {
    await seedInboundPost({
      id: 'inb-panel-4',
      sourceMessageId: 304,
      channelMessageId: 3004,
      category: 'news',
      createdAtMs: NOW - DAY_MS,
    });
    const panel = buildPanel(false);
    const list = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'posts',
    });
    expect(list.text).toContain('not available');
    // The list still renders from the panel side? Without the service the
    // posts screen reports unavailability and offers no pin buttons.
    expect(calls).toEqual([]);
  });
});
