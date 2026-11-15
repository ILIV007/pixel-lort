/**
 * Phase 8.4b — the CORRECTION CONTENT RENDER suite (crn1): the pure,
 * deterministic label-prepend pipeline that derives the corrected per-message
 * envelopes the edit/correction engine (8.4) transports. The 8.4 carry, now
 * delivered: the engine no longer depends on hand-built edit payloads.
 *
 * Pinned here:
 *  - the composition is EXACT: `<label>: <statement>\n\n<original text>` —
 *    the untouched original text is a byte-for-byte SUFFIX (text identity
 *    preserved for the original content);
 *  - ONE fixed bold entity covers the authored label + ': ' only (never the
 *    editorial statement); every ORIGINAL entity survives with its offset
 *    shifted by exactly the UTF-16 prefix length and every other field
 *    byte-identical;
 *  - the minor_detail class is refused typed (class_not_editable): the ecl1
 *    planner never edits a minor detail — the render can never be abused to
 *    fabricate one;
 *  - the statement is capped BEFORE any parse work (statement_too_large)
 *    and must be non-empty (statement_empty);
 *  - the original envelope is re-read defensively (readRichTextEnvelope) and
 *    its kind must match the claimed kind (kind_mismatch) — the transport's
 *    own re-validation can never be surprised;
 *  - the composed content must fit the kind cap — the failure is TYPED
 *    (text_too_large / caption_too_large), never a truncation-to-fit;
 *  - the same input always renders JSON-equal (deterministic);
 *  - deriveCorrectionEdits maps a bounded message list to the EXACT
 *    CorrectionEditMessage shape the engine consumes, preserving input
 *    order, failing typed with the offending index — over the 16-message
 *    engine bound it refuses wholesale (too_many_messages).
 */

import { describe, expect, it } from 'vitest';

import {
  CORRECTION_EDITS_MAX_MESSAGES,
  CORRECTION_LABELS,
  CORRECTION_RENDER_VERSION,
  CORRECTION_STATEMENT_MAX_UNITS,
  deriveCorrectionEdits,
  renderCorrectionEditEnvelope,
} from '../../src/domain/publishing/correction-render';
import {
  createRichTextEnvelope,
  serializeRichTextEnvelope,
  type RichTextEntity,
} from '../../src/domain/telegram/rich-text-envelope';

const STATEMENT = 'در نسخهٔ پیشین نام شرکت اشتباه درج شده بود؛ نام صحیح در این نسخه آمده است.';

function serializeOriginal(
  kind: 'text' | 'caption',
  text: string,
  entities: readonly RichTextEntity[],
): string {
  const outcome = createRichTextEnvelope({ kind, text, entities });
  if (!outcome.ok) throw new Error(`fixture envelope rejected: ${outcome.reason}`);
  const serialized = serializeRichTextEnvelope(outcome.envelope);
  if (!serialized.ok) throw new Error(`fixture serialization rejected: ${serialized.reason}`);
  return serialized.json;
}

function renderOk(
  originalJson: string,
  kind: 'text' | 'caption',
  correctionClass: string,
  statement: string,
) {
  const outcome = renderCorrectionEditEnvelope({
    originalEnvelopeJson: originalJson,
    kind,
    correctionClass,
    statement,
  });
  if (!outcome.ok) throw new Error(`render failed: ${outcome.reason}`);
  return outcome;
}

