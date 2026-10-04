import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/entrypoints/worker';
import { handleTelegramWebhook } from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';

/**
 * POST /telegram/webhook — security-edge contract tests (Phase 2A).
 *
 * Executed through the real worker entrypoint inside workerd (no network).
 * The enabled-ingress environment uses explicit fake fixtures that satisfy
 * the documented Phase 2 formats — never realistic credentials.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
const FAKE_OWNER_ID = '1000000001';
const FAKE_BOT_TOKEN = '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000';

const ENABLED_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: FAKE_OWNER_ID,
  BOT_TOKEN: FAKE_BOT_TOKEN,
  DB: env.DB,
};

const DISABLED_ENV = { TELEGRAM_INGRESS_ENABLED: 'false' };

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function webhookRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': FAKE_WEBHOOK_SECRET,
      ...headers,
    },
    body,
  });
}

function validUpdateBody(): string {
  return JSON.stringify({
    update_id: 5001,
    message: { message_id: 1, chat: { id: 1000000001 }, from: { id: 1000000001 }, text: '/start' },
  });
}

beforeEach(async () => {
  await applyMigrations(env.DB);
});

describe('POST /telegram/webhook — ingress flag gating', () => {
  it('behaves like an unknown route (404) while the ingress flag is disabled', async () => {
    const res = await worker.fetch(webhookRequest(validUpdateBody()), DISABLED_ENV, testCtx());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('not_found');
  });

  it('rejects an invalid flag value like an unknown route (fail closed)', async () => {
    const res = await worker.fetch(
      webhookRequest(validUpdateBody()),
      {
        TELEGRAM_INGRESS_ENABLED: 'maybe',
      },
      testCtx(),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /telegram/webhook — non-POST methods are rejected uniformly', () => {
  it.each(['GET', 'PUT', 'DELETE', 'HEAD'])(
    'rejects %s with the uniform safe 404',
    async (method) => {
      const res = await worker.fetch(
        new Request('https://example.com/telegram/webhook', { method }),
        ENABLED_ENV,
        testCtx(),
      );
      expect(res.status).toBe(404);
    },
  );
});

describe('POST /telegram/webhook — durable idempotency requirements', () => {
  it('fails closed with a safe 503 when ingress is enabled but D1 is unavailable', async () => {
    const res = await worker.fetch(
      webhookRequest(validUpdateBody()),
      {
        TELEGRAM_INGRESS_ENABLED: 'true',
        WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
        OWNER_TELEGRAM_ID: FAKE_OWNER_ID,
        BOT_TOKEN: FAKE_BOT_TOKEN,
        // No DB binding: durable update claims are impossible -> unavailable.
      },
      testCtx(),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('service_unavailable');
  });
});

describe('POST /telegram/webhook — secret verification', () => {
  it('rejects a missing secret header with 401', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validUpdateBody(),
      }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects an empty secret header with 401', async () => {
    const res = await worker.fetch(
      webhookRequest(validUpdateBody(), {
        'x-telegram-bot-api-secret-token': '',
      }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret with 401 without echoing anything', async () => {
    const res = await worker.fetch(
      webhookRequest(validUpdateBody(), {
        'x-telegram-bot-api-secret-token': `${FAKE_WEBHOOK_SECRET.slice(0, -1)}X`,
      }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('unauthorized');
  });

  it('serves a valid secret request with a deterministic minimal 200', async () => {
    const res = await worker.fetch(webhookRequest(validUpdateBody()), ENABLED_ENV, testCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /telegram/webhook — content type and body-size caps', () => {
  it('rejects a non-JSON content type with 415', async () => {
    const res = await worker.fetch(
      webhookRequest(validUpdateBody(), {
        'content-type': 'text/plain',
      }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(415);
  });

  it('rejects a declared oversized body with 413', async () => {
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const res = await worker.fetch(webhookRequest(oversized), ENABLED_ENV, testCtx());
    expect(res.status).toBe(413);
  });

  it('enforces the cap on actual bytes even when Content-Length lies', async () => {
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const res = await worker.fetch(
      webhookRequest(oversized, { 'content-length': '2' }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(413);
  });
});

describe('POST /telegram/webhook — body validation', () => {
  it('rejects malformed JSON with a safe 400', async () => {
    const res = await worker.fetch(webhookRequest('{"update_id":'), ENABLED_ENV, testCtx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('bad_request');
  });

  it('rejects a missing update_id with a safe 400', async () => {
    const res = await worker.fetch(
      webhookRequest(JSON.stringify({ message: { text: '/start' } })),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unsafe update_id with a safe 400', async () => {
    const res = await worker.fetch(
      webhookRequest(JSON.stringify({ update_id: 'not-a-number', message: {} })),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('acknowledges unsupported update types without crashing', async () => {
    const res = await worker.fetch(
      webhookRequest(JSON.stringify({ update_id: 5099, channel_post: { message_id: 3 } })),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /telegram/webhook — response hygiene', () => {
  it('retains security headers and correlation-ID behavior on success and errors', async () => {
    for (const request of [
      webhookRequest(validUpdateBody()),
      webhookRequest(validUpdateBody(), { 'x-telegram-bot-api-secret-token': 'wrong' }),
      new Request('https://example.com/telegram/webhook', { method: 'GET' }),
    ]) {
      const res = await worker.fetch(request, ENABLED_ENV, testCtx());
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-request-id')).toMatch(/^[!-~]{8,128}$/);
    }
  });

  it('honors a well-formed incoming x-request-id', async () => {
    const res = await worker.fetch(
      webhookRequest(validUpdateBody(), { 'x-request-id': 'webhook-test-req-00000001' }),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.headers.get('x-request-id')).toBe('webhook-test-req-00000001');
  });
});

describe('POST /telegram/webhook — no payload or secret leakage in logs', () => {
  it('never logs the secret, the body, message text, or chat/user identifiers', async () => {
    const CANARY_TEXT = 'LEAK-CANARY-سلام-abc123';
    const captured: string[] = [];
    const sink: LogSink = (_level, line) => {
      captured.push(line);
    };
    const logger = createLogger({ level: 'debug', sink });

    const request = webhookRequest(
      JSON.stringify({
        update_id: 5200,
        message: {
          message_id: 11,
          chat: { id: -100424242 },
          from: { id: 1000000001 },
          text: `/status ${CANARY_TEXT}`,
        },
      }),
    );
    const res = await handleTelegramWebhook(request, ENABLED_ENV, { logger });
    expect(res.status).toBe(200);

    const everything = captured.join('\n');
    expect(everything).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(everything).not.toContain('LEAK-CANARY');
    expect(everything).not.toContain('سلام');
    expect(everything).not.toContain('-100424242');
    expect(everything).not.toContain('1000000001');
  });
});
