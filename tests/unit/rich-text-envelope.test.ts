import { describe, expect, it } from 'vitest';
import {
  MESSAGE_ENTITY_TYPES,
  RICH_TEXT_LIMITS,
  createRichTextEnvelope,
  readRichTextEnvelope,
  richTextEntitiesWire,
  serializeRichTextEnvelope,
  type RichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';

/**
 * R1.19 — Telegram rich-text foundation: the pure versioned envelope.
 *
 * Contract: faithful entities IN -> validated entities OUT. Text identity is
 * absolute (no trim, no NFC, no HTML escape, no Markdown interpretation);
 * offsets are UTF-16 code units; every invalid/malformed/unsupported input
 * has an explicit typed outcome (never silent plain-text success, never
 * empty-entity success, never truncation-to-fit).
 */

function entity(
  type: string,
  offset: number,
  length: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, offset, length, ...extra };
}

function textEnvelope(text: string, entities: unknown[] = []) {
  return createRichTextEnvelope({ kind: 'text', text, entities });
}

function okEntities(outcome: ReturnType<typeof createRichTextEnvelope>) {
  if (!outcome.ok) {
    throw new Error(`expected ok envelope, got ${outcome.reason}`);
  }
  return outcome.envelope.entities;
}

const MENTION_USER = {
  id: 1000000001,
  isBot: true,
  firstName: 'پیکسل',
  username: 'pixel_admin_bot',
};

describe('rich-text envelope — all 20 current Bot API entity types are explicitly classified', () => {
  it('accepts every documented current type (metadata-free kinds)', () => {
    for (const type of [
      'mention',
      'hashtag',
      'cashtag',
      'bot_command',
      'url',
      'email',
      'phone_number',
      'bold',
      'italic',
      'underline',
      'strikethrough',
      'spoiler',
      'blockquote',
      'expandable_blockquote',
      'code',
    ]) {
      const outcome = textEnvelope('متن نمونه', [entity(type, 0, 4)]);
      expect(outcome.ok, type).toBe(true);
    }
  });

  it('accepts the metadata-bearing kinds with their required metadata', () => {
    expect(
      textEnvelope('sample link', [entity('text_link', 0, 6, { url: 'https://example.example/x' })])
        .ok,
    ).toBe(true);
    expect(textEnvelope('sample pre', [entity('pre', 0, 6, { language: 'fa' })]).ok).toBe(true);
    expect(textEnvelope('sample pre', [entity('pre', 0, 6)]).ok).toBe(true); // language optional
    expect(
      textEnvelope('sample mention', [entity('text_mention', 0, 6, { user: MENTION_USER })]).ok,
    ).toBe(true);
    expect(
      textEnvelope('emoji here', [
        entity('custom_emoji', 0, 5, { customEmojiId: '5369000000000000001' }),
      ]).ok,
    ).toBe(true);
    expect(
      textEnvelope('time here', [entity('date_time', 0, 4, { unixTime: 1_700_000_000 })]).ok,
    ).toBe(true);
    expect(
      textEnvelope('time here', [
        entity('date_time', 0, 4, { unixTime: 1_700_000_000, dateTimeFormat: 'wdt' }),
      ]).ok,
    ).toBe(true);
    expect(MESSAGE_ENTITY_TYPES).toHaveLength(20);
    expect(MESSAGE_ENTITY_TYPES).toContain('date_time');
  });

  it('rejects unknown future entity types with a typed, index-carrying outcome', () => {
    const outcome = textEnvelope('hello world', [entity('hologram', 0, 5)]);
    expect(outcome).toEqual({ ok: false, reason: 'unsupported_entity_type', entityIndex: 0 });
  });

  it('rejects documented metadata on types that must not carry it', () => {
    expect(
      textEnvelope('bold here', [entity('bold', 0, 4, { url: 'https://example.example' })]),
    ).toEqual({
      ok: false,
      reason: 'unexpected_metadata',
      entityIndex: 0,
    });
    expect(textEnvelope('time here', [entity('mention', 0, 4, { unixTime: 1 })])).toEqual({
      ok: false,
      reason: 'unexpected_metadata',
      entityIndex: 0,
    });
  });
});