describe('correction-render: the label-prepend composition', () => {
  it.each(['meaningful_update', 'rumor_confirmed', 'rumor_denied', 'correction'] as const)(
    'prepends the fixed %s label and shifts every original entity',
    (correctionClass) => {
      const original = serializeOriginal('text', 'خط اول بدنهٔ خبر', [
        { type: 'bold', offset: 0, length: 7 },
        { type: 'italic', offset: 4, length: 3 },
      ]);
      const outcome = renderOk(original, 'text', correctionClass, STATEMENT);

      const label = CORRECTION_LABELS[correctionClass];
      const lead = `${label}: ${STATEMENT}`;
      const expectedText = `${lead}\n\nخط اول بدنهٔ خبر`;
      expect(outcome.envelope.text).toBe(expectedText);
      // The original text survives byte-for-byte as the SUFFIX.
      expect(outcome.envelope.text.endsWith('خط اول بدنهٔ خبر')).toBe(true);

      const prefixUnits = lead.length + 2; // the '\n\n' separator
      expect(outcome.envelope.entities).toEqual([
        { type: 'bold', offset: 0, length: label.length + 2 },
        { type: 'bold', offset: 0 + prefixUnits, length: 7 },
        { type: 'italic', offset: 4 + prefixUnits, length: 3 },
      ]);
      expect(outcome.envelope.kind).toBe('text');
      expect(outcome.envelope.schemaVersion).toBe(1);
    },
  );

  it('keeps the authored labels stable across the four editable classes', () => {
    expect(CORRECTION_LABELS.correction.length).toBeGreaterThan(0);
    expect(CORRECTION_LABELS.rumor_denied).not.toBe(CORRECTION_LABELS.rumor_confirmed);
    expect(CORRECTION_LABELS.meaningful_update).not.toBe(CORRECTION_LABELS.correction);
    expect(Object.keys(CORRECTION_LABELS)).toHaveLength(4);
  });

  it('renders an original with zero entities to the label entity only', () => {
    const original = serializeOriginal('text', 'متن ساده', []);
    const outcome = renderOk(original, 'text', 'correction', STATEMENT);
    const lead = `${CORRECTION_LABELS.correction}: ${STATEMENT}`;
    expect(outcome.envelope.entities).toEqual([
      { type: 'bold', offset: 0, length: CORRECTION_LABELS.correction.length + 2 },
    ]);
    expect(outcome.envelope.text).toBe(`${lead}\n\nمتن ساده`);
  });

  it('preserves every non-offset entity field byte-identically', () => {
    const original = serializeOriginal('text', 'لینک منبع اینجاست', [
      {
        type: 'text_link',
        offset: 0,
        length: 4,
        url: 'https://example.com/proof',
      },
    ]);
    const outcome = renderOk(original, 'text', 'correction', STATEMENT);
    const prefixUnits = `${CORRECTION_LABELS.correction}: ${STATEMENT}`.length + 2;
    expect(outcome.envelope.entities[1]).toEqual({
      type: 'text_link',
      offset: prefixUnits,
      length: 4,
      url: 'https://example.com/proof',
    });
  });

  it('is JSON-equal deterministic for the same input', () => {
    const original = serializeOriginal('text', 'متن', []);
    const a = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'text',
      correctionClass: 'rumor_denied',
      statement: STATEMENT,
    });
    const b = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'text',
      correctionClass: 'rumor_denied',
      statement: STATEMENT,
    });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('exposes the versioned module identity', () => {
    expect(CORRECTION_RENDER_VERSION).toBe('crn1');
    expect(CORRECTION_STATEMENT_MAX_UNITS).toBeGreaterThan(0);
    expect(CORRECTION_EDITS_MAX_MESSAGES).toBe(16);
  });
});

describe('correction-render: the fail-closed input gates', () => {
  it('refuses the minor_detail class typed — the planner never edits one', () => {
    const original = serializeOriginal('text', 'متن', []);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'text',
      correctionClass: 'minor_detail',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'class_not_editable' });
  });

  it.each([
    ['unknown-class', 'text', STATEMENT] as const,
    ['correction', 'caption_caption', STATEMENT] as const,
    ['correction', 'text', ''] as const,
  ])('rejects the malformed input %j typed', (correctionClass, kind, statement) => {
    const original = serializeOriginal('text', 'متن', []);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: kind as unknown,
      correctionClass,
      statement,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(['invalid_input', 'statement_empty']).toContain(outcome.reason);
    }
  });

  it('rejects non-string inputs typed before any parse work', () => {
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: 42 as unknown,
      kind: 'text',
      correctionClass: 'correction',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('caps the statement BEFORE the original envelope is read', () => {
    // The original is deliberately malformed: if the module read it first,
    // the reason would be malformed_json — the statement cap must win.
    const oversized = 'ا'.repeat(CORRECTION_STATEMENT_MAX_UNITS + 1);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: 'not-json-at-all',
      kind: 'text',
      correctionClass: 'correction',
      statement: oversized,
    });
    expect(outcome).toEqual({ ok: false, reason: 'statement_too_large' });
  });

  it('accepts a statement exactly at the cap', () => {
    const original = serializeOriginal('text', 'متن', []);
    const atCap = 'ب'.repeat(CORRECTION_STATEMENT_MAX_UNITS);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'text',
      correctionClass: 'correction',
      statement: atCap,
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('correction-render: the original envelope re-read', () => {
  it('forwards the malformed-json failure verbatim', () => {
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: '{broken',
      kind: 'text',
      correctionClass: 'correction',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'malformed_json' });
  });

  it('forwards the unsupported-version failure verbatim', () => {
    const future = JSON.stringify({ schemaVersion: 99, kind: 'text', text: 'x', entities: [] });
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: future,
      kind: 'text',
      correctionClass: 'correction',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  it('refuses a kind mismatch between the claim and the stored envelope', () => {
    const textOriginal = serializeOriginal('text', 'متن', []);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: textOriginal,
      kind: 'caption',
      correctionClass: 'correction',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'kind_mismatch' });
  });

  it('renders a caption original with the caption kind preserved', () => {
    const original = serializeOriginal('caption', 'عنوان آلبوم', [
      { type: 'bold', offset: 0, length: 5 },
    ]);
    const outcome = renderOk(original, 'caption', 'rumor_confirmed', STATEMENT);
    expect(outcome.envelope.kind).toBe('caption');
  });
});

