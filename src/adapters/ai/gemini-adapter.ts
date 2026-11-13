/**
 * Gemini Developer API adapter (Phase 6 — ADR-0041): the SECONDARY port
 * over the existing GEMINI_API_KEY through a bounded, injected HTTP
 * transport.
 *
 * Security/robustness contract (round 1.10.6 §4):
 * - The key travels ONLY in the `x-goog-api-key` request header — NEVER in
 *   a URL/query string, never in any log, error, or outcome.
 * - Strict HTTPS to the official endpoint; the model id is the ONLY
 *   caller-controlled path segment and is percent-encoded. No arbitrary
 *   host may be supplied by callers or by model output.
 * - `redirect: 'error'` — a redirect is refused outright instead of being
 *   followed to an untrusted host.
 * - The response body is read with the shared bounded reader (strict byte
 *   cap + early Content-Length rejection + strict UTF-8), so a hostile or
 *   broken peer cannot force unbounded allocation.
 * - The wall deadline covers HEADERS *AND* BODY (round 1.10.6.1): the
 *   timer stays armed across the whole transport+body work, really aborts
 *   the request signal (best-effort runtime cancellation), and an
 *   independent race returns the typed deadline outcome even when the
 *   transport/stream ignores the signal. Late rejections after the race
 *   settled are absorbed (never unhandled). Timers are cleaned up on
 *   success and failure.
 * - Native failures map to stable AiCallOutcome kinds. Raw response
 *   bodies, headers, URLs and the key NEVER cross this boundary.
 */
import type { AiCallOutcome, AiProviderPort } from '../../domain/ai/types';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from '../../shared/http/bounded-reader';

/** Official Gemini Developer API origin (v1beta generateContent). */
const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';
const GEMINI_API_PATH_TEMPLATE = '/v1beta/models/:model:generateContent';

/** Strict response byte cap for the Gemini JSON body. */
const GEMINI_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Minimal fetch-compatible transport (injected; faked in tests). */
export type AiHttpTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Gemini finish reasons that mean the model refused on content grounds. */
const REFUSAL_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

export class GeminiAdapter implements AiProviderPort {
  readonly provider = 'gemini' as const;

  constructor(
    private readonly transport: AiHttpTransport,
    private readonly apiKey: string,
  ) {}

  async complete(input: {
    readonly modelId: string;
    readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
    readonly maxOutputTokens: number;
    readonly deadlineAtMs: number;
  }): Promise<AiCallOutcome> {
    // Clock contract: the deadline is an ABSOLUTE timestamp in the caller's
    // clock domain (the service's injected clock — the system wall clock in
    // production). This adapter measures against the system wall clock
    // (Date.now) because REAL cancellation requires real timers.
    const remainingMs = input.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return { kind: 'deadline_exceeded' };
    }

    const url = buildEndpointUrl(input.modelId);
    const systemParts = input.messages.filter((message) => message.role === 'system');
    const userParts = input.messages.filter((message) => message.role === 'user');
    const body = JSON.stringify({
      systemInstruction: { parts: systemParts.map((message) => ({ text: message.content })) },
      contents: userParts.map((message) => ({
        role: 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: { maxOutputTokens: input.maxOutputTokens },
    });

    // The wall deadline covers HEADERS *AND* BODY (round 1.10.6.1):
    // receiving fast 200 headers must NOT end the deadline protection. The
    // timer stays armed until the whole transport+body work settles; it
    // really ABORTS the request signal (best-effort runtime cancellation)
    // and independently fires the typed deadline race. If the transport or
    // body stream ignores the signal, the race still enforces the deadline
    // — the abandoned in-flight work is documented, never hidden.
    const abortController = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const deadlineRace = new Promise<'deadline'>((resolve) => {
      if (remainingMs < 2_147_483_647) {
        timerId = setTimeout(() => {
          abortController.abort();
          resolve('deadline');
        }, remainingMs);
      }
    });

    const work = (async (): Promise<AiCallOutcome> => {
      const response = await this.transport(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body,
        redirect: 'error',
        signal: abortController.signal,
      });
      if (response.status !== 200) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        switch (response.status) {
          case 404:
            return { kind: 'model_unavailable', retryAfterMs };
          case 429:
            return { kind: 'quota_denied', retryAfterMs };
          case 401:
          case 403:
            return { kind: 'auth_failed' };
          default:
            return { kind: 'transient', retryAfterMs };
        }
      }
      const bodyText = await readBodyBounded(response);
      if (bodyText === null) {
        return { kind: 'transient' };
      }
      return interpretGeminiBody(bodyText);
    })();

    try {
      const winner = await Promise.race([work, deadlineRace]);
      if (winner === 'deadline') {
        return { kind: 'deadline_exceeded' };
      }
      return winner;
    } catch (error) {
      // AbortError => the wall deadline fired (real cancellation);
      // anything else is a transport failure. Neither leaks URL/headers.
      if (error instanceof Error && error.name === 'AbortError') {
        return { kind: 'deadline_exceeded' };
      }
      return { kind: 'transient' };
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      // A late transport/body rejection after the race settled must never
      // surface as an unhandled rejection; the outcome is already decided.
      void work.catch(() => undefined);
    }
  }
}

