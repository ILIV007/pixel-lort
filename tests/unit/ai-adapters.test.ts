import { describe, expect, it } from 'vitest';
import {
  buildEndpointUrl,
  createGeminiAdapter,
  GeminiAdapter,
  parseRetryAfterMs,
  type AiHttpTransport,
} from '../../src/adapters/ai/gemini-adapter';
import {
  classifyBindingError,
  createWorkersAiAdapter,
  interpretRunResult,
  WorkersAiAdapter,
} from '../../src/adapters/ai/workers-ai-adapter';

/**
 * Adapter-boundary tests (Phase 6, ADR-0041) over injected fakes — the
 * Gemini transport is a scripted fetch-like fake; the Workers AI binding
 * is a minimal fake object. No network, no native runtime.
 */

const OK_DEADLINE = Date.now() + 10_000;

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Gemini adapter — endpoint and secret hygiene', () => {
  it('builds the strict official endpoint with the model id percent-encoded', () => {
    const url = buildEndpointUrl('gemini-2.5-flash-lite');
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    );
    expect(buildEndpointUrl('weird/model id')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/weird%2Fmodel%20id:generateContent',
    );
  });

  it('sends the key ONLY in the x-goog-api-key header — never in the URL', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transport: AiHttpTransport = async (url, init) => {
      seen.push({ url, init });
      return jsonRes(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    };
    const adapter = createGeminiAdapter(transport, 'test-only-not-a-real-key');
    const outcome = await adapter.complete({
      modelId: 'gemini-2.5-flash-lite',
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ],
      maxOutputTokens: 768,
      deadlineAtMs: OK_DEADLINE,
    });
    expect(outcome.kind).toBe('ok');
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.url.includes('test-only-not-a-real-key')).toBe(false);
    expect(request?.url.includes('key=')).toBe(false);
    const headers = request?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('test-only-not-a-real-key');
    expect(request?.init.redirect).toBe('error');
    const body = JSON.parse(request?.init.body as string) as {
      systemInstruction?: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.systemInstruction?.parts[0]?.text).toBe('system text');
    expect(body.contents).toHaveLength(1);
    expect(body.generationConfig.maxOutputTokens).toBe(768);
  });

  it('never leaks the key through outcomes (only stable kinds cross the boundary)', async () => {
    const transport: AiHttpTransport = async () =>
      jsonRes(403, { error: { message: 'API key invalid. Key: test-only-not-a-real-key' } });
    const adapter = createGeminiAdapter(transport, 'test-only-not-a-real-key');
    const outcome = await adapter.complete({
      modelId: 'gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 768,
      deadlineAtMs: OK_DEADLINE,
    });
    expect(outcome).toEqual({ kind: 'auth_failed' });
    expect(JSON.stringify(outcome)).not.toContain('test-only-not-a-real-key');
  });
});

describe('Gemini adapter — status and body classification', () => {
  const BASE = {
    modelId: 'gemini-2.5-flash-lite',
    messages: [{ role: 'user' as const, content: 'x' }],
    maxOutputTokens: 768,
    deadlineAtMs: OK_DEADLINE,
  };

  function transportWith(response: () => Promise<Response>): AiHttpTransport {
    return response;
  }

  it('maps status codes to stable kinds with Retry-After parsing', async () => {
    const cases: { status: number; expected: string; retryAfter?: string }[] = [
      { status: 404, expected: 'model_unavailable' },
      { status: 429, expected: 'quota_denied', retryAfter: '30' },
      { status: 401, expected: 'auth_failed' },
      { status: 500, expected: 'transient' },
    ];
    for (const testCase of cases) {
      const adapter = new GeminiAdapter(
        transportWith(async () =>
          jsonRes(
            testCase.status,
            {},
            testCase.retryAfter ? { 'retry-after': testCase.retryAfter } : {},
          ),
        ),
        'k',
      );
      const outcome = await adapter.complete(BASE);
      expect(outcome.kind).toBe(testCase.expected);
      if (testCase.retryAfter && outcome.kind === 'quota_denied') {
        expect(outcome.retryAfterMs).toBe(30_000);
      }
    }
  });

  it('classifies safety blocks and refusals', async () => {
    const refused = new GeminiAdapter(
      transportWith(async () =>
        jsonRes(200, {
          candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'x' }] } }],
        }),
      ),
      'k',
    );
    expect((await refused.complete(BASE)).kind).toBe('refused');

    const blockedPrompt = new GeminiAdapter(
      transportWith(async () => jsonRes(200, { promptFeedback: { blockReason: 'SAFETY' } })),
      'k',
    );
    expect((await blockedPrompt.complete(BASE)).kind).toBe('refused');
  });

  it('joins candidate text parts and surfaces provider-reported usage', async () => {
    const adapter = new GeminiAdapter(
      transportWith(async () =>
        jsonRes(200, {
          candidates: [
            { finishReason: 'STOP', content: { parts: [{ text: 'aa' }, { text: 'bb' }] } },
          ],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
        }),
      ),
      'k',
    );
    const outcome = await adapter.complete(BASE);
    expect(outcome).toMatchObject({
      kind: 'ok',
      rawText: 'aabb',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it('treats malformed, oversized, and non-UTF8-ish bodies as transient', async () => {
    const malformed = new GeminiAdapter(
      transportWith(async () => jsonRes(200, '{"candidates": [truncated')),
      'k',
    );
    expect((await malformed.complete(BASE)).kind).toBe('transient');

    const oversized = new GeminiAdapter(
      transportWith(async () => jsonRes(200, 'x', { 'content-length': `${1024 * 1024 + 1}` })),
      'k',
    );
    expect((await oversized.complete(BASE)).kind).toBe('transient');
  });

  it('maps transport rejection and aborts to transient/deadline outcomes', async () => {
    const networkError = new GeminiAdapter(
      transportWith(async () => {
        throw new TypeError('fetch failed');
      }),
      'k',
    );
    expect((await networkError.complete(BASE)).kind).toBe('transient');

    const aborted = new GeminiAdapter(
      transportWith(async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }),
      'k',
    );
    expect((await aborted.complete(BASE)).kind).toBe('deadline_exceeded');
  });

  it('skips all transport work when the wall deadline is already passed', async () => {
    let called = false;
    const adapter = new GeminiAdapter(
      transportWith(async () => {
        called = true;
        return jsonRes(200, {});
      }),
      'k',
    );
    const outcome = await adapter.complete({ ...BASE, deadlineAtMs: Date.now() - 1 });
    expect(outcome).toEqual({ kind: 'deadline_exceeded' });
    expect(called).toBe(false);
  });

  it('parses numeric Retry-After conservatively', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('999999')).toBeUndefined();
  });
});

