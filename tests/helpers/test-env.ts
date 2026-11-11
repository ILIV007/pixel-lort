import type { WorkerEnv } from '../../src/shared/types/env';

/**
 * Build a Phase 0/2A test environment. Values are obviously-fake, non-token
 * placeholders used ONLY by unit tests that call handlers directly.
 * Integration tests use the real vars from wrangler.jsonc via SELF.
 *
 * Phase 2 secrets are intentionally ABSENT here; Telegram-specific tests
 * build their own explicit fake fixtures (never realistic credentials).
 */
export function createTestEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    APP_VERSION: '1.29.0-test',
    ENVIRONMENT: 'development',
    LOG_LEVEL: 'debug',
    // R1.18 (ADR-0046): the read-only review gate ships OFF in the test-env
    // default too — suites that exercise the review surface enable it
    // explicitly.
    ADMIN_REVIEW_ENABLED: 'false',
    // R1.20-R: the admin post pipeline gates ship OFF in the test-env
    // default too — suites that exercise the surface enable them explicitly.
    ADMIN_POST_ENABLED: 'false',
    ADMIN_POST_LIVE_PUBLISH_ENABLED: 'false',
    ...overrides,
  };
}

/** Minimal ExecutionContext mock for direct handler invocation. */
export function createTestExecutionContext(): ExecutionContext & {
  waitUntilCalls: unknown[];
} {
  const waitUntilCalls: unknown[] = [];
  return {
    waitUntil: (promise: unknown) => {
      waitUntilCalls.push(promise);
    },
    passThroughOnException: () => {},
    waitUntilCalls,
  } as unknown as ExecutionContext & { waitUntilCalls: unknown[] };
}

/** Minimal ScheduledController mock for cron smoke tests. */
export function createTestScheduledController(
  cron = '*/5 * * * *',
  scheduledTime = 1_700_000_000_000,
): ScheduledController {
  return {
    cron,
    scheduledTime,
    noRetry: () => {},
  } as unknown as ScheduledController;
}
