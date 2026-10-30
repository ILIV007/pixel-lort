import { describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import {
  createEventRelationService,
  type EventRelationServiceConfig,
} from '../../src/application/ai/event-relation-service';
import type { AiCallOutcome, AiProvider, AiProviderPort } from '../../src/domain/ai/types';
import { createLogger } from '../../src/observability/logger';

/**
 * The BOUNDED event-relation service (R1.17) over INJECTED FAKES — fully
 * offline. The shared budget/deadline/allowlist protections are exercised
 * at the seam the service owns; REAL workerd D1 budget authority is
 * covered by tests/integration/ai-budget.test.ts and the R1.17
 * integration suite. Fixture outputs prove CONTRACT correctness, never
 * model quality.
 */

function createFakeExecutor(options: { denyAll?: boolean } = {}): DbExecutor {
  return {
    async query<T>(_: { sql: string }): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(_: { sql: string }): Promise<T | null> {
      return null;
    },
    async run(_: { sql: string }): Promise<DbQueryMeta> {
      return { durationMs: 0, changes: 1 };
    },
    async batch(statements: readonly { sql: string }[]): Promise<readonly DbQueryMeta[]> {
      return statements.map(() => ({ durationMs: 0, changes: options.denyAll ? 0 : 1 }));
    },
  };
}

function createFakePort(
  provider: AiProvider,
  outcomes: readonly AiCallOutcome[],
): AiProviderPort & { calls: number } {
  const queue = [...outcomes];
  let calls = 0;
  return {
    provider,
    get calls() {
      return calls;
    },
    async complete() {
      calls += 1;
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('fake port exhausted');
      }
      return next;
    },
  } as AiProviderPort & { calls: number };
}

const fixedClock = {
  now: () => 1_700_000_000_000,
};

const silentLogger = createLogger({ level: 'error', sink: () => undefined });

function validOkOutput(
  pairId: string,
  sideAEvidenceId: string,
  sideBEvidenceId: string,
): AiCallOutcome {
  return {
    kind: 'ok',
    rawText: JSON.stringify({
      pairId,
      verdict: 'same_event_proposed',
      reasons: ['هر دو یک اطلاعیه را ترجمه کرده‌اند'],
      references: [
        { side: 'A', evidenceId: sideAEvidenceId },
        { side: 'B', evidenceId: sideBEvidenceId },
      ],
      conflicts: [],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function pairRequest(pairId: 'erp-1' | 'erp-2', sideBStoryId: string) {
  return {
    pairId,
    sideA: {
      evidenceId: 'item-self',
      text: 'متن فارسی رویداد',
      storyId: 'edst_self',
      sourceItemId: 'item-self',
      contentHash: 'a'.repeat(64),
    },
    sideB: {
      evidenceId: 'item-other',
      text: 'English text of the event',
      storyId: sideBStoryId,
      sourceItemId: 'item-other',
      contentHash: 'b'.repeat(64),
    },
    canonicalInputHash: 'c'.repeat(64),
  };
}

const enabledConfig: EventRelationServiceConfig = {
  eventRelationEnabled: true,
  workersAiBindingPresent: true,
  geminiApiKeyPresent: false,
};

describe('createEventRelationService — the fail-closed gates', () => {
  it('is typed `ai_disabled` with ZERO calls when the independent flag is OFF', async () => {
    const port = createFakePort('workers-ai', [validOkOutput('erp-1', 'item-self', 'item-other')]);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: { ...enabledConfig, eventRelationEnabled: false },
    });
    const outcome = await service.evaluateEventRelations({
      pairs: [pairRequest('erp-1', 'edst_other')],
    });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'ai_disabled' });
    expect(port.calls).toBe(0);
  });

  it('rejects invalid requests (oversized bundle, wrong shape) before anything', async () => {
    const port = createFakePort('workers-ai', []);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const oversized = await service.evaluateEventRelations({
      pairs: [
        {
          ...pairRequest('erp-1', 'edst_other'),
          sideA: { ...pairRequest('erp-1', 'edst_other').sideA, text: 'الف'.repeat(20000) },
        },
      ],
    });
    expect(oversized).toEqual({ kind: 'deferred', reason: 'input_invalid' });
    expect(await service.evaluateEventRelations({ pairs: 'nope' })).toEqual({
      kind: 'deferred',
      reason: 'input_invalid',
    });
    expect(port.calls).toBe(0);
  });

  it('is the bounded no-op for an empty pair list', async () => {
    const port = createFakePort('workers-ai', []);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const outcome = await service.evaluateEventRelations({ pairs: [] });
    expect(outcome).toEqual({ kind: 'decisions', pairs: [] });
    expect(port.calls).toBe(0);
  });
});

