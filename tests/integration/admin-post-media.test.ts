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
 * R1.21 — the SINGLE-media path end to end over the REAL webhook + REAL D1 +
 * the REAL Bot API client: one photo (with a faithful caption) and one video
 * (without a caption) travel from the Telegram update through capture,
 * preview, approval and publication, and reach the SAME client the webhook
 * built. The ONLY faked boundary is the NETWORK (global fetch). Albums,
 * unsupported media, oversized/malformed captions and invalid file ids are
 * rejected or failed EXPLICITLY — nothing is degraded, truncated, or
 * silently dropped, and no caption is ever published without its media.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
// Deliberately NOT a real Telegram token SHAPE (the secret scanner
// treats `digits:AA...` as a credential): the tests only need a stable
// URL component, never a credential-shaped string.
const FAKE_BOT_TOKEN = '123456789:AB-FAKE-not-a-credential-shape-0000000000';
const TARGET_CHANNEL = '@pixel_channel';
const OWNER_ID = 1000000001;

const PHOTO_FILE_ID = 'AgAC_photo_file_id_AAAAAQ';
const VIDEO_FILE_ID = 'BAAC_video_file_id_BBBBBQ';
const CAPTION_TEXT = 'تصویر خبر فوری';
const CAPTION_BOLD_PART = 'تصویر خبر';
const CAPTION_ENTITIES = [{ type: 'bold', offset: 0, length: CAPTION_BOLD_PART.length }];

interface RecordedApiCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface ApiFake {
  readonly fetchFn: typeof fetch;
  readonly calls: RecordedApiCall[];
  readonly sentMessages: Record<string, unknown>[];
  respondWithError: { code: number; description: string } | null;
}

function createTelegramApiFake(): ApiFake {
  const calls: RecordedApiCall[] = [];
  const sentMessages: Record<string, unknown>[] = [];
  const state: { respondWithError: { code: number; description: string } | null } = {
    respondWithError: null,
  };
  let nextMessageId = 3000;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText.length > 0 ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith('/sendMessage') || url.endsWith('/sendPhoto') || url.endsWith('/sendVideo')) {
      sentMessages.push(body);
    }
    if (state.respondWithError !== null) {
      const { code, description } = state.respondWithError;
      return new Response(JSON.stringify({ ok: false, error_code: code, description }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const fake: ApiFake = {
    fetchFn,
    calls,
    sentMessages,
    get respondWithError() {
      return state.respondWithError;
    },
    set respondWithError(value: { code: number; description: string } | null) {
      state.respondWithError = value;
    },
  };
  return fake;
}

const BASE_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  BOT_TOKEN: FAKE_BOT_TOKEN,
  TARGET_CHANNEL,
  DB: env.DB,
};

const LIVE_ENV = {
  ...BASE_ENV,
  ADMIN_POST_ENABLED: 'true',
  ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true',
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
  // 200 = completed processing. 503 is only acceptable where a test
  // deliberately expects an honest retryable failure.
  expect([200, 503]).toContain(response.status);
}

function textUpdate(updateId: number, fromId: number, text: string, chatId = fromId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' },
      from: { id: fromId },
      text,
    },
  };
}

function photoUpdate(
  updateId: number,
  fromId: number,
  options: {
    readonly caption?: string;
    readonly captionEntities?: unknown[];
    readonly mediaGroupId?: string;
    readonly fileId?: string;
  } = {},
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId },
      photo: [
        {
          file_id: `${options.fileId ?? PHOTO_FILE_ID}_small`,
          file_unique_id: 'u1',
          width: 90,
          height: 90,
        },
        {
          file_id: options.fileId ?? PHOTO_FILE_ID,
          file_unique_id: 'u2',
          width: 1280,
          height: 960,
        },
      ],
      ...(options.caption !== undefined ? { caption: options.caption } : {}),
      ...(options.captionEntities !== undefined
        ? { caption_entities: options.captionEntities }
        : {}),
      ...(options.mediaGroupId !== undefined ? { media_group_id: options.mediaGroupId } : {}),
    },
  };
}

function videoUpdate(
  updateId: number,
  fromId: number,
  options: { readonly fileId?: string; readonly duration?: number } = {},
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId },
      video: {
        file_id: options.fileId ?? VIDEO_FILE_ID,
        file_unique_id: 'uv',
        width: 1280,
        height: 720,
        duration: options.duration ?? 21,
      },
    },
  };
}

function buttonFromReply(markup: unknown, match: string): string {
  const keyboard = (markup as { inline_keyboard: { text: string; callback_data: string }[][] })
    .inline_keyboard;
  const flat = keyboard.flat();
  const button = flat.find((b) => b.text.includes(match));
  if (button === undefined) throw new Error(`button not found: ${match}`);
  return button.callback_data.slice('a:'.length);
}