/** Build the strict official endpoint URL (model id percent-encoded). */
export function buildEndpointUrl(modelId: string): string {
  const encoded = encodeURIComponent(modelId);
  return `${GEMINI_API_ORIGIN}${GEMINI_API_PATH_TEMPLATE.replace(':model', encoded)}`;
}

/** Parse a numeric Retry-After (seconds) into ms; absent/invalid => undefined. */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400) {
    return undefined;
  }
  return seconds * 1000;
}

/** Bounded body read; ANY bounded-read failure maps to a transient outcome. */
async function readBodyBounded(response: Response): Promise<string | null> {
  const declared = parseContentLengthHeader(
    response.headers.get('content-length'),
    GEMINI_MAX_RESPONSE_BYTES,
  );
  if (declared.kind === 'oversized' || declared.kind === 'invalid') {
    return null;
  }
  try {
    const bytes = await readStreamBounded(response.body, GEMINI_MAX_RESPONSE_BYTES);
    return decodeUtf8Strict(bytes);
  } catch (error) {
    if (error instanceof BoundedReadError) {
      return null;
    }
    return null;
  }
}

/** Strict, shape-checked interpretation — never surfaces raw payloads. */
export function interpretGeminiBody(bodyText: string): AiCallOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: 'transient' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'transient' };
  }
  const record = parsed as Record<string, unknown>;

  const promptFeedback = record['promptFeedback'];
  if (promptFeedback !== null && typeof promptFeedback === 'object') {
    const blockReason = (promptFeedback as Record<string, unknown>)['blockReason'];
    if (typeof blockReason === 'string' && blockReason.length > 0) {
      return { kind: 'refused' };
    }
  }

  const candidates = record['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { kind: 'transient' };
  }
  const first = candidates[0];
  if (first === null || typeof first !== 'object') {
    return { kind: 'transient' };
  }
  const candidate = first as Record<string, unknown>;

  const finishReason = candidate['finishReason'];
  if (typeof finishReason === 'string' && REFUSAL_FINISH_REASONS.has(finishReason)) {
    return { kind: 'refused' };
  }

  const content = candidate['content'];
  if (content === null || typeof content !== 'object') {
    return { kind: 'transient' };
  }
  const parts = (content as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts)) {
    return { kind: 'transient' };
  }
  const textChunks: string[] = [];
  for (const part of parts) {
    if (part !== null && typeof part === 'object') {
      const text = (part as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        textChunks.push(text);
      }
    }
  }
  const rawText = textChunks.join('');
  if (rawText.trim().length === 0) {
    return { kind: 'transient' };
  }

  const usageMetadata = record['usageMetadata'];
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  if (usageMetadata !== null && typeof usageMetadata === 'object') {
    const usageRecord = usageMetadata as Record<string, unknown>;
    const inputTokens =
      typeof usageRecord['promptTokenCount'] === 'number'
        ? usageRecord['promptTokenCount']
        : undefined;
    const outputTokens =
      typeof usageRecord['candidatesTokenCount'] === 'number'
        ? usageRecord['candidatesTokenCount']
        : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) {
      usage = { inputTokens, outputTokens };
    }
  }

  return usage === undefined ? { kind: 'ok', rawText } : { kind: 'ok', rawText, usage };
}

/**
 * Factory for the production port. The injected transport defaults to the
 * runtime global fetch (strict HTTPS origin enforced by the URL builder).
 */
export function createGeminiAdapter(transport: AiHttpTransport, apiKey: string): AiProviderPort {
  return new GeminiAdapter(transport, apiKey);
}
