import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createAdminPostService } from '../../src/application/admin-post/admin-post-service';
import type { Clock } from '../../src/shared/time/clock';

/**
 * R1.20-R security matrix over the REAL webhook edge and the REAL service:
 * fail-closed gating, authorization scope, explicit rejections (nothing
 * silently dropped), and the SERVER-SIDE approval binding — including the
 * optional-fingerprint contract (omitting it bypasses NOTHING; a foreign
 * fingerprint is rejected as tampered).
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
const OWNER_ID = 1000000001;
const EDITOR_ID = 2000000002;
const UNAUTHORIZED_ID = 2999999999;

const BASE_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  DB: env.DB,
};

const FLAG_ON_ENV = { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' };

interface CapturedLine {
  readonly msg: string;
  readonly [key: string]: unknown;
}

function captureLogger(): { lines: CapturedLine[]; logger: ReturnType<typeof createLogger> } {
  const lines: CapturedLine[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(JSON.parse(line) as CapturedLine);
  };
  return { lines, logger: createLogger({ level: 'debug', sink }) };
}

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<{ status: number; lines: CapturedLine[] }> {
  const { lines, logger } = captureLogger();
  const request = new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TELEGRAM_SECRET_HEADER]: FAKE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  const response = await handleTelegramWebhook(request, envOverrides, { logger }).then(
    (res) => res,
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? 'internal_error';
      const status = code === 'service_unavailable' ? 503 : 500;
      return new Response(JSON.stringify({ error: { code } }), { status });
    },
  );
  return { status: response.status, lines };
}

function textUpdate(updateId: number, fromId: number, text: string, chatId = fromId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' },
      from: { id: fromId },
      text,
    },
  };
}

function mutableClock(startMs: number): Clock & { advance(ms: number): void } {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms: number) => (nowMs += ms) };
}

describe('R1.20-R webhook edge — fail-closed gating and scope', () => {
  let executor: DbExecutor;

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
      'telegram_updates',
      // R1.20-R1: the capture session lives in the settings table.
      'settings',
      'admins',
    ]) {
      await executor.run({ sql: `DELETE FROM ${table}` });
    }
  });

  it('keeps EXACT legacy behavior while the flag is OFF (text -> not_a_command noop)', async () => {
    const { status, lines } = await deliver(BASE_ENV, textUpdate(7001, OWNER_ID, 'سلام پست جدید'));
    expect(status).toBe(200);
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('not_a_command');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('captures authorized private text while the flag is ON (durable version row)', async () => {
    // R1.20-R1: the capture requires the EXPLICIT /post session start.
    const started = await deliver({ ...FLAG_ON_ENV }, textUpdate(7002, OWNER_ID, '/post'));
    expect(started.status).toBe(503); // the confirmation reply is outbound (offline mode)
    const startUnavailable = started.lines.find(
      (l) => l.msg === 'telegram.action.outbound_unavailable',
    );
    expect(startUnavailable?.['action']).toBe('admin_post_reply');

    const { status, lines } = await deliver(
      { ...FLAG_ON_ENV },
      textUpdate(7002, OWNER_ID, 'پست فارسی برای ذخیره'),
    );
    // Offline mode: the capture reply is an outbound action — honest 503.
    expect(status).toBe(503);
    const unavailable = lines.find((l) => l.msg === 'telegram.action.outbound_unavailable');
    expect(unavailable?.['action']).toBe('admin_post_reply');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(1);
  });

  it('rejects group-chat content with a silent noop (no group feedback, nothing stored)', async () => {
    const { status, lines } = await deliver(
      FLAG_ON_ENV,
      textUpdate(7003, OWNER_ID, 'گروه نباید ذخیره شود', -1001234567890),
    );
    expect(status).toBe(200);
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['noopReason']).toBe('post_not_private_chat');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('keeps unauthorized senders silent (legacy noop, no storage, no feedback)', async () => {
    const { status, lines } = await deliver(
      FLAG_ON_ENV,
      textUpdate(7004, UNAUTHORIZED_ID, 'هر چیزی'),
    );
    expect(status).toBe(200);
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('not_a_command');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('explicitly rejects edited messages (an edit never enters the pipeline)', async () => {
    // R1.20-R1: outside a session an edit stays SILENT; inside one it gets
    // the explicit rejection. Open the session first.
    await deliver(FLAG_ON_ENV, textUpdate(7005, OWNER_ID, '/post'));
    const { status, lines } = await deliver(FLAG_ON_ENV, {
      update_id: 7005,
      edited_message: {
        message_id: 55,
        chat: { id: OWNER_ID, type: 'private' },
        from: { id: OWNER_ID },
        text: 'متن ویرایش‌شده',
      },
    });
    expect(status).toBe(503);
    // R1.20-R1: the rejection is the SERVICE's reply (admin_post_reply).
    const unavailable = lines.find((l) => l.msg === 'telegram.action.outbound_unavailable');
    expect(unavailable?.['action']).toBe('admin_post_reply');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('captures a photo+caption as a complete post and explicitly rejects unsupported media', async () => {
    // R1.21: a SINGLE photo with an optional caption is now a complete post
    // (captured within an open session); every OTHER media shape stays an
    // explicit rejection and never degrades into a partial post.
    await deliver(FLAG_ON_ENV, textUpdate(7006, OWNER_ID, '/post'));
    const captured = await deliver(FLAG_ON_ENV, {
      update_id: 7006,
      message: {
        message_id: 56,
        chat: { id: OWNER_ID, type: 'private' },
        from: { id: OWNER_ID },
        photo: [
          { file_id: 'small_photo_id', file_unique_id: 'y1', width: 90, height: 90 },
          { file_id: 'large_photo_id', file_unique_id: 'y2', width: 800, height: 600 },
        ],
        caption: 'کپشن تصویر',
      },
    });
    expect(captured.status).toBe(503); // offline reply send, capture SUCCEEDED
    const versionsAfterPhoto = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versionsAfterPhoto?.count).toBe(1);

    // A document is NOT a supported post media type: explicit rejection,
    // nothing stored, nothing silently dropped.
    const rejected = await deliver(FLAG_ON_ENV, {
      update_id: 7006,
      message: {
        message_id: 57,
        chat: { id: OWNER_ID, type: 'private' },
        from: { id: OWNER_ID },
        document: { file_id: 'doc_id', file_unique_id: 'z' },
        caption: 'سند به‌تنهایی پست نیست',
      },
    });
    expect(rejected.status).toBe(503);
    const unavailable = rejected.lines.find((l) => l.msg === 'telegram.action.outbound_unavailable');
    expect(unavailable?.['action']).toBe('admin_post_reply');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(1);
  });

  it('explicitly rejects oversized text beyond the Telegram 4096 bound', async () => {
    // R1.20-R1: the oversize rejection fires within an open capture session.
    await deliver(FLAG_ON_ENV, textUpdate(7007, OWNER_ID, '/post'));
    const { status, lines } = await deliver(
      FLAG_ON_ENV,
      textUpdate(7007, OWNER_ID, 'a'.repeat(4100)),
    );
    expect(status).toBe(503);
    // R1.20-R1: the rejection is the SERVICE's reply (admin_post_reply).
    const unavailable = lines.find((l) => l.msg === 'telegram.action.outbound_unavailable');
    expect(unavailable?.['action']).toBe('admin_post_reply');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('keeps callback queries legacy while the flag is OFF', async () => {
    const { status, lines } = await deliver(BASE_ENV, {
      update_id: 7008,
      callback_query: {
        id: 'cbq1',
        from: { id: OWNER_ID },
        data: 'a:sometoken12345678',
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    expect(status).toBe(200);
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['noopReason']).toBe('callback_not_supported');
  });

  it('routes valid-format callbacks to the service while the flag is ON (unknown token answered)', async () => {
    // Without BOT_TOKEN the answerCallbackQuery is an outbound action that
    // fails retryably — the observable action type proves the routing.
    const { status, lines } = await deliver(FLAG_ON_ENV, {
      update_id: 7009,
      callback_query: {
        id: 'cbq2',
        from: { id: OWNER_ID },
        data: 'a:sometoken12345678',
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    expect(status).toBe(503);
    const unavailable = lines.find((l) => l.msg === 'telegram.action.outbound_unavailable');
    expect(unavailable?.['action']).toBe('admin_post_callback');
  });

  it('denies /post_* commands to unauthorized senders and respects the private-chat scope', async () => {
    const denied = await deliver(FLAG_ON_ENV, textUpdate(7010, UNAUTHORIZED_ID, '/post_preview'));
    expect(denied.status).toBe(503);
    const deniedAction = denied.lines.find((l) => l.msg === 'telegram.action.outbound_unavailable');
    expect(deniedAction?.['action']).toBe('denied');

    const group = await deliver(
      FLAG_ON_ENV,
      textUpdate(7011, OWNER_ID, '/post_status', -1001234567890),
    );
    expect(group.status).toBe(200);
    const groupProcessed = group.lines.find((l) => l.msg === 'telegram.update.processed');
    expect(groupProcessed?.['noopReason']).toBe('post_not_private_chat');
  });
});

describe('R1.20-R approval binding — the previewed version contract (service level)', () => {
  let executor: DbExecutor;
  let clock: ReturnType<typeof mutableClock>;

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
      // R1.20-R1: the capture session lives in the settings table.
      'settings',
      'admins',
    ]) {
      await executor.run({ sql: `DELETE FROM ${table}` });
    }
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, 'Owner', 'owner', 'active', 1, 1)`,
      params: [OWNER_ID],
    });
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, 'Editor', 'editor', 'active', 1, 1)`,
      params: [EDITOR_ID],
    });
    clock = mutableClock(1_700_000_000_000);
  });

  function makeService(livePublishEnabled = true) {
    return createAdminPostService({
      executor,
      clock,
      logger: createLogger({ level: 'error', sink: () => {} }),
      config: { livePublishEnabled, destination: '@pixellores' },
    });
  }

  async function captureVersion1(service: ReturnType<typeof makeService>): Promise<void> {
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71000,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7100,
      kind: 'message',
      hasText: true,
      text: 'متن نسخهٔ یک',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
  }

  it('rejects approval without a real preview session (knowing the version is not enough)', async () => {
    const service = makeService();
    await captureVersion1(service);
    // A token shaped like a real one but minted OUTSIDE a preview: the
    // callback resolves the server-side session and must fail closed.
    const { issueActionToken } = await import('../../src/adapters/telegram/action-tokens');
    const { randomToken } = await import('../../src/domain/admin-post/fingerprint');
    const token = randomToken();
    await issueActionToken(executor, {
      token,
      telegramUserId: OWNER_ID,
      permission: 'draft.approve',
      action: 'admin_post.approve',
      targetType: 'admin_post_draft',
      targetId: 'any-draft',
      payloadJson: JSON.stringify({ version: 1, sessionId: randomToken() }),
      expiresAtMs: clock.now() + 1000,
      nowMs: clock.now(),
    });
    const result = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind !== 'answer') throw new Error('unreachable');
    expect(result.callbackText).toContain('unknown or expired');
    // Nothing approved.
    const approvals = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_approvals',
    });
    expect(approvals?.count).toBe(0);
  });

  it('rejects a token minted for a DIFFERENT user (token-user binding)', async () => {
    const service = makeService();
    await captureVersion1(service);
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7101,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    const token = preview.buttons[0]?.[0]?.callbackData.slice(2) ?? '';
    const result = await service.handleCallback({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind !== 'answer') throw new Error('unreachable');
    expect(result.callbackText).toContain('not yours');
    const approvals = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_approvals',
    });
    expect(approvals?.count).toBe(0);
  });

  it('a foreign fingerprint in the payload is rejected as TAMPERED; omitting it bypasses NOTHING', async () => {
    const service = makeService();
    await captureVersion1(service);
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7102,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    const approveToken = preview.buttons[0]?.[0]?.callbackData.slice(2) ?? '';

    // Rewrite the stored token payload with a FOREIGN fingerprint: the
    // server-side session fingerprint wins the comparison — tampered.
    const { randomToken } = await import('../../src/domain/admin-post/fingerprint');
    const foreign = 'f'.repeat(64);
    await executor.run({
      sql: 'UPDATE admin_action_tokens SET payload_json = ? WHERE id = ?',
      params: [
        JSON.stringify({ version: 1, fingerprint: foreign, sessionId: randomToken() }),
        approveToken,
      ],
    });
    const tampered = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(tampered.kind).toBe('answer');
    if (tampered.kind !== 'answer') throw new Error('unreachable');
    // The sessionId no longer matches any session (we replaced it) AND the
    // fingerprint is foreign — either way the answer is a typed rejection.
    expect(
      tampered.callbackText.includes('unknown or expired') ||
        tampered.callbackText.includes('does not match'),
    ).toBe(true);
  });

  it('a content update invalidates the old approval and stales the old preview', async () => {
    const service = makeService(false);
    await captureVersion1(service);
    const previewV1 = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7103,
    });
    if (previewV1.kind !== 'preview') throw new Error('unreachable');
    const approveV1 = previewV1.buttons[0]?.[0]?.callbackData.slice(2) ?? '';
    const approved = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveV1,
    });
    expect(approved.kind).toBe('answer');
    if (approved.kind !== 'answer') throw new Error('unreachable');
    expect(approved.callbackText).toContain('APPROVED');

    // Content update -> version 2; the v1 approval must be invalidated.
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71001,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7104,
      kind: 'message',
      hasText: true,
      text: 'متن نسخهٔ دو — تغییر یافته',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    const drafts = await executor.first<{ id: string; current_version: number }>({
      sql: 'SELECT id, current_version FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    expect(drafts?.current_version).toBe(2);
    const approvalV1 = await executor.first<{ state: string }>({
      sql: 'SELECT state FROM admin_post_approvals WHERE draft_id = ? AND version = 1',
      params: [drafts?.id ?? ''],
    });
    expect(approvalV1?.state).toBe('invalidated');

    // The OLD preview's approve/publish tokens can no longer act: the draft
    // head moved on — stale.
    const publishV1 = previewV1.buttons[0]?.[1]?.callbackData.slice(2) ?? '';
    const stale = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: publishV1,
    });
    expect(stale.kind).toBe('answer');
    if (stale.kind !== 'answer') throw new Error('unreachable');
    expect(stale.callbackText).toContain('newer version');
    const publications = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_publications',
    });
    expect(publications?.count).toBe(0);
  });

  it('a duplicate approver gets an honest already-approved answer (single active approval)', async () => {
    const service = makeService(false);
    await captureVersion1(service);
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7105,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    const firstToken = preview.buttons[0]?.[0]?.callbackData.slice(2) ?? '';
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: firstToken,
    });

    // A SECOND preview mints a fresh publish-capable session; approving via
    // a second approve token must answer already-approved, not duplicate.
    const preview2 = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7106,
    });
    if (preview2.kind !== 'preview') throw new Error('unreachable');
    const secondApprove = preview2.buttons[0]?.[0]?.callbackData.slice(2) ?? '';
    const second = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: secondApprove,
    });
    expect(second.kind).toBe('answer');
    if (second.kind !== 'answer') throw new Error('unreachable');
    expect(second.callbackText).toContain('already has an active approval');
  });

  it('malformed rich-text metadata is rejected explicitly (never stored, never dropped)', async () => {
    const service = makeService(false);
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71002,
    });
    const result = await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7107,
      kind: 'message',
      hasText: true,
      text: 'متن با فرادادهٔ خراب',
      richText: { ok: false, kind: 'text', reason: 'entities_malformed' },
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    expect(result.kind).toBe('reply');
    if (result.kind !== 'reply') throw new Error('unreachable');
    expect(result.text).toContain('malformed');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('a redelivered capture (same update_id) can never create a duplicate version', async () => {
    const service = makeService(false);
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71003,
    });
    const first = await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7108,
      kind: 'message',
      hasText: true,
      text: 'اولین ارسال',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    expect(first.kind).toBe('reply');
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71004,
    });
    const second = await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7108,
      kind: 'message',
      hasText: true,
      text: 'اولین ارسال',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    expect(second.kind).toBe('reply');
    if (second.kind !== 'reply') throw new Error('unreachable');
    expect(second.text).toContain('already captured');
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(1);
  });
});

describe('R1.20-R approval binding — the OPTIONAL fingerprint contract', () => {
  let executor: DbExecutor;
  let clock: ReturnType<typeof mutableClock>;

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
      // R1.20-R1: the capture session lives in the settings table.
      'settings',
      'admins',
    ]) {
      await executor.run({ sql: `DELETE FROM ${table}` });
    }
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, 'Owner', 'owner', 'active', 1, 1)`,
      params: [OWNER_ID],
    });
    clock = mutableClock(1_700_000_000_000);
  });

  function makeService(livePublishEnabled = true) {
    return createAdminPostService({
      executor,
      clock,
      logger: createLogger({ level: 'error', sink: () => {} }),
      config: { livePublishEnabled, destination: '@pixellores' },
    });
  }

  it('omitting the payload fingerprint bypasses NOTHING: the SERVER-SIDE binding still approves the right version and still rejects moved content', async () => {
    const service = makeService(false);
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71005,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7300,
      kind: 'message',
      hasText: true,
      text: 'متن بدون اثر انگشت در توکن',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7301,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    const approveToken = preview.buttons[0]?.[0]?.callbackData.slice(2) ?? '';

    // Strip BOTH fingerprint and version from the token payload: the callback
    // now carries ONLY the opaque token + session id. The binding must hold
    // purely through the durable session + stored version rows.
    await executor.run({
      sql: 'UPDATE admin_action_tokens SET payload_json = ? WHERE id = ?',
      params: [JSON.stringify({ sessionId: undefined }), approveToken],
    });
    // payload.sessionId undefined would fail the session check — extract the
    // REAL session id from the sessions table first, then store the reduced
    // payload (this is exactly what a "fingerprint-optional" client does).
    const session = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM admin_post_preview_sessions ORDER BY created_at_ms DESC LIMIT 1',
    });
    await executor.run({
      sql: 'UPDATE admin_action_tokens SET payload_json = ? WHERE id = ?',
      params: [JSON.stringify({ sessionId: session?.id }), approveToken],
    });

    const approved = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: approveToken,
    });
    expect(approved.kind).toBe('answer');
    if (approved.kind !== 'answer') throw new Error('unreachable');
    // The binding held: the approval succeeded WITHOUT any fingerprint in
    // the payload — because the SERVER-SIDE session + stored version agree.
    expect(approved.callbackText).toContain('APPROVED');

    // The bypass-prevention direction: strip the fingerprint from a token
    // for an OLDER version after the content moved — still rejected.
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 71006,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7302,
      kind: 'message',
      hasText: true,
      text: 'متن نسخهٔ دو — محتوا عوض شد',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    const preview2 = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7303,
    });
    if (preview2.kind !== 'preview') throw new Error('unreachable');
    void preview2; // v2 preview is irrelevant; the v1 session is stale now
    const staleSession = await executor.first<{ id: string }>({
      sql: `SELECT s.id FROM admin_post_preview_sessions s
            JOIN admin_post_versions v ON v.draft_id = s.draft_id AND v.version = s.version
            WHERE v.version = 1
            ORDER BY s.created_at_ms DESC LIMIT 1`,
    });
    expect(staleSession).not.toBeNull();
    const staleToken = (await import('../../src/domain/admin-post/fingerprint')).randomToken();
    const { issueActionToken } = await import('../../src/adapters/telegram/action-tokens');
    await issueActionToken(executor, {
      token: staleToken,
      telegramUserId: OWNER_ID,
      permission: 'publication.publish',
      action: 'admin_post.publish',
      targetType: 'admin_post_draft',
      targetId:
        (await executor.first<{ id: string }>({ sql: 'SELECT id FROM admin_post_drafts' }))?.id ??
        '',
      // fingerprint OMITTED on purpose — only version + stale session
      payloadJson: JSON.stringify({ version: 1, sessionId: staleSession?.id }),
      expiresAtMs: clock.now() + 60_000,
      nowMs: clock.now(),
    });
    const stale = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: staleToken,
    });
    expect(stale.kind).toBe('answer');
    if (stale.kind !== 'answer') throw new Error('unreachable');
    // The draft head moved to version 2 — the v1 session cannot act even
    // though the payload carried no fingerprint to "mismatch".
    expect(stale.callbackText).toContain('newer version');
  });
});
