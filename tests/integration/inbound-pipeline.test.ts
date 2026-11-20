import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { findPublishedPostBySource, getInboundApproval } from '../../src/adapters/db/inbound-store';
import { readTodayCounts, setPublishMode } from '../../src/adapters/db/publishing-settings-store';
import type { PublishMode } from '../../src/domain/publishing/publishing-settings';
import {
  createInboundPipelineService,
  type InboundPipelineService,
  type InboundProcessInput,
  type InboundTransport,
} from '../../src/application/inbound/inbound-pipeline-service';
import type {
  InboundRewriter,
  InboundRewriteOutcome,
} from '../../src/application/inbound/ai-rewriter';
import type { AdminPostExecutionResult } from '../../src/application/admin-post/admin-post-service';
import type { Clock } from '../../src/shared/time/clock';

/**
 * Slice 4 — the inbound AI-admin pipeline end to end over the real workerd
 * D1 binding: owner post in the PV -> clean -> classify -> rewrite-or-
 * fallback -> preservation -> format -> rich decision -> route per mode
 * -> publish + PV copy + published_posts row; approval previews with
 * 24h expiry; in-place edits; dedupe; owner stats (cap-exempt, visible).
 *
 * The Telegram transport is faked (no network, no real Bot API); every
 * other layer — D1, migrations, stores, domain modules — is real.
 */

const db: D1Database = env.DB;

const OWNER_ID = 1000000001;
const PV_CHAT_ID = 111111;
const DESTINATION = '@pixellores';
const NOW = 1_790_000_000_000;

let executor: DbExecutor;
let messageSeq = 0;
let updateSeq = 0;

function nextMessageId(): number {
  messageSeq += 1;
  return 100 + messageSeq;
}

function nextUpdateId(): number {
  updateSeq += 1;
  return 90000 + updateSeq;
}

function createMutableClock(startMs: number): Clock & { readonly advance: (ms: number) => void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

type FakeTransportBehavior = 'ok' | 'rich_forbidden' | 'rich_timeout';

interface TransportCall {
  readonly method: string;
  readonly chatId: number | string;
  readonly text?: string;
  readonly messageId?: number;
}

function telegramApiError(code: string, retryable: boolean): Error {
  return Object.assign(new Error(`Telegram API ${code}`), {
    name: 'TelegramApiError',
    code,
    retryable,
  });
}

function createFakeTransport(behavior: FakeTransportBehavior = 'ok'): {
  readonly transport: InboundTransport;
  readonly calls: TransportCall[];
  setBehavior(next: FakeTransportBehavior): void;
} {
  const calls: TransportCall[] = [];
  let current: FakeTransportBehavior = behavior;
  let nextId = 5000;
  const transport: InboundTransport = {
    async sendMessageRich(input) {
      if (current === 'rich_forbidden') {
        throw telegramApiError('telegram_forbidden', false);
      }
      if (current === 'rich_timeout') {
        throw telegramApiError('telegram_timeout', true);
      }
      nextId += 1;
      calls.push({
        method: 'sendMessageRich',
        chatId: input.chatId,
        text: input.content.text,
        messageId: nextId,
      });
      return { messageId: nextId };
    },
    async sendPhotoRich(input) {
      nextId += 1;
      calls.push({
        method: 'sendPhotoRich',
        chatId: input.chatId,
        text: input.caption?.text,
        messageId: nextId,
      });
      return { messageId: nextId };
    },
    async sendVideoRich(input) {
      nextId += 1;
      calls.push({
        method: 'sendVideoRich',
        chatId: input.chatId,
        text: input.caption?.text,
        messageId: nextId,
      });
      return { messageId: nextId };
    },
    async sendMessageClassic(input) {
      nextId += 1;
      calls.push({
        method: 'sendMessageClassic',
        chatId: input.chatId,
        text: input.html,
        messageId: nextId,
      });
      return { messageId: nextId };
    },
    async editMessageTextRich(input) {
      if (current === 'rich_forbidden') {
        throw telegramApiError('telegram_forbidden', false);
      }
      if (current === 'rich_timeout') {
        throw telegramApiError('telegram_timeout', true);
      }
      calls.push({
        method: 'editMessageTextRich',
        chatId: input.chatId,
        text: input.content.text,
        messageId: input.messageId,
      });
      return true;
    },
    async editMessageCaptionRich(input) {
      calls.push({
        method: 'editMessageCaptionRich',
        chatId: input.chatId,
        text: input.content.text,
        messageId: input.messageId,
      });
      return true;
    },
    async editMessageTextClassic(input) {
      calls.push({
        method: 'editMessageTextClassic',
        chatId: input.chatId,
        text: input.html,
        messageId: input.messageId,
      });
      return true;
    },
    async deleteMessage(input) {
      calls.push({ method: 'deleteMessage', chatId: input.chatId, messageId: input.messageId });
      return true;
    },
  };
  return {
    calls,
    transport,
    setBehavior(next: FakeTransportBehavior) {
      current = next;
    },
  };
}

function createFakeRewriter(outcomes: readonly InboundRewriteOutcome[] = []): {
  readonly rewriter: InboundRewriter;
  readonly calls: number;
} {
  const queue = [...outcomes];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    rewriter: {
      async rewrite() {
        calls += 1;
        const next = queue.shift();
        if (next === undefined) {
          return { kind: 'deferred', reason: 'ai_disabled', attempts: 0 } as InboundRewriteOutcome;
        }
        return next;
      },
    },
  };
}