describe('rich-text envelope — text identity (UTF-16, ZWNJ, emoji, combining marks, hostile literals)', () => {
  it('preserves Persian text with ZWNJ and astral emoji byte-for-byte with exact offsets', () => {
    const text = 'سلام\u200cدنیا 😀';
    // س ل ا م = 4, ZWNJ = 1, د ن ی ا = 4 -> bold over 'دنیا' is offset 5 length 4.
    const outcome = textEnvelope(text, [entity('bold', 5, 4)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.text).toBe(text);
    expect(text.length).toBe(12); // ZWNJ and the 2-unit emoji counted in UTF-16 units
    expect(outcome.envelope.entities).toEqual([{ type: 'bold', offset: 5, length: 4 }]);
  });

  it('keeps a combining-mark sequence unchanged (no NFC folding)', () => {
    // 'e' + combining circumflex DOES compose under NFC — the envelope must not.
    const decomposed = '\u0065\u0302';
    const outcome = textEnvelope(decomposed, [entity('italic', 0, 2)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.text).toBe(decomposed);
    expect(outcome.envelope.text).not.toBe(decomposed.normalize('NFC'));
    expect(decomposed.length).toBe(2);
    expect(decomposed.normalize('NFC').length).toBe(1);
  });

  it('keeps a range AFTER a surrogate-pair emoji correct and rejects ranges that split the pair', () => {
    const text = '😀a';
    expect(textEnvelope(text, [entity('bold', 2, 1)]).ok).toBe(true); // the 'a' after the emoji
    expect(textEnvelope(text, [entity('bold', 1, 1)])).toEqual({
      ok: false,
      reason: 'range_surrogate_split',
      entityIndex: 0,
    });
    expect(textEnvelope(text, [entity('bold', 0, 1)])).toEqual({
      ok: false,
      reason: 'range_surrogate_split',
      entityIndex: 0,
    });
  });

  it('rejects unpaired surrogates in the text explicitly (never repaired)', () => {
    expect(textEnvelope('bad \uD83D tail')).toEqual({
      ok: false,
      reason: 'text_unpaired_surrogate',
    });
    expect(textEnvelope('bad \uDC00 tail')).toEqual({
      ok: false,
      reason: 'text_unpaired_surrogate',
    });
  });

  it('leaves hostile Markdown/HTML literals untouched when there are no entities', () => {
    const hostile = '*bold* <b>x</b> `code` & <script>';
    const outcome = textEnvelope(hostile);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.text).toBe(hostile);
    expect(outcome.envelope.entities).toEqual([]);
  });

  it('treats plain text with an EMPTY entity list as a valid distinct case', () => {
    const outcome = textEnvelope('فقط متن ساده');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.entities).toEqual([]);
    expect(outcome.envelope.kind).toBe('text');
    expect(outcome.envelope.schemaVersion).toBe(1);
  });
});

