import { describe, expect, it } from 'vitest';
import { parseTelegramUpdate, type ParsedUpdate } from '../../src/adapters/telegram/update-parser';
import { createRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';

/**
 * R1.19 — bounded typed native rich-text extraction in the REAL
 * parseTelegramUpdate (message/edited_message: text/entities and
 * caption/caption_entities).
 *
 * Contract: the extraction is passive metadata. Command extraction, routing
 * gates and legacy behavior are untouched; captions never become commands;
 * malformed rich-text metadata is an EXPLICIT typed outcome (never silently
 * absent, never silently empty) and never erases a legitimate admin command;
 * hostile payloads carrying both text and caption keep BOTH extractions
 * (neither is silently selected over the other).
 */

function messageUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 900,
    message: {
      message_id: 7,
      chat: { id: 555, type: 'private' },
      from: { id: 1000000001, is_bot: false, first_name: 'Test' },
      text: '/status',
      ...overrides,
    },
  };
}

function messagePayload(
  raw: unknown,
): Extract<ParsedUpdate, { kind: 'message' | 'edited_message' }> {
  const result = parseTelegramUpdate(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  if (result.update.kind !== 'message' && result.update.kind !== 'edited_message') {
    throw new Error(`unexpected kind ${result.update.kind}`);
  }
  return result.update;
}

describe('parseTelegramUpdate — rich text extraction (message)', () => {
  it('extracts text + entities as explicit typed rich metadata with exact content', () => {
    const update = messagePayload(
      messageUpdate({
        text: 'سلام 😀 دنیا',
        entities: [
          { type: 'bold', offset: 0, length: 4 },
          { type: 'custom_emoji', offset: 5, length: 2, custom_emoji_id: '5369000000000000001' },
          { type: 'text_link', offset: 8, length: 4, url: 'https://example.example/x' },
        ],
      }),
    );
    expect(update.richText).toEqual({
      ok: true,
      kind: 'text',
      text: 'سلام 😀 دنیا',
      entities: [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'custom_emoji', offset: 5, length: 2, customEmojiId: '5369000000000000001' },
        { type: 'text_link', offset: 8, length: 4, url: 'https://example.example/x' },
      ],
    });
  });

  it('keeps the offset/length/metadata values RAW for the envelope validator to judge', () => {
    const update = messagePayload(
      messageUpdate({
        text: 'hostile offsets',
        entities: [{ type: 'bold', offset: '0', length: -1, url: { nested: 'object' } }],
      }),
    );
    expect(update.richText).toEqual({
      ok: true,
      kind: 'text',
      text: 'hostile offsets',
      entities: [{ type: 'bold', offset: '0', length: -1, url: { nested: 'object' } }],
    });
  });

  it('treats an empty entity list as a valid explicit case and absent entities as no rich metadata', () => {
    const empty = messagePayload(messageUpdate({ text: 'plain', entities: [] }));
    expect(empty.richText).toEqual({ ok: true, kind: 'text', text: 'plain', entities: [] });

    const none = messagePayload(messageUpdate({ text: 'plain' }));
    expect(none.richText).toBeUndefined();
    // Conditional-spread convention: with no metadata the key is absent.
    expect('richText' in none).toBe(false);
  });

  it('reports malformed rich metadata explicitly without erasing the command', () => {
    for (const entities of [
      null,
      42,
      'nope',
      [null],
      [{ type: 7 }],
      [{ nope: true }],
      [{ type: '' }],
    ]) {
      const update = messagePayload(messageUpdate({ text: '/status', entities }));
      expect(update.text).toBe('/status');
      expect(update.command).toBe('status');
      expect(update.richText).toEqual({ ok: false, kind: 'text', reason: 'entities_malformed' });
    }
  });

  it('reports an over-cap entity list explicitly (entities_too_many)', () => {
    const entities = Array.from({ length: 101 }, (_, i) => ({
      type: 'bold',
      offset: i,
      length: 1,
    }));
    const update = messagePayload(messageUpdate({ text: 'too many', entities }));
    expect(update.richText).toEqual({ ok: false, kind: 'text', reason: 'entities_too_many' });
    expect(update.text).toBe('too many');
  });

  it('drops arbitrary undocumented entity fields at the projection boundary', () => {
    const update = messagePayload(
      messageUpdate({
        text: 'clean projection',
        entities: [
          {
            type: 'bold',
            offset: 0,
            length: 5,
            hostile_field: { deep: 'raw payload data' },
            another: 1,
          },
        ],
      }),
    );
    if (update.richText?.ok !== true) throw new Error('expected ok richText');
    expect(update.richText.entities[0]).toEqual({ type: 'bold', offset: 0, length: 5 });
    expect('hostile_field' in (update.richText.entities[0] as object)).toBe(false);
  });

  it('provides NO rich text when the text itself is absent or over the existing 4096 bound', () => {
    const noText = messagePayload(
      messageUpdate({ text: undefined, entities: [{ type: 'bold', offset: 0, length: 1 }] }),
    );
    expect(noText.text).toBeUndefined();
    expect(noText.richText).toBeUndefined();

    const huge = messagePayload(
      messageUpdate({ text: 'x'.repeat(4097), entities: [{ type: 'bold', offset: 0, length: 1 }] }),
    );
    expect(huge.text).toBeUndefined();
    expect(huge.richText).toBeUndefined();
    expect(huge.command).toBeUndefined();
  });
});

