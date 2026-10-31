import { describe, expect, it } from 'vitest';
import { createBotApiClient, TelegramApiError } from '../../src/adapters/telegram/bot-api-client';
import { parseTelegramUpdate } from '../../src/adapters/telegram/update-parser';
import {
  createRichTextEnvelope,
  readRichTextEnvelope,
  serializeRichTextEnvelope,
  type RichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';
import { escapeTelegramHtml } from '../../src/admin/telegram-html';
import { AppError } from '../../src/shared/errors/app-error';

/**
 * R1.19 — entity-based output on the REAL Bot API client factory.
 *
 * Contract: direct entity payloads use exact `text` + `entities` or
 * `caption` + `caption_entities` with NO parse_mode; every input is
 * re-validated at runtime (a forged cast cannot bypass the boundary);
 * validation failure and custom_emoji restriction are typed outcomes with
 * ZERO fetch calls; the admin-safe HTML path is unchanged; transport error
 * classification is unchanged.
 */

const FAKE_TOKEN = '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000';
const CHAT_ID = 555000111;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CapturedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function makeClient(respond?: (url: string, body: Record<string, unknown>) => Response) {
  const requests: CapturedRequest[] = [];
  const client = createBotApiClient({
    botToken: FAKE_TOKEN,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      return respond?.(String(url), body) ?? jsonResponse({ ok: true, result: { message_id: 77 } });
    },
  });
  return { client, requests };
}

function textEnvelopeFixture(): RichTextEnvelope {
  const outcome = createRichTextEnvelope({
    kind: 'text',
    text: 'گزارش 😀 امروز',
    entities: [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'text_link', offset: 9, length: 5, url: 'https://example.example/x' },
    ],
  });
  if (!outcome.ok) throw new Error(`fixture broken: ${outcome.reason}`);
  return outcome.envelope;
}

function captionEnvelopeFixture(): RichTextEnvelope {
  const outcome = createRichTextEnvelope({
    kind: 'caption',
    text: 'تصویر: دمو ✓',
    entities: [{ type: 'italic', offset: 7, length: 3 }],
  });
  if (!outcome.ok) throw new Error(`fixture broken: ${outcome.reason}`);
  return outcome.envelope;
}

function semanticEntities(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) throw new Error('entities not a list');
  return list.map((raw) => {
    const e = raw as Record<string, unknown>;
    return {
      type: e['type'],
      offset: e['offset'],
      length: e['length'],
      url: e['url'],
      language: e['language'],
      custom_emoji_id: e['custom_emoji_id'],
      unix_time: e['unix_time'],
      date_time_format: e['date_time_format'],
      user: e['user'],
    };
  });
}

