import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/entrypoints/worker';
import { applyMigrations } from '../helpers/migrations';
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
  TELEGRAM_UPDATE_CLAIM_LEASE_MS,
} from '../../src/adapters/telegram/update-claims';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Durable Telegram update claims — lifecycle, LEASE, and idempotency tests
 * (Phase 2A, ADR-0025, lifecycle completed by ADR-0030/0031 — schema v2).
 * All statements run against the isolated workerd D1 binding; no network and
 * no real Telegram involvement.
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
const LEASE = TELEGRAM_UPDATE_CLAIM_LEASE_MS;

interface LifecycleRow {
  status: string;
  claim_expires_at: number | null;
  failure_class: string | null;
  attempt_count: number;
  received_at: number;
  processed_at: number | null;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
});

async function readRow(updateId: number): Promise<LifecycleRow | null> {
  const executor = createDbExecutor(env.DB);
  return executor.first<LifecycleRow>({
    sql: `SELECT status, claim_expires_at, failure_class, attempt_count, received_at, processed_at
          FROM telegram_updates WHERE update_id = ?`,
    params: [updateId],
  });
}

describe('claimTelegramUpdate — lifecycle', () => {
  it('claims a new update_id with a FULL lease state (ADR-0030)', async () => {
    const executor = createDbExecutor(env.DB);
    const claim = await claimTelegramUpdate(executor, 7001, NOW);
    expect(claim).toEqual({ kind: 'claimed' });

    const row = await readRow(7001);
    expect(row?.status).toBe('claimed');
    expect(row?.received_at).toBe(NOW);
    // Lease state written by the new-claim INSERT:
    expect(row?.claim_expires_at).toBe(NOW + LEASE);
    expect(row?.failure_class).toBeNull();
    expect(row?.attempt_count).toBe(1);
  });

  it('reports an in-flight claim while the lease is active', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7002, NOW);
    const second = await claimTelegramUpdate(executor, 7002, NOW + 5_000);
    expect(second).toEqual({ kind: 'in_flight' });
    // The in-flight observation did not mutate the winner's lease state.
    const row = await readRow(7002);
    expect(row?.status).toBe('claimed');
    expect(row?.claim_expires_at).toBe(NOW + LEASE);
    expect(row?.attempt_count).toBe(1);
  });

  it('transitions claimed -> processed and reports the terminal state on re-claim', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7003, NOW);
    await expect(markTelegramUpdateProcessed(executor, 7003, NOW + 10)).resolves.toBe(true);

    const row = await readRow(7003);
    expect(row?.status).toBe('processed');
    expect(row?.processed_at).toBe(NOW + 10);
    // Terminal success carries no recoverable state (ADR-0030/0031).
    expect(row?.claim_expires_at).toBeNull();
    expect(row?.failure_class).toBeNull();

    const redelivery = await claimTelegramUpdate(executor, 7003, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'already_processed' });
  });

  it('transitions claimed -> failed(retryable), clears the lease, and stays RECLAIMABLE', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7004, NOW);
    await expect(markTelegramUpdateFailed(executor, 7004, NOW + 10, 'retryable')).resolves.toBe(
      true,
    );

    const row = await readRow(7004);
    expect(row?.status).toBe('failed');
    // FIX 2: the failure class is persisted and the lease is cleared.
    expect(row?.failure_class).toBe('retryable');
    expect(row?.claim_expires_at).toBeNull();

    // A retryable failed update is NOT terminal: redelivery reclaims it
    // atomically (ADR-0027) so a temporary failure can never lose it.
    const redelivery = await claimTelegramUpdate(executor, 7004, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'reclaimed_retryable' });

    // Reclaim state: fresh lease, class cleared, attempt counted.
    const reclaimed = await readRow(7004);
    expect(reclaimed?.status).toBe('claimed');
    expect(reclaimed?.claim_expires_at).toBe(NOW + 20_000 + LEASE);
    expect(reclaimed?.failure_class).toBeNull();
    expect(reclaimed?.attempt_count).toBe(2);
  });

  it('transitions claimed -> failed(permanent) and reports TERMINAL permanently_failed', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7005, NOW);
    await expect(markTelegramUpdateFailed(executor, 7005, NOW + 10, 'permanent')).resolves.toBe(
      true,
    );

    const row = await readRow(7005);
    expect(row?.status).toBe('failed');
    expect(row?.failure_class).toBe('permanent');
    expect(row?.claim_expires_at).toBeNull();

    // FIX 2 (ADR-0031): a permanent failure is TERMINAL — never reclaimable,
    // never re-executed, at ANY later time (lease mechanics do not apply).
    const redelivery = await claimTelegramUpdate(executor, 7005, NOW + 3_600_000);
    expect(redelivery).toEqual({ kind: 'permanently_failed' });
    const unchanged = await readRow(7005);
    expect(unchanged?.status).toBe('failed');
    expect(unchanged?.failure_class).toBe('permanent');
    expect(unchanged?.attempt_count).toBe(1);
  });

  it('never overwrites a terminal state with the guarded transitions', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7006, NOW);
    await expect(markTelegramUpdateProcessed(executor, 7006, NOW + 10)).resolves.toBe(true);
    await expect(markTelegramUpdateFailed(executor, 7006, NOW + 20, 'retryable')).resolves.toBe(
      false,
    );
    await expect(markTelegramUpdateFailed(executor, 7006, NOW + 20, 'permanent')).resolves.toBe(
      false,
    );
    await expect(markTelegramUpdateProcessed(executor, 7006, NOW + 30)).resolves.toBe(false);
  });

  it('returns false for terminal transitions on unknown update ids', async () => {
    const executor = createDbExecutor(env.DB);
    await expect(markTelegramUpdateProcessed(executor, 7099, NOW)).resolves.toBe(false);
    await expect(markTelegramUpdateFailed(executor, 7099, NOW, 'retryable')).resolves.toBe(false);
  });
});