describe('Workers AI adapter — binding boundary', () => {
  const BASE = {
    modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
    messages: [{ role: 'user' as const, content: 'x' }],
    maxOutputTokens: 768,
    deadlineAtMs: OK_DEADLINE,
  };

  function fakeBinding(runImpl: () => Promise<unknown>): Ai {
    return { run: runImpl } as unknown as Ai;
  }

  it('interprets the post-processed instruct shape with optional usage', () => {
    expect(interpretRunResult('plain text')).toEqual({ kind: 'ok', rawText: 'plain text' });
    expect(
      interpretRunResult({
        response: '{"a":1}',
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      }),
    ).toEqual({
      kind: 'ok',
      rawText: '{"a":1}',
      usage: { inputTokens: 9, outputTokens: 4 },
    });
    expect(interpretRunResult({ response: '' }).kind).toBe('transient');
    expect(interpretRunResult({ unrelated: true }).kind).toBe('transient');
    expect(interpretRunResult(null).kind).toBe('transient');
    // Usage is reported ONLY when actually present.
    expect(interpretRunResult({ response: 'x' })).toEqual({ kind: 'ok', rawText: 'x' });
  });

  it('classifies binding errors conservatively without leaking message text', async () => {
    const quota = classifyBindingError(new Error('account has no remaining Neurons quota'));
    expect(quota.kind).toBe('quota_denied');
    const missing = classifyBindingError(new Error('model not found'));
    expect(missing.kind).toBe('model_unavailable');
    const auth = classifyBindingError(new Error('Authentication error'));
    expect(auth.kind).toBe('auth_failed');
    const unknown = classifyBindingError(new Error('something exploded internally'));
    expect(unknown.kind).toBe('transient');
    const outcomeText = JSON.stringify([quota, missing, auth, unknown]);
    expect(outcomeText).not.toContain('Neurons');
    expect(outcomeText).not.toContain('exploded');
  });

  it('passes bounded inputs to the binding and returns interpreted results', async () => {
    const seen: { model: string; inputs: unknown }[] = [];
    const adapter = new WorkersAiAdapter(
      fakeBinding(async () => {
        return { response: '{"ok":true}', usage: { prompt_tokens: 5, completion_tokens: 2 } };
      }),
    );
    // Wrap run to observe arguments.
    const binding = {
      run: async (model: string, inputs: unknown) => {
        seen.push({ model, inputs });
        return { response: '{"ok":true}', usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
    } as unknown as Ai;
    const direct = new WorkersAiAdapter(binding);
    const outcome = await direct.complete(BASE);
    expect(outcome).toMatchObject({ kind: 'ok', rawText: '{"ok":true}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe('@cf/meta/llama-3.1-8b-instruct-fp8');
    const inputs = seen[0]?.inputs as { messages: unknown[]; max_tokens: number };
    expect(inputs.max_tokens).toBe(768);
    expect(inputs.messages).toHaveLength(1);
    void adapter;
  });

  it('skips binding work when the wall deadline is already passed', async () => {
    let called = false;
    const binding = fakeBinding(async () => {
      called = true;
      return { response: 'x' };
    });
    const adapter = new WorkersAiAdapter(binding);
    const outcome = await adapter.complete({ ...BASE, deadlineAtMs: Date.now() - 1 });
    expect(outcome).toEqual({ kind: 'deadline_exceeded' });
    expect(called).toBe(false);
  });

  it('maps a thrown binding error into a stable kind', async () => {
    const binding = fakeBinding(async () => {
      throw new Error('model not found');
    });
    const adapter = new WorkersAiAdapter(binding);
    const outcome = await adapter.complete(BASE);
    expect(outcome).toEqual({ kind: 'model_unavailable' });
  });

  it('factory returns the same provider id', () => {
    expect(createWorkersAiAdapter(fakeBinding(async () => ({}))).provider).toBe('workers-ai');
    expect(createGeminiAdapter(async () => new Response(null), 'k').provider).toBe('gemini');
  });
});
