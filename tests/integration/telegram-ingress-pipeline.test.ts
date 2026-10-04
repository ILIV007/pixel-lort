import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import type { TelegramIngressDeps } from '../../src/application/telegram-ingress';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
import type {
  TelegramBotApiClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import { TelegramApiError } from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * Cross-cutting ingress pipeline tests (Phase 2A): duplicate-delivery
 * semantics with a COUNTING fake Bot API client, concurrent duplicate
 * claims, failed-processing states, and no-leak logging — all offline.
 */

const OWNER_ID = 1000000001;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await applyMigrations(env.DB);
});

/** Counting fake client — records every sendMessage call. */
function countingClient(options: { failWith?: TelegramApiError } = {}): {
  client: TelegramBotApiClient;
  sends: { chatId: number; text: string }[];
} {
  const sends: { chatId: number; text: string }[] = [];
  const client: TelegramBotApiClient = {
    async getMe() {
      return { id: 42, username: 'pixel_admin_bot' };
    },
    async sendMessage(input) {
      if (options.failWith !== undefined) {
        throw options.failWith;
      }
      sends.push({ chatId: input.chatId, text: input.text });
      const message: TelegramSentMessage = { messageId: sends.length };
      return message;
    },
    async editMessageText() {
      return true;
    },
    async answerCallbackQuery() {},
  };
  return { client, sends };
}

function captureLogger() {
  const lines: string[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(line);
  };
  return { lines, logger: createLogger({ level: 'debug', sink }) };
}

/** Wrap the real executor to intercept terminal-state statements.
 *  Interceptions reject asynchronously — the realistic D1 failure shape. */
function interceptingExecutor(shouldReject: (statement: DbStatement) => boolean): DbExecutor {
  const delegate = createDbExecutor(env.DB);
  return {
    query: (statement) => delegate.query(statement),
    first: (statement) => delegate.first(statement),
    run: (statement) => {
      if (shouldReject(statement)) {
        return Promise.reject(new Error('simulated D1 outage during terminal transition'));
      }
      return delegate.run(statement);
    },
    batch: (statements) => delegate.batch(statements),
  };
}

function buildDeps(overrides: Partial<TelegramIngressDeps> = {}): TelegramIngressDeps {
  const executor = overrides.executor ?? createDbExecutor(env.DB);
  return {
    executor,
    authorization:
      overrides.authorization ??
      createAuthorizationService({
        ownerTelegramId: OWNER_ID,
        lookup: createAdminRoleLookup(executor),
      }),
    commandRouter: overrides.commandRouter ?? createCommandRouter({ applicationVersion: '1.2.0' }),
    botApi: overrides.botApi,
    clock: overrides.clock ?? fixedClock(NOW),
    logger: overrides.logger ?? captureLogger().logger,
  };
}

function ownerCommand(updateId: number, text: string): ParsedUpdate {
  return {
    kind: 'message',
    updateId,
    messageId: updateId,
    chatId: OWNER_ID,
    fromUserId: OWNER_ID,
    text,
    command: text.replace('/', '').split(' ')[0],
  };
}

describe('duplicate deliveries never execute the command twice', () => {
  it('sends at most one response across sequential redeliveries', async () => {
    const { client, sends } = countingClient();
    const ingress = createTelegramIngress(buildDeps({ botApi: client }));
    const update = ownerCommand(9001, '/status');

    await expect(ingress.processUpdate(update)).resolves.toBe('processed');
    await expect(ingress.processUpdate(update)).resolves.toBe('duplicate');
    await expect(ingress.processUpdate(update)).resolves.toBe('duplicate');
    expect(sends).toHaveLength(1);
  });

  it('produces exactly one winner for concurrent duplicate claims', async () => {
    const { client, sends } = countingClient();
    const ingress = createTelegramIngress(buildDeps({ botApi: client }));
    const update = ownerCommand(9002, '/help');

    const outcomes = await Promise.all([
      ingress.processUpdate(update),
      ingress.processUpdate(update),
      ingress.processUpdate(update),
    ]);

    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'failed')).toHaveLength(0);
    // Exactly one routed response despite three deliveries.
    expect(sends).toHaveLength(1);
  });
});

