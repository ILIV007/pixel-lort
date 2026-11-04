import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  createAdminPostService,
  type AdminPostTransport,
} from '../../src/application/admin-post/admin-post-service';
import type { Clock } from '../../src/shared/time/clock';

/**
 * OFFLINE DEMO (demo:admin-post) — R1.20-R admin post pipeline.
 *
 * One clear, human-readable walkthrough of the SUCCESS path plus ONE
 * explicit rejection and ONE uncertain outcome. No network, no cost, no
 * real Telegram/Cloudflare: the only mock is the synthetic transport
 * (the network boundary). Everything else is the real code over the real
 * workerd D1 binding.
 *
 * THIS DEMO IS OFFLINE-ONLY: a passing run is NOT a real channel
 * publication and NOT a production-readiness claim.
 */

const OWNER_ID = 1000000001;
const BOLD_PART = 'خبر داغ';
const LINK_PART = 'PIXEL';
const POST_TEXT = `🎮 ${BOLD_PART}: نسخهٔ جدید ${LINK_PART} منتشر شد!`;
const ENTITIES = [
  { type: 'bold', offset: POST_TEXT.indexOf(BOLD_PART), length: BOLD_PART.length },
  {
    type: 'text_link',
    offset: POST_TEXT.indexOf(LINK_PART),
    length: LINK_PART.length,
    url: 'https://example.com/patch-notes',
  },
];

function log(step: string, detail = ''): void {
  // eslint-disable-next-line no-console -- THE demo output (safe, bounded, fictional)
  console.log(`  [demo] ${step}${detail ? ` — ${detail}` : ''}`);
}

describe('demo: R1.20-R admin post pipeline (offline)', () => {
  let executor: DbExecutor;
  let nowMs: number;
  const clock: Clock = { now: () => nowMs };

  beforeEach(async () => {
    await applyMigrations(env.DB);
    executor = createDbExecutor(env.DB);
    for (const table of [
      'admin_post_publications',
      'admin_post_approvals',
      'admin_post_preview_sessions',
      'admin_post_versions',
      'admin_post_drafts',
      'admin_action_tokens',
      'admins',
    ]) {
      await executor.run({ sql: `DELETE FROM ${table}` });
    }
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, 'Demo Owner', 'owner', 'active', 1, 1)`,
      params: [OWNER_ID],
    });
    nowMs = 1_700_000_000_000;
  });

  it('walks the success path, one rejection, and one honest uncertain outcome', async () => {
    // eslint-disable-next-line no-console -- THE demo output (safe, bounded, fictional)
    console.log('\n=== R1.20-R admin post pipeline — OFFLINE demo ===');

    // ---- Setup: real service, synthetic transport (the network mock) -----
    const sentBodies: Array<{ chatId: number | string; text: string; entities: number }> = [];
    let failFirstSendWithTimeout = false;
    const transport: AdminPostTransport = {
      async sendMessageRich(input) {
        if (failFirstSendWithTimeout) {
          failFirstSendWithTimeout = false;
          throw Object.assign(new Error('Telegram API timeout'), {
            name: 'TelegramApiError',
            code: 'telegram_timeout',
            retryable: true,
          });
        }
        sentBodies.push({
          chatId: input.chatId,
          text: input.content.text,
          entities: input.content.entities.length,
        });
        return { messageId: 31337 };
      },
    };
    const service = createAdminPostService({
      executor,
      clock,
      logger: createLogger({ level: 'error', sink: () => {} }),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport,
    });
    log(
      'service wired',
      'ADMIN_POST gates parsed fail-closed; destination=@pixellores (operator config)',
    );

    // ---- Scenario 3 (rejection): a media post with caption ---------------
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 99000,
    });
    const mediaRejected = await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 9001,
      kind: 'message',
      hasText: true,
      text: '',
      richText: undefined,
      richCaptionPresent: true,
      hasMediaAttachment: true,
    });
    expect(mediaRejected.kind).toBe('reply');
    log(
      'REJECTION (media)',
      'a photo+caption post is explicitly rejected — a caption is never a complete post',
    );

    // ---- Scenario 1 (success path): persian rich post --------------------
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 99001,
    });
    const captured = await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 9002,
      kind: 'message',
      hasText: true,
      text: POST_TEXT,
      richText: { ok: true, kind: 'text', text: POST_TEXT, entities: ENTITIES },
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });
    expect(captured.kind).toBe('reply');
    log('CAPTURED v1', 'persian text stored byte-for-byte with bold + text_link entities');

    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 9003,
    });
    expect(preview.kind).toBe('preview');
    if (preview.kind !== 'preview') throw new Error('unreachable');
    expect(preview.content.text).toBe(POST_TEXT);
    log(
      'PREVIEW (faithful)',
      `re-read from D1: text matches EXACTLY (${preview.content.text.length} units), entities=${preview.content.entities.length}, control message separate`,
    );

    const approveToken = preview.buttons[0]?.[0]?.callbackData.slice(2) ?? '';
    const approved = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      token: approveToken,
    });
    expect(approved.kind).toBe('answer');
    log(
      'APPROVED',
      'bound SERVER-SIDE to the previewed version + fingerprint (token consumed once)',
    );

    const publishToken = preview.buttons[0]?.[1]?.callbackData.slice(2) ?? '';
    const published = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      token: publishToken,
    });
    expect(published.kind).toBe('answer');
    if (published.kind !== 'answer') throw new Error('unreachable');
    expect(published.callbackText).toContain('منتشر شد');
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]?.chatId).toBe('@pixellores');
    expect(sentBodies[0]?.text).toBe(POST_TEXT);
    log(
      'PUBLISHED (synthetic request)',
      `direct-entity body arrived at the real transport contract: destination=${String(sentBodies[0]?.chatId)}, exact text, entities=${String(sentBodies[0]?.entities)}, NO parse_mode`,
    );

    // ---- Scenario 6 (uncertain): timeout -> honest UNKNOWN, no auto-resend
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 99002,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 9004,
      kind: 'message',
      hasText: true,
      text: 'پست دوم برای نمایش نتیجهٔ نامشخص',
      richText: undefined,
      richCaptionPresent: false,
      hasMediaAttachment: false,
    });
    const preview2 = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      updateId: 9005,
    });
    if (preview2.kind !== 'preview') throw new Error('unreachable');
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      token: preview2.buttons[0]?.[0]?.callbackData.slice(2) ?? '',
    });
    failFirstSendWithTimeout = true;
    const uncertain = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
      token: preview2.buttons[0]?.[1]?.callbackData.slice(2) ?? '',
    });
    expect(uncertain.kind).toBe('answer');
    if (uncertain.kind !== 'answer') throw new Error('unreachable');
    expect(uncertain.callbackText).toContain('نامشخص');
    log(
      'UNCERTAIN OUTCOME',
      'timeout: the message MAY have arrived — recorded honestly, NEVER auto-resent',
    );

    nowMs += 10 * 60 * 1000;
    const status = await service.status({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'fa',
    });
    expect(status.kind).toBe('reply');
    if (status.kind !== 'reply') throw new Error('unreachable');
    expect(status.buttons).toBeDefined();
    log(
      'STATUS shows UNKNOWN + confirm button',
      'the ONLY re-send path is the human-confirmed supersede flow',
    );
    log('=== demo complete: 1 success path, 1 explicit rejection, 1 honest uncertain ===\n');
  });
});
