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
 * R1.21 — the usable multi-role flow over the REAL webhook + REAL D1 + the
 * REAL Bot API client, where EVERY id and EVERY button is taken from the
 * bot's REAL replies (the recorded network sends) — NEVER from a direct DB
 * read and never from tokens that were not actually delivered to a user:
 *
 *   editor (draft.create)  captures -> the reply carries the DRAFT ID;
 *   reviewer (draft.view + draft.approve) previews THE EDITOR'S draft by
 *                          that id and approves via the reply's button;
 *   publisher (publication.publish) previews by id, publishes via the
 *                          reply's button, and — when the outcome is
 *                          uncertain — reaches the confirm-re-send path
 *                          through /post_status <draftId> (even though the
 *                          publisher is NOT the creator).
 *
 * Non-holders get honest denials with no existence disclosure, and the
 * previewed / approved / sent content are proven byte-identical.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
// Deliberately NOT a real Telegram token SHAPE (the secret scanner
// treats `digits:AA...` as a credential): the tests only need a stable
// URL component, never a credential-shaped string.
const FAKE_BOT_TOKEN = '123456789:AB-FAKE-not-a-credential-shape-0000000000';
const TARGET_CHANNEL = '@pixel_channel';
const OWNER_ID = 1000000001; // publisher by role (owner holds every permission)
const EDITOR_ID = 2000000002;
const REVIEWER_ID = 2000000003;
const SOURCE_MANAGER_ID = 2000000004;

