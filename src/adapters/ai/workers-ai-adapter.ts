/**
 * Workers AI adapter (Phase 6 — ADR-0041): the PRIMARY provider port over
 * the native `env.AI.run(modelId, inputs)` binding. No Cloudflare API
 * token, account id, REST inference proxy, AI Gateway, or extra resource —
 * the binding IS the account access for this path.
 *
 * Deadline honesty (documented limitation): the Workers AI binding offers
 * NO guaranteed native cancellation (AiOptions has no abort mechanism), so
 * this adapter races the call against the wall deadline and returns
 * `deadline_exceeded` on timeout while the in-flight call MAY still be
 * computing server-side. The service accounts for that conservatively:
 * a timed-out attempt stays charged (no refunds) and can never start new
 * work after the deadline.
 *
 * Error mapping is deliberately conservative and code-only: thrown
 * binding errors are classified by bounded message-name patterns into the
 * stable AiCallOutcome kinds. Raw error text, provider payloads, headers
 * and URLs NEVER cross this boundary (they are not logged and not
 * returned — only the sanitized kind is).
 */
import type { AiCallOutcome, AiProviderPort } from '../../domain/ai/types';

/** Conservative bounded classification patterns (never emitted verbatim). */
const QUOTA_PATTERN = /(quota|neuron|credit|exhaust)/;
const MODEL_UNAVAILABLE_PATTERN =
  /(not[_ ]found|no such model|unknown model|unsupported model|retired|deprecated)/;
const AUTH_PATTERN =
  /(unauthorized|forbidden|permission denied|invalid.*credential|authentication)/;

export class WorkersAiAdapter implements AiProviderPort {
  readonly provider = 'workers-ai' as const;

  constructor(private readonly binding: Ai) {}

  async complete(input: {
    readonly modelId: string;
    readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
    readonly maxOutputTokens: number;
    readonly deadlineAtMs: number;
  }): Promise<AiCallOutcome> {
    const remainingMs = input.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return { kind: 'deadline_exceeded' };
    }

    const inputs = {
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      max_tokens: input.maxOutputTokens,
    };

    let runPromise: Promise<unknown>;
    try {
      runPromise = this.binding.run(input.modelId, inputs);
    } catch (error) {
      return classifyBindingError(error);
    }
    // A late rejection after the deadline race is resolved must never
    // become an unhandled rejection; the outcome is already decided.
    void runPromise.catch(() => undefined);

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const deadlineRace = new Promise<'deadline'>((resolve) => {
      timerId = setTimeout(() => resolve('deadline'), remainingMs);
    });

    try {
      const result = (await Promise.race([
        runPromise.then((value) => ({ kind: 'result' as const, value })),
        deadlineRace,
      ])) as { kind: 'result'; value: unknown } | 'deadline';
      if (result === 'deadline') {
        return { kind: 'deadline_exceeded' };
      }
      return interpretRunResult(result.value);
    } catch (error) {
      return classifyBindingError(error);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }
}

/** Conservative classification — emits ONLY the stable kind. */
export function classifyBindingError(error: unknown): AiCallOutcome {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const haystack = `${name} ${message}`.toLowerCase();
  if (QUOTA_PATTERN.test(haystack)) {
    return { kind: 'quota_denied' };
  }
  if (AUTH_PATTERN.test(haystack)) {
    return { kind: 'auth_failed' };
  }
  if (MODEL_UNAVAILABLE_PATTERN.test(haystack)) {
    return { kind: 'model_unavailable' };
  }
  return { kind: 'transient' };
}

/**
 * Defensive extraction of the binding's post-processed output. Known
 * shapes, in order:
 *
 * 1. OpenAI-compatible `chat.completion` (what gemma-4-26b / qwen3.8-27b
 *    actually return through the binding): `{ choices: [{ message:
 *    { content, reasoning_content }, finish_reason }], usage }`. The
 *    answer is the FIRST choice whose `message.content` is a non-empty
 *    string. `reasoning_content` is the model's thinking — NEVER the
 *    answer: empty `content` with `reasoning_content` present is NOT ok
 *    (transient), because the model spent the token budget thinking and
 *    produced no answer text.
 * 2. The instruct-model shape `{ response: string, usage?: {
 *    prompt_tokens, completion_tokens } }`.
 * 3. A raw non-empty string.
 *
 * Anything else is uninterpretable at this boundary. Usage is reported
 * ONLY when actually present (never invented); the chat.completion
 * `usage` object carries the same `prompt_tokens` / `completion_tokens`
 * fields (plus provider extras such as `neurons`, which are ignored).
 */
export function interpretRunResult(result: unknown): AiCallOutcome {
  if (typeof result === 'string') {
    return result.trim().length > 0 ? { kind: 'ok', rawText: result } : { kind: 'transient' };
  }
  if (result !== null && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const usage = readUsageRecord(record['usage']);
    const chatContent = readChatCompletionContent(record['choices']);
    if (chatContent !== undefined) {
      return usage === undefined
        ? { kind: 'ok', rawText: chatContent }
        : { kind: 'ok', rawText: chatContent, usage };
    }
    const response = record['response'];
    if (typeof response === 'string' && response.trim().length > 0) {
      return usage === undefined
        ? { kind: 'ok', rawText: response }
        : { kind: 'ok', rawText: response, usage };
    }
  }
  return { kind: 'transient' };
}

/**
 * First non-empty `choices[i].message.content` of a chat.completion
 * result, or undefined when no choice carries answer text.
 * `reasoning_content` is deliberately never read here.
 */
function readChatCompletionContent(choices: unknown): string | undefined {
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') {
      continue;
    }
    const message = (choice as Record<string, unknown>)['message'];
    if (message === null || typeof message !== 'object') {
      continue;
    }
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
  }
  return undefined;
}

function readUsageRecord(
  value: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens =
    typeof record['prompt_tokens'] === 'number' ? record['prompt_tokens'] : undefined;
  const outputTokens =
    typeof record['completion_tokens'] === 'number' ? record['completion_tokens'] : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

/** Factory for the production port (binding comes from the runtime env). */
export function createWorkersAiAdapter(binding: Ai): AiProviderPort {
  return new WorkersAiAdapter(binding);
}
