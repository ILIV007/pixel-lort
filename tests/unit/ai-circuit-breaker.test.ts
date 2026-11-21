import { beforeEach, describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import {
  AI_CIRCUIT_BREAKER_COOLDOWN_MS,
  AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  AI_CIRCUIT_BREAKER_SETTINGS_KEY,
  checkAiCircuitBreaker,
  readAiCircuitBreaker,
  recordAiCircuitBreakerFailure,
  recordAiCircuitBreakerSuccess,
} from '../../src/application/ai/ai-circuit-breaker';
import {
  createAiDraftService,
  type AiDraftServiceConfig,
} from '../../src/application/ai/draft-service';
import { createAiInboundRewriter } from '../../src/application/inbound/ai-rewriter';
import type { AiCallOutcome, AiProvider, AiProviderPort } from '../../src/domain/ai/types';
import { createLogger } from '../../src/observability/logger';

/**
 * AI circuit breaker + charge-on-success (owner-ordered guards,
 * ai-policy-v2.2 follow-up) over INJECTED FAKES — fully offline; no
 * native binding, no network, no real D1. Real workerd D1 refund
 * authority is covered by tests/integration/ai-budget.test.ts.
 *
 * The stateful fake below is the WHOLE point: the breaker persists in
 * the `settings` table and the budget counter persists in `budgets`,
 * so the fake must remember both across invocations — the plain
 * always-null fakes in ai-draft-service.test.ts cannot observe either.
 */

const silentLogger = createLogger({ level: 'error', sink: () => undefined });

const VALID_DRAFT_JSON = JSON.stringify({
  headlineFa: 'تیتر خبر',
  summaryFa: 'خلاصهٔ خبر',
  claims: [{ text: 'ادعای اول', evidenceIds: ['ev-1'] }],
});

const VALID_REQUEST = {
  taskType: 'news_draft',
  locale: 'fa',
  evidence: [{ id: 'ev-1', text: 'متن شاهد عمومی' }],
};

function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    setNow(value: number) {
      current = value;
    },
  };
}

/**
 * Stateful fake executor: a `settings` map (the breaker row) + a
 * `budgets` counter (one provider's Tehran-day charges). SQL is
 * distinguished by its stable fragments — the same technique the
 * other AI tests use to count authorization batches.
 */
interface StatefulFake extends DbExecutor {
  readonly settings: Map<string, string>;
  budgetRequests: number;
  batchCalls: number;
  refundCalls: number;
  failFirst: boolean;
  failRefunds: boolean;
  denyAll: boolean;
}

function createStatefulExecutor(): StatefulFake {
  const state: StatefulFake = {
    settings: new Map<string, string>(),
    budgetRequests: 0,
    batchCalls: 0,
    refundCalls: 0,
    failFirst: false,
    failRefunds: false,
    denyAll: false,
    async query<T>(): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(statement: { sql: string; params?: readonly unknown[] }): Promise<T | null> {
      if (state.failFirst) {
        throw new Error('settings read down');
      }
      if (statement.sql.includes('FROM settings')) {
        const key = statement.params?.[0] as string;
        const valueJson = state.settings.get(key);
        return (valueJson === undefined ? null : { value_json: valueJson }) as T | null;
      }
      return null;
    },
    async run(statement: { sql: string; params?: readonly unknown[] }): Promise<DbQueryMeta> {
      if (statement.sql.includes('INSERT INTO settings')) {
        const key = statement.params?.[0] as string;
        const valueJson = statement.params?.[1] as string;
        state.settings.set(key, valueJson);
        return { durationMs: 0, changes: 1 };
      }
      if (statement.sql.includes('requests = requests - 1')) {
        state.refundCalls += 1;
        if (state.failRefunds) {
          throw new Error('refund write down');
        }
        if (state.budgetRequests > 0) {
          state.budgetRequests -= 1;
          return { durationMs: 0, changes: 1 };
        }
        return { durationMs: 0, changes: 0 };
      }
      return { durationMs: 0, changes: 1 };
    },
    async batch(statements: readonly { sql: string }[]): Promise<readonly DbQueryMeta[]> {
      state.batchCalls += 1;
      if (!state.denyAll) {
        state.budgetRequests += 1;
      }
      return statements.map(() => ({ durationMs: 0, changes: state.denyAll ? 0 : 1 }));
    },
  };
  return state;
}