describe('createBotApiClient — direct entity transport (no parse_mode)', () => {
  it('sends sendMessageRich with exact text + entities and never a parse_mode key', async () => {
    const { client, requests } = makeClient();
    const envelope = textEnvelopeFixture();
    await client.sendMessageRich({ chatId: CHAT_ID, content: envelope });
    expect(requests).toHaveLength(1);
    const { url, body } = requests[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(body['chat_id']).toBe(CHAT_ID);
    expect(body['text']).toBe('گزارش 😀 امروز');
    expect('caption' in body).toBe(false);
    expect('parse_mode' in body).toBe(false);
    expect(semanticEntities(body['entities'])).toEqual([
      { type: 'bold', offset: 0, length: 6 },
      { type: 'text_link', offset: 9, length: 5, url: 'https://example.example/x' },
    ]);
    // Existing documented policy: link previews disabled by default.
    expect(body['disable_web_page_preview']).toBe(true);
    await expect(
      client.sendMessageRich({ chatId: CHAT_ID, content: envelope, disableLinkPreview: false }),
    ).resolves.toEqual({ messageId: 77 });
    expect(requests[1]?.body['disable_web_page_preview']).toBe(false);
  });

  it('sends editMessageTextRich with text + entities and no parse_mode', async () => {
    const { client, requests } = makeClient();
    await expect(
      client.editMessageTextRich({
        chatId: CHAT_ID,
        messageId: 12,
        content: textEnvelopeFixture(),
      }),
    ).resolves.toBe(true);
    const { url, body } = requests[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/editMessageText`);
    expect(body['chat_id']).toBe(CHAT_ID);
    expect(body['message_id']).toBe(12);
    expect(body['text']).toBe('گزارش 😀 امروز');
    expect('parse_mode' in body).toBe(false);
  });

  it('sends editMessageCaptionRich with caption + caption_entities and no parse_mode (no media forwarding claim)', async () => {
    const { client, requests } = makeClient();
    await expect(
      client.editMessageCaptionRich({
        chatId: CHAT_ID,
        messageId: 15,
        content: captionEnvelopeFixture(),
      }),
    ).resolves.toBe(true);
    const { url, body } = requests[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/editMessageCaption`);
    expect(body['caption']).toBe('تصویر: دمو ✓');
    expect('text' in body).toBe(false);
    expect('parse_mode' in body).toBe(false);
    expect(semanticEntities(body['caption_entities'])).toEqual([
      { type: 'italic', offset: 7, length: 3 },
    ]);
  });

  it('preserves metadata for supported entities, including date_time', async () => {
    const { client, requests } = makeClient();
    const outcome = createRichTextEnvelope({
      kind: 'text',
      text: 'زمان و کاربر',
      entities: [
        { type: 'date_time', offset: 0, length: 4, unixTime: 1_700_000_000, dateTimeFormat: 'wdt' },
        {
          type: 'text_mention',
          offset: 5,
          length: 6,
          user: { id: 42, isBot: false, firstName: 'علی' },
        },
      ],
    });
    if (!outcome.ok) throw new Error('fixture broken');
    await client.sendMessageRich({ chatId: CHAT_ID, content: outcome.envelope });
    expect(semanticEntities(requests[0]!.body['entities'])).toEqual([
      {
        type: 'date_time',
        offset: 0,
        length: 4,
        unix_time: 1_700_000_000,
        date_time_format: 'wdt',
      },
      {
        type: 'text_mention',
        offset: 5,
        length: 6,
        user: { id: 42, is_bot: false, first_name: 'علی' },
      },
    ]);
  });
});

describe('createBotApiClient — typed pre-fetch rejections (zero fetch)', () => {
  it('rejects text/caption kind mismatches before any fetch', async () => {
    const { client, requests } = makeClient();
    await expect(
      client.sendMessageRich({ chatId: CHAT_ID, content: captionEnvelopeFixture() }),
    ).rejects.toMatchObject({ reason: 'kind_mismatch' });
    await expect(
      client.editMessageCaptionRich({
        chatId: CHAT_ID,
        messageId: 1,
        content: textEnvelopeFixture(),
      }),
    ).rejects.toMatchObject({ reason: 'kind_mismatch' });
    expect(requests).toHaveLength(0);
  });

  it('re-validates content at runtime — a forged cast cannot smuggle invalid entities into fetch', async () => {
    const { client, requests } = makeClient();
    const forged = {
      schemaVersion: 1,
      kind: 'text',
      text: 'forged',
      entities: [{ type: 'bold', offset: Number.NaN, length: 1 }],
    } as unknown as RichTextEnvelope;
    await expect(
      client.sendMessageRich({ chatId: CHAT_ID, content: forged }),
    ).rejects.toMatchObject({ reason: 'invalid_content' });
    const forgedRange = {
      schemaVersion: 1,
      kind: 'text',
      text: 'forged range',
      entities: [{ type: 'bold', offset: 0, length: 99 }],
    } as unknown as RichTextEnvelope;
    await expect(
      client.sendMessageRich({ chatId: CHAT_ID, content: forgedRange }),
    ).rejects.toMatchObject({ reason: 'invalid_content' });
    expect(requests).toHaveLength(0);
  });

  it('keeps custom_emoji output restricted behind the explicit eligibility capability (zero fetch)', async () => {
    const outcome = createRichTextEnvelope({
      kind: 'text',
      text: 'emoji 🎗 here',
      entities: [
        { type: 'custom_emoji', offset: 6, length: 2, customEmojiId: '5369000000000000001' },
      ],
    });
    if (!outcome.ok) throw new Error('fixture broken');

    const restricted = makeClient();
    await expect(
      restricted.client.sendMessageRich({ chatId: CHAT_ID, content: outcome.envelope }),
    ).rejects.toMatchObject({ reason: 'custom_emoji_not_eligible' });
    expect(restricted.requests).toHaveLength(0);

    const eligible = makeClient();
    await eligible.client.sendMessageRich({
      chatId: CHAT_ID,
      content: outcome.envelope,
      customEmojiEligible: true,
    });
    expect(eligible.requests).toHaveLength(1);
    expect(semanticEntities(eligible.requests[0]!.body['entities'])).toEqual([
      { type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '5369000000000000001' },
    ]);
    // Custom-emoji retention is NOT a delivery promise — only the explicit
    // capability authorizes the attempt; rendering remains Telegram's call.
  });
});

describe('createBotApiClient — unchanged HTML path and transport classification', () => {
  it('keeps the admin HTML send path on parse_mode: HTML with its runtime validator', async () => {
    const { client, requests } = makeClient();
    await client.sendMessage({ chatId: CHAT_ID, text: escapeTelegramHtml('<b>سلام</b>') });
    expect(requests[0]!.body['parse_mode']).toBe('HTML');
    expect(requests[0]!.body['entities']).toBeUndefined();

    // A forged raw string still cannot bypass the runtime HTML boundary.
    await expect(
      client.sendMessage({ chatId: CHAT_ID, text: '<script>alert(1)</script>' as never }),
    ).rejects.toEqual(new AppError('internal_error'));
    expect(requests).toHaveLength(1);
  });

  it('preserves transport error classification for entity-based calls (429 -> retryable rate limit)', async () => {
    const { client } = makeClient(() =>
      jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests' }, 429),
    );
    const error = await client
      .sendMessageRich({ chatId: CHAT_ID, content: textEnvelopeFixture() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).code).toBe('telegram_rate_limited');
    expect((error as TelegramApiError).retryable).toBe(true);
  });

  it('preserves timeout classification for entity-based calls', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const client = createBotApiClient({
      botToken: FAKE_TOKEN,
      fetchImpl: async () => {
        throw abort;
      },
    });
    const error = await client
      .editMessageTextRich({ chatId: CHAT_ID, messageId: 1, content: textEnvelopeFixture() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).code).toBe('telegram_timeout');
    expect((error as TelegramApiError).retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R1.19.1 — ORIGINAL M1 and P1 transport companions: the REAL incoming raw
// update flows through parser -> envelope -> serialize -> read -> the REAL
// client factory with a captured fake fetch, proving the wire User and the
// plain caption survive end-to-end with NO parse_mode. The ORIGINAL proof
// lives in tests/unit/posidon-r119-original-proof.test.ts.
// ---------------------------------------------------------------------------
describe('createBotApiClient — R1.19.1 end-to-end correctness companions', () => {
  it('M1: raw text_mention update reaches the wire with the EXACT Bot API User shape', async () => {
    const parsed = parseTelegramUpdate({
      update_id: 99001,
      message: {
        message_id: 11,
        date: 1760000000,
        chat: { id: 555, type: 'private' },
        from: { id: 1000000001, is_bot: false, first_name: 'Fixture' },
        text: 'سلام دوست',
        entities: [
          {
            type: 'text_mention',
            offset: 5,
            length: 4,
            user: {
              id: 222,
              is_bot: false,
              first_name: 'دوست',
              username: 'fixture_friend',
              is_premium: true, // real-payload extra: dropped by the parser
            },
          },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.update.kind !== 'message') throw new Error('parse failed');
    if (!parsed.update.richText?.ok) throw new Error('extraction failed');
    const envelopeOutcome = createRichTextEnvelope(parsed.update.richText);
    if (!envelopeOutcome.ok) throw new Error(`envelope failed: ${envelopeOutcome.reason}`);
    // Persistence round trip: serialize -> defensive read.
    const serialized = serializeRichTextEnvelope(envelopeOutcome.envelope);
    if (!serialized.ok) throw new Error('serialize failed');
    const read = readRichTextEnvelope(serialized.json);
    if (!read.ok) throw new Error(`read failed: ${read.reason}`);
    // Transport: the REAL client factory with a captured fake fetch.
    const { client, requests } = makeClient();
    await client.sendMessageRich({ chatId: 555, content: read.envelope });
    expect(requests).toHaveLength(1);
    const { url, body } = requests[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(body['chat_id']).toBe(555);
    expect(body['text']).toBe('سلام دوست');
    expect('parse_mode' in body).toBe(false);
    const entities = semanticEntities(body['entities']);
    expect(entities[0]).toEqual({
      type: 'text_mention',
      offset: 5,
      length: 4,
      url: undefined,
      language: undefined,
      custom_emoji_id: undefined,
      unix_time: undefined,
      date_time_format: undefined,
      // EXACT wire shape on output: snake_case, minimal documented fields,
      // no arbitrary nested raw data and no camelCase leakage.
      user: { id: 222, is_bot: false, first_name: 'دوست', username: 'fixture_friend' },
    });
    expect(JSON.stringify(body)).not.toContain('is_premium');
    expect(JSON.stringify(body)).not.toContain('isBot');
  });

  it('P1: plain caption flows to a real editMessageCaption with exact caption and empty entities', async () => {
    const parsed = parseTelegramUpdate({
      update_id: 99002,
      edited_message: {
        message_id: 12,
        date: 1760000000,
        chat: { id: 555, type: 'private' },
        from: { id: 1000000001, is_bot: false, first_name: 'Fixture' },
        photo: [
          { file_id: 'synthetic-file', file_unique_id: 'synthetic-unique', width: 1, height: 1 },
        ],
        caption: 'کپشن ساده 😀', // NO caption_entities field at all
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.update.kind !== 'edited_message') throw new Error('parse failed');
    if (!parsed.update.richCaption?.ok) throw new Error('caption extraction failed');
    const envelopeOutcome = createRichTextEnvelope(parsed.update.richCaption);
    if (!envelopeOutcome.ok) throw new Error(`envelope failed: ${envelopeOutcome.reason}`);
    expect(envelopeOutcome.envelope.kind).toBe('caption');
    const { client, requests } = makeClient(() => jsonResponse({ ok: true, result: true }));
    const edited = await client.editMessageCaptionRich({
      chatId: 555,
      messageId: 12,
      content: envelopeOutcome.envelope,
    });
    expect(edited).toBe(true);
    expect(requests).toHaveLength(1);
    const { url, body } = requests[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/editMessageCaption`);
    expect(body['chat_id']).toBe(555);
    expect(body['message_id']).toBe(12);
    expect(body['caption']).toBe('کپشن ساده 😀');
    expect(body['caption_entities']).toEqual([]);
    expect('parse_mode' in body).toBe(false);
    expect('text' in body).toBe(false);
  });
});