describe('rich-text envelope — typed failure at every hostile boundary', () => {
  it('rejects invalid kind and invalid text', () => {
    expect(createRichTextEnvelope({ kind: null, text: 'x', entities: [] })).toEqual({
      ok: false,
      reason: 'invalid_kind',
    });
    expect(createRichTextEnvelope({ kind: 'title', text: 'x', entities: [] })).toEqual({
      ok: false,
      reason: 'invalid_kind',
    });
    expect(createRichTextEnvelope({ kind: undefined, text: 'x', entities: [] })).toEqual({
      ok: false,
      reason: 'invalid_kind',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: null, entities: [] })).toEqual({
      ok: false,
      reason: 'text_invalid',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: 42, entities: [] })).toEqual({
      ok: false,
      reason: 'text_invalid',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: [], entities: [] })).toEqual({
      ok: false,
      reason: 'text_invalid',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: '', entities: [] })).toEqual({
      ok: false,
      reason: 'text_invalid',
    });
  });

  it('rejects invalid entity list shapes', () => {
    expect(createRichTextEnvelope({ kind: 'text', text: 'x', entities: null })).toEqual({
      ok: false,
      reason: 'entities_not_list',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: 'x', entities: {} })).toEqual({
      ok: false,
      reason: 'entities_not_list',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: 'x', entities: 'nope' })).toEqual({
      ok: false,
      reason: 'entities_not_list',
    });
    expect(createRichTextEnvelope({ kind: 'text', text: 'x', entities: [null] })).toEqual({
      ok: false,
      reason: 'entity_invalid',
      entityIndex: 0,
    });
    expect(createRichTextEnvelope({ kind: 'text', text: 'x', entities: [42] })).toEqual({
      ok: false,
      reason: 'entity_invalid',
      entityIndex: 0,
    });
    expect(
      createRichTextEnvelope({
        kind: 'text',
        text: 'x',
        entities: [{ type: 7, offset: 0, length: 1 }],
      }),
    ).toEqual({
      ok: false,
      reason: 'entity_invalid',
      entityIndex: 0,
    });
  });

  it('rejects non-integer, NaN, float, negative, zero-length and out-of-range offsets/lengths', () => {
    const bad: unknown[] = [
      undefined,
      '0',
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const offset of bad) {
      const outcome = textEnvelope('hello world', [{ type: 'bold', offset, length: 2 }]);
      expect(outcome).toEqual({ ok: false, reason: 'range_invalid', entityIndex: 0 });
    }
    for (const length of [undefined, '2', 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      const outcome = textEnvelope('hello world', [{ type: 'bold', offset: 0, length }]);
      expect(outcome).toEqual({ ok: false, reason: 'range_invalid', entityIndex: 0 });
    }
    // End bound is checked overflow-safely: MAX_SAFE offset + small length never wraps.
    expect(textEnvelope('short', [entity('bold', 3, Number.MAX_SAFE_INTEGER - 2)])).toEqual({
      ok: false,
      reason: 'range_invalid',
      entityIndex: 0,
    });
  });
});

