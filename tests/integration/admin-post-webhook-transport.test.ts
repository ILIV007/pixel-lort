import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';

/**
 * R1.20-R1 — the REAL publication wiring, end to end from the REAL webhook
 * factory: `handleTelegramWebhook` builds the REAL combined Bot API client
 * and hands the SAME instance to the admin post service as its channel
 * transport. The ONLY faked boundary is the NETWORK (global fetch): every
 * parser, router, store, binding, flag gate, and the client itself are the
 * production objects. No real Telegram, no real channel, no real
 * Cloudflare — the fake records exactly what the REAL client would send.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
// Deliberately NOT a real Telegram token SHAPE (the secret scanner
// treats `digits:AA...` as a credential): the tests only need a stable
// URL component, never a credential-shaped string.
const FAKE_BOT_TOKEN = '123456789:AB-FAKE-not-a-credential-shape-0000000000';
const TARGET_CHANNEL = '@pixel_channel';
const OWNER_ID = 1000000001;

const BOLD_PART = 'خبر جدید';
const POST_TEXT = `🎉 ${BOLD_PART}: نسخهٔ جدید PIXEL منتشر شد!`;
const POST_ENTITIES = [
  { type: 'bold', offset: POST_TEXT.indexOf(BOLD_PART), length: BOLD_PART.length },
];

interface RecordedApiCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function createTelegramApiFake(): {
  readonly fetchFn: typeof fetch;
  readonly calls: RecordedApiCall[];
  readonly sentMessages: Record<string, unknown>[];
} {
  const calls: RecordedApiCall[] = [];
  const sentMessages: Record<string, unknown>[] = [];
  let nextMessageId = 1000;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText.length > 0 ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith('/sendMessage')) {
      sentMessages.push(body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, calls, sentMessages };
}

const BASE_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  BOT_TOKEN: FAKE_BOT_TOKEN,
  TARGET_CHANNEL,
  DB: env.DB,
};

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<void> {
  const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });
  const request = new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TELEGRAM_SECRET_HEADER]: FAKE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  const response = await handleTelegramWebhook(request, envOverrides, { logger }).then(
    (res) => res,
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? 'internal_error';
      const status = code === 'service_unavailable' ? 503 : 500;
      return new Response(JSON.stringify({ error: { code } }), { status });
    },
  );
  // The webhook answers 200 for completed processing; 503 would mean an
  // outbound action failed — the network fake must satisfy every send.
  expect(response.status).toBe(200);
}

function textUpdate(
  updateId: number,
  fromId: number,
  text: string,
  chatId = fromId,
  entities?: unknown[],
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' },
      from: { id: fromId },
      text,
      ...(entities !== undefined ? { entities } : {}),
    },
  };
}

function callbackUpdate(updateId: number, fromId: number, token: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: fromId },
      data: `a:${token}`,
      message: { message_id: 9, chat: { id: fromId, type: 'private' } },
    },
  };
}

let executor: DbExecutor;

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  for (const table of [
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
    'telegram_updates',
    'admins',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, 'Owner', 'owner', 'active', 1, 1)`,
    params: [OWNER_ID],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R1.20-R1 — the real webhook wires the REAL Bot API client as the channel transport', () => {
  it('delivers the channel request with the EXACT text, entities and destination to that client (live flags on)', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // 1) explicit session start
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true', ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' },
      textUpdate(8100, OWNER_ID, '/post'),
    );
    // 2) capture the rich text (bold entity carried on the message wire)
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true', ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' },
      textUpdate(8101, OWNER_ID, POST_TEXT, OWNER_ID, POST_ENTITIES),
    );
    // 3) faithful preview (content message + control message with buttons)
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true', ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' },
      textUpdate(8102, OWNER_ID, '/post_preview'),
    );

    // The preview reached the SAME client: a direct-entity content message
    // (text + entities, NO parse_mode) for the owner's chat.
    const previewContent = fake.sentMessages.find(
      (m) => m['chat_id'] === OWNER_ID && Array.isArray(m['entities']),
    );
    expect(previewContent).toBeDefined();
    expect(previewContent?.['text']).toBe(POST_TEXT);
    expect(previewContent?.['parse_mode']).toBeUndefined();

    // The publish token rides the control message's inline keyboard.
    const control = fake.sentMessages.find((m) => m['reply_markup'] !== undefined);
    expect(control).toBeDefined();
    const markup = control?.['reply_markup'] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const buttons = markup.inline_keyboard.flat();
    const publishButton = buttons.find((b) => b.text.includes('Publish'));
    const approveButton = buttons.find((b) => b.text.includes('Approve'));
    expect(publishButton).toBeDefined();
    expect(approveButton).toBeDefined();

    // 4a) the reviewer-side approve click FIRST (the owner holds every
    // permission; the approval is bound to the previewed content).
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true', ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' },
      callbackUpdate(8103, OWNER_ID, approveButton!.callback_data.slice('a:'.length)),
    );

    // 4b) publish callback → the REAL client sends to the OPERATOR channel.
    fake.calls.length = 0;
    fake.sentMessages.length = 0;
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true', ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' },
      callbackUpdate(8104, OWNER_ID, publishButton!.callback_data.slice('a:'.length)),
    );

    // EXACTLY ONE channel request, to the operator-configured destination,
    // carrying the previewed text + entities with NO parse_mode — through
    // the very client instance the webhook constructed (the recorded URL
    // is that client's Bot API endpoint for the configured token).
    const channelSends = fake.sentMessages.filter((m) => m['chat_id'] === TARGET_CHANNEL);
    expect(channelSends).toHaveLength(1);
    const channelSend = channelSends[0]!;
    expect(channelSend['text']).toBe(POST_TEXT);
    expect(channelSend['entities']).toEqual(POST_ENTITIES);
    expect(channelSend['parse_mode']).toBeUndefined();
    expect(channelSend['disable_web_page_preview']).toBe(true);
    expect(fake.calls).toHaveLength(2); // channel sendMessage + answerCallbackQuery
    expect(fake.calls[0]!.url).toBe(`https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage`);
    expect(fake.calls[1]!.url).toBe(
      `https://api.telegram.org/bot${FAKE_BOT_TOKEN}/answerCallbackQuery`,
    );

    // The outbox recorded the honest durable outcome.
    const publication = await executor.first<{
      state: string;
      bot_message_id: number;
      fingerprint: string;
    }>({ sql: 'SELECT state, bot_message_id, fingerprint FROM admin_post_publications' });
    expect(publication?.state).toBe('sent');
    expect(publication?.bot_message_id).toBeGreaterThan(0);
  });

  it('sends ZERO channel requests in the default OFF state (both flags absent)', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // The SAME flow an operator might try — every step keeps legacy
    // behavior with the flags off: /post is an unknown command, plain text
    // is an ordinary message.
    await deliver({ ...BASE_ENV }, textUpdate(8200, OWNER_ID, '/post'));
    await deliver({ ...BASE_ENV }, textUpdate(8201, OWNER_ID, POST_TEXT));
    await deliver({ ...BASE_ENV }, textUpdate(8202, OWNER_ID, '/post_preview'));

    expect(fake.calls).toHaveLength(0);
    const versions = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
    });
    expect(versions?.count).toBe(0);
  });

  it('sends ZERO channel requests while ADMIN_POST_ENABLED is on but the LIVE flag stays off', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    await deliver({ ...BASE_ENV, ADMIN_POST_ENABLED: 'true' }, textUpdate(8300, OWNER_ID, '/post'));
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' },
      textUpdate(8301, OWNER_ID, POST_TEXT),
    );
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' },
      textUpdate(8302, OWNER_ID, '/post_preview'),
    );
    const control = fake.sentMessages.find((m) => m['reply_markup'] !== undefined);
    expect(control).toBeDefined();
    const markup = control?.['reply_markup'] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const buttons = markup.inline_keyboard.flat();
    // The owner approves first (a real flow), then tries to publish.
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' },
      callbackUpdate(
        8303,
        OWNER_ID,
        buttons.find((b) => b.text.includes('Approve'))!.callback_data.slice('a:'.length),
      ),
    );
    const publishToken = buttons
      .find((b) => b.text.includes('Publish'))!
      .callback_data.slice('a:'.length);

    fake.calls.length = 0;
    fake.sentMessages.length = 0;
    await deliver(
      { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' },
      callbackUpdate(8304, OWNER_ID, publishToken),
    );

    // The live gate stops BEFORE any publication row or Bot API call —
    // zero sends anywhere, and nothing durable was enqueued.
    expect(fake.calls).toHaveLength(1); // only the answerCallbackQuery notice
    expect(fake.sentMessages.filter((m) => m['chat_id'] === TARGET_CHANNEL)).toHaveLength(0);
    const publications = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_publications',
    });
    expect(publications?.count).toBe(0);
    // The approval was NOT consumed by the blocked publish.
    const approval = await executor.first<{ state: string }>({
      sql: 'SELECT state FROM admin_post_approvals',
    });
    expect(approval?.state).toBe('active');
  });
});
