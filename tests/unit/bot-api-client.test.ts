import { describe, expect, it } from 'vitest';
import {
  createBotApiClient,
  DEFAULT_TELEGRAM_API_TIMEOUT_MS,
  MAX_TELEGRAM_RESPONSE_BYTES,
  TelegramApiError,
} from '../../src/adapters/telegram/bot-api-client';
import { escapeTelegramHtml, type TelegramSafeHtml } from '../../src/admin/telegram-html';
import type { AppError } from '../../src/shared/errors/app-error';
import { createLogger, type LogSink } from '../../src/observability/logger';

/**
 * Telegram Bot API client boundary tests (Phase 2A).
 * Every test injects a fake fetch — NO real network request occurs, and the
 * Bot Token fixture is an obviously-fake structural shape.
 */

const FAKE_TOKEN = '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

interface CapturedLine {
  readonly msg: string;
  readonly [key: string]: unknown;
}

function captureLogger(): { lines: CapturedLine[]; logger: ReturnType<typeof createLogger> } {
  const lines: CapturedLine[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(JSON.parse(line) as CapturedLine);
  };
  return { lines, logger: createLogger({ level: 'debug', sink }) };
}

const CHAT_ID = 555000111;
const TEXT = escapeTelegramHtml('<b>وضعیت</b> — متن نمونه');

