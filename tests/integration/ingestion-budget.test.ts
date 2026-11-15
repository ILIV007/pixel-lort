import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  reserveIngestionBudget,
  reconcileIngestionBudget,
  readIngestionBudget,
} from '../../src/adapters/db/ingestion-budget-store';
import { tehranBudgetDay } from '../../src/shared/time/tehran-day';

/**
 * Ingestion budget on REAL workerd D1 (Phase 4 — ADR-0038 §6): atomic
 * pre-network reservation, cap enforcement under races, Tehran day
 * rollover without a reset write, honest reconciliation.
 */

const DAY1 = Date.UTC(2025, 9, 6, 12, 0, 0); // Tehran 2025-10-06 15:30
const DAY2 = Date.UTC(2025, 9, 6, 20, 31, 0); // Tehran 2025-10-07 00:01

const executor: DbExecutor = createDbExecutor(env.DB);

beforeEach(async () => {
  await applyMigrations(env.DB);
  await executor.run({ sql: 'DELETE FROM source_state' });
  await executor.run({ sql: 'DELETE FROM sources' });
  await executor.run({ sql: "DELETE FROM budgets WHERE scope = 'ingestion'" });
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) throw new Error('registry invalid');
  await seedSourcesFromRegistry(executor, registry.registry, DAY1);
});

describe('reserveIngestionBudget', () => {
  it('reserves under the cap on a fresh day row', async () => {
    const result = await reserveIngestionBudget(executor, {
      sourceId: 'playstation_blog', // daily budget 300
      count: 1,
      nowMs: DAY1,
    });
    expect(result).toMatchObject({ kind: 'reserved', bucketDate: '2025-10-06', requests: 1 });
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      1,
    );
  });

  it('accumulates across reservations until the cap, then exhausts', async () => {
    // Shrink the cap for a crisp boundary.
    await executor.run({
      sql: 'UPDATE sources SET daily_request_budget = 3 WHERE id = ?',
      params: ['playstation_blog'],
    });
    expect(
      (
        await reserveIngestionBudget(executor, {
          sourceId: 'playstation_blog',
          count: 2,
          nowMs: DAY1,
        })
      ).kind,
    ).toBe('reserved');
    expect(
      (
        await reserveIngestionBudget(executor, {
          sourceId: 'playstation_blog',
          count: 1,
          nowMs: DAY1,
        })
      ).kind,
    ).toBe('reserved');
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      3,
    );
    // Exactly at cap: any further reservation is refused.
    const exhausted = await reserveIngestionBudget(executor, {
      sourceId: 'playstation_blog',
      count: 1,
      nowMs: DAY1,
    });
    expect(exhausted).toMatchObject({ kind: 'exhausted', bucketDate: '2025-10-06' });
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      3,
    );
  });

  it('rolls over implicitly at the Tehran day boundary (no reset write)', async () => {
    await executor.run({
      sql: 'UPDATE sources SET daily_request_budget = 3 WHERE id = ?',
      params: ['playstation_blog'],
    });
    await reserveIngestionBudget(executor, { sourceId: 'playstation_blog', count: 3, nowMs: DAY1 });
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      3,
    );
    // Next Tehran day: a NEW bucket (fresh counter, old row untouched).
    expect(tehranBudgetDay(DAY2)).toBe('2025-10-07');
    const next = await reserveIngestionBudget(executor, {
      sourceId: 'playstation_blog',
      count: 1,
      nowMs: DAY2,
    });
    expect(next).toMatchObject({ kind: 'reserved', bucketDate: '2025-10-07' });
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      3,
    );
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY2 })).toBe(
      1,
    );
  });

  it('isolates budgets per source', async () => {
    await executor.run({
      sql: 'UPDATE sources SET daily_request_budget = 1 WHERE id = ?',
      params: ['playstation_blog'],
    });
    expect(
      (
        await reserveIngestionBudget(executor, {
          sourceId: 'playstation_blog',
          count: 1,
          nowMs: DAY1,
        })
      ).kind,
    ).toBe('reserved');
    // Another source with its own cap is unaffected.
    expect(
      (await reserveIngestionBudget(executor, { sourceId: 'xbox_wire', count: 1, nowMs: DAY1 }))
        .kind,
    ).toBe('reserved');
    expect(
      (
        await reserveIngestionBudget(executor, {
          sourceId: 'playstation_blog',
          count: 1,
          nowMs: DAY1,
        })
      ).kind,
    ).toBe('exhausted');
  });

  it('reports a missing source distinctly from exhaustion', async () => {
    const result = await reserveIngestionBudget(executor, {
      sourceId: 'nonexistent_source',
      count: 1,
      nowMs: DAY1,
    });
    expect(result).toMatchObject({ kind: 'source_missing' });
  });

  it('survives overlapping concurrent reservations without exceeding the cap', async () => {
    await executor.run({
      sql: 'UPDATE sources SET daily_request_budget = 5 WHERE id = ?',
      params: ['playstation_blog'],
    });
    // 8 concurrent single-request reservations on a cap of 5.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserveIngestionBudget(executor, { sourceId: 'playstation_blog', count: 1, nowMs: DAY1 }),
      ),
    );
    const reserved = results.filter((r) => r.kind === 'reserved').length;
    const exhausted = results.filter((r) => r.kind === 'exhausted').length;
    expect(reserved).toBe(5); // EXACTLY the cap — never over
    expect(exhausted).toBe(3);
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      5,
    );
  });
});

describe('reconcileIngestionBudget', () => {
  it('records observed extra requests (redirect hops) best-effort', async () => {
    await reserveIngestionBudget(executor, { sourceId: 'playstation_blog', count: 1, nowMs: DAY1 });
    const recorded = await reconcileIngestionBudget(executor, {
      sourceId: 'playstation_blog',
      extraCount: 2,
      nowMs: DAY1,
    });
    expect(recorded).toBe(2);
    expect(await readIngestionBudget(executor, { sourceId: 'playstation_blog', nowMs: DAY1 })).toBe(
      3,
    );
  });

  it('is a no-op for zero extras or unknown rows', async () => {
    expect(
      await reconcileIngestionBudget(executor, {
        sourceId: 'xbox_wire',
        extraCount: 0,
        nowMs: DAY1,
      }),
    ).toBe(0);
    expect(await readIngestionBudget(executor, { sourceId: 'xbox_wire', nowMs: DAY1 })).toBe(0);
  });
});