describe('rich-text envelope — metadata validation', () => {
  it('validates text_link URLs: bound, scheme policy, malformed input, exact opaque preservation', () => {
    expect(textEnvelope('link', [entity('text_link', 0, 4)])).toEqual({
      ok: false,
      reason: 'url_invalid',
      entityIndex: 0,
    });
    expect(textEnvelope('link', [entity('text_link', 0, 4, { url: 42 })])).toEqual({
      ok: false,
      reason: 'url_invalid',
      entityIndex: 0,
    });
    expect(textEnvelope('link', [entity('text_link', 0, 4, { url: 'ht tp://broken' })])).toEqual({
      ok: false,
      reason: 'url_malformed',
      entityIndex: 0,
    });

    const maxUrl = `https://example.example/${'a'.repeat(2048 - 'https://example.example/'.length)}`;
    expect(new TextEncoder().encode(maxUrl).byteLength).toBe(2048);
    expect(textEnvelope('link', [entity('text_link', 0, 4, { url: maxUrl })]).ok).toBe(true);
    expect(textEnvelope('link', [entity('text_link', 0, 4, { url: `${maxUrl}x` })])).toEqual({
      ok: false,
      reason: 'url_too_large',
      entityIndex: 0,
    });

    for (const dangerous of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'file:///etc/passwd',
      'ftp://example.example/x',
    ]) {
      expect(textEnvelope('link', [entity('text_link', 0, 4, { url: dangerous })])).toEqual({
        ok: false,
        reason: 'url_unsafe_scheme',
        entityIndex: 0,
      });
    }

    for (const allowed of [
      'http://example.example/a?b=c',
      'https://example.example/a?b=c',
      'tg://resolve?domain=example',
      'mailto:user@example.example',
      'tel:+15551234567',
    ]) {
      expect(textEnvelope('link', [entity('text_link', 0, 4, { url: allowed })]).ok, allowed).toBe(
        true,
      );
    }

    // Opaque URLs are preserved EXACTLY: no decoding, no case folding, no query rewriting.
    const opaque = 'https://example.example/a?b=%D9%86%DB%8C%D9%85&c=D#frag';
    const outcome = textEnvelope('link', [entity('text_link', 0, 4, { url: opaque })]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.entities[0]?.url).toBe(opaque);
  });

  it('validates pre language bound', () => {
    expect(textEnvelope('code block', [entity('pre', 0, 4, { language: 'x'.repeat(64) })]).ok).toBe(
      true,
    );
    expect(textEnvelope('code block', [entity('pre', 0, 4, { language: 'x'.repeat(65) })])).toEqual(
      {
        ok: false,
        reason: 'language_invalid',
        entityIndex: 0,
      },
    );
    expect(textEnvelope('code block', [entity('pre', 0, 4, { language: 7 })])).toEqual({
      ok: false,
      reason: 'language_invalid',
      entityIndex: 0,
    });
  });

  it('validates custom_emoji id presence and bound', () => {
    expect(textEnvelope('emoji', [entity('custom_emoji', 0, 5)])).toEqual({
      ok: false,
      reason: 'custom_emoji_id_invalid',
      entityIndex: 0,
    });
    expect(
      textEnvelope('emoji', [entity('custom_emoji', 0, 5, { customEmojiId: 'x'.repeat(128) })]).ok,
    ).toBe(true);
    expect(
      textEnvelope('emoji', [entity('custom_emoji', 0, 5, { customEmojiId: 'x'.repeat(129) })]),
    ).toEqual({
      ok: false,
      reason: 'custom_emoji_id_invalid',
      entityIndex: 0,
    });
    expect(textEnvelope('emoji', [entity('custom_emoji', 0, 5, { customEmojiId: 42 })])).toEqual({
      ok: false,
      reason: 'custom_emoji_id_invalid',
      entityIndex: 0,
    });
  });

  it('validates the minimal documented text_mention User shape (no arbitrary raw fields)', () => {
    expect(textEnvelope('who', [entity('text_mention', 0, 3)])).toEqual({
      ok: false,
      reason: 'user_invalid',
      entityIndex: 0,
    });
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, { user: { id: -5, isBot: true, firstName: 'x' } }),
      ]),
    ).toEqual({
      ok: false,
      reason: 'user_invalid',
      entityIndex: 0,
    });
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, { user: { id: 1.5, isBot: true, firstName: 'x' } }),
      ]),
    ).toEqual({
      ok: false,
      reason: 'user_invalid',
      entityIndex: 0,
    });
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, { user: { id: 1, isBot: 'yes', firstName: 'x' } }),
      ]),
    ).toEqual({
      ok: false,
      reason: 'user_invalid',
      entityIndex: 0,
    });
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, { user: { id: 1, isBot: true, firstName: '' } }),
      ]),
    ).toEqual({
      ok: false,
      reason: 'user_invalid',
      entityIndex: 0,
    });
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, { user: { id: 1, isBot: true, firstName: 'x'.repeat(64) } }),
      ]).ok,
    ).toBe(true);
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, { user: { id: 1, isBot: true, firstName: 'x'.repeat(65) } }),
      ]),
    ).toEqual({ ok: false, reason: 'user_invalid', entityIndex: 0 });
    // Arbitrary raw nested fields are rejected — the forwarded shape stays the documented minimum.
    expect(
      textEnvelope('who', [
        entity('text_mention', 0, 3, {
          user: { id: 1, isBot: true, firstName: 'x', rawBlob: { a: 1 } },
        }),
      ]),
    ).toEqual({ ok: false, reason: 'user_invalid', entityIndex: 0 });
  });

  it('validates date_time unix_time domain and the exact date_time_format grammar', () => {
    for (const bad of [undefined, '1700000000', 1.5, Number.NaN, -1, 4_102_444_801]) {
      expect(textEnvelope('time', [entity('date_time', 0, 4, { unixTime: bad })])).toEqual({
        ok: false,
        reason: 'unix_time_invalid',
        entityIndex: 0,
      });
    }
    expect(textEnvelope('time', [entity('date_time', 0, 4, { unixTime: 4_102_444_800 })]).ok).toBe(
      true,
    );
    expect(textEnvelope('time', [entity('date_time', 0, 4, { unixTime: 0 })]).ok).toBe(true);

    for (const goodFormat of ['', 'r', 'w', 'd', 't', 'D', 'T', 'wd', 'wT', 'wDt', 'dt']) {
      expect(
        textEnvelope('time', [
          entity('date_time', 0, 4, { unixTime: 1, dateTimeFormat: goodFormat }),
        ]).ok,
        JSON.stringify(goodFormat),
      ).toBe(true);
    }
    for (const badFormat of ['q', 'rw', 'wdt ', ' wdt', 'ww', 'r d']) {
      expect(
        textEnvelope('time', [
          entity('date_time', 0, 4, { unixTime: 1, dateTimeFormat: badFormat }),
        ]),
      ).toEqual({ ok: false, reason: 'date_time_format_invalid', entityIndex: 0 });
    }
  });
});

