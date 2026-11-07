import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  AI_BUDGET_SCOPE,
  authorizeAiRequestAttempt,
  readAiBudget,
  recordAiUsage,
} from '../../src/adapters/db/ai-budget-store';
import { tehranBudgetDay } from '../../src/shared/time/tehran-day';

/**
 * AI request-budget authority on REAL disposable workerd D1 (Phase 6,
 * ADR-0041 §4): atomic per-attempt authorization under the cap, race
 * safety, Tehran-day bucketing, scope isolation from ingestion, and
 * non-authoritative usage recording.
 */

const DAY1 = Date.UTC(2025, 9, 6, 12, 0, 0); // Tehran 2025-10-06 15:30
const DAY2 = Date.UTC(2025, 9, 6, 20, 31, 0); // Tehran 2025-10-07 00:01

const executor: DbExecutor = createDbExecutor(env.DB);

beforeEach(async () => {
  await applyMigrations(env.DB);
  await executor.run({ sql: `DELETE FROM budgets WHERE scope = '${AI_BUDGET_SCOPE}'` });
  await executor.run({ sql: `DELETE FROM budgets WHERE scope = 'ingestion'` });
  await executor.run({ sql: 'DELETE FROM sources' });
});

describe('authorizeAiRequestAttempt', () => {
  it('creates the day row on first charge under the cap', async () => {
    const result = await authorizeAiRequestAttempt(executor, {
      provider: 'workers-ai',
      cap: 5,
      nowMs: DAY1,
    });
    expect(result).toEqual({ kind: 'authorized', bucketDate: '2025-10-06' });
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY1 })).toBe(1);
  });

  it('accumulates to the cap, then denies without a network call concept', async () => {
    for (let i = 0; i < 5; i += 1) {
      const authorized = await authorizeAiRequestAttempt(executor, {
        provider: 'workers-ai',
        cap: 5,
        nowMs: DAY1,
      });
      expect(authorized.kind).toBe('authorized');
    }
    const denied = await authorizeAiRequestAttempt(executor, {
      provider: 'workers-ai',
      cap: 5,
      nowMs: DAY1,
    });
    expect(denied).toEqual({ kind: 'denied', bucketDate: '2025-10-06' });
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY1 })).toBe(5);
  });

  it('a cap of 0 denies every attempt', async () => {
    const denied = await authorizeAiRequestAttempt(executor, {
      provider: 'gemini',
      cap: 0,
      nowMs: DAY1,
    });
    expect(denied.kind).toBe('denied');
    expect(await readAiBudget(executor, { provider: 'gemini', nowMs: DAY1 })).toBe(0);
  });

  it('is race-safe: concurrent authorizations never exceed the cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 5, nowMs: DAY1 }),
      ),
    );
    const authorized = results.filter((result) => result.kind === 'authorized');
    const denied = results.filter((result) => result.kind === 'denied');
    expect(authorized).toHaveLength(5);
    expect(denied).toHaveLength(7);
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY1 })).toBe(5);
  });

  it('rolls over to a NEW Tehran-day bucket without touching the previous day', async () => {
    for (let i = 0; i < 3; i += 1) {
      await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 3, nowMs: DAY1 });
    }
    const deniedOnDay1 = await authorizeAiRequestAttempt(executor, {
      provider: 'workers-ai',
      cap: 3,
      nowMs: DAY1,
    });
    expect(deniedOnDay1.kind).toBe('denied');

    const authorizedOnDay2 = await authorizeAiRequestAttempt(executor, {
      provider: 'workers-ai',
      cap: 3,
      nowMs: DAY2,
    });
    expect(authorizedOnDay2).toEqual({ kind: 'authorized', bucketDate: '2025-10-07' });
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY1 })).toBe(3);
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY2 })).toBe(1);
  });

  it('keeps per-provider accounting separate (distinct budget_key rows)', async () => {
    await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 5, nowMs: DAY1 });
    await authorizeAiRequestAttempt(executor, { provider: 'gemini', cap: 5, nowMs: DAY1 });
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY1 })).toBe(1);
    expect(await readAiBudget(executor, { provider: 'gemini', nowMs: DAY1 })).toBe(1);
  });
});

describe('recordAiUsage and scope isolation', () => {
  it('records reported tokens without changing the charged attempt count', async () => {
    await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 5, nowMs: DAY1 });
    const recorded = await recordAiUsage(executor, {
      provider: 'workers-ai',
      bucketDate: tehranBudgetDay(DAY1),
      inputTokens: 100,
      outputTokens: 30,
      nowMs: DAY1,
    });
    expect(recorded).toBe(true);
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY1 })).toBe(1);
    const row = await executor.first<{
      requests: number;
      input_tokens: number;
      output_tokens: number;
    }>({
      sql: `SELECT requests, input_tokens, output_tokens FROM budgets WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = 'workers-ai' AND bucket_date = '2025-10-06'`,
    });
    expect(row).toEqual({ requests: 1, input_tokens: 100, output_tokens: 30 });
  });

  it('usage recording with no existing row reports honestly (no ghost row)', async () => {
    const recorded = await recordAiUsage(executor, {
      provider: 'gemini',
      bucketDate: tehranBudgetDay(DAY1),
      inputTokens: 10,
      outputTokens: 5,
      nowMs: DAY1,
    });
    expect(recorded).toBe(false);
    expect(await readAiBudget(executor, { provider: 'gemini', nowMs: DAY1 })).toBe(0);
  });

  it('never mingles AI accounting with ingestion accounting', async () => {
    // Seed one source + an ingestion budget row (the Phase 4 authority).
    await executor.run({
      sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds, daily_request_budget, approval_policy, created_at, updated_at)
            VALUES ('probe-source', 'Probe', 'rss', 'official', 50, 1, 3600, 10, 'auto', ${DAY1}, ${DAY1})`,
    });
    await executor.run({
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            VALUES ('ingestion', 'probe-source', '2025-10-06', 7, 0, 0, 0, ${DAY1})`,
    });

    // AI authorizations on the SAME day must not touch ingestion rows.
    for (let i = 0; i < 2; i += 1) {
      await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 5, nowMs: DAY1 });
    }
    const ingestionRow = await executor.first<{ requests: number }>({
      sql: `SELECT requests FROM budgets WHERE scope = 'ingestion' AND budget_key = 'probe-source' AND bucket_date = '2025-10-06'`,
    });
    expect(ingestionRow?.requests).toBe(7);
    const aiRow = await executor.first<{ requests: number }>({
      sql: `SELECT requests FROM budgets WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = 'workers-ai' AND bucket_date = '2025-10-06'`,
    });
    expect(aiRow?.requests).toBe(2);
  });
});