function readBreakerRow(executor: StatefulFake): unknown {
  const raw = executor.settings.get(AI_CIRCUIT_BREAKER_SETTINGS_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

interface FakePort {
  readonly provider: AiProvider;
  readonly calls: string[];
  setOutcomes(outcomes: readonly AiCallOutcome[]): void;
}

function createFakePort(provider: AiProvider): FakePort & AiProviderPort {
  const calls: string[] = [];
  const queue: AiCallOutcome[] = [];
  return {
    provider,
    calls,
    setOutcomes(next: readonly AiCallOutcome[]) {
      queue.length = 0;
      queue.push(...next);
    },
    async complete(input: { modelId: string }) {
      calls.push(input.modelId);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('fake port exhausted its scripted outcomes');
      }
      return next;
    },
  } as FakePort & AiProviderPort;
}

function baseConfig(overrides: Partial<AiDraftServiceConfig> = {}): AiDraftServiceConfig {
  return {
    aiEnabled: true,
    geminiEnabled: false,
    workersAiBindingPresent: true,
    geminiApiKeyPresent: false,
    ...overrides,
  };
}

describe('AI circuit breaker — durable settings state', () => {
  let executor: StatefulFake;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    executor = createStatefulExecutor();
  });

  it('starts CLOSED when no row exists, and a failed read throws (callers fail open)', async () => {
    expect(await readAiCircuitBreaker(executor, NOW)).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
      openedAtMs: null,
    });
    expect(await checkAiCircuitBreaker(executor, NOW)).toMatchObject({
      allow: true,
      probe: false,
    });
    executor.failFirst = true;
    await expect(readAiCircuitBreaker(executor, NOW)).rejects.toThrow();
  });

  it('opens exactly at the threshold of consecutive failures', async () => {
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1; i += 1) {
      const snapshot = await recordAiCircuitBreakerFailure(executor, NOW);
      expect(snapshot.state).toBe('closed');
    }
    const opened = await recordAiCircuitBreakerFailure(executor, NOW);
    expect(opened.state).toBe('open');
    expect(opened.openedAtMs).toBe(NOW);
    expect(await checkAiCircuitBreaker(executor, NOW)).toMatchObject({ allow: false });
    expect(readBreakerRow(executor)).toMatchObject({ state: 'open' });
  });

  it('a success resets the counter before the threshold', async () => {
    await recordAiCircuitBreakerFailure(executor, NOW);
    await recordAiCircuitBreakerFailure(executor, NOW);
    const reset = await recordAiCircuitBreakerSuccess(executor, NOW);
    expect(reset).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(await checkAiCircuitBreaker(executor, NOW)).toMatchObject({ allow: true });
  });

  it('a success on a clean closed breaker writes nothing', async () => {
    await recordAiCircuitBreakerSuccess(executor, NOW);
    expect(executor.settings.has(AI_CIRCUIT_BREAKER_SETTINGS_KEY)).toBe(false);
  });

  it('stays OPEN inside the cooldown, then admits a half-open probe', async () => {
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await recordAiCircuitBreakerFailure(executor, NOW);
    }
    expect(
      await checkAiCircuitBreaker(executor, NOW + AI_CIRCUIT_BREAKER_COOLDOWN_MS - 1),
    ).toMatchObject({ allow: false });
    const probe = await checkAiCircuitBreaker(executor, NOW + AI_CIRCUIT_BREAKER_COOLDOWN_MS);
    expect(probe).toMatchObject({ allow: true, probe: true });
    expect(readBreakerRow(executor)).toMatchObject({ state: 'half_open' });
  });

  it('a probe failure re-opens with a fresh cooldown; a probe success closes', async () => {
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await recordAiCircuitBreakerFailure(executor, NOW);
    }
    await checkAiCircuitBreaker(executor, NOW + AI_CIRCUIT_BREAKER_COOLDOWN_MS);
    const reopened = await recordAiCircuitBreakerFailure(
      executor,
      NOW + AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1_000,
    );
    expect(reopened.state).toBe('open');
    expect(reopened.openedAtMs).toBe(NOW + AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1_000);
    // Fresh cooldown from the re-open: still denied just before it ends.
    expect(
      await checkAiCircuitBreaker(executor, NOW + 2 * AI_CIRCUIT_BREAKER_COOLDOWN_MS),
    ).toMatchObject({ allow: false });
    await checkAiCircuitBreaker(executor, NOW + 2 * AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1);
    const closed = await recordAiCircuitBreakerSuccess(
      executor,
      NOW + 2 * AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1,
    );
    expect(closed).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('a malformed row fails open to CLOSED', async () => {
    executor.settings.set(AI_CIRCUIT_BREAKER_SETTINGS_KEY, '{not json');
    expect(await checkAiCircuitBreaker(executor, NOW)).toMatchObject({
      allow: true,
      probe: false,
    });
    executor.settings.set(
      AI_CIRCUIT_BREAKER_SETTINGS_KEY,
      JSON.stringify({ state: 'open', consecutive_failures: 5 }),
    );
    // OPEN without an opened_at is not a valid open state — fail open.
    expect(await checkAiCircuitBreaker(executor, NOW)).toMatchObject({ allow: true });
  });
});