describe('rich-text envelope — bounded application caps (never truncation-to-fit)', () => {
  it('keeps text at exactly 4096 UTF-16 units and rejects 4097', () => {
    expect(textEnvelope('x'.repeat(RICH_TEXT_LIMITS.maxTextUnits)).ok).toBe(true);
    expect(textEnvelope('x'.repeat(RICH_TEXT_LIMITS.maxTextUnits + 1))).toEqual({
      ok: false,
      reason: 'text_too_large',
    });
  });

  it('keeps captions at exactly 1024 UTF-16 units and rejects 1025', () => {
    const caption = createRichTextEnvelope({
      kind: 'caption',
      text: 'x'.repeat(RICH_TEXT_LIMITS.maxCaptionUnits),
      entities: [],
    });
    expect(caption.ok).toBe(true);
    const tooBig = createRichTextEnvelope({
      kind: 'caption',
      text: 'x'.repeat(RICH_TEXT_LIMITS.maxCaptionUnits + 1),
      entities: [],
    });
    expect(tooBig).toEqual({ ok: false, reason: 'caption_too_large' });
  });

  it('keeps entities at exactly 100 and rejects 101', () => {
    const text = 'x'.repeat(100); // one disjoint 1-unit range per entity — no duplicates
    const hundred = Array.from({ length: RICH_TEXT_LIMITS.maxEntities }, (_, i) =>
      entity('bold', i, 1),
    );
    expect(textEnvelope(text, hundred).ok).toBe(true);
    const oneOhOne = Array.from({ length: RICH_TEXT_LIMITS.maxEntities + 1 }, (_, i) =>
      entity('bold', i % 10, 1),
    );
    expect(textEnvelope(text, oneOhOne)).toEqual({ ok: false, reason: 'entities_too_many' });
  });

  it('fails the total serialized-envelope byte cap with a typed outcome (never truncates the JSON)', () => {
    const text = 'x'.repeat(100); // disjoint 1-unit ranges — cap failure comes from serialization only
    const longUrl = `https://example.example/${'a'.repeat(1900)}`;
    const hundred = Array.from({ length: 100 }, (_, i) =>
      entity('text_link', i, 1, { url: longUrl }),
    );
    const built = textEnvelope(text, hundred);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const serialized = serializeRichTextEnvelope(built.envelope);
    expect(serialized).toEqual({ ok: false, reason: 'serialized_too_large' });
  });
});

