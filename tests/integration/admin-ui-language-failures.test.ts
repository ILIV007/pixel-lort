import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import { parseTelegramUpdate } from '../../src/adapters/telegram/update-parser';
import type {
  TelegramBotApiClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';

/**
 * Admin UI language STORAGE-FAILURE honesty (v1.2.5, ADR-0034) — dedicated
 * FILE because the workerd test environment keeps per-file database state:
 * these tests deliberately BREAK the `settings` table (DROP), which must
 * never leak into other suites (applyMigrations is a no-op at the latest
 * schema version and would not rebuild it).
 *
 * Contract under test: a preference WRITE or READ storage failure is a
 * retryable processing failure (safe 503 semantics — Telegram redelivers),
 * and NO success confirmation is ever produced for a preference that was
 * not durably persisted.
 */

const OWNER_ID = 1000000001;
const EDITOR_ID = 2000000002;
const NOW = 1_700_000_000_000;

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

function stubBotApi(sent: { texts: string[] }): TelegramBotApiClient {
  return {
    async sendMessage(input: { chatId: number; text: string }): Promise<TelegramSentMessage> {
      sent.texts.push(input.text);
      return { messageId: sent.texts.length };
    },
    async answerCallbackQuery(): Promise<void> {},
  } as unknown as TelegramBotApiClient;
}

function messageUpdate(updateId: number, fromId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId },
      text,
    },
  };
}

beforeEach(async () => {
  // `settings` is deliberately NOT deleted here: it may be deliberately
  // dropped by a failure test. Everything else is reset per test.
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB);
  await executor.run({ sql: 'DELETE FROM telegram_updates' });
  await executor.run({ sql: 'DELETE FROM admins' });
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [EDITOR_ID, 'Editor', 'editor', 'active', NOW, NOW],
  });
});

async function process(
  update: Record<string, unknown>,
): Promise<{ status: number; sent: string[]; lines: CapturedLine[] }> {
  const parsed = parseTelegramUpdate(update);
  if (!parsed.ok) {
    throw new Error(`test update failed to parse: ${parsed.reason}`);
  }
  const sent: { texts: string[] } = { texts: [] };
  const { lines, logger } = captureLogger();
  const executor = createDbExecutor(env.DB);
  const ingress = createTelegramIngress({
    executor,
    authorization: createAuthorizationService({
      ownerTelegramId: OWNER_ID,
      lookup: createAdminRoleLookup(executor),
    }),
    commandRouter: createCommandRouter({ applicationVersion: '1.2.5' }),
    botApi: stubBotApi(sent),
    clock: { now: () => NOW },
    logger,
  });
  try {
    await ingress.processUpdate(parsed.update);
    return { status: 200, sent: sent.texts, lines };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'internal_error';
    return { status: code === 'service_unavailable' ? 503 : 500, sent: sent.texts, lines };
  }
}

describe('preference READ storage failure', () => {
  it('fails retryably with 503 instead of silently falling back to English', async () => {
    // A stored preference exists first; then the table is destroyed, so the
    // per-request preference READ fails.
    const saved = await process(messageUpdate(9210, EDITOR_ID, '/language fa'));
    expect(saved.status).toBe(200);
    await createDbExecutor(env.DB).run({ sql: 'DROP TABLE IF EXISTS settings' });

    const { status, sent } = await process(messageUpdate(9211, EDITOR_ID, '/start'));
    expect(status).toBe(503);
    expect(sent).toEqual([]);
  });
});

describe('preference WRITE storage failure', () => {
  it('fails retryably with 503 and NEVER sends a success confirmation', async () => {
    await createDbExecutor(env.DB).run({ sql: 'DROP TABLE IF EXISTS settings' });

    const { status, sent, lines } = await process(messageUpdate(9200, EDITOR_ID, '/language fa'));
    expect(status).toBe(503);
    expect(sent).toEqual([]);
    const failed = lines.find((l) => l.msg === 'telegram.update.failed');
    expect(failed?.['retryable']).toBe(true);
    // The claim stays recoverable for Telegram's redelivery.
    const row = await createDbExecutor(env.DB).first<{ status: string; failure_class: string }>({
      sql: 'SELECT status, failure_class FROM telegram_updates WHERE update_id = ?',
      params: [9200],
    });
    expect(row?.status).toBe('failed');
    expect(row?.failure_class).toBe('retryable');
  });
});
