import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  createAdminPostService,
  type AdminPostTransport,
} from '../../src/application/admin-post/admin-post-service';
import { findPrimaryPublication, getApproval } from '../../src/adapters/db/admin-post-store';
import { readRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';
import type { Clock } from '../../src/shared/time/clock';

/**
 * R1.20-R — the REAL admin post pipeline end to end over the real workerd
 * D1 binding: capture (persian rich text preserved byte-for-byte) -> durable
 * versioned storage -> re-read from the STORED document -> faithful preview
 * -> version-bound approval -> synthetic publish request through the
 * direct-entity transport (network mocked; everything else real).
 */

const OWNER_ID = 1000000001;

const BOLD_PART = 'خبر جدید';
const LINK_PART = 'PIXEL';
const MENTION_PART = '@pixellores';
const POST_TEXT = `🎉 ${BOLD_PART}: بازی ${LINK_PART} از ${MENTION_PART} منتشر شد!`;

const POST_ENTITIES = [
  { type: 'bold', offset: POST_TEXT.indexOf(BOLD_PART), length: BOLD_PART.length },
  {
    type: 'text_link',
    offset: POST_TEXT.indexOf(LINK_PART),
    length: LINK_PART.length,
    url: 'https://example.com/pixel',
  },
  { type: 'mention', offset: POST_TEXT.indexOf(MENTION_PART), length: MENTION_PART.length },
];

interface TransportCall {
  readonly chatId: number | string;
  readonly text: string;
  readonly entities: readonly unknown[];
}

function createFakeTransport(behavior: 'ok' | 'timeout' | 'forbidden' = 'ok'): {
  readonly transport: AdminPostTransport;
  readonly calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  return {
    calls,
    transport: {
      async sendMessageRich(input) {
        calls.push({
          chatId: input.chatId,
          text: input.content.text,
          entities: input.content.entities,
        });
        if (behavior === 'timeout') {
          throw Object.assign(new Error('Telegram API timeout'), {
            name: 'TelegramApiError',
            code: 'telegram_timeout',
            retryable: true,
          });
        }
        if (behavior === 'forbidden') {
          throw Object.assign(new Error('Telegram API forbidden for this target'), {
            name: 'TelegramApiError',
            code: 'telegram_forbidden',
            retryable: false,
          });
        }
        return { messageId: 4242 };
      },
    },
  };
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

function buttonToken(
  buttons: ReadonlyArray<ReadonlyArray<{ readonly callbackData: string }>>,
  index: number,
): string {
  const row = buttons[0];
  const button = row?.[index];
  if (button === undefined) {
    throw new Error('expected button missing');
  }
  expect(button.callbackData.startsWith('a:')).toBe(true);
  return button.callbackData.slice(2);
}

describe('R1.20-R admin post pipeline — real path over real D1', () => {
  let executor: DbExecutor;
  let clock: ReturnType<typeof createMutableClock>;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    executor = createDbExecutor(env.DB);
    await executor.run({ sql: 'DELETE FROM admin_post_publications' });
    await executor.run({ sql: 'DELETE FROM admin_post_approvals' });
    await executor.run({ sql: 'DELETE FROM admin_post_preview_sessions' });
    await executor.run({ sql: 'DELETE FROM admin_post_versions' });
    await executor.run({ sql: 'DELETE FROM admin_post_drafts' });
    await executor.run({ sql: 'DELETE FROM settings' });
    await executor.run({ sql: 'DELETE FROM admin_action_tokens' });
    await executor.run({ sql: 'DELETE FROM telegram_updates' });
    await executor.run({ sql: 'DELETE FROM admins' });
    // The action-token table carries a FOREIGN KEY to admins — seed the actor.
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, 'Pipeline Owner', 'owner', 'active', 1, 1)`,
      params: [OWNER_ID],
    });
    clock = createMutableClock(1_700_000_000_000);
  });

  it('captures a persian rich post, stores it versioned, and re-reads it faithfully', async () => {
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: false, destination: '@pixellores' },
    });

    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 99000,
    });
    const captured = await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9100,
      kind: 'message',
      hasText: true,
      text: POST_TEXT,
      richText: { ok: true, kind: 'text', text: POST_TEXT, entities: POST_ENTITIES },
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });
    expect(captured.kind).toBe('reply');
    if (captured.kind !== 'reply') throw new Error('unreachable');
    expect(captured.text).toContain('version 1');

    // Durable versioned storage: the STORED document re-reads to EXACTLY
    // the original text (byte-for-byte) and the original entities.
    const drafts = await executor.query<{ id: string; current_version: number }>({
      sql: 'SELECT id, current_version FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    expect(drafts.rows).toHaveLength(1);
    expect(drafts.rows[0]?.current_version).toBe(1);
    const draftId = drafts.rows[0]?.id ?? '';

    const versionRow = await executor.first<{ envelope_json: string; fingerprint: string }>({
      sql: 'SELECT envelope_json, fingerprint FROM admin_post_versions WHERE draft_id = ? AND version = 1',
      params: [draftId],
    });
    expect(versionRow).not.toBeNull();
    const read = readRichTextEnvelope(versionRow?.envelope_json ?? '');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.envelope.text).toBe(POST_TEXT);
      expect(read.envelope.kind).toBe('text');
      expect(read.envelope.entities).toHaveLength(3);
      expect(read.envelope.entities[0]?.type).toBe('bold');
      expect(read.envelope.entities[1]?.type).toBe('text_link');
      expect(read.envelope.entities[1]?.url).toBe('https://example.com/pixel');
      expect(read.envelope.entities[2]?.type).toBe('mention');
    }
  });

  it('previews from the STORED document with separated control, then approves the EXACT previewed version', async () => {
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
    });
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 99001,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9101,
      kind: 'message',
      hasText: true,
      text: POST_TEXT,
      richText: { ok: true, kind: 'text', text: POST_TEXT, entities: POST_ENTITIES },
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });

    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9102,
    });
    expect(preview.kind).toBe('preview');
    if (preview.kind !== 'preview') throw new Error('unreachable');
    // The preview content is the EXACT stored text + validated entities.
    expect(preview.content.text).toBe(POST_TEXT);
    expect(preview.content.entities).toHaveLength(3);
    // Owner holds both permissions -> both buttons.
    expect(preview.buttons[0]).toHaveLength(2);

    const approveToken = buttonToken(preview.buttons, 0);
    const approved = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(approved.kind).toBe('answer');
    if (approved.kind !== 'answer') throw new Error('unreachable');
    expect(approved.callbackText).toContain('APPROVED');

    const drafts = await executor.query<{ id: string }>({
      sql: 'SELECT id FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    const draftId = drafts.rows[0]?.id ?? '';
    const approval = await getApproval(executor, draftId, 1);
    expect(approval?.state).toBe('active');
    expect(approval?.approved_by_user_id).toBe(OWNER_ID);
    // The approval pins the stored fingerprint — the previewed content.
    const versionRow = await executor.first<{ fingerprint: string }>({
      sql: 'SELECT fingerprint FROM admin_post_versions WHERE draft_id = ? AND version = 1',
      params: [draftId],
    });
    expect(approval?.fingerprint).toBe(versionRow?.fingerprint);
  });

  it('publishes the approved version through the direct-entity transport with the configured destination — no parse_mode', async () => {
    const fake = createFakeTransport('ok');
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport: fake.transport,
    });
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 99002,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9110,
      kind: 'message',
      hasText: true,
      text: POST_TEXT,
      richText: { ok: true, kind: 'text', text: POST_TEXT, entities: POST_ENTITIES },
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9111,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    const approveToken = buttonToken(preview.buttons, 0);
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });

    const publishToken = buttonToken(preview.buttons, 1);
    const published = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: publishToken,
    });
    expect(published.kind).toBe('answer');
    if (published.kind !== 'answer') throw new Error('unreachable');
    expect(published.callbackText).toContain('PUBLISHED');

    // The synthetic transport request: EXACT version content + legitimate
    // operator-configured destination. (parse_mode does not exist on the
    // rich transport by construction — the client never sets it.)
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.chatId).toBe('@pixellores');
    expect(fake.calls[0]?.text).toBe(POST_TEXT);
    expect(fake.calls[0]?.entities).toHaveLength(3);

    const drafts = await executor.query<{ id: string }>({
      sql: 'SELECT id FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    const draftId = drafts.rows[0]?.id ?? '';
    const publication = await findPrimaryPublication(executor, draftId, 1);
    expect(publication?.state).toBe('sent');
    expect(publication?.bot_message_id).toBe(4242);
    expect(publication?.destination).toBe('@pixellores');
    const approval = await getApproval(executor, draftId, 1);
    expect(approval?.state).toBe('consumed');
  });

  it('never auto-resends an uncertain publish; the explicit confirm path is the only re-send', async () => {
    const fake = createFakeTransport('timeout');
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport: fake.transport,
    });
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 99003,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9120,
      kind: 'message',
      hasText: true,
      text: POST_TEXT,
      richText: { ok: true, kind: 'text', text: POST_TEXT, entities: POST_ENTITIES },
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9121,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: buttonToken(preview.buttons, 0),
    });
    const firstPublish = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: buttonToken(preview.buttons, 1),
    });
    expect(firstPublish.kind).toBe('answer');
    if (firstPublish.kind !== 'answer') throw new Error('unreachable');
    expect(firstPublish.callbackText).toContain('UNKNOWN');
    expect(fake.calls).toHaveLength(1);

    // Time passes; nothing is resent — no background path exists.
    clock.advance(10 * 60 * 1000);
    const status = await service.status({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(status.kind).toBe('reply');
    if (status.kind !== 'reply') throw new Error('unreachable');
    expect(status.text).toContain('UNKNOWN');
    expect(status.buttons).toBeDefined();
    expect(fake.calls).toHaveLength(1);

    // The ONLY re-send path: the human-confirmed supersede flow.
    const confirmToken = buttonToken(status.buttons ?? [], 0);
    const confirm = createFakeTransport('ok');
    const confirmService = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport: confirm.transport,
    });
    const republished = await confirmService.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: confirmToken,
    });
    expect(republished.kind).toBe('answer');
    if (republished.kind !== 'answer') throw new Error('unreachable');
    expect(republished.callbackText).toContain('PUBLISHED');
    expect(confirm.calls).toHaveLength(1);
    expect(confirm.calls[0]?.text).toBe(POST_TEXT);

    const drafts = await executor.query<{ id: string }>({
      sql: 'SELECT id FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    const draftId = drafts.rows[0]?.id ?? '';
    const publications = await executor.query<{
      state: string;
      attempt: number;
      supersede_of: string | null;
    }>({
      sql: 'SELECT state, attempt, supersede_of FROM admin_post_publications WHERE draft_id = ? ORDER BY attempt',
      params: [draftId],
    });
    expect(publications.rows).toHaveLength(2);
    expect(publications.rows[0]?.state).toBe('superseded');
    expect(publications.rows[0]?.attempt).toBe(1);
    expect(publications.rows[1]?.state).toBe('sent');
    expect(publications.rows[1]?.attempt).toBe(2);
    expect(publications.rows[1]?.supersede_of).not.toBeNull();
  });

  it('records a definitive failure separately and never retries it automatically', async () => {
    const fake = createFakeTransport('forbidden');
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport: fake.transport,
    });
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 99004,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9130,
      kind: 'message',
      hasText: true,
      text: 'متن ساده بدون قالب‌بندی',
      richText: undefined,
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9131,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: buttonToken(preview.buttons, 0),
    });
    const publish = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: buttonToken(preview.buttons, 1),
    });
    expect(publish.kind).toBe('answer');
    if (publish.kind !== 'answer') throw new Error('unreachable');
    expect(publish.callbackText).toContain('FAILED definitively');

    clock.advance(60 * 60 * 1000);
    expect(fake.calls).toHaveLength(1);
    const drafts = await executor.query<{ id: string }>({
      sql: 'SELECT id FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    const publication = await findPrimaryPublication(executor, drafts.rows[0]?.id ?? '', 1);
    expect(publication?.state).toBe('failed_definitive');
    expect(publication?.error_code).toBe('telegram_forbidden');
  });
});