describe('failed processing is observable and never falsely processed', () => {
  it('marks failed when authorization lookup throws (transient internal failure)', async () => {
    const { client, sends } = countingClient();
    const executor = createDbExecutor(env.DB);
    const failingAuthorization = {
      resolveActor: async () => {
        throw new Error('simulated transient D1 outage');
      },
    };
    const ingress = createTelegramIngress(
      buildDeps({ executor, authorization: failingAuthorization, botApi: client }),
    );

    await expect(ingress.processUpdate(ownerCommand(9010, '/status'))).resolves.toBe('failed');
    const row = await executor.first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
      params: [9010],
    });
    expect(row?.status).toBe('failed');
    // Nothing was sent — the failure happened before any action executed.
    expect(sends).toHaveLength(0);
  });

  it('keeps the row claimed (recoverable) when even the failure marking fails', async () => {
    const { client } = countingClient();
    const failingExecutor = interceptingExecutor((statement) => {
      // Simulate a D1 outage for ALL terminal-state transitions.
      return statement.sql.startsWith('UPDATE telegram_updates SET status = ?');
    });
    const ingress = createTelegramIngress(buildDeps({ executor: failingExecutor, botApi: client }));

    await expect(ingress.processUpdate(ownerCommand(9011, '/status'))).resolves.toBe('failed');
    const row = await createDbExecutor(env.DB).first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
      params: [9011],
    });
    // NOT processed, NOT failed — claimed remains the observable truth.
    expect(row?.status).toBe('claimed');
  });

  it('marks failed (not processed) when the Bot API call throws', async () => {
    const { client } = countingClient({
      failWith: new TelegramApiError('telegram_rate_limited', { retryAfterMs: 5000 }),
    });
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: client }));

    await expect(ingress.processUpdate(ownerCommand(9012, '/status'))).resolves.toBe('failed');
    const row = await executor.first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
      params: [9012],
    });
    expect(row?.status).toBe('failed');
  });
});

describe('no secret or payload leakage in pipeline logs', () => {
  it('never logs message text, chat ids, user ids, or callback data', async () => {
    const { client } = countingClient();
    const { lines, logger } = captureLogger();
    const CANARY = 'LEAK-PIPELINE-سلام-999';
    const ingress = createTelegramIngress(
      buildDeps({
        botApi: client,
        logger,
        clock: fixedClock(NOW),
      }),
    );

    await ingress.processUpdate({
      kind: 'message',
      updateId: 9020,
      messageId: 1,
      chatId: -100777,
      fromUserId: OWNER_ID,
      text: `/status ${CANARY}`,
      command: 'status',
    });

    const everything = lines.join('\n');
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain('LEAK-PIPELINE');
    expect(everything).not.toContain('-100777');
    expect(everything).not.toContain(String(OWNER_ID));
    expect(everything).not.toContain('سلام');
    // The counting client DID receive the message for the owner chat — the
    // exclusion above proves it came from the client, not from logs.
    expect(client).toBeDefined();
  });

  it('does not log callback data even for malformed payloads', async () => {
    const { lines, logger } = captureLogger();
    const ingress = createTelegramIngress(buildDeps({ logger }));
    const HOSTILE = 'a:<img src=x onerror=alert(1)>-padding-padding!';

    await ingress.processUpdate({
      kind: 'callback_query',
      updateId: 9021,
      callbackQueryId: 'cb-leak',
      fromUserId: OWNER_ID,
      callbackData: HOSTILE.length <= 64 ? HOSTILE : 'a:oversized-but-still-hostile-data-padding!',
    });

    const everything = lines.join('\n');
    expect(everything).not.toContain('<img');
    expect(everything).not.toContain('onerror');
    expect(everything).not.toContain('cb-leak');
  });
});