describe('createBotApiClient — success paths', () => {
  it('sends getMe with the tokenized URL and parses the bot identity', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({
          ok: true,
          result: { id: 42, is_bot: true, username: 'pixel_admin_bot' },
        });
      },
    });
    await expect(client.getMe()).resolves.toEqual({ id: 42, username: 'pixel_admin_bot' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getMe`);
  });

  it('sends sendMessage with HTML parse mode and no markdown fallback', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ ok: true, result: { message_id: 77 } });
      },
    });
    await expect(client.sendMessage({ chatId: CHAT_ID, text: TEXT })).resolves.toEqual({
      messageId: 77,
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['chat_id']).toBe(CHAT_ID);
    expect(body['parse_mode']).toBe('HTML');
    expect(String(body['text'])).not.toContain('MarkdownV2');
  });

  it('accepts `true` or a Message result for editMessageText', async () => {
    let respondWith: unknown = true;
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ ok: true, result: respondWith }),
    });
    await expect(
      client.editMessageText({ chatId: CHAT_ID, messageId: 5, text: TEXT }),
    ).resolves.toBe(true);
    respondWith = { message_id: 5 };
    await expect(
      client.editMessageText({ chatId: CHAT_ID, messageId: 5, text: TEXT }),
    ).resolves.toBe(true);
  });

  it('completes answerCallbackQuery on `true`', async () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ ok: true, result: true }),
    });
    await expect(client.answerCallbackQuery({ callbackQueryId: 'cb-9' })).resolves.toBeUndefined();
  });
});

describe('createBotApiClient — Telegram error mapping', () => {
  const cases: {
    name: string;
    respond: () => Response;
    code: string;
    retryable: boolean;
  }[] = [
    {
      name: 'maps HTTP 400 to a permanent bad request',
      respond: () =>
        jsonResponse({ ok: false, error_code: 400, description: 'chat not found' }, 400),
      code: 'telegram_bad_request',
      retryable: false,
    },
    {
      name: 'maps HTTP 401 to a permanent unauthorized (bad token)',
      respond: () => jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401),
      code: 'telegram_unauthorized',
      retryable: false,
    },
    {
      name: 'maps HTTP 403 to a permanent forbidden',
      respond: () => jsonResponse({ ok: false, error_code: 403, description: 'bot blocked' }, 403),
      code: 'telegram_forbidden',
      retryable: false,
    },
    {
      name: 'maps HTTP 404 to a permanent not found',
      respond: () => jsonResponse({ ok: false, error_code: 404, description: 'nope' }, 404),
      code: 'telegram_not_found',
      retryable: false,
    },
    {
      name: 'maps HTTP 500 to a retryable server error',
      respond: () => jsonResponse({ ok: false, error_code: 500, description: 'boom' }, 500),
      code: 'telegram_server_error',
      retryable: true,
    },
    {
      name: 'maps HTTP 503 to a retryable server error',
      respond: () => jsonResponse({ ok: false, error_code: 503, description: 'unavailable' }, 503),
      code: 'telegram_server_error',
      retryable: true,
    },
    {
      name: 'classifies an ok:false envelope with an unknown code as permanent',
      respond: () => jsonResponse({ ok: false, description: 'mystery' }),
      code: 'telegram_bad_request',
      retryable: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      let fetchCalls = 0;
      const client = createBotApiClient({
        botToken: FAKE_TOKEN,
        fetchImpl: async () => {
          fetchCalls += 1;
          return testCase.respond();
        },
      });
      const error = await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TelegramApiError);
      const apiError = error as TelegramApiError;
      expect(apiError.code).toBe(testCase.code);
      expect(apiError.retryable).toBe(testCase.retryable);
      // Single attempt — the client NEVER retries (no retry storm).
      expect(fetchCalls).toBe(1);
      // Raw Telegram descriptions never surface in the error message.
      expect(JSON.stringify({ m: apiError.message })).not.toContain('chat not found');
      expect(JSON.stringify({ m: apiError.message })).not.toContain('boom');
    });
  }

  it('maps HTTP 429 with retry_after and parses it safely', async () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () =>
        jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 7 },
          },
          429,
        ),
    });
    const error = await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    );
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error?.code).toBe('telegram_rate_limited');
    expect(error?.retryable).toBe(true);
    expect(error?.retryAfterMs).toBe(7000);
  });

  it('ignores unsafe retry_after values (0, negative, oversized, non-numeric)', async () => {
    for (const retryAfter of [0, -5, 99999, 1.5, '3', null]) {
      const client = createBotApiClient({
        botToken: FAKE_TOKEN,
        fetchImpl: async () =>
          jsonResponse(
            {
              ok: false,
              error_code: 429,
              description: 'rate',
              parameters: { retry_after: retryAfter },
            },
            429,
          ),
      });
      const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
        () => null,
        (e: unknown) => e as TelegramApiError,
      )) as TelegramApiError;
      expect(error?.retryAfterMs).toBeUndefined();
    }
  });
});

describe('createBotApiClient — transport failures', () => {
  it('maps fetch rejections to a retryable network error', async () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_network_error');
    expect(error?.retryable).toBe(true);
  });

  it('maps abort/timeout rejections to a retryable timeout', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const client = createBotApiClient({
        botToken: FAKE_TOKEN,
        fetchImpl: async () => {
          const abort = new Error('The operation was aborted');
          abort.name = name;
          throw abort;
        },
      });
      const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
        () => null,
        (e: unknown) => e as TelegramApiError,
      )) as TelegramApiError;
      expect(error?.code).toBe('telegram_timeout');
      expect(error?.retryable).toBe(true);
    }
  });

  it('classifies malformed 2xx responses as invalid', async () => {
    for (const respond of [
      () => textResponse('not json at all'),
      () => jsonResponse({ unexpected: true }),
      () => jsonResponse({ ok: true, result: 'not-a-message' }),
      () => textResponse('x'.repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1)),
    ]) {
      const client = createBotApiClient({
        botToken: FAKE_TOKEN,
        fetchImpl: async () => respond(),
      });
      const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
        () => null,
        (e: unknown) => e as TelegramApiError,
      )) as TelegramApiError;
      expect(error?.code).toBe('telegram_response_invalid');
    }
  });

  it('uses the documented default timeout value', () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ ok: true, result: true }),
    });
    expect(client).toBeDefined();
    expect(DEFAULT_TELEGRAM_API_TIMEOUT_MS).toBe(10_000);
  });
});

describe('createBotApiClient — bounded response reading (ADR-0028)', () => {
  it('rejects an oversized STREAMED response without Content-Length', async () => {
    // Streamed body: no content-length header exists — the byte cap must be
    // enforced by the reader itself (never by trusting declarations).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(600_000)));
        controller.enqueue(new TextEncoder().encode('x'.repeat(600_000)));
        controller.close();
      },
    });
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_response_invalid');
  });

  it('rejects a lying Content-Length once the streamed bytes cross the cap', async () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () =>
        new Response(textResponse('x'.repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1)).body, {
          status: 200,
          headers: { 'content-length': '5' },
        }),
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_response_invalid');
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    let bodyRead = false;
    // A minimal Response stand-in so the declared header survives exactly as
    // the client would see it from a hostile server (workerd strips a
    // mismatched content-length on stream bodies, which would hide the
    // early-rejection path under test). The flag is set on .body ACCESS:
    // ReadableStream pull callbacks fire eagerly on construction, so only
    // a getter proves the client never even acquired the stream.
    const hostileResponse = {
      status: 200,
      headers: new Headers({ 'content-length': '99999999' }),
      get body(): ReadableStream<Uint8Array> {
        bodyRead = true;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
        });
      },
    } as unknown as Response;
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => hostileResponse,
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_response_invalid');
    expect(bodyRead).toBe(false);
  });

  it('rejects an invalid (non-integer) declared Content-Length', async () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () =>
        new Response(textResponse('ok').body, {
          status: 200,
          headers: { 'content-length': 'abc' },
        }),
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_response_invalid');
  });

  it('accepts a response at the exact byte limit', async () => {
    const envelope = JSON.stringify({ ok: true, result: { message_id: 77 } });
    const padded = `${envelope}${' '.repeat(MAX_TELEGRAM_RESPONSE_BYTES - envelope.length)}`;
    expect(new TextEncoder().encode(padded).length).toBe(MAX_TELEGRAM_RESPONSE_BYTES);
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => new Response(padded, { status: 200 }),
    });
    await expect(client.sendMessage({ chatId: CHAT_ID, text: TEXT })).resolves.toEqual({
      messageId: 77,
    });
  });

  it('rejects malformed UTF-8 in the response as invalid', async () => {
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }),
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_response_invalid');
  });

  it('maps a mid-stream response failure to a retryable network error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('truncated'));
      },
    });
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_network_error');
    expect(error?.retryable).toBe(true);
  });

  it('keeps retry_after parsing bounded and safe on the 429 error path', async () => {
    // Oversized 429 payload: the error classification survives (with no
    // retry_after) — the bounded reader must not mask or leak the body.
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () =>
        new Response('x'.repeat(MAX_TELEGRAM_RESPONSE_BYTES + 1), { status: 429 }),
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_rate_limited');
    expect(error?.retryable).toBe(true);
    expect(error?.retryAfterMs).toBeUndefined();
  });

  it('never logs response bodies on success or error paths', async () => {
    const { lines, logger } = captureLogger();
    const RESPONSE_CANARY = 'RESPONSE-BODY-CANARY-مخفی';
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => textResponse(RESPONSE_CANARY), // malformed JSON body
      logger,
    });
    await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).catch(() => {});
    const everything = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(everything).not.toContain(RESPONSE_CANARY);
    expect(everything).not.toContain('مخفی');
  });
});

describe('createBotApiClient — redirect safety (ADR-0028)', () => {
  it('explicitly sends redirect: "error" on every request', async () => {
    const inits: RequestInit[] = [];
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async (_url, init) => {
        inits.push(init ?? {});
        const method = String(_url).split('/').pop();
        if (method === 'getMe') {
          return jsonResponse({ ok: true, result: { id: 42, username: 'pixel_admin_bot' } });
        }
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    await client.getMe();
    await client.sendMessage({ chatId: CHAT_ID, text: TEXT });
    expect(inits.length).toBe(2);
    for (const init of inits) {
      expect(init['redirect']).toBe('error');
    }
  });

  it('maps a redirected response to a retryable network error without leaking the token or URL', async () => {
    const { lines, logger } = captureLogger();
    // Simulate workerd's redirect failure: the raw error may carry the
    // redirect target and even the original URL (with the embedded token).
    const hostileFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect !== 'error') {
        return jsonResponse({ ok: true, result: true });
      }
      throw new Error(
        `redirect from https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage to https://evil.example.com/?leak=${FAKE_TOKEN}`,
      );
    };
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: hostileFetch,
      logger,
    });
    const error = (await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).then(
      () => null,
      (e: unknown) => e as TelegramApiError,
    )) as TelegramApiError;
    expect(error?.code).toBe('telegram_network_error');
    expect(error?.retryable).toBe(true);
    // The error surface (message + JSON serialization) never contains the
    // token or any URL.
    const serialized = JSON.stringify({
      message: error?.message,
      code: error?.code,
      name: error?.name,
    });
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain('api.telegram.org');
    expect(serialized).not.toContain('evil.example.com');
    // And the logger (fail-safe policy) never emits them either.
    const everything = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain('api.telegram.org');
    expect(everything).not.toContain('evil.example.com');
  });
});