describe('AI draft service — circuit breaker across invocations', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let cfPort: FakePort & AiProviderPort;

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    cfPort = createFakePort('workers-ai');
  });

  function buildService() {
    return createAiDraftService({
      executor,
      ports: { 'workers-ai': cfPort },
      clock,
      logger: silentLogger,
      config: baseConfig(),
    });
  }

  /** One invocation whose two CF models both fail transiently. */
  async function failingInvocation() {
    cfPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    return buildService().generateNewsDraft(VALID_REQUEST);
  }

  it('opens after consecutive failures, then skips calls AND charges with circuit_open', async () => {
    // Two provider failures per invocation (gemma → qwen): the breaker
    // opens during the third invocation (2 + 2 + 1 ≥ 5).
    for (let i = 0; i < 3; i += 1) {
      const outcome = await failingInvocation();
      expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    }
    expect(readBreakerRow(executor)).toMatchObject({ state: 'open' });

    const batchCallsBefore = executor.batchCalls;
    const portCallsBefore = cfPort.calls.length;
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toEqual({ kind: 'deferred', reason: 'circuit_open', attempts: [] });
    expect(cfPort.calls).toHaveLength(portCallsBefore); // ZERO provider calls
    expect(executor.batchCalls).toBe(batchCallsBefore); // ZERO charges
    expect(executor.budgetRequests).toBe(0); // every failed attempt refunded
  });

  it('half-open probe after the cooldown: success closes, later calls work normally', async () => {
    for (let i = 0; i < 3; i += 1) {
      await failingInvocation();
    }
    expect(readBreakerRow(executor)).toMatchObject({ state: 'open' });

    clock.setNow(clock.now() + AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1);
    cfPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const probe = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(probe.kind).toBe('draft');
    expect(readBreakerRow(executor)).toMatchObject({ state: 'closed', consecutive_failures: 0 });

    cfPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const next = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(next.kind).toBe('draft');
    expect(executor.budgetRequests).toBe(2); // probe + next, both kept
  });

  it('half-open probe failure re-opens: the next call is circuit_open again', async () => {
    for (let i = 0; i < 3; i += 1) {
      await failingInvocation();
    }
    clock.setNow(clock.now() + AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1);
    const probe = await failingInvocation();
    expect(probe).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(readBreakerRow(executor)).toMatchObject({ state: 'open' });

    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toEqual({ kind: 'deferred', reason: 'circuit_open', attempts: [] });
  });

  it('a failed breaker read fails open: drafting proceeds', async () => {
    executor.failFirst = true;
    cfPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome.kind).toBe('draft');
  });
});

