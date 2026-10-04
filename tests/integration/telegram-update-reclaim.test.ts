import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/entrypoints/worker';
import { applyMigrations } from '../helpers/migrations';
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
} from '../../src/adapters/telegram/update-claims';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import type { TelegramIngressDeps } from '../../src/application/telegram-ingress';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import type {
  TelegramBotApiClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import { TelegramApiError } from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';
import { fixedClock } from '../../src/shared/time/clock';
import { createLogger } from '../../src/observability/logger';

/**
 * Retryable update reclaim semantics (Phase 2A correction, ADR-0027).
 *
 * Proves that a RETRYABLE processing failure:
 * - never answers the webhook with a false-success 200 (503 instead);
 * - marks the update failed WITHOUT making it terminal — the row is
 *   atomically reclaimable on Telegram's redelivery;
 * - converges to processed when the retry succeeds;
 * - executes exactly once under concurrent reclaim;
 * - and that PERMANENT failures stay acknowledged (no infinite retry loop).
 * All offline — fake clients and the local workerd D1 binding only.
 */

const OWNER_ID = 1000000001;
const NOW = 1_700_000_000_000;
const WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

const ENABLED_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  // No BOT_TOKEN: offline mode — outbound actions fail RETRYABLY (503),
  // which is exactly the behavior under test at the webhook edge.
  DB: env.DB,
};

beforeEach(async () => {
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB);
  await executor.run({ sql: 'DELETE FROM telegram_updates' });
});

function ownerStatusBody(updateId: number): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: OWNER_ID },
      from: { id: OWNER_ID },
      text: '/status',
    },
  });
}

function webhookRequest(body: string): Request {
  return new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
    },
    body,
  });
}

async function rowStatus(updateId: number): Promise<string | undefined> {
  const executor = createDbExecutor(env.DB);
  const row = await executor.first<{ status: string }>({
    sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
    params: [updateId],
  });
  return row?.status;
}

/** Flaky fake client: fails the first N sendMessage calls with `error`. */
function flakyClient(
  error: TelegramApiError,
  failuresBeforeSuccess = 1,
): {
  client: TelegramBotApiClient;
  sends: { chatId: number; text: string }[];
} {
  const sends: { chatId: number; text: string }[] = [];
  let calls = 0;
  const client: TelegramBotApiClient = {
    async getMe() {
      return { id: 42, username: 'pixel_admin_bot' };
    },
    async sendMessage(input) {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        throw error;
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
    commandRouter: overrides.commandRouter ?? createCommandRouter({ applicationVersion: '1.2.1' }),
    botApi: overrides.botApi,
    clock: overrides.clock ?? fixedClock(NOW),
    logger: overrides.logger ?? createLogger({ level: 'error', sink: () => {} }),
  };
}

function ownerCommand(updateId: number): ParsedUpdate {
  return {
    kind: 'message',
    updateId,
    messageId: updateId,
    chatId: OWNER_ID,
    fromUserId: OWNER_ID,
    text: '/status',
    command: 'status',
  };
}

describe('webhook edge — retryable failure is never falsely acknowledged', () => {
  it('answers 503 (service_unavailable) when an outbound action has no client', async () => {
    const res = await worker.fetch(webhookRequest(ownerStatusBody(8600)), ENABLED_ENV, testCtx());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('service_unavailable');
    // The update is NOT processed — it is failed and reclaimable.
    expect(await rowStatus(8600)).toBe('failed');
  });

  it('completes a noop update safely without a client (200, processed)', async () => {
    const res = await worker.fetch(
      webhookRequest(JSON.stringify({ update_id: 8601, channel_post: { message_id: 1 } })),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rowStatus(8601)).toBe('processed');
  });

  it('redelivers after the 503 and the reclaim path acknowledges the same update', async () => {
    const body = ownerStatusBody(8602);
    const first = await worker.fetch(webhookRequest(body), ENABLED_ENV, testCtx());
    expect(first.status).toBe(503);
    expect(await rowStatus(8602)).toBe('failed');

    // Telegram redelivers the same update_id. The retry STILL cannot send
    // (still offline), so it fails again — but via the RECLAIM path, not a
    // duplicate ack: the redelivery must be re-claimed, not acknowledged as
    // already processed.
    const executor = createDbExecutor(env.DB);
    const reclaim = await claimTelegramUpdate(executor, 8602, NOW + 1_000);
    expect(reclaim).toEqual({ kind: 'reclaimed' });
  });
});

describe('claim boundary — reclaim semantics', () => {
  it('reclaims a failed update exactly once and records the claimed state', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8610, NOW);
    await markTelegramUpdateFailed(executor, 8610, NOW + 10);

    const reclaim = await claimTelegramUpdate(executor, 8610, NOW + 20_000);
    expect(reclaim).toEqual({ kind: 'reclaimed' });

    const row = await executor.first<{ status: string; processed_at: number | null }>({
      sql: 'SELECT status, processed_at FROM telegram_updates WHERE update_id = ?',
      params: [8610],
    });
    expect(row?.status).toBe('claimed');
    expect(row?.processed_at).toBeNull();
  });

  it('never reclaims a processed update (terminal)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8611, NOW);
    await markTelegramUpdateProcessed(executor, 8611, NOW + 10);

    const redelivery = await claimTelegramUpdate(executor, 8611, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'already_processed' });
  });

  it('acknowledges an in-flight claim as a duplicate', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8612, NOW);
    const second = await claimTelegramUpdate(executor, 8612, NOW + 1_000);
    expect(second).toEqual({ kind: 'in_flight' });
  });

  it('produces exactly one winner for concurrent failed-update reclaims', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8613, NOW);
    await markTelegramUpdateFailed(executor, 8613, NOW + 10);

    const results = await Promise.all([
      claimTelegramUpdate(executor, 8613, NOW + 20_000),
      claimTelegramUpdate(executor, 8613, NOW + 20_000),
      claimTelegramUpdate(executor, 8613, NOW + 20_000),
    ]);

    const reclaims = results.filter((r) => r.kind === 'reclaimed');
    const inFlight = results.filter((r) => r.kind === 'in_flight');
    expect(reclaims).toHaveLength(1);
    expect(inFlight).toHaveLength(2);
  });
});

