import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/entrypoints/worker';
import { applyMigrations } from '../helpers/migrations';
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
} from '../../src/adapters/telegram/update-claims';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Durable Telegram update claims — lifecycle and idempotency tests
 * (Phase 2A, ADR-0025). All statements run against the isolated workerd D1
 * binding; no network and no real Telegram involvement.
 */

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

const ENABLED_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: 'test-webhook-secret-0000000000000000',
  OWNER_TELEGRAM_ID: '1000000001',
  DB: env.DB,
};

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await applyMigrations(env.DB);
});

describe('claimTelegramUpdate — lifecycle', () => {
  it('claims a new update_id and records the claimed status', async () => {
    const executor = createDbExecutor(env.DB);
    const claim = await claimTelegramUpdate(executor, 7001, NOW);
    expect(claim).toEqual({ kind: 'claimed' });

    const row = await executor.first<{ status: string; received_at: number }>({
      sql: 'SELECT status, received_at FROM telegram_updates WHERE update_id = ?',
      params: [7001],
    });
    expect(row?.status).toBe('claimed');
    expect(row?.received_at).toBe(NOW);
  });

  it('reports an in-flight claim when the same update_id is claimed again', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7002, NOW);
    const second = await claimTelegramUpdate(executor, 7002, NOW + 5_000);
    expect(second).toEqual({ kind: 'in_flight' });
  });

  it('transitions claimed -> processed and reports the terminal state on re-claim', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7003, NOW);
    await expect(markTelegramUpdateProcessed(executor, 7003, NOW + 10)).resolves.toBe(true);

    const row = await executor.first<{ status: string; processed_at: number }>({
      sql: 'SELECT status, processed_at FROM telegram_updates WHERE update_id = ?',
      params: [7003],
    });
    expect(row?.status).toBe('processed');
    expect(row?.processed_at).toBe(NOW + 10);

    const redelivery = await claimTelegramUpdate(executor, 7003, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'already_processed' });
  });

  it('transitions claimed -> failed and keeps the failure observable and RECLAIMABLE', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7004, NOW);
    await expect(markTelegramUpdateFailed(executor, 7004, NOW + 10)).resolves.toBe(true);

    const row = await executor.first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = ?',
      params: [7004],
    });
    expect(row?.status).toBe('failed');

    // A failed update is NOT terminal: redelivery reclaims it atomically
    // (ADR-0027) so a retryable failure can never permanently lose it.
    const redelivery = await claimTelegramUpdate(executor, 7004, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'reclaimed' });
  });

  it('never overwrites a terminal state with the guarded transitions', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7005, NOW);
    await expect(markTelegramUpdateProcessed(executor, 7005, NOW + 10)).resolves.toBe(true);
    await expect(markTelegramUpdateFailed(executor, 7005, NOW + 20)).resolves.toBe(false);
    await expect(markTelegramUpdateProcessed(executor, 7005, NOW + 30)).resolves.toBe(false);
  });

  it('returns false for terminal transitions on unknown update ids', async () => {
    const executor = createDbExecutor(env.DB);
    await expect(markTelegramUpdateProcessed(executor, 7099, NOW)).resolves.toBe(false);
    await expect(markTelegramUpdateFailed(executor, 7099, NOW)).resolves.toBe(false);
  });
});

describe('concurrent duplicate claims', () => {
  it('produces exactly one winner for simultaneous claims of the same update_id', async () => {
    const executor = createDbExecutor(env.DB);
    const results = await Promise.all([
      claimTelegramUpdate(executor, 7100, NOW),
      claimTelegramUpdate(executor, 7100, NOW),
      claimTelegramUpdate(executor, 7100, NOW),
    ]);

    const winners = results.filter((r) => r.kind === 'claimed');
    const losers = results.filter((r) => r.kind === 'in_flight');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
  });
});

describe('duplicate delivery through the worker webhook', () => {
  it('acknowledges the second delivery of the same update without reprocessing', async () => {
    // A noop update (channel_post) completes offline without a Bot API
    // client, so the full duplicate path is observable end to end.
    const body = JSON.stringify({
      update_id: 7200,
      channel_post: { message_id: 21, chat: { id: -100123 } },
    });

    const first = await worker.fetch(
      new Request('https://example.com/telegram/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': ENABLED_ENV.WEBHOOK_SECRET,
        },
        body,
      }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(first.status).toBe(200);

    const executor = createDbExecutor(env.DB);
    const afterFirst = await executor.first<{ status: string; received_at: number }>({
      sql: 'SELECT status, received_at FROM telegram_updates WHERE update_id = ?',
      params: [7200],
    });
    expect(afterFirst?.status).toBe('processed');

    const second = await worker.fetch(
      new Request('https://example.com/telegram/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': ENABLED_ENV.WEBHOOK_SECRET,
        },
        body,
      }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(second.status).toBe(200);

    // Exactly one row, unchanged terminal state, original claim timestamp.
    const rows = await executor.query<{ update_id: number; status: string; received_at: number }>({
      sql: 'SELECT update_id, status, received_at FROM telegram_updates WHERE update_id = ?',
      params: [7200],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('processed');
    expect(rows.rows[0]?.received_at).toBe(afterFirst?.received_at);
  });
});