describe('parseTelegramUpdate — caption extraction (never a command)', () => {
  it('extracts caption + caption_entities as explicit typed rich metadata', () => {
    const update = messagePayload(
      messageUpdate({
        text: undefined,
        caption: 'تصویر: دمو ✓',
        caption_entities: [
          { type: 'bold', offset: 0, length: 5 },
          { type: 'italic', offset: 7, length: 3 },
        ],
      }),
    );
    expect(update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'تصویر: دمو ✓',
      entities: [
        { type: 'bold', offset: 0, length: 5 },
        { type: 'italic', offset: 7, length: 3 },
      ],
    });
    // A caption is NEVER a bot command — not even "/status"-shaped ones.
    expect(update.command).toBeUndefined();
  });

  it('never lets a caption become a command, and never feeds captions into command extraction', () => {
    const update = messagePayload(
      messageUpdate({ text: undefined, caption: '/status all', caption_entities: [] }),
    );
    expect(update.command).toBeUndefined();
    expect(update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: '/status all',
      entities: [],
    });
  });

  it('reports an over-cap caption explicitly (caption_too_large) instead of silently dropping it', () => {
    const update = messagePayload(
      messageUpdate({
        text: undefined,
        caption: 'x'.repeat(1025),
        caption_entities: [],
      }),
    );
    expect(update.richCaption).toEqual({ ok: false, kind: 'caption', reason: 'caption_too_large' });
  });

  it('keeps caption metadata malformed outcomes explicit', () => {
    const update = messagePayload(
      messageUpdate({ text: undefined, caption: 'عنوان', caption_entities: 'broken' }),
    );
    expect(update.richCaption).toEqual({
      ok: false,
      kind: 'caption',
      reason: 'entities_malformed',
    });
  });

  it('provides no richCaption when the caption is absent, empty, or not a string', () => {
    for (const caption of [undefined, '', 42, null]) {
      const update = messagePayload(messageUpdate({ text: 'has text', caption }));
      expect(update.richCaption).toBeUndefined();
    }
  });

  it('carries BOTH text and caption extractions independently for malformed both-payloads', () => {
    const update = messagePayload(
      messageUpdate({
        text: 'متن اصلی',
        entities: [{ type: 'bold', offset: 0, length: 4 }],
        caption: 'عنوان تصویر',
        caption_entities: [{ type: 'italic', offset: 0, length: 5 }],
      }),
    );
    expect(update.richText).toEqual({
      ok: true,
      kind: 'text',
      text: 'متن اصلی',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
    });
    expect(update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'عنوان تصویر',
      entities: [{ type: 'italic', offset: 0, length: 5 }],
    });
  });
});

