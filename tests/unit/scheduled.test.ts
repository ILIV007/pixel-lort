import { describe, expect, it } from 'vitest';
import worker from '../../src/entrypoints/worker';
import {
  createTestEnv,
  createTestExecutionContext,
  createTestScheduledController,
} from '../helpers/test-env';

/**
 * Scheduled handler unit tests — fail-closed activation (ADR-0036 §7).
 * The default test environment has NO JOBS_ENABLED flag and NO D1 binding:
 * the pass must be a structured no-op (Phase 2 Telegram-only behavior
 * preserved). Enabled-path behavior is covered by the integration suite.
 */
describe('scheduled handler (engine disabled — default environment)', () => {
  it('resolves without throwing for the blueprint cron schedule', async () => {
    await expect(
      worker.scheduled(createTestScheduledController(), createTestEnv(), createTestExecutionContext()),
    ).resolves.toBeUndefined();
  });

  it('does not schedule follow-up work via waitUntil', async () => {
    const ctx = createTestExecutionContext();
    await worker.scheduled(createTestScheduledController('0 * * * *'), createTestEnv(), ctx);
    expect(ctx.waitUntilCalls).toHaveLength(0);
  });

  it('is a structured no-op for arbitrary cron expressions', async () => {
    await expect(
      worker.scheduled(createTestScheduledController('17 3 * * 1'), createTestEnv(), createTestExecutionContext()),
    ).resolves.toBeUndefined();
  });
});