function buildService(options: {
  live?: boolean;
  transport?: InboundTransport;
  rewriter?: InboundRewriter;
  clock?: Clock;
}): {
  readonly service: InboundPipelineService;
  readonly clock: Clock & { advance: (ms: number) => void };
} {
  const clock =
    (options.clock as Clock & { advance: (ms: number) => void }) ?? createMutableClock(NOW);
  const service = createInboundPipelineService({
    executor,
    clock,
    logger: silentLogger(),
    config: { livePublishEnabled: options.live ?? true, destination: DESTINATION },
    transport: options.transport,
    rewriter: options.rewriter,
  });
  return { service, clock };
}

function inboundInput(
  overrides: Partial<InboundProcessInput> & { text: string },
): InboundProcessInput {
  return {
    chatId: PV_CHAT_ID,
    telegramUserId: OWNER_ID,
    role: 'owner',
    uiLanguage: 'en',
    updateId: nextUpdateId(),
    sourceMessageId: nextMessageId(),
    kind: 'message',
    hasText: true,
    richText: undefined,
    media: undefined,
    richCaption: undefined,
    inMediaGroup: false,
    hasMediaAttachment: false,
    ...overrides,
  };
}

function replyText(result: AdminPostExecutionResult): string {
  if (result.kind !== 'reply') {
    throw new Error(`expected a reply, got ${result.kind}`);
  }
  return result.text;
}

function previewButtons(
  result: AdminPostExecutionResult,
): readonly (readonly { readonly callbackData: string }[])[] {
  if (result.kind !== 'preview') {
    throw new Error(`expected a preview, got ${result.kind}`);
  }
  return result.buttons;
}

function buttonToken(result: AdminPostExecutionResult, index: number): string {
  const buttons = previewButtons(result);
  const button = buttons[0]?.[index];
  if (button === undefined) {
    throw new Error('expected button missing');
  }
  expect(button.callbackData.startsWith('a:')).toBe(true);
  return button.callbackData.slice(2);
}

async function setMode(mode: PublishMode): Promise<void> {
  await setPublishMode(executor, { mode, actorId: OWNER_ID, nowMs: NOW });
}