describe('createEventRelationService — the bounded step', () => {
  it('evaluates one pair and returns the typed proposal', async () => {
    const port = createFakePort('workers-ai', [validOkOutput('erp-1', 'item-self', 'item-other')]);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const outcome = await service.evaluateEventRelations({
      pairs: [pairRequest('erp-1', 'edst_other')],
    });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind !== 'decisions') {
      return;
    }
    expect(outcome.pairs).toHaveLength(1);
    const pairOutcome = outcome.pairs[0]!;
    expect(pairOutcome.kind).toBe('evaluated');
    if (pairOutcome.kind === 'evaluated') {
      expect(pairOutcome.verdict).toBe('same_event_proposed');
      expect(pairOutcome.references).toEqual([
        { side: 'A', evidenceId: 'item-self' },
        { side: 'B', evidenceId: 'item-other' },
      ]);
      expect(pairOutcome.attempts).toHaveLength(1);
      expect(pairOutcome.attempts[0]).toMatchObject({
        provider: 'workers-ai',
        status: 'succeeded',
        inputTokens: 10,
        outputTokens: 5,
      });
    }
  });

  it('keeps a budget denial TYPED — never the semantic insufficient_evidence', async () => {
    const port = createFakePort('workers-ai', []);
    const service = createEventRelationService({
      executor: createFakeExecutor({ denyAll: true }),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const outcome = await service.evaluateEventRelations({
      pairs: [pairRequest('erp-1', 'edst_other')],
    });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind === 'decisions') {
      expect(outcome.pairs[0]).toMatchObject({ kind: 'deferred', reason: 'budget_denied' });
    }
    expect(port.calls).toBe(0);
  });

  it('terminates a refused pair without model hopping, then evaluates the next pair', async () => {
    const port = createFakePort('workers-ai', [
      { kind: 'refused' },
      validOkOutput('erp-2', 'item-self', 'item-other'),
    ]);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const outcome = await service.evaluateEventRelations({
      pairs: [pairRequest('erp-1', 'edst_a'), pairRequest('erp-2', 'edst_b')],
    });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind === 'decisions') {
      expect(outcome.pairs[0]?.kind).toBe('refused');
      expect(outcome.pairs[1]?.kind).toBe('evaluated');
    }
    expect(port.calls).toBe(2);
  });

  it('shares the ≤3 attempt cap across the WHOLE step (never per pair)', async () => {
    // With Gemini eligible the ladder has 3 models: pair 1 burns ALL THREE
    // step attempts on invalid outputs; the next pair must be typed
    // `step_attempt_cap` with ZERO further calls.
    const workersPort = createFakePort('workers-ai', [
      { kind: 'ok', rawText: 'not json' },
      { kind: 'ok', rawText: 'also not json' },
    ]);
    const geminiPort = createFakePort('gemini', [{ kind: 'ok', rawText: 'still not json' }]);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': workersPort, gemini: geminiPort },
      clock: fixedClock,
      logger: silentLogger,
      config: { ...enabledConfig, geminiApiKeyPresent: true },
      eligibility: { 'workers-ai': true, gemini: true },
    });
    const outcome = await service.evaluateEventRelations({
      pairs: [pairRequest('erp-1', 'edst_a'), pairRequest('erp-2', 'edst_b')],
    });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind === 'decisions') {
      const firstPair = outcome.pairs[0];
      expect(firstPair?.kind).toBe('deferred');
      if (firstPair?.kind === 'deferred') {
        expect(firstPair.attempts).toHaveLength(3);
      }
      expect(outcome.pairs[1]).toMatchObject({ kind: 'deferred', reason: 'step_attempt_cap' });
      const secondPair = outcome.pairs[1];
      if (secondPair?.kind === 'deferred') {
        expect(secondPair.attempts).toHaveLength(0);
      }
    }
    expect(workersPort.calls).toBe(2);
    expect(geminiPort.calls).toBe(1);
  });

  it('passes the 16 KiB bundle bound and the pair cap to the request schema', async () => {
    const port = createFakePort('workers-ai', []);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const threePairs = [
      pairRequest('erp-1', 'edst_a'),
      pairRequest('erp-2', 'edst_b'),
      pairRequest('erp-1', 'edst_c'),
    ];
    expect(await service.evaluateEventRelations({ pairs: threePairs })).toEqual({
      kind: 'deferred',
      reason: 'input_invalid',
    });
    expect(port.calls).toBe(0);
  });

  it('evaluates a zero-citation insufficient_evidence output honestly', async () => {
    const port = createFakePort('workers-ai', [
      {
        kind: 'ok',
        rawText: JSON.stringify({
          pairId: 'erp-1',
          verdict: 'insufficient_evidence',
          reasons: ['شواهد ارائه‌شده کافی نیست'],
          references: [],
          conflicts: [],
        }),
      },
    ]);
    const service = createEventRelationService({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: fixedClock,
      logger: silentLogger,
      config: enabledConfig,
    });
    const outcome = await service.evaluateEventRelations({
      pairs: [pairRequest('erp-1', 'edst_other')],
    });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind === 'decisions') {
      expect(outcome.pairs[0]).toMatchObject({
        kind: 'evaluated',
        verdict: 'insufficient_evidence',
      });
    }
  });
});
