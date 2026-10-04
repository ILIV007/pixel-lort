import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { consumeActionToken, issueActionToken } from '../../src/adapters/telegram/action-tokens';
import { formatCallbackData } from '../../src/admin/callback-tokens';

/**
 * Admin authorization + command contracts over the real workerd D1 binding
 * (Phase 2A). The owner resolves through the bootstrap identity; active and
 * disabled admins are seeded into the `admins` table. No live Telegram
 * connection exists — outbound actions are observable as skipped-offline
 * events in a captured logger.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
const OWNER_ID = 1000000001;
const EDITOR_ID = 2000000002;
const DISABLED_ID = 2000000003;
const UNKNOWN_ID = 2999999999;

const HANDLER_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  DB: env.DB,
};

const NOW = 1_700_000_000_000;

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB);
  // Per-file storage persists across tests in this file: reset the seeded
  // tables so every test starts from a clean admin/token state.
  await executor.run({ sql: 'DELETE FROM telegram_updates' });
  await executor.run({ sql: 'DELETE FROM admins' });
  await executor.run({ sql: 'DELETE FROM admin_action_tokens' });
  const seed = (userId: number, role: string, status: string) =>
    executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [userId, 'Test Admin', role, status, NOW, NOW],
    });
  await seed(EDITOR_ID, 'editor', 'active');
  await seed(DISABLED_ID, 'reviewer', 'disabled');
});

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

async function deliver(update: Record<string, unknown>): Promise<{ lines: CapturedLine[] }> {
  const { lines, logger } = captureLogger();
  const request = new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TELEGRAM_SECRET_HEADER]: FAKE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  const res = await handleTelegramWebhook(request, HANDLER_ENV, { logger });
  expect(res.status).toBe(200);
  return { lines };
}

function messageUpdate(updateId: number, fromId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: fromId }, from: { id: fromId }, text },
  };
}

describe('owner bootstrap authorization', () => {
  it('serves the admin response contract to the owner', async () => {
    const { lines } = await deliver(messageUpdate(8001, OWNER_ID, '/status'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed).toBeDefined();
    expect(processed?.['action']).toBe('send_message');
    expect(processed?.['authorized']).toBe(true);
    expect(processed?.['role']).toBe('owner');
    expect(lines.some((l) => l.msg === 'telegram.action.skipped_offline')).toBe(true);
  });
});

describe('D1 admin authorization', () => {
  it('serves an active admin by role', async () => {
    const { lines } = await deliver(messageUpdate(8002, EDITOR_ID, '/help'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('send_message');
    expect(processed?.['role']).toBe('editor');
  });

  it('denies a disabled admin (no privileged access)', async () => {
    const { lines } = await deliver(messageUpdate(8003, DISABLED_ID, '/status'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('denied');
    expect(processed?.['authorized']).toBe(false);
  });

  it('denies an unknown user', async () => {
    const { lines } = await deliver(messageUpdate(8004, UNKNOWN_ID, '/start'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('denied');
  });
});

describe('command allowlist', () => {
  it('ignores commands outside the allowlist even for the owner', async () => {
    const { lines } = await deliver(messageUpdate(8005, OWNER_ID, '/inbox'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('command_not_allowlisted');
  });

  it('ignores non-command text', async () => {
    const { lines } = await deliver(messageUpdate(8006, OWNER_ID, 'سلام، حالت چطوره؟'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('not_a_command');
  });

  it('accepts commands targeted at a @botname suffix', async () => {
    const { lines } = await deliver(messageUpdate(8007, OWNER_ID, '/version@pixel_admin_bot'));
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('send_message');
  });
});

describe('unsupported updates and callbacks', () => {
  it('acknowledges an unsupported update as processed without an action', async () => {
    const { lines } = await deliver({
      update_id: 8010,
      channel_post: { message_id: 1, chat: { id: -100123 } },
    });
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('unsupported_update');
  });

  it('classifies contract-valid callback data as not supported yet', async () => {
    const { lines } = await deliver({
      update_id: 8011,
      callback_query: {
        id: 'cb-001',
        from: { id: OWNER_ID },
        data: formatCallbackData('AAAbbCCCdddEEEff'),
      },
    });
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('callback_not_supported');
  });

  it('classifies malformed callback data as malformed without crashing', async () => {
    const { lines } = await deliver({
      update_id: 8012,
      callback_query: { id: 'cb-002', from: { id: OWNER_ID }, data: '<script>alert(1)</script>' },
    });
    const processed = lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['action']).toBe('noop');
    expect(processed?.['noopReason']).toBe('malformed_callback_data');
  });
});

describe('admin action token repository boundary', () => {
  const TOKEN = 'AAAbbCCCdddEEEff';

  async function seedToken(userId: number, expiresAtMs: number): Promise<void> {
    await issueActionToken(createDbExecutor(env.DB), {
      token: TOKEN,
      telegramUserId: userId,
      permission: 'draft.approve',
      action: 'draft.approve',
      targetId: 'draft-123',
      expiresAtMs,
      nowMs: NOW,
    });
  }

  it('consumes a bound token exactly once and returns the record', async () => {
    await seedToken(EDITOR_ID, NOW + 60_000);
    const executor = createDbExecutor(env.DB);
    const result = await consumeActionToken(executor, {
      token: TOKEN,
      telegramUserId: EDITOR_ID,
      nowMs: NOW + 1_000,
    });
    expect(result.kind).toBe('consumed');
    if (result.kind !== 'consumed') return;
    expect(result.record.permission).toBe('draft.approve');
    expect(result.record.targetId).toBe('draft-123');

    // Second consumption fails (single use).
    await expect(
      consumeActionToken(executor, { token: TOKEN, telegramUserId: EDITOR_ID, nowMs: NOW + 2_000 }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('never resolves a token for a different user', async () => {
    await seedToken(EDITOR_ID, NOW + 60_000);
    const executor = createDbExecutor(env.DB);
    await expect(
      consumeActionToken(executor, { token: TOKEN, telegramUserId: OWNER_ID, nowMs: NOW + 1_000 }),
    ).resolves.toEqual({ kind: 'invalid' });

    // And the wrong-user attempt did NOT consume the token.
    await expect(
      consumeActionToken(executor, { token: TOKEN, telegramUserId: EDITOR_ID, nowMs: NOW + 2_000 }),
    ).resolves.toMatchObject({ kind: 'consumed' });
  });

  it('rejects expired tokens', async () => {
    await seedToken(EDITOR_ID, NOW + 60_000);
    const executor = createDbExecutor(env.DB);
    await expect(
      consumeActionToken(executor, {
        token: TOKEN,
        telegramUserId: EDITOR_ID,
        nowMs: NOW + 61_000,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('rejects unknown tokens', async () => {
    const executor = createDbExecutor(env.DB);
    await expect(
      consumeActionToken(executor, {
        token: 'ZZZunknownZZZ000',
        telegramUserId: EDITOR_ID,
        nowMs: NOW,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });
});