describe('parseTelegramUpdate — edited messages and untouched legacy behavior', () => {
  it('extracts identical rich metadata from edited_message without granting new routing behavior', () => {
    const raw = {
      update_id: 901,
      edited_message: {
        message_id: 8,
        chat: { id: 555, type: 'private' },
        from: { id: 1000000001 },
        text: 'ویرایش شده',
        entities: [{ type: 'spoiler', offset: 0, length: 5 }],
      },
    };
    const result = parseTelegramUpdate(raw);
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'edited_message') return;
    expect(result.update.richText).toEqual({
      ok: true,
      kind: 'text',
      text: 'ویرایش شده',
      entities: [{ type: 'spoiler', offset: 0, length: 5 }],
    });
    expect(result.update.command).toBeUndefined();
  });

  it('leaves callback_query and unsupported updates untouched (no rich fields)', () => {
    const callback = parseTelegramUpdate({
      update_id: 902,
      callback_query: {
        id: 'cb',
        from: { id: 5 },
        data: 'a:b',
        entities: [{ type: 'bold', offset: 0, length: 1 }],
      },
    });
    expect(callback.ok).toBe(true);
    if (!callback.ok || callback.update.kind !== 'callback_query') return;
    expect('richText' in callback.update).toBe(false);
    expect('richCaption' in callback.update).toBe(false);

    const unsupported = parseTelegramUpdate({ update_id: 903, channel_post: { text: 'x' } });
    expect(unsupported.ok).toBe(true);
    if (!unsupported.ok || unsupported.update.kind !== 'unsupported') return;
    expect('richText' in unsupported.update).toBe(false);
  });

  it('preserves the existing command surface byte-for-byte on entity-bearing command texts', () => {
    const update = messagePayload(
      messageUpdate({
        text: '/drafts@Pixel_Admin_Bot d-123',
        entities: [{ type: 'bold', offset: 0, length: 7 }],
      }),
    );
    expect(update.command).toBe('drafts');
    expect(update.commandTarget).toBe('pixel_admin_bot');
    expect(update.chatType).toBe('private');
    expect(update.fromUserId).toBe(1000000001);
  });
});

// ---------------------------------------------------------------------------
// R1.19.1 — ORIGINAL M1 (real wire text_mention User) and P1 (plain caption
// with omitted optional caption_entities) companions on the REAL parser path.
// The ORIGINAL proof lives in tests/unit/posidon-r119-original-proof.test.ts.
// ---------------------------------------------------------------------------
describe('parseTelegramUpdate — R1.19.1 wire User projection (M1)', () => {
  it('projects a real wire User to the canonical shape and DROPS unrelated optional Telegram flags', () => {
    const update = messagePayload(
      messageUpdate({
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
              // Ordinary real-User extras: dropped, never a rejection reason.
              is_premium: true,
              added_to_attachment_menu: true,
              language_code: 'fa',
            },
          },
        ],
      }),
    );
    if (!update.richText?.ok) throw new Error('extraction failed');
    expect(update.richText.entities[0]?.user).toEqual({
      id: 222,
      isBot: false,
      firstName: 'دوست',
      username: 'fixture_friend',
      languageCode: 'fa',
    });
    // No arbitrary nested raw data survives into the extraction.
    expect(JSON.stringify(update.richText.entities[0])).not.toContain('is_premium');
    // And the envelope accepts the projected canonical user.
    expect(createRichTextEnvelope(update.richText).ok).toBe(true);
  });

  it('projects the wire User on the caption path too (caption_entities text_mention)', () => {
    const update = messagePayload(
      messageUpdate({
        text: undefined,
        caption: 'سلام دوست',
        caption_entities: [
          {
            type: 'text_mention',
            offset: 5,
            length: 4,
            user: { id: 223, is_bot: true, first_name: 'ربات', last_name: 'کمک' },
          },
        ],
      }),
    );
    if (!update.richCaption?.ok) throw new Error('extraction failed');
    expect(update.richCaption.entities[0]?.user).toEqual({
      id: 223,
      isBot: true,
      firstName: 'ربات',
      lastName: 'کمک',
    });
  });

  it('fails malformed/wrong-typed/oversized Users EXPLICITLY at the envelope boundary', () => {
    const cases: unknown[] = [
      'not-an-object',
      42,
      [], // arrays are not objects
      { id: 224 }, // missing required is_bot/first_name
      { id: 224, is_bot: 'yes', first_name: 'دوست' }, // wrong-typed flag
      { id: '224', is_bot: false, first_name: 'دوست' }, // wrong-typed id
      { id: 224, is_bot: false, first_name: 'د'.repeat(65) }, // oversized name
      { id: 0, is_bot: false, first_name: 'دوست' }, // id must be positive
    ];
    for (const user of cases) {
      const update = messagePayload(
        messageUpdate({
          text: 'سلام دوست',
          entities: [{ type: 'text_mention', offset: 5, length: 4, user }],
        }),
      );
      // The parser stays shallow (extraction ok) — the ENVELOPE fails typed.
      if (!update.richText?.ok) throw new Error('parser must not judge user shapes');
      expect(createRichTextEnvelope(update.richText)).toEqual({
        ok: false,
        reason: 'user_invalid',
        entityIndex: 0,
      });
    }
  });
});