describe('claim lease — expiry boundary (ADR-0030)', () => {
  it('treats a claim at lease minus 1 ms as ACTIVE (in_flight)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7110, NOW);
    const second = await claimTelegramUpdate(executor, 7110, NOW + LEASE - 1);
    expect(second).toEqual({ kind: 'in_flight' });
    expect((await readRow(7110))?.attempt_count).toBe(1);
  });

  it('treats a claim at EXACT expiry as STALE (reclaimable)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7111, NOW);
    const second = await claimTelegramUpdate(executor, 7111, NOW + LEASE);
    expect(second).toEqual({ kind: 'reclaimed_stale' });
    const row = await readRow(7111);
    expect(row?.attempt_count).toBe(2);
    expect(row?.claim_expires_at).toBe(NOW + LEASE + LEASE);
  });

  it('treats a claim AFTER expiry as STALE (reclaimable)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7112, NOW);
    const second = await claimTelegramUpdate(executor, 7112, NOW + LEASE + 1);
    expect(second).toEqual({ kind: 'reclaimed_stale' });
  });

  it('reclaims an abandoned lease-less claim (pre-0002 legacy row) as stale', async () => {
    // A row written before migration 0002 has claim_expires_at = NULL. Such a
    // claim is by definition abandoned (no lease was ever set) and must be
    // recoverable — never stranded inFlight forever (ADR-0030).
    const executor = createDbExecutor(env.DB);
    await executor.run({
      sql: 'INSERT INTO telegram_updates (update_id, received_at, status) VALUES (?, ?, ?)',
      params: [7113, NOW, 'claimed'],
    });
    const recovery = await claimTelegramUpdate(executor, 7113, NOW + 1_000);
    expect(recovery).toEqual({ kind: 'reclaimed_stale' });
    const row = await readRow(7113);
    expect(row?.claim_expires_at).toBe(NOW + 1_000 + LEASE);
    expect(row?.attempt_count).toBe(1);
  });

  it('reclaims a legacy failed row without a failure class as retryable (fail-safe)', async () => {
    // Pre-0002 failed rows carry no class. The fail-safe principle (ADR-0027)
    // treats them as retryable — bounded redelivery instead of update loss —
    // matching migration 0002's documented backfill.
    const executor = createDbExecutor(env.DB);
    await executor.run({
      sql: 'INSERT INTO telegram_updates (update_id, received_at, status) VALUES (?, ?, ?)',
      params: [7114, NOW, 'failed'],
    });
    const recovery = await claimTelegramUpdate(executor, 7114, NOW + 1_000);
    expect(recovery).toEqual({ kind: 'reclaimed_retryable' });
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

  it('produces exactly one stale-claim reclaim winner under concurrency', async () => {
    const executor = createDbExecutor(env.DB);
    // An abandoned claim: written in the past, lease long expired.
    await claimTelegramUpdate(executor, 7101, NOW - 3 * LEASE);

    const results = await Promise.all([
      claimTelegramUpdate(executor, 7101, NOW),
      claimTelegramUpdate(executor, 7101, NOW),
      claimTelegramUpdate(executor, 7101, NOW),
    ]);

    const reclaims = results.filter((r) => r.kind === 'reclaimed_stale');
    const inFlight = results.filter((r) => r.kind === 'in_flight');
    expect(reclaims).toHaveLength(1);
    expect(inFlight).toHaveLength(2);
    // Exactly one attempt was added by the single winning reclaim.
    expect((await readRow(7101))?.attempt_count).toBe(2);
  });

  it('produces exactly one retryable-failed reclaim winner under concurrency', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7102, NOW);
    await markTelegramUpdateFailed(executor, 7102, NOW + 10, 'retryable');

    const results = await Promise.all([
      claimTelegramUpdate(executor, 7102, NOW + 20_000),
      claimTelegramUpdate(executor, 7102, NOW + 20_000),
      claimTelegramUpdate(executor, 7102, NOW + 20_000),
    ]);

    const reclaims = results.filter((r) => r.kind === 'reclaimed_retryable');
    const inFlight = results.filter((r) => r.kind === 'in_flight');
    expect(reclaims).toHaveLength(1);
    expect(inFlight).toHaveLength(2);
  });

  it('never reclaims a permanent failed row under concurrency', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 7103, NOW);
    await markTelegramUpdateFailed(executor, 7103, NOW + 10, 'permanent');

    const results = await Promise.all([
      claimTelegramUpdate(executor, 7103, NOW + 20_000),
      claimTelegramUpdate(executor, 7103, NOW + 20_000),
      claimTelegramUpdate(executor, 7103, NOW + 20_000),
    ]);

    for (const result of results) {
      expect(result).toEqual({ kind: 'permanently_failed' });
    }
    expect((await readRow(7103))?.attempt_count).toBe(1);
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

    const afterFirst = await readRow(7200);
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
    const executor = createDbExecutor(env.DB);
    const rows = await executor.query<{ update_id: number; status: string; received_at: number }>({
      sql: 'SELECT update_id, status, received_at FROM telegram_updates WHERE update_id = ?',
      params: [7200],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('processed');
    expect(rows.rows[0]?.received_at).toBe(afterFirst?.received_at);
  });
});
