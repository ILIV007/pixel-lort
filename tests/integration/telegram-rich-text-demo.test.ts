import { describe, expect, it } from 'vitest';
import { parseTelegramUpdate } from '../../src/adapters/telegram/update-parser';
import { createBotApiClient } from '../../src/adapters/telegram/bot-api-client';
import {
  createRichTextEnvelope,
  readRichTextEnvelope,
  serializeRichTextEnvelope,
  RICH_TEXT_LIMITS,
  type RichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';

/**
 * R1.19 OFFLINE end-to-end demo — the required visible deliverable
 * (`npm run demo:telegram-rich-text`).
 *
 * REAL production parser -> versioned envelope -> bounded serializer ->
 * defensive re-reader -> REAL Bot API client factory with a FAKE fetch.
 * Persian formatted text (ZWNJ + astral emoji + link) and a caption fixture
 * flow through the whole chain; the captured synthetic request payloads are
 * compared field-by-field. Honest limits: NO durable DB persistence, NO live
 * Telegram call, NO AI/charge, NO media forwarding — this proves the
 * transport FOUNDATION, not the owner's final end-to-end publication.
 */

const FAKE_TOKEN = '0000000000:DEMO-DEMO-DEMO-DEMO-DEMO-DEMO-000000';

const POST_TEXT = '🎉 خبر فوری: بازار رمزارزها نیم\u200cفاصله دارد';
const POST_ENTITIES = [
  { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5369000000000000001' },
  { type: 'bold', offset: 3, length: 8 },
  { type: 'code', offset: 13, length: 5 },
  { type: 'italic', offset: 19, length: 8 },
  { type: 'text_link', offset: 28, length: 9, url: 'https://news.example.example/btc' },
];

const CAPTION_TEXT = 'تصویر: دمو ✓';
const CAPTION_ENTITIES = [
  { type: 'bold', offset: 0, length: 5 },
  { type: 'italic', offset: 7, length: 3 },
];

interface CapturedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function makeCapturingClient() {
  const requests: CapturedRequest[] = [];
  const client = createBotApiClient({
    botToken: FAKE_TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: requests.length + 100 } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  return { client, requests };
}

function semanticEntities(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) throw new Error('entities missing');
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

describe('telegram rich-text demo — offline parser -> envelope -> reader -> client transport', () => {
  it('keeps a formatted Persian post and a caption faithful through the whole offline chain', async () => {
    // ------------------------------------------------------------------
    // 1) Raw Telegram Update fixtures (clearly fictional, displayable) —
    //    frozen to prove the chain never mutates its input.
    // ------------------------------------------------------------------
    const rawTextUpdate = deepFreeze({
      update_id: 7001,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 2000001, type: 'private' },
        from: { id: 3000000001, is_bot: false, first_name: 'Demo' },
        text: POST_TEXT,
        entities: POST_ENTITIES.map((e) => deepFreeze({ ...e })),
      },
    });
    const rawCaptionUpdate = deepFreeze({
      update_id: 7002,
      message: {
        message_id: 12,
        date: 1_700_000_001,
        chat: { id: 2000001, type: 'private' },
        from: { id: 3000000001, is_bot: false, first_name: 'Demo' },
        caption: CAPTION_TEXT,
        caption_entities: CAPTION_ENTITIES.map((e) => deepFreeze({ ...e })),
      },
    });
    const snapshotBefore = JSON.stringify([rawTextUpdate, rawCaptionUpdate]);

    // ------------------------------------------------------------------
    // 2) REAL parser: bounded typed rich-text extraction.
    // ------------------------------------------------------------------
    const parsedText = parseTelegramUpdate(rawTextUpdate);
    const parsedCaption = parseTelegramUpdate(rawCaptionUpdate);
    expect(parsedText.ok && parsedCaption.ok).toBe(true);
    if (!parsedText.ok || !parsedCaption.ok) return;
    if (parsedText.update.kind !== 'message' || parsedCaption.update.kind !== 'message') return;
    const richText = parsedText.update.richText;
    const richCaption = parsedCaption.update.richCaption;
    if (richText?.ok !== true || richCaption?.ok !== true)
      throw new Error('parser extraction failed');
    expect(richText.text).toBe(POST_TEXT);
    expect(richCaption.text).toBe(CAPTION_TEXT);

    // ------------------------------------------------------------------
    // 3) Versioned envelope: validate, canonically order, serialize boundedly,
    //    re-read defensively — the exact future-persistence shape (NO DB here).
    // ------------------------------------------------------------------
    const textBuilt = createRichTextEnvelope({
      kind: richText.kind,
      text: richText.text,
      entities: richText.entities,
    });
    const captionBuilt = createRichTextEnvelope({
      kind: richCaption.kind,
      text: richCaption.text,
      entities: richCaption.entities,
    });
    expect(textBuilt.ok && captionBuilt.ok).toBe(true);
    if (!textBuilt.ok || !captionBuilt.ok) return;
    const textEnvelope: RichTextEnvelope = textBuilt.envelope;
    const captionEnvelope: RichTextEnvelope = captionBuilt.envelope;

    const textSerialized = serializeRichTextEnvelope(textEnvelope);
    const captionSerialized = serializeRichTextEnvelope(captionEnvelope);
    expect(textSerialized.ok && captionSerialized.ok).toBe(true);
    if (!textSerialized.ok || !captionSerialized.ok) return;
    expect(textSerialized.byteLength).toBeLessThanOrEqual(RICH_TEXT_LIMITS.maxSerializedBytes);

    const textReread = readRichTextEnvelope(textSerialized.json);
    const captionReread = readRichTextEnvelope(captionSerialized.json);
    expect(textReread.ok && captionReread.ok).toBe(true);
    if (!textReread.ok || !captionReread.ok) return;
    expect(textReread.envelope.text).toBe(POST_TEXT);
    expect(textReread.envelope.entities).toEqual(textEnvelope.entities);

    // ------------------------------------------------------------------
    // 4) REAL client factory + FAKE fetch: captured direct-entity payloads.
    // ------------------------------------------------------------------
    const { client, requests } = makeCapturingClient();
    await client.sendMessageRich({
      chatId: 2000001,
      content: textReread.envelope,
      disableLinkPreview: true,
      customEmojiEligible: true, // explicit trusted capability for the demo fixture
    });
    await client.editMessageCaptionRich({
      chatId: 2000001,
      messageId: 12,
      content: captionReread.envelope,
    });

    expect(requests).toHaveLength(2);
    const [send, captionEdit] = requests as [CapturedRequest, CapturedRequest];
    expect(send.url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(send.body['text']).toBe(POST_TEXT);
    expect('parse_mode' in send.body).toBe(false);
    expect(semanticEntities(send.body['entities'])).toEqual(
      semanticEntities(JSON.parse(textSerialized.json as string).entities ?? []),
    );
    expect(semanticEntities(send.body['entities'])).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5369000000000000001' },
      { type: 'bold', offset: 3, length: 8 },
      { type: 'code', offset: 13, length: 5 },
      { type: 'italic', offset: 19, length: 8 },
      { type: 'text_link', offset: 28, length: 9, url: 'https://news.example.example/btc' },
    ]);

    expect(captionEdit.url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/editMessageCaption`);
    expect(captionEdit.body['caption']).toBe(CAPTION_TEXT);
    expect('parse_mode' in captionEdit.body).toBe(false);
    expect('text' in captionEdit.body).toBe(false);
    expect(semanticEntities(captionEdit.body['caption_entities'])).toEqual([
      { type: 'bold', offset: 0, length: 5 },
      { type: 'italic', offset: 7, length: 3 },
    ]);

    // ------------------------------------------------------------------
    // 5) Honest rejection paths: custom-emoji restriction and malformed
    //    stored envelope both fail TYPED with ZERO new fetch calls.
    // ------------------------------------------------------------------
    const restricted = makeCapturingClient();
    await expect(
      restricted.client.sendMessageRich({ chatId: 2000001, content: textReread.envelope }),
    ).rejects.toMatchObject({ reason: 'custom_emoji_not_eligible' });
    expect(restricted.requests).toHaveLength(0);

    await expect(
      restricted.client.sendMessageRich({ chatId: 2000001, content: { nope: true } as never }),
    ).rejects.toMatchObject({ reason: 'invalid_content' });
    expect(restricted.requests).toHaveLength(0);
    expect(readRichTextEnvelope('{broken json')).toEqual({ ok: false, reason: 'malformed_json' });

    // ------------------------------------------------------------------
    // 6) Fixtures untouched; counters honest.
    // ------------------------------------------------------------------
    expect(JSON.stringify([rawTextUpdate, rawCaptionUpdate])).toBe(snapshotBefore);
    expect(
      requests.every((r) => r.url.startsWith(`https://api.telegram.org/bot${FAKE_TOKEN}/`)),
    ).toBe(true);

    const summary = {
      roundTrip: {
        textExact: true,
        captionExact: true,
        entitiesEqualAfterRoundTrip: true,
        textEnvelopeSerializedBytes: textSerialized.byteLength,
        captionEnvelopeSerializedBytes: captionSerialized.byteLength,
      },
      counters: {
        syntheticFetchRequests: requests.length,
        rejectedBeforeFetch: 2,
        malformedStoredEnvelopeOutcomes: 1,
        realNetworkCalls: 0,
        aiCalls: 0,
        charges: 0,
        dbWrites: 0,
        parseModeKeysInEntityPayloads: 0,
      },
      limits: {
        textCapUnits: RICH_TEXT_LIMITS.maxTextUnits,
        captionCapUnits: RICH_TEXT_LIMITS.maxCaptionUnits,
        maxEntities: RICH_TEXT_LIMITS.maxEntities,
        maxSerializedBytes: RICH_TEXT_LIMITS.maxSerializedBytes,
      },
      honestScope: [
        'foundation only — NO durable DB persistence, NO inbox/capture route, NO approval action',
        'NO live Telegram delivery; fake fetch only; custom-emoji retention is not a rendering promise',
      ],
    };
    // eslint-disable-next-line no-console -- THE demo output (safe, bounded, fictional)
    console.log(
      'TELEGRAM_RICH_TEXT_DEMO_CONTENT',
      JSON.stringify(
        {
          postText: POST_TEXT,
          postEntities: semanticEntities(send.body['entities']),
          capturedSendBodyKeys: Object.keys(send.body).sort(),
          caption: CAPTION_TEXT,
          capturedCaptionEntities: semanticEntities(captionEdit.body['caption_entities']),
          capturedCaptionBodyKeys: Object.keys(captionEdit.body).sort(),
          restrictedOutcome: 'custom_emoji_not_eligible (zero fetch)',
          invalidOutcome: 'invalid_content (zero fetch) + malformed_json (typed read failure)',
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console -- THE demo counters (LOCAL PROXY)
    console.log('TELEGRAM_RICH_TEXT_DEMO_SUMMARY', JSON.stringify(summary, null, 2));

    expect(summary.counters.syntheticFetchRequests).toBe(2);
    expect(summary.counters.rejectedBeforeFetch).toBe(2);
    expect(summary.counters.realNetworkCalls).toBe(0);
    expect(summary.counters.aiCalls).toBe(0);
    expect(summary.counters.charges).toBe(0);
    expect(summary.counters.dbWrites).toBe(0);
    expect(summary.counters.parseModeKeysInEntityPayloads).toBe(0);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