describe('correction-render: the no-truncation cap', () => {
  it('fails typed when the composed text exceeds the text cap', () => {
    const filler = 'خ'.repeat(4096);
    const original = serializeOriginal('text', filler, []);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'text',
      correctionClass: 'correction',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'text_too_large' });
  });

  it('fails typed when the composed caption exceeds the caption cap', () => {
    const filler = 'ک'.repeat(1024);
    const original = serializeOriginal('caption', filler, []);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'caption',
      correctionClass: 'rumor_denied',
      statement: STATEMENT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'caption_too_large' });
  });

  it('fails typed on an unpaired surrogate in the statement', () => {
    const original = serializeOriginal('text', 'متن', []);
    const outcome = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original,
      kind: 'text',
      correctionClass: 'correction',
      statement: 'بد\uD800بد',
    });
    expect(outcome).toEqual({ ok: false, reason: 'text_unpaired_surrogate' });
  });
});

describe('correction-render: deriveCorrectionEdits (the engine input derivation)', () => {
  const original = serializeOriginal('text', 'متن اصلی خبر', [
    { type: 'bold', offset: 0, length: 4 },
  ]);

  it('derives the exact engine CorrectionEditMessage shapes preserving input order', () => {
    const outcome = deriveCorrectionEdits({
      correctionClass: 'correction',
      statement: STATEMENT,
      messages: [
        {
          chatId: '@pixel_lores',
          messageId: 101,
          ordinal: 0,
          kind: 'text',
          originalEnvelopeJson: original,
        },
        {
          chatId: '@pixel_lores',
          messageId: 102,
          ordinal: 1,
          kind: 'text',
          originalEnvelopeJson: original,
        },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.edits).toHaveLength(2);
    expect(outcome.edits[0]).toEqual({
      chatId: '@pixel_lores',
      messageId: 101,
      ordinal: 0,
      shape: 'text',
      content: {
        kind: 'text',
        text: `${CORRECTION_LABELS.correction}: ${STATEMENT}\n\nمتن اصلی خبر`,
        entities: [
          { type: 'bold', offset: 0, length: CORRECTION_LABELS.correction.length + 2 },
          {
            type: 'bold',
            offset: `${CORRECTION_LABELS.correction}: ${STATEMENT}`.length + 2,
            length: 4,
          },
        ],
      },
    });
    expect(outcome.edits[1]?.messageId).toBe(102);
    expect(outcome.edits[1]?.ordinal).toBe(1);
  });

  it('refuses wholesale over the 16-message engine bound', () => {
    const messages = Array.from({ length: CORRECTION_EDITS_MAX_MESSAGES + 1 }, (_, index) => ({
      chatId: '@pixel_lores',
      messageId: index + 1,
      ordinal: index,
      kind: 'text' as const,
      originalEnvelopeJson: original,
    }));
    const outcome = deriveCorrectionEdits({
      correctionClass: 'correction',
      statement: STATEMENT,
      messages,
    });
    expect(outcome).toEqual({ ok: false, reason: 'too_many_messages' });
  });

  it('fails typed with the offending index for a malformed message entry', () => {
    const outcome = deriveCorrectionEdits({
      correctionClass: 'correction',
      statement: STATEMENT,
      messages: [
        {
          chatId: '@pixel_lores',
          messageId: 1,
          ordinal: 0,
          kind: 'text',
          originalEnvelopeJson: original,
        },
        {
          chatId: '@pixel_lores',
          messageId: 0, // invalid: must be a positive safe integer
          ordinal: 1,
          kind: 'text',
          originalEnvelopeJson: original,
        },
      ],
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_input', index: 1 });
  });

  it('fails typed with the offending index for one broken envelope among good ones', () => {
    const outcome = deriveCorrectionEdits({
      correctionClass: 'rumor_confirmed',
      statement: STATEMENT,
      messages: [
        {
          chatId: '@pixel_lores',
          messageId: 1,
          ordinal: 0,
          kind: 'text',
          originalEnvelopeJson: original,
        },
        {
          chatId: '@pixel_lores',
          messageId: 2,
          ordinal: 1,
          kind: 'text',
          originalEnvelopeJson: '{broken',
        },
      ],
    });
    expect(outcome).toEqual({ ok: false, reason: 'malformed_json', index: 1 });
  });

  it('refuses a minor_detail derivation the same way the single render does', () => {
    const outcome = deriveCorrectionEdits({
      correctionClass: 'minor_detail',
      statement: STATEMENT,
      messages: [
        {
          chatId: '@pixel_lores',
          messageId: 1,
          ordinal: 0,
          kind: 'text',
          originalEnvelopeJson: original,
        },
      ],
    });
    expect(outcome).toEqual({ ok: false, reason: 'class_not_editable', index: 0 });
  });
});
