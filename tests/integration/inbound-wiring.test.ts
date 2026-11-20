import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { findPublishedPostBySource } from '../../src/adapters/db/inbound-store';
import { setPublishMode } from '../../src/adapters/db/publishing-settings-store';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import type {
  TelegramBotApiClient,
  TelegramMessageDeleteClient,
  TelegramRichTextClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import { createAdminPostService } from '../../src/application/admin-post/admin-post-service';
import {
  createInboundPipelineService,
  type InboundTransport,
} from '../../src/application/inbound/inbound-pipeline-service';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * Slice 4 — the WIRING glue, end to end over the real workerd D1 binding:
 * a real Telegram update -> real router -> real admin-post capture (no
 * session) -> real inbound pipeline delegation -> real channel send +
 * PV copy + published_posts row; and an approval-preview callback through
 * the real `inbound.` dispatcher branch. The Bot API client is faked (no
 * network); every other layer is real.
 */

const db: D1Database = env.DB;

const OWNER_ID = 1000000001;
const DESTINATION = '@pixellores';
const NOW = 1_790_000_000_000;

let executor: DbExecutor;
let updateSeq = 0;

function nextUpdateId(): number {
  updateSeq += 1;
  return 80000 + updateSeq;
}

interface CapturedSend {
  readonly method: string;
  readonly chatId: number | string;
  readonly text?: string;
  readonly keyboardTokens: string[];
  readonly messageId: number;
}

type FullFakeClient = TelegramBotApiClient & TelegramRichTextClient & TelegramMessageDeleteClient;

function createCapturingBotApi(): {
  readonly client: FullFakeClient;
  readonly sends: CapturedSend[];
  readonly answers: string[];
} {
  const sends: CapturedSend[] = [];
  const answers: string[] = [];
  let nextId = 7000;
  const record = (
    method: string,
    chatId: number | string,
    text: string | undefined,
    replyMarkup?: { inline_keyboard: readonly (readonly { callbackData: string }[])[] },
  ): number => {
    nextId += 1;
    sends.push({
      method,
      chatId,
      text,
      keyboardTokens:
        replyMarkup?.inline_keyboard.flat().map((button) => button.callbackData) ?? [],
      messageId: nextId,
    });
    return nextId;
  };
  const client: FullFakeClient = {
    async getMe() {
      return { id: 42, username: 'pixel_admin_bot' };
    },
    async sendMessage(input) {
      const id = record('sendMessage', input.chatId, input.text, input.replyMarkup);
      return { messageId: id } as TelegramSentMessage;
    },
    async editMessageText(input) {
      record('editMessageText', input.chatId, input.text);
      return true;
    },
    async answerCallbackQuery(input) {
      answers.push(input.text ?? '');
    },
    async sendMessageRich(input) {
      const id = record('sendMessageRich', input.chatId, input.content.text);
      return { messageId: id } as TelegramSentMessage;
    },
    async sendPhotoRich(input) {
      const id = record('sendPhotoRich', input.chatId, input.caption?.text);
      return { messageId: id } as TelegramSentMessage;
    },
    async sendVideoRich(input) {
      const id = record('sendVideoRich', input.chatId, input.caption?.text);
      return { messageId: id } as TelegramSentMessage;
    },
    async sendMediaGroupRich() {
      return [];
    },
    async editMessageTextRich(input) {
      record('editMessageTextRich', input.chatId, input.content.text);
      return true;
    },
    async editMessageCaptionRich(input) {
      record('editMessageCaptionRich', input.chatId, input.content.text);
      return true;
    },
    async deleteMessage(input) {
      record('deleteMessage', input.chatId, undefined);
      return true;
    },
  };
  return { client, sends, answers };
}

function buildIngress(botApi: FullFakeClient, routerGates: { panelEnabled?: boolean } = {}) {
  const logger = createLogger({ level: 'error', sink: () => {} });
  const clock = fixedClock(NOW);
  const inboundTransport: InboundTransport = {
    sendMessageRich: (input) => botApi.sendMessageRich(input),
    sendPhotoRich: (input) => botApi.sendPhotoRich(input),
    sendVideoRich: (input) => botApi.sendVideoRich(input),
    sendMessageClassic: (input) => botApi.sendMessage({ chatId: input.chatId, text: input.html }),
    editMessageTextRich: (input) => botApi.editMessageTextRich(input),
    editMessageCaptionRich: (input) => botApi.editMessageCaptionRich(input),
    editMessageTextClassic: (input) =>
      botApi.editMessageText({
        chatId: input.chatId,
        messageId: input.messageId,
        text: input.html,
      }),
    deleteMessage: (input) => botApi.deleteMessage(input),
  };
  const inbound = createInboundPipelineService({
    executor,
    clock,
    logger,
    config: { livePublishEnabled: true, destination: DESTINATION },
    transport: inboundTransport,
  });
  const adminPost = createAdminPostService({
    executor,
    clock,
    logger,
    config: { livePublishEnabled: true, destination: DESTINATION },
    transport: botApi,
    inbound,
  });
  return createTelegramIngress({
    executor,
    authorization: createAuthorizationService({
      ownerTelegramId: OWNER_ID,
      lookup: createAdminRoleLookup(executor),
    }),
    commandRouter: createCommandRouter({
      applicationVersion: '1.43.0-test',
      adminPostEnabled: true,
      panelEnabled: routerGates.panelEnabled ?? false,
    }),
    botApi,
    adminPost,
    inbound,
    clock,
    logger,
  });
}

function ownerMessage(updateId: number, messageId: number, text: string): ParsedUpdate {
  return {
    kind: 'message',
    updateId,
    messageId,
    chatId: OWNER_ID,
    chatType: 'private',
    fromUserId: OWNER_ID,
    text,
    hasText: true,
  };
}

function callbackUpdate(updateId: number, token: string): ParsedUpdate {
  return {
    kind: 'callback_query',
    updateId,
    callbackQueryId: `cbq-${updateId}`,
    fromUserId: OWNER_ID,
    callbackData: `a:${token}`,
    callbackChatId: OWNER_ID,
    callbackMessageId: 9,
  };
}

beforeEach(async () => {
  executor = createDbExecutor(db);
  await applyMigrations(db);
  await executor.run({
    sql: `INSERT OR IGNORE INTO admins
            (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', ?, ?)`,
    params: [OWNER_ID, `admin-${OWNER_ID}`, NOW, NOW],
  });
  await setPublishMode(executor, { mode: 'auto', actorId: OWNER_ID, nowMs: NOW });
});

describe('slice 4 — inbound wiring (real ingress, fake Bot API)', () => {
  it('a plain owner message with no open session publishes through the inbound pipeline', async () => {
    const { client, sends } = createCapturingBotApi();
    const ingress = buildIngress(client);
    const updateId = nextUpdateId();
    const messageId = 5001;

    const outcome = await ingress.processUpdate(
      ownerMessage(
        updateId,
        messageId,
        'New trailer for Elden Ring is out! https://example.com/trailer',
      ),
    );
    expect(outcome).toBe('processed');

    const channelSends = sends.filter((send) => send.chatId === DESTINATION);
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.method).toBe('sendMessage');
    expect(channelSends[0]?.text).toContain('https://example.com/trailer');
    // The confirmation reply reaches the owner's private chat.
    expect(
      sends.some(
        (send) =>
          send.chatId === OWNER_ID && (send.text ?? '').includes('Published to the channel'),
      ),
    ).toBe(true);

    const row = await findPublishedPostBySource(executor, {
      sourceChatId: OWNER_ID,
      sourceMessageId: messageId,
    });
    expect(row).not.toBeNull();
    expect(row?.category).toBe('trailer');
  });

  it('an approval preview routes its approve callback through the inbound dispatcher', async () => {
    await setPublishMode(executor, { mode: 'approval', actorId: OWNER_ID, nowMs: NOW });
    const { client, sends, answers } = createCapturingBotApi();
    const ingress = buildIngress(client);

    const previewOutcome = await ingress.processUpdate(
      ownerMessage(
        nextUpdateId(),
        5002,
        'New trailer for Elden Ring is out! https://example.com/trailer',
      ),
    );
    expect(previewOutcome).toBe('processed');
    // The preview is content + control; only the control carries buttons.
    const control = sends.find((send) => send.keyboardTokens.length === 2);
    expect(control).toBeDefined();
    const approveToken = control?.keyboardTokens[0]?.slice(2);
    expect(approveToken).toBeDefined();
    expect(sends.filter((send) => send.chatId === DESTINATION)).toHaveLength(0);

    const callbackOutcome = await ingress.processUpdate(
      callbackUpdate(nextUpdateId(), approveToken ?? ''),
    );
    expect(callbackOutcome).toBe('processed');
    expect(answers.some((text) => text.includes('Published to the channel — trailer.'))).toBe(true);
    expect(sends.filter((send) => send.chatId === DESTINATION)).toHaveLength(1);
  });

  it('an approval callback also routes through the action-aware dispatcher when the panel gate is on', async () => {
    await setPublishMode(executor, { mode: 'approval', actorId: OWNER_ID, nowMs: NOW });
    const { client, sends, answers } = createCapturingBotApi();
    const ingress = buildIngress(client, { panelEnabled: true });

    const previewOutcome = await ingress.processUpdate(
      ownerMessage(
        nextUpdateId(),
        5004,
        'New trailer for Elden Ring is out! https://example.com/trailer',
      ),
    );
    expect(previewOutcome).toBe('processed');
    const control = sends.find((send) => send.keyboardTokens.length === 2);
    const approveToken = control?.keyboardTokens[0]?.slice(2);
    expect(approveToken).toBeDefined();

    const callbackOutcome = await ingress.processUpdate(
      callbackUpdate(nextUpdateId(), approveToken ?? ''),
    );
    expect(callbackOutcome).toBe('processed');
    expect(answers.some((text) => text.includes('Published to the channel — trailer.'))).toBe(true);
    expect(sends.filter((send) => send.chatId === DESTINATION)).toHaveLength(1);
  });

  it('a redelivered update is a duplicate: the post is published exactly once', async () => {
    const { client, sends } = createCapturingBotApi();
    const ingress = buildIngress(client);
    const update = ownerMessage(
      nextUpdateId(),
      5003,
      'New trailer for Elden Ring is out! https://example.com/trailer',
    );

    expect(await ingress.processUpdate(update)).toBe('processed');
    expect(await ingress.processUpdate(update)).toBe('duplicate');
    expect(sends.filter((send) => send.chatId === DESTINATION)).toHaveLength(1);
  });
});