describe('AI draft service — charge-on-success refund rules', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let cfPort: FakePort & AiProviderPort;

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    cfPort = createFakePort('workers-ai');
  });

  function buildService() {
    return createAiDraftService({
      executor,
      ports: { 'workers-ai': cfPort },
      clock,
      logger: silentLogger,
      config: baseConfig(),
    });
  }

  it('transient failures refund: net budget 0 after the ladder exhausts', async () => {
    cfPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(executor.batchCalls).toBe(2); // two authorizations happened
    expect(executor.refundCalls).toBe(2); // ...and both were refunded
    expect(executor.budgetRequests).toBe(0);
  });

  it('deadline_exceeded refunds; invalid_output keeps the charge', async () => {
    cfPort.setOutcomes([{ kind: 'deadline_exceeded' }, { kind: 'deadline_exceeded' }]);
    const deadlineOutcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(deadlineOutcome).toMatchObject({ kind: 'deferred', reason: 'deadline_exceeded' });
    // deadline_exceeded returns immediately after the FIRST attempt: one
    // authorization, one refund.
    expect(executor.refundCalls).toBe(1);
    expect(executor.budgetRequests).toBe(0);

    cfPort.setOutcomes([
      { kind: 'ok', rawText: 'not json at all' },
      { kind: 'ok', rawText: '{"headlineFa":1}' },
    ]);
    const invalidOutcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(invalidOutcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    // The provider answered twice: both charges stay.
    expect(executor.budgetRequests).toBe(2);
    expect(executor.refundCalls).toBe(1); // only the deadline refund above
  });

  it('auth_failed refunds; quota_denied keeps the charge', async () => {
    cfPort.setOutcomes([{ kind: 'auth_failed' }]);
    const authOutcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(authOutcome).toMatchObject({ kind: 'deferred', reason: 'provider_auth_failed' });
    expect(executor.budgetRequests).toBe(0);

    cfPort.setOutcomes([{ kind: 'quota_denied' }]);
    const quotaOutcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(quotaOutcome).toMatchObject({ kind: 'deferred', reason: 'budget_denied' });
    expect(executor.budgetRequests).toBe(1); // provider quota verdict: kept
  });

  it('success keeps the charge', async () => {
    cfPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome.kind).toBe('draft');
    expect(executor.budgetRequests).toBe(1);
    expect(executor.refundCalls).toBe(0);
  });

  it('a denied authorization never charges, so there is nothing to refund', async () => {
    executor.denyAll = true;
    cfPort.setOutcomes([{ kind: 'transient' }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'budget_denied' });
    expect(cfPort.calls).toHaveLength(0);
    expect(executor.budgetRequests).toBe(0);
    expect(executor.refundCalls).toBe(0);
  });

  it('a refund failure never fails the run', async () => {
    executor.failRefunds = true;
    cfPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(cfPort.calls).toHaveLength(2);
    expect(executor.refundCalls).toBe(2); // attempted twice, both failed
    expect(executor.budgetRequests).toBe(2); // charges stand when refunds fail
  });
});

describe('inbound AI rewriter — circuit breaker and charge-on-success', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let port: FakePort & AiProviderPort;

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    port = createFakePort('workers-ai');
  });

  function buildRewriter() {
    return createAiInboundRewriter({
      executor,
      ports: { 'workers-ai': port },
      clock,
      logger: silentLogger,
      config: baseConfig(),
    });
  }

  const INPUT = { text: 'متن خام', category: 'news' as const, isCaption: false };

  async function failingRewrite() {
    port.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    return buildRewriter().rewrite(INPUT);
  }

  it('opens after consecutive failures, then returns circuit_open with zero calls/charges', async () => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await failingRewrite();
      expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    }
    expect(readBreakerRow(executor)).toMatchObject({ state: 'open' });

    const batchCallsBefore = executor.batchCalls;
    const portCallsBefore = port.calls.length;
    const outcome = await buildRewriter().rewrite(INPUT);
    expect(outcome).toEqual({ kind: 'deferred', reason: 'circuit_open', attempts: 0 });
    expect(port.calls).toHaveLength(portCallsBefore);
    expect(executor.batchCalls).toBe(batchCallsBefore);
    expect(executor.budgetRequests).toBe(0);
  });

  it('half-open probe success closes the breaker; failures refund', async () => {
    for (let i = 0; i < 3; i += 1) {
      await failingRewrite();
    }
    clock.setNow(clock.now() + AI_CIRCUIT_BREAKER_COOLDOWN_MS + 1);
    port.setOutcomes([{ kind: 'ok', rawText: 'متن بازنویسی‌شده.' }]);
    const probe = await buildRewriter().rewrite(INPUT);
    expect(probe.kind).toBe('ok');
    expect(readBreakerRow(executor)).toMatchObject({ state: 'closed', consecutive_failures: 0 });
    expect(executor.budgetRequests).toBe(1); // probe kept; failures refunded
  });

  it('a refund failure never fails the rewrite', async () => {
    executor.failRefunds = true;
    port.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    const outcome = await buildRewriter().rewrite(INPUT);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(port.calls).toHaveLength(2);
  });
});