beforeEach(async () => {
  executor = createDbExecutor(db);
  await applyMigrations(db);
  // The owner must exist in `admins`: action tokens reference it
  // (telegram_user_id FK), and settings writes reference it too.
  // INSERT OR IGNORE — the row persists across tests in this file.
  await executor.run({
    sql: `INSERT OR IGNORE INTO admins
            (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', ?, ?)`,
    params: [OWNER_ID, `admin-${OWNER_ID}`, NOW, NOW],
  });
  // The publish mode persists in D1 across tests in this file: reset to
  // the default ('auto', direct) so each test starts from the same mode.
  await setPublishMode(executor, { mode: 'auto', actorId: OWNER_ID, nowMs: NOW });
});

describe('slice 4 — inbound pipeline (real D1, fake transport)', () => {
  it('publishes a trailer post directly in auto mode and records the owner bucket, never the cap', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const input = inboundInput({
      text: 'New trailer for Elden Ring is out! https://example.com/trailer',
    });
    const result = await service.processInbound(input);

    expect(replyText(result)).toContain('Published to the channel — trailer.');
    const channelSends = fake.calls.filter((call) => call.chatId === DESTINATION);
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.method).toBe('sendMessageClassic');
    expect(channelSends[0]?.text).toContain('https://example.com/trailer');
    // A PV copy of the same content goes to the owner's private chat.
    expect(fake.calls.filter((call) => call.chatId === PV_CHAT_ID)).toHaveLength(1);

    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId: input.sourceMessageId ?? 0,
    });
    expect(row).not.toBeNull();
    expect(row?.category).toBe('trailer');
    expect(row?.channelMessageIds).toHaveLength(1);

    const counts = await readTodayCounts(executor, { nowMs: NOW });
    expect(counts.owner).toBe(1);
    expect(counts.counted).toBe(0);
    expect(counts.published).toBe(1);
  });

  it('routes signal-only categories to approval in safe-auto, and direct posts stay direct', async () => {
    await setMode('safe-auto');
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });

    const leak = await service.processInbound(
      inboundInput({ text: 'LEAK: new Elden Ring DLC details leaked https://example.com/leak' }),
    );
    expect(leak.kind).toBe('preview');
    expect(fake.calls).toHaveLength(0);

    const trailer = await service.processInbound(
      inboundInput({ text: 'New trailer for Elden Ring is out! https://example.com/trailer' }),
    );
    expect(replyText(trailer)).toContain('Published to the channel — trailer.');
    expect(fake.calls.filter((call) => call.chatId === DESTINATION)).toHaveLength(1);
  });

  it('approval mode: preview, approve publishes, the token is single-use, reject rejects', async () => {
    await setMode('approval');
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });

    const preview = await service.processInbound(
      inboundInput({ text: 'Patch 1.4.2 is live for Elden Ring https://example.com/patch' }),
    );
    expect(preview.kind).toBe('preview');
    if (preview.kind === 'preview') {
      // Classic presentation (no source entities) carries the classic HTML
      // so the preview shows the exact form that will be published.
      expect(preview.classicText).toBeDefined();
      expect(preview.content.media).toBe('none');
    }
    const approveToken = buttonToken(preview, 0);
    const rejectToken = buttonToken(preview, 1);

    const approved = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(approved.kind).toBe('answer');
    if (approved.kind === 'answer') {
      expect(approved.callbackText).toContain('Published to the channel — patch.');
    }
    expect(fake.calls.filter((call) => call.chatId === DESTINATION)).toHaveLength(1);

    // The approve token is consumed: a second click is honestly invalid.
    const reused = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(reused.kind).toBe('answer');
    if (reused.kind === 'answer') {
      expect(reused.callbackText).toContain('already used');
    }

    // A second preview's reject token rejects without publishing.
    const preview2 = await service.processInbound(
      inboundInput({ text: 'Patch 1.4.3 is live for Elden Ring https://example.com/patch2' }),
    );
    const rejectToken2 = buttonToken(preview2, 1);
    const rejected = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: rejectToken2,
    });
    expect(rejected.kind).toBe('answer');
    if (rejected.kind === 'answer') {
      expect(rejected.callbackText).toContain('Rejected');
    }
    expect(fake.calls.filter((call) => call.chatId === DESTINATION)).toHaveLength(1);
    expect(rejectToken).not.toBe(approveToken);
  });

  it('approval mode: an expired preview answers expired and publishes nothing', async () => {
    await setMode('approval');
    const fake = createFakeTransport();
    const clock = createMutableClock(NOW);
    const { service } = buildService({ transport: fake.transport, clock });

    const preview = await service.processInbound(
      inboundInput({ text: 'New trailer for Elden Ring is out! https://example.com/trailer' }),
    );
    const approveToken = buttonToken(preview, 0);

    clock.advance(25 * 3_600_000);
    const answered = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(answered.kind).toBe('answer');
    if (answered.kind === 'answer') {
      expect(answered.callbackText).toContain('expired');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('paused mode: the post is rejected with «bot is off» and nothing is saved or queued', async () => {
    await setMode('paused');
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const input = inboundInput({
      text: 'New trailer for Elden Ring is out! https://example.com/trailer',
    });

    const result = await service.processInbound(input);
    expect(replyText(result)).toContain('bot is off');
    expect(fake.calls).toHaveLength(0);
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId: input.sourceMessageId ?? 0,
    });
    expect(row).toBeNull();
  });

  it('a refused rewrite falls back to the cleaned text, never fabricating', async () => {
    const fake = createFakeTransport();
    const rewriter = createFakeRewriter([
      { kind: 'refused', reason: 'provider_safety_refusal', attempts: 1 },
    ]);
    const { service } = buildService({ transport: fake.transport, rewriter: rewriter.rewriter });

    const result = await service.processInbound(
      inboundInput({ text: 'New trailer for Elden Ring is out! https://example.com/trailer' }),
    );
    expect(replyText(result)).toContain('Published to the channel');
    expect(rewriter.calls).toBe(1);
    const sent = fake.calls.find((call) => call.chatId === DESTINATION);
    expect(sent?.text).toContain('New trailer for Elden Ring is out!');
  });

  it('a rewrite that drops a URL falls back to the cleaned text (preservation)', async () => {
    const fake = createFakeTransport();
    const rewriter = createFakeRewriter([
      { kind: 'ok', text: 'تریلر جدید الدن رینگ منتشر شد.', attempts: 1 },
    ]);
    const { service } = buildService({ transport: fake.transport, rewriter: rewriter.rewriter });

    const result = await service.processInbound(
      inboundInput({ text: 'New trailer for Elden Ring is out! https://example.com/trailer' }),
    );
    expect(replyText(result)).toContain('Published to the channel');
    const sent = fake.calls.find((call) => call.chatId === DESTINATION);
    expect(sent?.text).toContain('https://example.com/trailer');
  });

  it('a rich source publishes rich, and a definitive rich failure falls back to classic', async () => {
    const fake = createFakeTransport('rich_forbidden');
    const { service } = buildService({ transport: fake.transport });
    const richText = {
      ok: true as const,
      kind: 'text' as const,
      text: 'New trailer for Elden Ring is out! https://example.com/trailer',
      entities: [{ type: 'bold', offset: 0, length: 11 }],
    };
    const result = await service.processInbound(inboundInput({ text: richText.text, richText }));

    expect(replyText(result)).toContain('Published to the channel — trailer.');
    // The rich send failed definitively (proved non-delivery), so the same
    // part went out as classic HTML instead — exactly one channel message.
    const channelSends = fake.calls.filter((call) => call.chatId === DESTINATION);
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.method).toBe('sendMessageClassic');
    expect(channelSends[0]?.text).toContain('https://example.com/trailer');
  });

  it('an uncertain rich failure is never retried as classic', async () => {
    const fake = createFakeTransport('rich_timeout');
    const { service } = buildService({ transport: fake.transport });
    const richText = {
      ok: true as const,
      kind: 'text' as const,
      text: 'New trailer for Elden Ring is out! https://example.com/trailer',
      entities: [{ type: 'bold', offset: 0, length: 11 }],
    };
    const input = inboundInput({ text: richText.text, richText });
    const result = await service.processInbound(input);

    expect(replyText(result)).toContain('OUTCOME UNKNOWN');
    // No classic retry (the rich send may have succeeded), no published row.
    expect(fake.calls.filter((call) => call.chatId === DESTINATION)).toHaveLength(0);
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId: input.sourceMessageId ?? 0,
    });
    expect(row).toBeNull();
  });

  it('publishes a photo with its caption and edits the caption in place', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const sourceMessageId = nextMessageId();
    const caption = 'Patch 1.4.2 is live for Elden Ring https://example.com/patch';

    const published = await service.processInbound(
      inboundInput({
        text: caption,
        sourceMessageId,
        hasText: false,
        media: { kind: 'photo', fileId: 'photo-file-1' },
        hasMediaAttachment: true,
      }),
    );
    expect(replyText(published)).toContain('Published to the channel — patch.');
    const photoSend = fake.calls.find((call) => call.method === 'sendPhotoRich');
    expect(photoSend?.chatId).toBe(DESTINATION);
    const channelMessageId = photoSend?.messageId;
    expect(channelMessageId).toBeDefined();

    const edited = await service.processInbound(
      inboundInput({
        kind: 'edited_message',
        text: 'Patch 1.4.2 is live for Elden Ring — servers are back https://example.com/patch',
        sourceMessageId,
        hasText: false,
        media: { kind: 'photo', fileId: 'photo-file-1' },
        hasMediaAttachment: true,
      }),
    );
    expect(replyText(edited)).toContain('updated in place');
    const captionEdit = fake.calls.find((call) => call.method === 'editMessageCaptionRich');
    expect(captionEdit?.messageId).toBe(channelMessageId);
    expect(captionEdit?.chatId).toBe(DESTINATION);
    // No new published row: the same source message still maps to one row.
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId,
    });
    expect(row?.channelMessageIds).toEqual([channelMessageId]);
  });

  it('edits a text post in place when the part count fits, and re-sends when it does not', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const sourceMessageId = nextMessageId();

    const published = await service.processInbound(
      inboundInput({
        text: 'New trailer for Elden Ring is out! https://example.com/trailer',
        sourceMessageId,
      }),
    );
    expect(replyText(published)).toContain('Published to the channel');
    const firstSend = fake.calls.find((call) => call.chatId === DESTINATION);
    const channelMessageId = firstSend?.messageId;

    // Same shape: the channel message is edited in place.
    const edited = await service.processInbound(
      inboundInput({
        kind: 'edited_message',
        text: 'New trailer for Elden Ring is out now! https://example.com/trailer',
        sourceMessageId,
      }),
    );
    expect(replyText(edited)).toContain('updated in place');
    const textEdit = fake.calls.find((call) => call.method === 'editMessageTextClassic');
    expect(textEdit?.messageId).toBe(channelMessageId);

    // Longer shape: two parts now — the old message is deleted and the
    // new parts are re-sent, and the row points at the new ids.
    const longText = `New trailer for Elden Ring is out! https://example.com/trailer ${'game '.repeat(900)}`;
    const editedLong = await service.processInbound(
      inboundInput({ kind: 'edited_message', text: longText, sourceMessageId }),
    );
    expect(replyText(editedLong)).toContain('updated in place');
    expect(
      fake.calls.some(
        (call) => call.method === 'deleteMessage' && call.messageId === channelMessageId,
      ),
    ).toBe(true);
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId,
    });
    expect(row?.channelMessageIds).toHaveLength(2);
    expect(row?.channelMessageIds).not.toContain(channelMessageId);
  });

  it('an edit of a never-published message stays silent', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const result = await service.processInbound(
      inboundInput({
        kind: 'edited_message',
        text: 'New trailer for Elden Ring is out! https://example.com/trailer',
      }),
    );
    expect(result.kind).toBe('none');
    expect(fake.calls).toHaveLength(0);
  });

  it('edits override paused mode', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const sourceMessageId = nextMessageId();
    await service.processInbound(
      inboundInput({
        text: 'New trailer for Elden Ring is out! https://example.com/trailer',
        sourceMessageId,
      }),
    );
    await setMode('paused');
    const edited = await service.processInbound(
      inboundInput({
        kind: 'edited_message',
        text: 'New trailer for Elden Ring is out now! https://example.com/trailer',
        sourceMessageId,
      }),
    );
    expect(replyText(edited)).toContain('updated in place');
    expect(fake.calls.some((call) => call.method === 'editMessageTextClassic')).toBe(true);
  });

  it('dedupe: the same source message creates one pending approval, the second send is told so', async () => {
    await setMode('approval');
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const sourceMessageId = nextMessageId();

    const first = await service.processInbound(
      inboundInput({
        text: 'LEAK: new Elden Ring DLC details leaked https://example.com/leak',
        sourceMessageId,
      }),
    );
    expect(first.kind).toBe('preview');
    const second = await service.processInbound(
      inboundInput({
        text: 'LEAK: new Elden Ring DLC details leaked https://example.com/leak',
        sourceMessageId,
      }),
    );
    expect(replyText(second)).toContain('already has a pending approval preview');
    expect(fake.calls).toHaveLength(0);
  });

  it('live flag off: direct publish is refused honestly and nothing is sent or recorded', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport, live: false });
    const input = inboundInput({
      text: 'New trailer for Elden Ring is out! https://example.com/trailer',
    });

    const result = await service.processInbound(input);
    expect(replyText(result)).toContain('Publishing is DISABLED');
    expect(fake.calls).toHaveLength(0);
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId: input.sourceMessageId ?? 0,
    });
    expect(row).toBeNull();
  });

  it('live flag off at approve time: the preview approves nothing and the approval stays pending', async () => {
    await setMode('approval');
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const input = inboundInput({
      text: 'New trailer for Elden Ring is out! https://example.com/trailer',
    });
    const preview = await service.processInbound(input);
    const approveToken = buttonToken(preview, 0);
    const approvalId = await pendingApprovalId(input.sourceMessageId ?? 0);

    const offline = buildService({ transport: fake.transport, live: false }).service;
    const answered = await offline.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(answered.kind).toBe('answer');
    if (answered.kind === 'answer') {
      expect(answered.callbackText).toContain('Publishing is DISABLED');
    }
    expect(fake.calls).toHaveLength(0);
    const approval = await getInboundApproval(executor, approvalId);
    expect(approval?.state).toBe('pending');
  });

  it('documents and albums are rejected explicitly, never silently dropped', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });

    const document = await service.processInbound(
      inboundInput({
        text: '',
        hasText: false,
        media: { kind: 'unsupported' },
        hasMediaAttachment: true,
      }),
    );
    expect(replyText(document)).toContain('not supported');

    const album = await service.processInbound(
      inboundInput({
        text: 'New trailer for Elden Ring is out! https://example.com/trailer',
        media: { kind: 'photo', fileId: 'photo-file-1' },
        inMediaGroup: true,
        hasMediaAttachment: true,
      }),
    );
    expect(replyText(album)).toContain('album');
    expect(fake.calls).toHaveLength(0);
  });

  it('a magnet link is never published', async () => {
    const fake = createFakeTransport();
    const { service } = buildService({ transport: fake.transport });
    const result = await service.processInbound(
      inboundInput({
        text: 'Elden Ring crack is out magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      }),
    );
    expect(replyText(result)).toContain('never be published');
    expect(fake.calls).toHaveLength(0);
  });
});

async function pendingApprovalId(sourceMessageId: number): Promise<string> {
  const row = await executor.first<{ id: string }>({
    sql: `SELECT id FROM inbound_approvals
           WHERE source_chat_id = ? AND source_message_id = ? AND state = 'pending'`,
    params: [PV_CHAT_ID, sourceMessageId],
  });
  if (row === null) {
    throw new Error('no pending approval found');
  }
  return row.id;
}