describe('rich-text envelope — nesting, crossing, duplicates, canonical order', () => {
  it('allows strict containment of containable leaf types inside formatting styles', () => {
    expect(
      textEnvelope('formatted content', [
        entity('bold', 0, 17),
        entity('text_link', 9, 7, { url: 'https://x.example' }),
      ]).ok,
    ).toBe(true);
    expect(textEnvelope('nested styles', [entity('bold', 0, 13), entity('italic', 7, 6)]).ok).toBe(
      true,
    );
  });

  it('rejects crossing overlaps', () => {
    expect(textEnvelope('crossing ranges', [entity('bold', 0, 4), entity('italic', 2, 6)])).toEqual(
      {
        ok: false,
        reason: 'crossing_overlap',
      },
    );
  });

  it('keeps code/pre isolated from every other entity', () => {
    expect(textEnvelope('code piece', [entity('code', 0, 4), entity('bold', 2, 4)])).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
    expect(textEnvelope('pre piece', [entity('pre', 0, 3), entity('spoiler', 1, 2)])).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
    expect(textEnvelope('pre piece', [entity('code', 0, 4), entity('pre', 3, 3)])).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
    // Disjoint isolated entities are legal — isolation only forbids OVERLAP.
    expect(textEnvelope('pre piece', [entity('code', 0, 4), entity('pre', 5, 3)]).ok).toBe(true);
  });

  it('enforces the quote rules: quotes may hold non-quote children but never nest in anything', () => {
    expect(
      textEnvelope('quoted bold', [entity('blockquote', 0, 11), entity('bold', 8, 3)]).ok,
    ).toBe(true);
    expect(
      textEnvelope('quote in quote', [entity('blockquote', 0, 14), entity('blockquote', 7, 7)]),
    ).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
    expect(
      textEnvelope('mixed quotes', [
        entity('blockquote', 0, 12),
        entity('expandable_blockquote', 7, 5),
      ]),
    ).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
    expect(
      textEnvelope('quote in bold', [entity('bold', 0, 13), entity('blockquote', 5, 8)]),
    ).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
  });

  it('forbids non-container types from containing others', () => {
    expect(textEnvelope('mention span', [entity('mention', 0, 7), entity('bold', 2, 3)])).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
    expect(textEnvelope('two leaf types', [entity('hashtag', 0, 4), entity('url', 0, 4)])).toEqual({
      ok: false,
      reason: 'nesting_violation',
    });
  });

  it('applies the declared duplicate policy: same type over an identical range is rejected', () => {
    expect(textEnvelope('dup bold', [entity('bold', 0, 3), entity('bold', 0, 3)])).toEqual({
      ok: false,
      reason: 'duplicate_entity',
    });
    expect(
      textEnvelope('two links', [
        entity('text_link', 0, 3, { url: 'https://a.example' }),
        entity('text_link', 0, 3, { url: 'https://b.example' }),
      ]),
    ).toEqual({ ok: false, reason: 'duplicate_entity' });
    // Equal ranges of DIFFERENT types are legal when one containment direction is legal.
    expect(textEnvelope('bold italic', [entity('bold', 0, 11), entity('italic', 0, 11)]).ok).toBe(
      true,
    );
    expect(
      textEnvelope('bold link', [
        entity('bold', 0, 4),
        entity('text_link', 0, 4, { url: 'https://x.example' }),
      ]).ok,
    ).toBe(true);
  });

  it('imposes the documented deterministic canonical ordering (offset asc, length desc, type asc)', () => {
    const entities = okEntities(
      textEnvelope('ordered entities', [
        entity('text_link', 8, 8, { url: 'https://x.example' }),
        entity('bold', 0, 16),
      ]),
    );
    expect(entities.map((e) => e.type)).toEqual(['bold', 'text_link']);
  });
});

