import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/entrypoints/worker';
import {
  createTestEnv,
  createTestExecutionContext,
  createTestScheduledController,
} from '../helpers/test-env';

/**
 * Scheduled handler smoke test (Phase 0: typed no-op foundation).
 * Asserts the handler resolves without side effects and without throwing.
 */
describe('scheduled handler', () => {
  it('resolves without throwing for a standard cron trigger', async () => {
    const env = createTestEnv();
    const ctx = createTestExecutionContext();
    const controller = createTestScheduledController();

    await expect(worker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
  });

  it('does not schedule follow-up work via waitUntil', async () => {
    const env = createTestEnv();
    const ctx = createTestExecutionContext();
    const controller = createTestScheduledController('0 * * * *');

    await worker.scheduled(controller, env, ctx);
    expect(ctx.waitUntilCalls).toHaveLength(0);
  });

  it('is a no-op for arbitrary cron expressions', async () => {
    const env = createTestEnv();
    const ctx = createTestExecutionContext();
    const controller = createTestScheduledController('17 3 * * 1');

    await expect(worker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
    expect(vi.isMockFunction(controller.noRetry)).toBe(false);
  });
});