const BASE_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  BOT_TOKEN: FAKE_BOT_TOKEN,
  TARGET_CHANNEL,
  DB: env.DB,
};
const FLAG_ON_ENV = { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' };
const LIVE_ENV = { ...FLAG_ON_ENV, ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' };

const POST_TEXT = 'پست گردش سه‌نقشی';
const POST_ENTITIES = [{ type: 'bold', offset: 0, length: 4 }];

interface RecordedApiCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface ApiFake {
  readonly fetchFn: typeof fetch;
  readonly calls: RecordedApiCall[];
  readonly sentMessages: Record<string, unknown>[];
  failSendsWith: 'timeout' | null;
}

function createTelegramApiFake(): ApiFake {
  const calls: RecordedApiCall[] = [];
  const sentMessages: Record<string, unknown>[] = [];
  const state: { failSendsWith: 'timeout' | null } = { failSendsWith: null };
  let nextMessageId = 5000;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText.length > 0 ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith('/sendMessage') || url.endsWith('/sendPhoto') || url.endsWith('/sendVideo')) {
      if (state.failSendsWith === 'timeout') {
        // The request was made but the response never arrived — UNCERTAIN.
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      sentMessages.push(body);
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
    get failSendsWith() {
      return state.failSendsWith;
    },
    set failSendsWith(value: 'timeout' | null) {
      state.failSendsWith = value;
    },
  };
  return fake;
}

interface DeliveryResult {
  readonly status: number;
}

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<DeliveryResult> {
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
  return { status: response.status };
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

/** ALL replies the bot sent to a given admin chat (the user-visible surface). */
function repliesTo(fake: ApiFake, chatId: number): Record<string, unknown>[] {
  return fake.sentMessages.filter((m) => m['chat_id'] === chatId);
}

function replyTexts(fake: ApiFake, chatId: number): string[] {
  return repliesTo(fake, chatId).map((m) => String(m['text'] ?? ''));
}

function firstButton(fake: ApiFake, chatId: number, match: string): string {
  for (const message of repliesTo(fake, chatId)) {
    const markup = message['reply_markup'] as
      { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;
    if (markup === undefined) continue;
    const button = markup.inline_keyboard.flat().find((b) => b.text.includes(match));
    if (button !== undefined) return button.callback_data.slice('a:'.length);
  }
  throw new Error(`no button matching "${match}" was delivered to chat ${chatId}`);
}

/** The draft id as it ACTUALLY reached the creator's reply text. */
function draftIdFromReply(fake: ApiFake, chatId: number): string {
  for (const text of replyTexts(fake, chatId)) {
    const match =
      /Draft id: ([0-9a-f-]{36})/u.exec(text) ?? /شناسهٔ پیش‌نویس: ([0-9a-f-]{36})/u.exec(text);
    if (match !== null) return match[1]!;
  }
  throw new Error(`no draft id was delivered to chat ${chatId}`);
}

let executor: DbExecutor;
let updateSeq: number;

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  updateSeq = 7000;
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
  const admins: Array<[number, string]> = [
    [OWNER_ID, 'owner'],
    [EDITOR_ID, 'editor'],
    [REVIEWER_ID, 'reviewer'],
    [SOURCE_MANAGER_ID, 'source_manager'],
  ];
  for (const [id, role] of admins) {
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', 1, 1)`,
      params: [id, `Admin ${id}`, role],
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R1.21 — the editor → reviewer → publisher flow over REAL replies (no DB-scraped ids/tokens)', () => {
  it('walks the full flow: the draft id and every button come from the bot replies; previewed == approved == sent', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // ---- EDITOR: start + capture; the DRAFT ID arrives in the reply text.
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post'));
    await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, EDITOR_ID, POST_TEXT, EDITOR_ID, POST_ENTITIES),
    );
    const draftId = draftIdFromReply(fake, EDITOR_ID);
    expect(draftId).toMatch(/^[0-9a-f-]{36}$/u);

    // ---- REVIEWER: previews THE EDITOR'S draft by that id and approves
    // with the button from their OWN reply.
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${draftId}`));
    // The reviewer received the content message (exact text + entities).
    const reviewerContent = repliesTo(fake, REVIEWER_ID).find((m) => m['entities'] !== undefined);
    expect(reviewerContent).toBeDefined();
    expect(reviewerContent?.['text']).toBe(POST_TEXT);
    expect(reviewerContent?.['entities']).toEqual(POST_ENTITIES);
    const approveToken = firstButton(fake, REVIEWER_ID, 'Approve');
    await deliver(FLAG_ON_ENV, callbackUpdate(++updateSeq, REVIEWER_ID, approveToken));
    // The approval confirmation reached the reviewer as an answerCallbackQuery.
    const approveAnswer = fake.calls.find(
      (c) =>
        c.url.endsWith('/answerCallbackQuery') && String(c.body['text'] ?? '').includes('APPROVED'),
    );
    expect(approveAnswer).toBeDefined();

    // ---- PUBLISHER (not the creator): previews by id, publishes via their
    // own reply's button. The content arrives byte-identical.
    await deliver(LIVE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${draftId}`));
    const publisherContent = repliesTo(fake, OWNER_ID).find((m) => m['entities'] !== undefined);
    expect(publisherContent?.['text']).toBe(POST_TEXT);
    const publishToken = firstButton(fake, OWNER_ID, 'Publish');
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, callbackUpdate(++updateSeq, OWNER_ID, publishToken));

    // Exactly ONE channel request carrying the SAME text + entities.
    const channelSends = fake.sentMessages.filter((m) => m['chat_id'] === TARGET_CHANNEL);
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.['text']).toBe(POST_TEXT);
    expect(channelSends[0]?.['entities']).toEqual(POST_ENTITIES);
    expect(channelSends[0]?.['parse_mode']).toBeUndefined();

    // The durable outcome agrees with what the roles saw.
    const publication = await executor.first<{
      state: string;
      fingerprint: string;
      draft_id: string;
    }>({ sql: 'SELECT state, fingerprint, draft_id FROM admin_post_publications' });
    expect(publication?.state).toBe('sent');
    expect(publication?.draft_id).toBe(draftId);
    const version = await executor.first<{ fingerprint: string }>({
      sql: 'SELECT fingerprint FROM admin_post_versions WHERE draft_id = ? AND version = 1',
      params: [draftId],
    });
    const approval = await executor.first<{ fingerprint: string; state: string }>({
      sql: 'SELECT fingerprint, state FROM admin_post_approvals WHERE draft_id = ? AND version = 1',
      params: [draftId],
    });
    // The ONLY DB assertions: identity CONSISTENCY of what the flow showed.
    expect(version?.fingerprint).toBe(publication?.fingerprint);
    expect(approval?.state).toBe('consumed');
  });

  it('/post_status <draftId> gives the PUBLISHER the state and the recovery path of a post they did not create', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // Editor captures; reviewer approves; publisher's first send TIMES OUT
    // (uncertain — the message MAY have arrived).
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post'));
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, POST_TEXT));
    const draftId = draftIdFromReply(fake, EDITOR_ID);

    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${draftId}`));
    await deliver(
      FLAG_ON_ENV,
      callbackUpdate(++updateSeq, REVIEWER_ID, firstButton(fake, REVIEWER_ID, 'Approve')),
    );

    await deliver(LIVE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${draftId}`));
    fake.failSendsWith = 'timeout';
    await deliver(
      LIVE_ENV,
      callbackUpdate(++updateSeq, OWNER_ID, firstButton(fake, OWNER_ID, 'Publish')),
    );
    fake.failSendsWith = null;
    const publication = await executor.first<{ state: string }>({
      sql: 'SELECT state FROM admin_post_publications',
    });
    expect(publication?.state).toBe('uncertain');

    // The PUBLISHER (not the creator) asks for the status BY ID and gets
    // the honest unknown-outcome view + the confirm re-send button.
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_status ${draftId}`));
    const statusTexts = replyTexts(fake, OWNER_ID).join('\n');
    expect(statusTexts).toContain(draftId);
    expect(statusTexts).toContain('UNKNOWN');
    const confirmToken = firstButton(fake, OWNER_ID, 're-send');

    // The confirmed re-send completes the recovery through the same client.
    fake.sentMessages.length = 0;
    await deliver(LIVE_ENV, callbackUpdate(++updateSeq, OWNER_ID, confirmToken));
    const channelSends = fake.sentMessages.filter((m) => m['chat_id'] === TARGET_CHANNEL);
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.['text']).toBe(POST_TEXT);
    const finalPublication = await executor.first<{ state: string }>({
      sql: 'SELECT state FROM admin_post_publications ORDER BY created_at_ms DESC LIMIT 1',
    });
    expect(finalPublication?.state).toBe('sent');
  });

  it('roles without publication.publish get an honest denial for /post_status <id> — no state, no disclosure', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post'));
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, POST_TEXT));
    const draftId = draftIdFromReply(fake, EDITOR_ID);

    // source_manager holds NEITHER publication.publish nor any post surface.
    const denied = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, SOURCE_MANAGER_ID, `/post_status ${draftId}`),
    );
    // The denial reply is delivered (the fake network answers) and carries
    // NO state — one honest permission denial, nothing about the draft.
    expect(denied.status).toBe(200);
    const denialTexts = replyTexts(fake, SOURCE_MANAGER_ID).join(' ');
    expect(denialTexts).toContain('publication permission');
    expect(denialTexts).not.toContain(draftId);

    // An UNKNOWN id gets the one not-found answer — no existence oracle.
    fake.sentMessages.length = 0;
    await deliver(
      LIVE_ENV,
      textUpdate(++updateSeq, OWNER_ID, '/post_status 00000000-0000-4000-8000-000000000000'),
    );
    expect(replyTexts(fake, OWNER_ID).join(' ')).toContain('no OPEN draft');

    // Malformed argument: usage reply BEFORE any service call.
    fake.sentMessages.length = 0;
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, OWNER_ID, '/post_status a b c'));
    expect(replyTexts(fake, OWNER_ID).join(' ')).toContain('Invalid usage');
  });

  it('the reviewer (no publish permission) never receives a publish button; the editor sees their draft id in /post_status', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post'));
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, POST_TEXT));
    const draftId = draftIdFromReply(fake, EDITOR_ID);

    // Reviewer preview: approve button only.
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${draftId}`));
    const reviewerButtons: string[] = [];
    for (const message of repliesTo(fake, REVIEWER_ID)) {
      const markup = message['reply_markup'] as
        { inline_keyboard: { text: string }[][] } | undefined;
      if (markup === undefined) continue;
      reviewerButtons.push(...markup.inline_keyboard.flat().map((b) => b.text));
    }
    expect(reviewerButtons.some((t) => t.includes('Approve'))).toBe(true);
    expect(reviewerButtons.some((t) => t.includes('Publish'))).toBe(false);

    // The editor's own /post_status shows the SAME draft id.
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post_status'));
    const editorStatus = replyTexts(fake, EDITOR_ID).join('\n');
    expect(editorStatus).toContain(draftId);
    expect(editorStatus).toContain('version 1');
  });
});