describe('rich-text envelope — serialization, defensive re-reading, forward compatibility', () => {
  const text = '🎉 خبر فوری: بازار رمزارزها نیم\u200cفاصله دارد';
  const inputEntities = [
    entity('bold', 3, 8),
    entity('code', 13, 5),
    entity('italic', 19, 8),
    entity('text_link', 28, 9, { url: 'https://example.example/نیم' }),
    entity('custom_emoji', 0, 2, { customEmojiId: '5369000000000000001' }),
  ];

  function builtEnvelope(): RichTextEnvelope {
    const outcome = textEnvelope(text, inputEntities);
    if (!outcome.ok) throw new Error(`fixture broken: ${outcome.reason}`);
    return outcome.envelope;
  }

  it('round-trips serialize -> defensive read with exact text and semantic entities', () => {
    const envelope = builtEnvelope();
    const frozen = JSON.parse(JSON.stringify(envelope));
    const serialized = serializeRichTextEnvelope(envelope);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.byteLength).toBe(new TextEncoder().encode(serialized.json).byteLength);
    expect(serialized.byteLength).toBeLessThanOrEqual(RICH_TEXT_LIMITS.maxSerializedBytes);

    const read = readRichTextEnvelope(serialized.json);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.envelope.text).toBe(text);
    expect(read.envelope.schemaVersion).toBe(1);
    expect(read.envelope.kind).toBe('text');
    expect(read.envelope.entities).toEqual(envelope.entities);
    expect(read.envelope.entities.map((e) => e.offset)).toEqual(
      [...read.envelope.entities.map((e) => e.offset)].sort((a, b) => a - b),
    );
    void frozen;
  });

  it('keeps fixtures immutable: the validated envelope never mutates its input', () => {
    const rawInput = deepFreeze({
      kind: 'text' as const,
      text,
      entities: inputEntities.map((e) => deepFreeze({ ...e })),
    });
    const snapshot = JSON.stringify(rawInput);
    const outcome = createRichTextEnvelope(rawInput);
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(rawInput)).toBe(snapshot);
  });

  it('exposes the canonical Bot API wire projection for transport', () => {
    const wire = richTextEntitiesWire(builtEnvelope().entities);
    expect(wire[0]).toEqual({
      type: 'custom_emoji',
      offset: 0,
      length: 2,
      custom_emoji_id: '5369000000000000001',
    });
    expect(
      wire.some((e) => e['type'] === 'text_link' && e['url'] === 'https://example.example/نیم'),
    ).toBe(true);
    expect(wire.every((e) => !('parse_mode' in e))).toBe(true);
  });

  it('reads stored envelopes defensively: malformed JSON, wrong version, broken shape', () => {
    expect(readRichTextEnvelope('{not json')).toEqual({ ok: false, reason: 'malformed_json' });
    expect(
      readRichTextEnvelope(
        JSON.stringify({ schemaVersion: 2, kind: 'text', text: 'x', entities: [] }),
      ),
    ).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(
      readRichTextEnvelope(JSON.stringify({ schemaVersion: 1, kind: 'text', entities: [] })),
    ).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
    expect(
      readRichTextEnvelope(
        JSON.stringify({ schemaVersion: 1, kind: 'title', text: 'x', entities: [] }),
      ),
    ).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
    expect(readRichTextEnvelope('[]')).toEqual({ ok: false, reason: 'malformed_envelope' });
    expect(readRichTextEnvelope('null')).toEqual({ ok: false, reason: 'malformed_envelope' });
  });

  it('documents the forward-compatibility policy: unknown extra envelope fields are ignored, required fields still validated', () => {
    const serialized = serializeRichTextEnvelope(builtEnvelope());
    if (!serialized.ok) throw new Error('fixture broken');
    const doctored = JSON.parse(serialized.json) as Record<string, unknown>;
    doctored['futureField'] = { anything: true };
    const read = readRichTextEnvelope(JSON.stringify(doctored));
    expect(read.ok).toBe(true);
    // But an invalid REQUIRED field still fails the reader.
    doctored['text'] = 42;
    expect(readRichTextEnvelope(JSON.stringify(doctored))).toEqual({
      ok: false,
      reason: 'text_invalid',
    });
  });

  it('applies the byte cap to the READER input before parsing', () => {
    const huge = `{"schemaVersion":1,"kind":"text","text":"${'x'.repeat(RICH_TEXT_LIMITS.maxSerializedBytes)}","entities":[]}`;
    expect(readRichTextEnvelope(huge)).toEqual({ ok: false, reason: 'serialized_too_large' });
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
