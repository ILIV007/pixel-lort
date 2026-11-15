import { describe, expect, it } from 'vitest';
import { parseTelegramUpdate } from '../../src/adapters/telegram/update-parser';
import { createRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';
import { createBotApiClient } from '../../src/adapters/telegram/bot-api-client';

function parseMessage(fields: Record<string, unknown>) {
  const result = parseTelegramUpdate({
    update_id: 99001,
    message: {
      message_id: 11,
      date: 1760000000,
      chat: { id: 555, type: 'private' },
      from: { id: 1000000001, is_bot: false, first_name: 'Fixture' },
      ...fields,
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.update.kind !== 'message') throw new Error('unexpected parser result');
  return result.update;
}

describe('Posidon R119 ORIGINAL native-rich-text correctness', () => {
  it('M1: real wire text_mention survives parser -> domain without losing user metadata', () => {
    const update = parseMessage({
      text: 'سلام دوست',
      entities: [
        {
          type: 'text_mention',
          offset: 5,
          length: 4,
          user: { id: 222, is_bot: false, first_name: 'دوست', username: 'fixture_friend' },
        },
      ],
    });
    expect(update.richText?.ok).toBe(true);
    if (!update.richText?.ok) throw new Error('extraction failed');
    const outcome = createRichTextEnvelope(update.richText);
    console.log('POSIDON_R119_M1', JSON.stringify(outcome));
    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect(outcome.envelope.entities[0]?.user).toMatchObject({
        id: 222,
        isBot: false,
        firstName: 'دوست',
      });
  });
  it('N1: documented style-inside-link nesting is legal, not an atomic-leaf rejection', () => {
    const outcome = createRichTextEnvelope({
      kind: 'text',
      text: 'abcdefghij',
      entities: [
        { type: 'text_link', offset: 0, length: 10, url: 'https://example.com/story' },
        { type: 'bold', offset: 2, length: 3 },
      ],
    });
    console.log('POSIDON_R119_N1', JSON.stringify(outcome));
    expect(outcome.ok).toBe(true);
  });
  it('P1: plain caption with omitted optional caption_entities is preserved, not lost', () => {
    const update = parseMessage({
      photo: [
        { file_id: 'synthetic-file', file_unique_id: 'synthetic-unique', width: 1, height: 1 },
      ],
      caption: 'کپشن ساده 😀',
    });
    console.log(
      'POSIDON_R119_P1',
      JSON.stringify({ richCaption: update.richCaption ?? null, legacyText: update.text ?? null }),
    );
    expect(update.richCaption).toMatchObject({
      ok: true,
      kind: 'caption',
      text: 'کپشن ساده 😀',
      entities: [],
    });
    expect(update.command).toBeUndefined();
  });
  it('F1: date_time format full-match rejects trailing LF before transport fetch', async () => {
    const outcome = createRichTextEnvelope({
      kind: 'text',
      text: 'tomorrow',
      entities: [
        { type: 'date_time', offset: 0, length: 8, unixTime: 1760000000, dateTimeFormat: 'r\n' },
      ],
    });
    let fetchCalls = 0;
    const client = createBotApiClient({
      botToken: '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000',
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    if (outcome.ok) await client.sendMessageRich({ chatId: 555, content: outcome.envelope });
    console.log('POSIDON_R119_F1', JSON.stringify({ domainAccepted: outcome.ok, fetchCalls }));
    expect(outcome.ok).toBe(false);
    expect(fetchCalls).toBe(0);
  });
});