describe('parseTelegramUpdate — R1.19.1 plain-caption preservation (P1)', () => {
  it('preserves a plain caption with OMITTED caption_entities as the canonical extraction', () => {
    const update = messagePayload(
      messageUpdate({
        text: undefined,
        photo: [
          { file_id: 'synthetic-file', file_unique_id: 'synthetic-unique', width: 1, height: 1 },
        ],
        caption: 'کپشن ساده 😀',
      }),
    );
    expect(update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'کپشن ساده 😀',
      entities: [],
    });
    expect(update.text).toBeUndefined(); // plain captions have no legacy text field
    expect(update.command).toBeUndefined(); // captions never become commands
  });

  it('treats explicit [] identically to omitted metadata, but keeps null/primitive MALFORMED', () => {
    const omitted = messagePayload(
      messageUpdate({ text: undefined, caption: 'عنوان', caption_entities: undefined }),
    );
    expect(omitted.richCaption).toEqual({ ok: true, kind: 'caption', text: 'عنوان', entities: [] });

    const explicitEmpty = messagePayload(
      messageUpdate({ text: undefined, caption: 'عنوان', caption_entities: [] }),
    );
    expect(explicitEmpty.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'عنوان',
      entities: [],
    });

    for (const broken of [null, 'broken', 42]) {
      const malformed = messagePayload(
        messageUpdate({ text: undefined, caption: 'عنوان', caption_entities: broken }),
      );
      expect(malformed.richCaption).toEqual({
        ok: false,
        kind: 'caption',
        reason: 'entities_malformed',
      });
    }
  });

  it('preserves whitespace and Markdown-literal captions EXACTLY (no trim, no interpretation)', () => {
    for (const caption of ['   ', '**بولد**', '_italic_ not parsed', 'خط اول\nخط دوم']) {
      const update = messagePayload(
        messageUpdate({ text: undefined, caption, caption_entities: undefined }),
      );
      expect(update.richCaption).toEqual({
        ok: true,
        kind: 'caption',
        text: caption,
        entities: [],
      });
    }
  });

  it('provides no richCaption for an EMPTY caption string (no content to preserve)', () => {
    const update = messagePayload(
      messageUpdate({ text: undefined, caption: '', caption_entities: undefined }),
    );
    expect(update.richCaption).toBeUndefined();
  });

  it('applies the same plain-caption preservation to edited_message', () => {
    const raw = messageUpdate({ text: undefined, caption: 'عنوان ویرایش‌شده' });
    const edited = parseTelegramUpdate({
      update_id: 901,
      edited_message: (raw as { message: Record<string, unknown> }).message,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error('unreachable');
    if (edited.update.kind !== 'edited_message') throw new Error('unexpected kind');
    expect(edited.update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'عنوان ویرایش‌شده',
      entities: [],
    });
  });
});