async function versionCount(): Promise<number> {
  const row = await executor.first<{ count: number }>({
    sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
  });
  return row?.count ?? 0;
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

describe('R1.21 — single photo/video path from the real webhook to the fake Bot API network', () => {
  it('photo with a formatted caption: capture → faithful preview (sendPhoto + caption_entities) → publish (sendPhoto to the channel)', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    await deliver(LIVE_ENV, textUpdate(6000, OWNER_ID, '/post'));
    await deliver(
      LIVE_ENV,
      photoUpdate(6001, OWNER_ID, {
        caption: CAPTION_TEXT,
        captionEntities: CAPTION_ENTITIES,
      }),
    );
    expect(await versionCount()).toBe(1);

    // Faithful preview: the content message is a sendPhoto carrying the
    // EXACT caption text + caption_entities (NO parse_mode), then the
    // separate control message with the buttons.
    await deliver(LIVE_ENV, textUpdate(6002, OWNER_ID, '/post_preview'));
    const previewPhoto = fake.sentMessages.find((m) => m['photo'] !== undefined);
    expect(previewPhoto).toBeDefined();
    expect(previewPhoto?.['photo']).toBe(PHOTO_FILE_ID); // the LARGEST variant
    expect(previewPhoto?.['caption']).toBe(CAPTION_TEXT);
    expect(previewPhoto?.['caption_entities']).toEqual(CAPTION_ENTITIES);
    expect(previewPhoto?.['parse_mode']).toBeUndefined();
    expect(previewPhoto?.['text']).toBeUndefined(); // a media send has no text field
    const control = fake.sentMessages.find((m) => m['reply_markup'] !== undefined);
    expect(control).toBeDefined();

    const approveToken = buttonFromReply(control?.['reply_markup'], 'Approve');
    const publishToken = buttonFromReply(control?.['reply_markup'], 'Publish');

    await deliver(LIVE_ENV, {
      update_id: 6003,
      callback_query: {
        id: 'cbq-6003',
        from: { id: OWNER_ID },
        data: `a:${approveToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, {
      update_id: 6004,
      callback_query: {
        id: 'cbq-6004',
        from: { id: OWNER_ID },
        data: `a:${publishToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });

    // The channel request: ONE sendPhoto to the operator destination with
    // the SAME caption + entities, no parse_mode, no text field.
    const channelSends = fake.sentMessages.filter(
      (m) => m['chat_id'] === TARGET_CHANNEL && m['photo'] !== undefined,
    );
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.['photo']).toBe(PHOTO_FILE_ID);
    expect(channelSends[0]?.['caption']).toBe(CAPTION_TEXT);
    expect(channelSends[0]?.['caption_entities']).toEqual(CAPTION_ENTITIES);
    expect(channelSends[0]?.['parse_mode']).toBeUndefined();

    const publication = await executor.first<{ state: string; error_code: string | null }>({
      sql: 'SELECT state, error_code FROM admin_post_publications',
    });
    expect(publication?.state).toBe('sent');
  });

  it('video WITHOUT a caption: captured, previewed and published with NO caption field at all', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    await deliver(LIVE_ENV, textUpdate(6100, OWNER_ID, '/post'));
    await deliver(LIVE_ENV, videoUpdate(6101, OWNER_ID));
    expect(await versionCount()).toBe(1);

    await deliver(LIVE_ENV, textUpdate(6102, OWNER_ID, '/post_preview'));
    const previewVideo = fake.sentMessages.find((m) => m['video'] !== undefined);
    expect(previewVideo).toBeDefined();
    expect(previewVideo?.['video']).toBe(VIDEO_FILE_ID);
    expect(previewVideo?.['caption']).toBeUndefined();
    expect(previewVideo?.['caption_entities']).toBeUndefined();
    const control = fake.sentMessages.find((m) => m['reply_markup'] !== undefined);
    const approveToken = buttonFromReply(control?.['reply_markup'], 'Approve');
    const publishToken = buttonFromReply(control?.['reply_markup'], 'Publish');

    await deliver(LIVE_ENV, {
      update_id: 6103,
      callback_query: {
        id: 'cbq-6103',
        from: { id: OWNER_ID },
        data: `a:${approveToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, {
      update_id: 6104,
      callback_query: {
        id: 'cbq-6104',
        from: { id: OWNER_ID },
        data: `a:${publishToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    const channelSends = fake.sentMessages.filter(
      (m) => m['chat_id'] === TARGET_CHANNEL && m['video'] !== undefined,
    );
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.['video']).toBe(VIDEO_FILE_ID);
    expect(channelSends[0]?.['caption']).toBeUndefined();
    const publication = await executor.first<{ state: string }>({
      sql: 'SELECT state FROM admin_post_publications',
    });
    expect(publication?.state).toBe('sent');
  });

  it('albums are rejected EXPLICITLY (a single album member is never degraded into a post)', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    await deliver(LIVE_ENV, textUpdate(6200, OWNER_ID, '/post'));
    await deliver(
      LIVE_ENV,
      photoUpdate(6201, OWNER_ID, { caption: 'یک عضو آلبوم', mediaGroupId: 'group-77' }),
    );
    expect(await versionCount()).toBe(0);
    // Zero outbound media sends and no publication state anywhere.
    expect(fake.sentMessages.filter((m) => m['photo'] !== undefined)).toHaveLength(0);
  });

  it('unsupported media (document/audio/sticker) is rejected EXPLICITLY, never degraded', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    await deliver(LIVE_ENV, textUpdate(6300, OWNER_ID, '/post'));
    for (const [index, extra] of [
      { document: { file_id: 'doc-1', file_unique_id: 'u' }, caption: 'سند' },
      { audio: { file_id: 'aud-1', file_unique_id: 'u', duration: 5 }, caption: 'صدا' },
      { sticker: { file_id: 'st-1', file_unique_id: 'u' } },
    ].entries()) {
      await deliver(LIVE_ENV, {
        update_id: 6301 + index,
        message: {
          message_id: 6301 + Number(index),
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID },
          ...extra,
        },
      });
    }
    expect(await versionCount()).toBe(0);
  });

  it('a caption beyond 1024 units is rejected explicitly; a malformed caption metadata never stores', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    await deliver(LIVE_ENV, textUpdate(6400, OWNER_ID, '/post'));
    await deliver(LIVE_ENV, photoUpdate(6401, OWNER_ID, { caption: 'ک'.repeat(1025) }));
    expect(await versionCount()).toBe(0);

    // Malformed caption_entities (primitive instead of a list).
    await deliver(LIVE_ENV, {
      update_id: 6402,
      message: {
        message_id: 6402,
        chat: { id: OWNER_ID, type: 'private' },
        from: { id: OWNER_ID },
        photo: [{ file_id: PHOTO_FILE_ID, file_unique_id: 'u', width: 5, height: 5 }],
        caption: 'کپشن',
        caption_entities: 'not-a-list',
      },
    });
    expect(await versionCount()).toBe(0);
  });

  it('a duplicate delivery of the SAME media update never creates a second version', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    await deliver(LIVE_ENV, textUpdate(6500, OWNER_ID, '/post'));
    await deliver(LIVE_ENV, photoUpdate(6501, OWNER_ID, { caption: 'کپشن یکتا' }));
    expect(await versionCount()).toBe(1);
    // Telegram redelivery: the same update_id again.
    await deliver(LIVE_ENV, photoUpdate(6501, OWNER_ID, { caption: 'کپشن یکتا' }));
    expect(await versionCount()).toBe(1);
  });

  it('a media version whose file reference the Bot API rejects is a DEFINITIVE failure — reported honestly, never auto-resent', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    await deliver(LIVE_ENV, textUpdate(6600, OWNER_ID, '/post'));
    await deliver(LIVE_ENV, photoUpdate(6601, OWNER_ID, { caption: 'فایل خراب' }));
    await deliver(LIVE_ENV, textUpdate(6602, OWNER_ID, '/post_preview'));
    const control = fake.sentMessages.find((m) => m['reply_markup'] !== undefined);
    const approveToken = buttonFromReply(control?.['reply_markup'], 'Approve');
    const publishToken = buttonFromReply(control?.['reply_markup'], 'Publish');
    await deliver(LIVE_ENV, {
      update_id: 6603,
      callback_query: {
        id: 'cbq-6603',
        from: { id: OWNER_ID },
        data: `a:${approveToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });

    // The Bot API rejects the file (invalid/expired/unusable reference):
    // ok:false + 400 — a DEFINITIVE failure (the request was not accepted).
    fake.respondWithError = { code: 400, description: 'Bad Request: wrong file identifier' };
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, {
      update_id: 6604,
      callback_query: {
        id: 'cbq-6604',
        from: { id: OWNER_ID },
        data: `a:${publishToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    const publication = await executor.first<{ state: string; error_code: string | null }>({
      sql: 'SELECT state, error_code FROM admin_post_publications',
    });
    expect(publication?.state).toBe('failed_definitive');
    expect(publication?.error_code).toBe('telegram_bad_request');
    // The failed channel request reached the client with the stored file id
    // (the send was attempted exactly once — no silent skip, no retry).
    const attempts = fake.sentMessages.filter((m) => m['photo'] !== undefined);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.['photo']).toBe(PHOTO_FILE_ID);

    // The only re-send path is the human-confirmed one via /post_status.
    fake.respondWithError = null;
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, textUpdate(6605, OWNER_ID, '/post_status'));
    const statusControl = fake.sentMessages.find((m) => m['reply_markup'] !== undefined);
    expect(statusControl).toBeDefined();
    const confirmToken = buttonFromReply(statusControl?.['reply_markup'], 're-send');
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, {
      update_id: 6606,
      callback_query: {
        id: 'cbq-6606',
        from: { id: OWNER_ID },
        data: `a:${confirmToken}`,
        message: { message_id: 9, chat: { id: OWNER_ID, type: 'private' } },
      },
    });
    // The confirmed re-send SUCCEEDED (the fake is healthy now) and the
    // publication is a supersede attempt that was sent.
    const republished = await executor.first<{ state: string; supersede_of: string | null }>({
      sql: 'SELECT state, supersede_of FROM admin_post_publications ORDER BY created_at_ms DESC LIMIT 1',
    });
    expect(republished?.state).toBe('sent');
    expect(republished?.supersede_of).not.toBeNull();
  });
});
