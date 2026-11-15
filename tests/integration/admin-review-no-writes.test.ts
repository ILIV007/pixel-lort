import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  NOW,
  OWNER_ID,
  buildReviewHarness,
  createCountingExecutor,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import type { TelegramIngressDeps } from '../../src/application/telegram-ingress';
import { createEditorialReviewService } from '../../src/application/editorial/draft-review-view';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import { createLogger } from '../../src/observability/logger';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * R1.18 non-effects tests: a read command mutates ZERO editorial/AI/job/
 * publication/budget tables; the expected existing Telegram update
 * lifecycle writes remain; replayed processed updates suppress duplicate
 * execution; transient DB failures stay retryable (never fake
 * empty/not-found); a missing Bot API is never falsely processed; a
 * missing review service is an honest retryable wiring failure.
 */

const EDITORIAL_TABLES = [
  'drafts',
  'stories',
  'claims',
  'evidence',
  'story_entities',
  'story_fingerprints',
  'ai_runs',
  'jobs',
  'publications',
  'budgets',
] as const;

async function seedOneReadyDraft(): Promise<void> {
  await seedStory('story-writes', 'داستان نوشتن');
  await seedDraft({
    id: 'draft-writes-1',
    storyId: 'story-writes',
    title: 'پیش‌نویس نوشتن',
    documentJson: JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: 'پیش‌نویس نوشتن',
      summaryFa: 'خلاصه',
      sourceReport: {
        sourceItemId: 'i-writes',
        sourceName: 'منبع',
        stance: 'mentions',
        excerptText: 'متن',
        truncated: false,
      },
      modelClaims: [],
    }),
  });
}

beforeEach(async () => {
  await freshDb();
  await seedOneReadyDraft();
});

/** Table counts via a RAW executor — meta-queries never pollute counters. */
async function rawTableCounts(): Promise<Map<string, number>> {
  const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  const counts = new Map<string, number>();
  for (const table of EDITORIAL_TABLES) {
    const row = await raw.first<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
    counts.set(table, row?.n ?? -1);
  }
  return counts;
}

describe('zero editorial mutation', () => {
  it('list + detail mutate no editorial/AI/job/publication/budget table', async () => {
    const harness = buildReviewHarness();
    const before = await rawTableCounts();
    await harness.ingress.processUpdate(privateMessage(7800, OWNER_ID, '/drafts'));
    await harness.ingress.processUpdate(privateMessage(7801, OWNER_ID, '/drafts draft-writes-1'));
    const after = await rawTableCounts();
    for (const table of EDITORIAL_TABLES) {
      expect(after.get(table)).toBe(before.get(table));
    }
    // Zero WRITE statements touched drafts at any point in both commands.
    const draftsWriteSql = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bdrafts\b/i.test(sql))
      .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
    expect(draftsWriteSql).toHaveLength(0);
    // Two editorial SELECTs total (list + detail), nothing else on drafts.
    expect(harness.executor.stats().draftsSql).toBe(2);
  });

  it('the expected existing Telegram update lifecycle rows remain (honest, not zero-write)', async () => {
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7802, OWNER_ID, '/drafts'));
    const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const row = await raw.first<{ status: string }>({
      sql: 'SELECT status FROM telegram_updates WHERE update_id = 7802',
    });
    expect(row?.status).toBe('processed');
  });

  it('replayed processed update suppresses duplicate execution (one send only)', async () => {
    const harness = buildReviewHarness();
    const update = privateMessage(7803, OWNER_ID, '/drafts');
    expect(await harness.ingress.processUpdate(update)).toBe('processed');
    expect(await harness.ingress.processUpdate(update)).toBe('duplicate');
    expect(harness.sends).toHaveLength(1);
  });

  it('transient drafts-read failure stays retryable — never a fake empty page or not-found', async () => {
    const delegate = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    let failNextDraftsRead = true;
    const executor: DbExecutor = {
      query: async (statement) => {
        if (failNextDraftsRead && /FROM drafts/i.test(statement.sql)) {
          failNextDraftsRead = false;
          throw new Error('simulated transient D1 outage');
        }
        return delegate.query(statement);
      },
      first: async (statement) => {
        if (failNextDraftsRead && /FROM drafts/i.test(statement.sql)) {
          failNextDraftsRead = false;
          throw new Error('simulated transient D1 outage');
        }
        return delegate.first(statement);
      },
      run: (statement) => delegate.run(statement),
      batch: (statements) => delegate.batch(statements),
    };
    const counting = createCountingExecutor(executor);
    const harness = buildReviewHarness({ executor: counting });
    // First delivery: the transient failure propagates (503 semantics).
    let firstError: unknown = null;
    try {
      await harness.ingress.processUpdate(privateMessage(7804, OWNER_ID, '/drafts'));
    } catch (error) {
      firstError = error;
    }
    expect(firstError).not.toBeNull();
    const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const failed = await raw.first<{ status: string; failure_class: string | null }>({
      sql: 'SELECT status, failure_class FROM telegram_updates WHERE update_id = 7804',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.failure_class).toBe('retryable');
    expect(harness.sends).toHaveLength(0);
    // Redelivery (a NEW update id): the read path works — no fabricated state.
    await expect(
      harness.ingress.processUpdate(privateMessage(7805, OWNER_ID, '/drafts')),
    ).resolves.toBe('processed');
    expect(harness.sends).toHaveLength(1);
  });

  it('missing Bot API (offline): the read is computed, the reply fails retryably — never falsely processed', async () => {
    const executor = createCountingExecutor(createDbExecutor(env.DB, { clock: fixedClock(NOW) }));
    const deps: TelegramIngressDeps = {
      executor,
      authorization: createAuthorizationService({
        ownerTelegramId: OWNER_ID,
        lookup: createAdminRoleLookup(executor),
      }),
      commandRouter: createCommandRouter({ applicationVersion: '1.12.3', reviewEnabled: true }),
      editorialReview: createEditorialReviewService({ executor }),
      // botApi deliberately ABSENT — documented offline mode.
      clock: fixedClock(NOW),
      logger: createLogger({ level: 'error', clock: fixedClock(NOW) }),
    };
    const ingress = createTelegramIngress(deps);
    await expect(
      ingress.processUpdate(privateMessage(7806, OWNER_ID, '/drafts')),
    ).rejects.toThrow();
    const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const failed = await raw.first<{ status: string; failure_class: string | null }>({
      sql: 'SELECT status, failure_class FROM telegram_updates WHERE update_id = 7806',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.failure_class).toBe('retryable');
  });

  it('gate ON with the review service missing: honest retryable wiring failure, not silence', async () => {
    const harness = buildReviewHarness({ omitReviewService: true });
    await expect(
      harness.ingress.processUpdate(privateMessage(7807, OWNER_ID, '/drafts')),
    ).rejects.toThrow();
    const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const failed = await raw.first<{ status: string; failure_class: string | null }>({
      sql: 'SELECT status, failure_class FROM telegram_updates WHERE update_id = 7807',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.failure_class).toBe('retryable');
    expect(harness.sends).toHaveLength(0);
  });
});