describe('createBotApiClient — runtime Telegram-safe HTML gate (ADR-0029)', () => {
  it('rejects a forged TelegramSafeHtml value BEFORE fetch is called', async () => {
    let fetchCalls = 0;
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    // Forged cast: compile-time branding bypassed, runtime gate must hold.
    const forged =
      '<a href="https://example.com/" onmouseover="alert(1)">hi</a>' as unknown as TelegramSafeHtml;
    const error = await client.sendMessage({ chatId: CHAT_ID, text: forged }).then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe('internal_error');
    expect(fetchCalls).toBe(0);
  });

  it('applies the same runtime gate to editMessageText', async () => {
    let fetchCalls = 0;
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({ ok: true, result: true });
      },
    });
    const forged = '<b>not actually safe<script>' as unknown as TelegramSafeHtml;
    await expect(
      client.editMessageText({ chatId: CHAT_ID, messageId: 3, text: forged }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(fetchCalls).toBe(0);
  });
});

describe('createBotApiClient — no secret or payload leakage in logs', () => {
  it('never logs the token, the URL, or the message text', async () => {
    const { lines, logger } = captureLogger();
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () =>
        jsonResponse({ ok: false, error_code: 400, description: 'chat not found' }, 400),
      logger,
    });
    await client.sendMessage({ chatId: CHAT_ID, text: TEXT }).catch(() => {});

    const everything = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain('api.telegram.org');
    expect(everything).not.toContain('وضعیت');
    expect(everything).not.toContain('chat not found');
    // Error events carry only method + stable code.
    const errorLine = lines.find((l) => l.msg === 'telegram.api.error');
    expect(errorLine?.['method']).toBe('sendMessage');
    expect(errorLine?.['code']).toBe('telegram_bad_request');
  });
});