describe('ingress pipeline — retryable vs permanent failures', () => {
  it('propagates 503 semantics for a retryable Bot API failure and marks failed', async () => {
    const { client } = flakyClient(
      new TelegramApiError('telegram_rate_limited', { retryAfterMs: 5_000 }),
    );
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: client }));

    await expect(ingress.processUpdate(ownerCommand(8620))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(await rowStatus(8620)).toBe('failed');
  });

  it('reclaims on redelivery and the retry ends as processed (executes once)', async () => {
    const { client, sends } = flakyClient(new TelegramApiError('telegram_timeout'), 1);
    const ingress = createTelegramIngress(buildDeps({ botApi: client }));

    // First delivery: retryable timeout -> 503 propagation, row failed.
    await expect(ingress.processUpdate(ownerCommand(8621))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(await rowStatus(8621)).toBe('failed');

    // Redelivery reclaims the failed row and succeeds.
    await expect(ingress.processUpdate(ownerCommand(8621))).resolves.toBe('processed');
    expect(await rowStatus(8621)).toBe('processed');
    // Exactly ONE outbound execution across both deliveries.
    expect(sends).toHaveLength(1);

    // A third delivery is a duplicate of the processed (terminal) row.
    await expect(ingress.processUpdate(ownerCommand(8621))).resolves.toBe('duplicate');
    expect(sends).toHaveLength(1);
  });

  it('acknowledges a permanent Bot API failure without an endless retry loop', async () => {
    const { client, sends } = flakyClient(new TelegramApiError('telegram_bad_request'), 10_000);
    const ingress = createTelegramIngress(buildDeps({ botApi: client }));

    // Permanent: resolves (200 semantics — Telegram does NOT redeliver after
    // a 200, so there is no retry loop), marked failed, NOT re-executed.
    await expect(ingress.processUpdate(ownerCommand(8622))).resolves.toBe('failed');
    expect(await rowStatus(8622)).toBe('failed');

    // A manual/operative redelivery of the failed row RECLAIMS it (failed is
    // reclaimable by design) and fails again — always with 200 semantics and
    // no propagated error. The retry loop is bounded by Telegram's own
    // redelivery policy, which never triggers after an acknowledged 200.
    await expect(ingress.processUpdate(ownerCommand(8622))).resolves.toBe('failed');
    await expect(ingress.processUpdate(ownerCommand(8622))).resolves.toBe('failed');
    expect(sends).toHaveLength(0);
  });

  it('propagates 503 for database/service unavailability during processing', async () => {
    const { client } = flakyClient(new TelegramApiError('telegram_network_error'));
    const failingAuthorization = {
      resolveActor: async () => {
        throw new Error('simulated transient D1 outage');
      },
    };
    const executor: DbExecutor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(
      buildDeps({ executor, authorization: failingAuthorization, botApi: client }),
    );

    await expect(ingress.processUpdate(ownerCommand(8623))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(await rowStatus(8623)).toBe('failed');
  });

  it('never marks an outbound update processed when the client is missing', async () => {
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: undefined }));

    await expect(ingress.processUpdate(ownerCommand(8624))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(await rowStatus(8624)).toBe('failed');
  });

  it('completes a noop update without a client (offline-safe)', async () => {
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: undefined }));

    await expect(ingress.processUpdate({ kind: 'unsupported', updateId: 8625 })).resolves.toBe(
      'processed',
    );
    expect(await rowStatus(8625)).toBe('processed');
  });
});
