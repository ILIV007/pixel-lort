import { beforeEach, describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import {
  createAiInboundRewriter,
  type AiInboundRewriterConfig,
} from '../../src/application/inbound/ai-rewriter';
import type { AiCallOutcome, AiProvider, AiProviderPort } from '../../src/domain/ai/types';
import { createLogger } from '../../src/observability/logger';

/**
 * Slice 4 — inbound AI rewriter over INJECTED FAKES (fully offline; no
 * native binding, no network, no real D1). The ladder, budget gate and
 * refusal discipline mirror the draft service (ADR-0041); the real workerd
 * D1 budget authority is covered by tests/integration/ai-budget.test.ts.
 * The pipeline-level fallback (deferred/refused → cleaned text) is covered
 * by tests/integration/inbound-pipeline.test.ts.
 */

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
        return { kind: 'transient' } as AiCallOutcome;
      }
      return next;
    },
  };
}

function createFakeExecutor(): DbExecutor {
  return {
    async query<T>(): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(): Promise<T | null> {
      return null;
    },
    async run(): Promise<DbQueryMeta> {
      return { durationMs: 0, changes: 1 };
    },
    async batch(statements: readonly { sql: string }[]): Promise<readonly DbQueryMeta[]> {
      return statements.map(() => ({ durationMs: 0, changes: 1 }));
    },
  };
}

const CONFIG: AiInboundRewriterConfig = {
  aiEnabled: true,
  geminiEnabled: false,
  workersAiBindingPresent: true,
  geminiApiKeyPresent: false,
};

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

describe('inbound AI rewriter', () => {
  let port: FakePort & AiProviderPort;

  beforeEach(() => {
    port = createFakePort('workers-ai');
  });

  function buildRewriter(config: AiInboundRewriterConfig = CONFIG) {
    return createAiInboundRewriter({
      executor: createFakeExecutor(),
      ports: { 'workers-ai': port },
      clock: { now: () => 1_000_000 },
      logger: silentLogger(),
      config,
    });
  }

  it('rewrites with the primary model and returns plain text', async () => {
    port.setOutcomes([{ kind: 'ok', rawText: 'تریلر رسمی بازی منتشر شد.' }]);
    const rewriter = buildRewriter();
    const outcome = await rewriter.rewrite({
      text: 'تریلر بازی منتشر شد',
      category: 'trailer',
      isCaption: false,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.text).toBe('تریلر رسمی بازی منتشر شد.');
    }
    expect(port.calls).toEqual(['@cf/google/gemma-4-26b-a4b-it']);
  });

  it('falls to the alternate model when the primary is unavailable', async () => {
    port.setOutcomes([{ kind: 'model_unavailable' }, { kind: 'ok', rawText: 'متن بازنویسی‌شده.' }]);
    const rewriter = buildRewriter();
    const outcome = await rewriter.rewrite({
      text: 'متن خام',
      category: 'news',
      isCaption: false,
    });
    expect(outcome.kind).toBe('ok');
    expect(port.calls).toEqual(['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b']);
  });

  it('defers with ai_disabled and ZERO provider calls when AI is off', async () => {
    const rewriter = buildRewriter({ ...CONFIG, aiEnabled: false });
    const outcome = await rewriter.rewrite({
      text: 'متن خام',
      category: 'news',
      isCaption: false,
    });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'ai_disabled', attempts: 0 });
    expect(port.calls).toEqual([]);
  });

  it('defers with binding_missing and zero calls when the binding is absent', async () => {
    const rewriter = buildRewriter({ ...CONFIG, workersAiBindingPresent: false });
    const outcome = await rewriter.rewrite({
      text: 'متن خام',
      category: 'news',
      isCaption: false,
    });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'binding_missing', attempts: 0 });
    expect(port.calls).toEqual([]);
  });

  it('a safety refusal is terminal: no model hopping', async () => {
    port.setOutcomes([{ kind: 'refused' }, { kind: 'ok', rawText: 'نباید برسد.' }]);
    const rewriter = buildRewriter();
    const outcome = await rewriter.rewrite({
      text: 'متن خام',
      category: 'news',
      isCaption: false,
    });
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'provider_safety_refusal',
      attempts: 1,
    });
    expect(port.calls).toHaveLength(1);
  });

  it('an empty model output is a rejected attempt, not a successful rewrite', async () => {
    port.setOutcomes([
      { kind: 'ok', rawText: '   ' },
      { kind: 'ok', rawText: 'متن درست.' },
    ]);
    const rewriter = buildRewriter();
    const outcome = await rewriter.rewrite({
      text: 'متن خام',
      category: 'news',
      isCaption: false,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.text).toBe('متن درست.');
    }
    expect(port.calls).toHaveLength(2);
  });

  it('strips a surrounding code fence from the model output', async () => {
    port.setOutcomes([{ kind: 'ok', rawText: '```\nمتن بازنویسی‌شده.\n```' }]);
    const rewriter = buildRewriter();
    const outcome = await rewriter.rewrite({
      text: 'متن خام',
      category: 'news',
      isCaption: false,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.text).toBe('متن بازنویسی‌شده.');
    }
  });

  it('defers with input_invalid for empty text, before any provider call', async () => {
    const rewriter = buildRewriter();
    const outcome = await rewriter.rewrite({ text: '   ', category: 'news', isCaption: false });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'input_invalid', attempts: 0 });
    expect(port.calls).toEqual([]);
  });
});
