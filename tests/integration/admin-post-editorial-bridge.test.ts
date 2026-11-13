import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { buildPipelineReadyDraft } from '../helpers/review-test-fixtures';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { EDITORIAL_POST_LABELS } from '../../src/domain/admin-post/editorial-post-render';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';

/**
 * R1.22 Phase A — the editorial→post bridge over the REAL webhook + REAL D1
 * + the REAL Bot API client, where the editorial draft id comes from the
 * bot's REAL /drafts reply, the admin post draft id comes from the bot's
 * REAL /post_from_draft reply, and every button/token comes from REAL
 * delivered messages — never from a direct DB read:
 *
 *   source fixture -> REAL editorial.prepare_draft job (artificial AI port,
 *   zero network) -> READY editorial draft -> /drafts (real reply) ->
 *   /post_from_draft (real conversion with durable provenance) ->
 *   /post_preview (exact stored render) -> approve (real button) ->
 *   publish with the live flag OFF (honest stop, nothing sent) and ON
 *   (exact single channel send, no parse_mode).
 *
 * The unverified status is preserved end-to-end: the rendered channel text
 * carries the fixed unverified note, and the bridge is idempotent (a second
 * conversion of the same editorial draft is an honest pointer, never a
 * duplicate of the news).
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
// Deliberately NOT a real Telegram token SHAPE (the secret scanner
// treats `digits:AA...` as a credential): the tests only need a stable
// URL component, never a credential-shaped string.
const FAKE_BOT_TOKEN = '123456789:AB-FAKE-not-a-credential-shape-0000000000';
const TARGET_CHANNEL = '@pixel_channel';
const OWNER_ID = 1000000001; // holds every permission
const REVIEWER_ID = 2000000003; // draft.view + draft.approve, NO draft.create

const BASE_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  BOT_TOKEN: FAKE_BOT_TOKEN,
  TARGET_CHANNEL,
  DB: env.DB,
};
const BRIDGE_ENV = {
  ...BASE_ENV,
  ADMIN_POST_ENABLED: 'true',
  ADMIN_REVIEW_ENABLED: 'true',
  EDITORIAL_TO_POST_ENABLED: 'true',
};
const LIVE_ENV = { ...BRIDGE_ENV, ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' };

// The EXACT known pipeline output of buildPipelineReadyDraft() — the
// deterministic render these tests assert against.
const PIPELINE_HEADLINE = 'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه منتشر شد';
const PIPELINE_SUMMARY =
  'استودیوی نمونه از انتشار به‌روزرسانی بزرگ بازی نمونه خبر داد؛ این به‌روزرسانی بخش داستانی تازه و بهبود عملکرد را به همراه دارد.';
const PIPELINE_CLAIM =
  'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه و بهبود عملکرد در دسترس قرار گرفت.';
const PIPELINE_SOURCE_NAME = 'دموی منبع رسمی';
const EXPECTED_POST_TEXT = [
  PIPELINE_HEADLINE,
  PIPELINE_SUMMARY,
  `• ${PIPELINE_CLAIM}`,
  EDITORIAL_POST_LABELS.unverifiedNote,
  `${EDITORIAL_POST_LABELS.sourcePrefix}${PIPELINE_SOURCE_NAME}`,
].join('\n\n');
const EXPECTED_POST_ENTITIES = [{ type: 'bold', offset: 0, length: PIPELINE_HEADLINE.length }];

interface RecordedApiCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface ApiFake {
  readonly fetchFn: typeof fetch;
  readonly calls: RecordedApiCall[];
  readonly sentMessages: Record<string, unknown>[];
}

function createTelegramApiFake(): ApiFake {
  const calls: RecordedApiCall[] = [];
  const sentMessages: Record<string, unknown>[] = [];
  let nextMessageId = 6000;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText.length > 0 ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith('/sendMessage') || url.endsWith('/sendPhoto') || url.endsWith('/sendVideo')) {
      sentMessages.push(body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, calls, sentMessages };
}

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<number> {
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
    (res) => res.status,
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? 'internal_error';
      return code === 'service_unavailable' ? 503 : 500;
    },
  );
  return response;
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

/** The LAST callback answer text (button feedback) in delivery order. */
function lastAnswerText(fake: ApiFake): string {
  const answers = fake.calls
    .filter((c) => c.url.endsWith('/answerCallbackQuery'))
    .map((c) => String(c.body['text'] ?? ''));
  expect(answers.length).toBeGreaterThan(0);
  return answers.at(-1)!;
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

/** The editorial draft id EXACTLY as the real /drafts reply delivered it. */
function editorialIdFromDraftsReply(fake: ApiFake, chatId: number): string {
  for (const text of replyTexts(fake, chatId)) {
    const match = /<code>(eddr_[0-9a-f]{32})<\/code>/u.exec(text);
    if (match !== null) return match[1]!;
  }
  throw new Error(`no editorial draft id was delivered to chat ${chatId}`);
}

/** The admin post draft id EXACTLY as the conversion reply delivered it. */
function postDraftIdFromReply(fake: ApiFake, chatId: number): string {
  for (const text of replyTexts(fake, chatId)) {
    const match = /Post draft id: ([0-9a-f-]{36})/u.exec(text);
    if (match !== null) return match[1]!;
  }
  throw new Error(`no post draft id was delivered to chat ${chatId}`);
}

let executor: DbExecutor;
let updateSeq: number;

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  updateSeq = 9000;
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
    'drafts',
    'ai_runs',
    'evidence',
    'claims',
    'story_fingerprints',
    'stories',
    'source_items',
    'sources',
    'jobs',
    'budgets',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
  const admins: Array<[number, string]> = [
    [OWNER_ID, 'owner'],
    [REVIEWER_ID, 'reviewer'],
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

describe('R1.22 Phase A — the editorial→post bridge over REAL replies', () => {
  it('walks the full bridge: /drafts -> /post_from_draft -> preview == stored render -> approve -> publish stops honestly while live is OFF', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // ---- REAL editorial pipeline: source fixture -> real job -> ready draft.
    // The id the test USES later comes from the real /drafts reply below;
    // this returned id exists ONLY to cross-check that the reply delivered
    // exactly the pipeline's draft (never substituted for it).
    const editorialDraftId = await buildPipelineReadyDraft();

    // ---- OWNER reads the id from the REAL /drafts reply (never from the DB).
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, '/drafts'));
    const deliveredId = editorialIdFromDraftsReply(fake, OWNER_ID);
    expect(deliveredId).toBe(editorialDraftId);

    // ---- OWNER converts: the reply carries the POST draft id + provenance.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${deliveredId}`));
    const postDraftId = postDraftIdFromReply(fake, OWNER_ID);
    const convertedReply = replyTexts(fake, OWNER_ID).find((t) => t.includes('Post draft id:'))!;
    expect(convertedReply).toContain('unverified status preserved');
    expect(convertedReply).toContain(deliveredId);

    // ---- Idempotency: a SECOND conversion of the same editorial draft is
    // an honest pointer to the SAME post — never a duplicate.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${deliveredId}`));
    const again = replyTexts(fake, OWNER_ID).at(-1)!;
    expect(again).toContain('already prepared as post version 1');
    expect(again).toContain(postDraftId);

    // ---- REVIEWER (draft.view, NO draft.create) is honestly denied the
    // conversion — but can preview by the delivered id.
    await deliver(
      BRIDGE_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, `/post_from_draft ${deliveredId}`),
    );
    expect(replyTexts(fake, REVIEWER_ID).at(-1)).toContain('draft creation permission');

    // ---- REVIEWER previews: the content message IS the deterministic
    // render (exact text + entities), never the raw excerpt.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${postDraftId}`));
    const previewContent = repliesTo(fake, REVIEWER_ID).find(
      (m) => m['text'] === EXPECTED_POST_TEXT,
    );
    expect(previewContent).toBeDefined();
    expect(previewContent?.['entities']).toEqual(EXPECTED_POST_ENTITIES);
    expect(previewContent?.['parse_mode']).toBeUndefined();

    // ---- REVIEWER approves via the REAL button from their OWN reply.
    const approveToken = firstButton(fake, REVIEWER_ID, 'Approve');
    await deliver(BRIDGE_ENV, callbackUpdate(++updateSeq, REVIEWER_ID, approveToken));
    const approveAnswer = fake.calls.find(
      (c) =>
        c.url.endsWith('/answerCallbackQuery') && String(c.body['text'] ?? '').includes('APPROVED'),
    );
    expect(approveAnswer).toBeDefined();

    // ---- OWNER publishes while the LIVE flag is OFF: the action stops
    // BEFORE any publication row or Bot API call; nothing reaches the
    // channel and the approval stays active. The outcome travels as the
    // REAL callback answer.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${postDraftId}`));
    const publishToken = firstButton(fake, OWNER_ID, 'Publish');
    await deliver(BRIDGE_ENV, callbackUpdate(++updateSeq, OWNER_ID, publishToken));
    expect(lastAnswerText(fake)).toContain('DISABLED');
    expect(lastAnswerText(fake)).toContain('nothing was sent');
    const channelSends = fake.sentMessages.filter((m) => m['chat_id'] === TARGET_CHANNEL);
    expect(channelSends).toHaveLength(0);
    // The approval was NOT consumed by the stopped publish: a fresh preview
    // still offers the Publish button.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${postDraftId}`));
    expect(firstButton(fake, OWNER_ID, 'Publish')).toMatch(/^[0-9a-f-]+$/u);
  });

  it('publishes the exact rendered content to the configured channel once the live flag is ON (same real client, no bypass)', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // The id the test USES comes from the real /drafts reply below.
    await buildPipelineReadyDraft();
    await deliver(LIVE_ENV, textUpdate(++updateSeq, OWNER_ID, '/drafts'));
    const deliveredId = editorialIdFromDraftsReply(fake, OWNER_ID);
    await deliver(LIVE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${deliveredId}`));
    const postDraftId = postDraftIdFromReply(fake, OWNER_ID);

    // Reviewer previews + approves (the version-bound server-side flow).
    await deliver(LIVE_ENV, textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${postDraftId}`));
    const approveToken = firstButton(fake, REVIEWER_ID, 'Approve');
    await deliver(LIVE_ENV, callbackUpdate(++updateSeq, REVIEWER_ID, approveToken));

    // Publisher (the owner) previews and publishes through the REAL button.
    await deliver(LIVE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${postDraftId}`));
    const publishToken = firstButton(fake, OWNER_ID, 'Publish');
    await deliver(LIVE_ENV, callbackUpdate(++updateSeq, OWNER_ID, publishToken));

    // EXACTLY ONE channel send with the EXACT stored render — direct
    // entities, NO parse_mode, destination = operator configuration.
    const channelSends = fake.sentMessages.filter((m) => m['chat_id'] === TARGET_CHANNEL);
    expect(channelSends).toHaveLength(1);
    expect(channelSends[0]?.['text']).toBe(EXPECTED_POST_TEXT);
    expect(channelSends[0]?.['entities']).toEqual(EXPECTED_POST_ENTITIES);
    expect(channelSends[0]?.['parse_mode']).toBeUndefined();
    expect(lastAnswerText(fake)).toContain('PUBLISHED');
  });

  it('converts into the caller\u2019s EXISTING open draft as a new version and invalidates the older approval', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // Owner captures a manual text post and the reviewer approves v1.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, '/post'));
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, 'پست دستی اول'));
    const captureReply = replyTexts(fake, OWNER_ID).find((t) => /Draft id: /.test(t));
    expect(captureReply).toBeDefined();
    const postDraftId = /Draft id: ([0-9a-f-]{36})/u.exec(captureReply!)![1]!;
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${postDraftId}`));
    const approveToken = firstButton(fake, REVIEWER_ID, 'Approve');
    await deliver(BRIDGE_ENV, callbackUpdate(++updateSeq, REVIEWER_ID, approveToken));

    // The bridge adds the editorial content as version 2 of the SAME open
    // draft — the reply says so and warns that older approvals are INVALID.
    const _editorialDraftUnused = await buildPipelineReadyDraft();
    void _editorialDraftUnused;
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, '/drafts'));
    const deliveredId = editorialIdFromDraftsReply(fake, OWNER_ID);
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${deliveredId}`));
    const converted = replyTexts(fake, OWNER_ID).at(-1)!;
    expect(converted).toContain('version 2');
    expect(converted).toContain('INVALID');
    expect(converted).toContain(deliveredId);
    // The SAME open draft (the reply repeats its id via the conversion text).
    expect(converted).toContain(postDraftId);

    // The stale v1 approval can no longer publish: the Publish button is
    // offered to the holder, but the ACTION answers honestly. The click
    // runs under the LIVE env (the live gate would otherwise answer first —
    // it precedes the approval check by design), proving the v1 approval
    // was invalidated by the conversion's atomic batch: no ACTIVE approval
    // exists for the new current version until a fresh approval.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${postDraftId}`));
    const stalePublishToken = firstButton(fake, OWNER_ID, 'Publish');
    await deliver(LIVE_ENV, callbackUpdate(++updateSeq, OWNER_ID, stalePublishToken));
    expect(lastAnswerText(fake)).toContain('no ACTIVE approval');
    // The new current version IS the editorial render.
    const preview = repliesTo(fake, OWNER_ID).find((m) => m['text'] === EXPECTED_POST_TEXT);
    expect(preview).toBeDefined();
  });

  it('rejects unknown, non-ready, malformed, unsupported and over-limit editorial drafts with explicit typed replies (never truncation)', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);

    // Unknown id.
    await deliver(
      BRIDGE_ENV,
      textUpdate(++updateSeq, OWNER_ID, '/post_from_draft eddr_00000000000000000000000000000000'),
    );
    expect(replyTexts(fake, OWNER_ID).at(-1)).toContain('no editorial draft with that id exists');

    // Invalid usage: no argument / extra tokens.
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, '/post_from_draft'));
    expect(replyTexts(fake, OWNER_ID).at(-1)).toContain('Invalid usage');
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, '/post_from_draft a b'));
    expect(replyTexts(fake, OWNER_ID).at(-1)).toContain('Invalid usage');

    // Non-ready status.
    const realId = await buildPipelineReadyDraft();
    await executor.run({
      sql: `UPDATE drafts SET status = 'failed' WHERE id = ?`,
      params: [realId],
    });
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${realId}`));
    expect(replyTexts(fake, OWNER_ID).at(-1)).toContain('not in the READY state');
    await executor.run({
      sql: `UPDATE drafts SET status = 'ready' WHERE id = ?`,
      params: [realId],
    });

    // Malformed stored document.
    await executor.run({
      sql: `UPDATE drafts SET document_json = 'not json' WHERE id = ?`,
      params: [realId],
    });
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${realId}`));
    expect(replyTexts(fake, OWNER_ID).at(-1)).toContain('unreadable or unsupported');

    // Unsupported document version.
    await executor.run({
      sql: `UPDATE drafts SET document_json = '{"schemaVersion":2}' WHERE id = ?`,
      params: [realId],
    });
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${realId}`));
    expect(replyTexts(fake, OWNER_ID).at(-1)).toContain('unreadable or unsupported');

    // Over-limit content: the render fails TYPED — nothing is truncated,
    // nothing is saved.
    await executor.run({
      sql: `UPDATE drafts SET document_json = ? WHERE id = ?`,
      params: [
        JSON.stringify({
          schemaVersion: 1,
          headlineFa: PIPELINE_HEADLINE,
          summaryFa: 'خ'.repeat(4200),
        }),
        realId,
      ],
    });
    await deliver(BRIDGE_ENV, textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${realId}`));
    const overLimit = replyTexts(fake, OWNER_ID).at(-1)!;
    expect(overLimit).toContain('beyond the post length limit');
    expect(overLimit).toContain('NOT truncated');
    // The honest negative: NO admin post version exists for this owner.
    const versionCount = await executor.first<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM admin_post_versions WHERE created_by_user_id = ?`,
      params: [OWNER_ID],
    });
    expect(versionCount?.n).toBe(0);
  });

  it('keeps the exact legacy noop while the bridge flag is OFF and ignores group-chat usage', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    const editorialDraftId = await buildPipelineReadyDraft();

    // Flag OFF (admin post surface ON): the command is an unknown command —
    // zero feedback, zero state.
    const flagOffEnv = { ...BASE_ENV, ADMIN_POST_ENABLED: 'true', ADMIN_REVIEW_ENABLED: 'true' };
    await deliver(
      flagOffEnv,
      textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${editorialDraftId}`),
    );
    expect(replyTexts(fake, OWNER_ID)).toHaveLength(0);

    // Bridge ON but GROUP chat: silent noop (private chat only).
    await deliver(
      BRIDGE_ENV,
      textUpdate(++updateSeq, OWNER_ID, `/post_from_draft ${editorialDraftId}`, -100300),
    );
    expect(replyTexts(fake, -100300)).toHaveLength(0);

    // Nothing was derived anywhere.
    const versionCount = await executor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM admin_post_versions',
    });
    expect(versionCount?.n).toBe(0);
  });
});
