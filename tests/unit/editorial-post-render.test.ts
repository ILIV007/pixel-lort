import { describe, expect, it } from 'vitest';
import {
  EDITORIAL_POST_LABELS,
  renderEditorialPostText,
} from '../../src/domain/admin-post/editorial-post-render';
import { readRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';

/**
 * R1.22 Phase A — the pure editorial→post render contract: deterministic,
 * honest (unverified preserved, nothing fabricated), and bounded (typed
 * failures, never silent truncation).
 */

const HEADLINE = 'به‌روزرسانی بزرگ بازی نمونه منتشر شد';
const SUMMARY = 'استودیوی نمونه از انتشار به‌روزرسانی بزرگ خبر داد.';
const CLAIM = 'به‌روزرسانی با بخش داستانی تازه در دسترس است.';

function documentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    locale: 'fa',
    headlineFa: HEADLINE,
    summaryFa: SUMMARY,
    sourceReport: {
      sourceItemId: 'item-1',
      sourceName: 'منبع رسمی دمو',
      stance: 'mentions',
      excerptText: 'excerpt',
      truncated: false,
    },
    modelClaims: [{ text: CLAIM, evidenceIds: ['item-1'], status: 'unverified' }],
    ...overrides,
  });
}

describe('R1.22 — renderEditorialPostText (pure, deterministic, honest)', () => {
  it('renders headline + summary + claims + unverified note + source, with ONE bold headline entity', () => {
    const outcome = renderEditorialPostText(documentJson());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Exact deterministic composition (sections joined by a blank line).
    expect(outcome.text).toBe(
      [
        HEADLINE,
        SUMMARY,
        `• ${CLAIM}`,
        EDITORIAL_POST_LABELS.unverifiedNote,
        `${EDITORIAL_POST_LABELS.sourcePrefix}منبع رسمی دمو`,
      ].join('\n\n'),
    );

    // The envelope is a validated kind-'text' envelope whose canonical text
    // is EXACTLY the composed text (byte-for-byte, no transformation).
    expect(outcome.envelope.kind).toBe('text');
    expect(outcome.envelope.text).toBe(outcome.text);
    expect(outcome.envelope.entities).toEqual([
      { type: 'bold', offset: 0, length: HEADLINE.length },
    ]);

    // The unverified status is PRESERVED in the post text itself.
    expect(outcome.text).toContain(EDITORIAL_POST_LABELS.unverifiedNote);
    expect(outcome.text).toContain(CLAIM);
    // The source is an attribution line, never presented as verification.
    expect(outcome.text).toContain(`${EDITORIAL_POST_LABELS.sourcePrefix}منبع رسمی دمو`);
  });

  it('is deterministic: the same document bytes render to the same text and entities', () => {
    const first = renderEditorialPostText(documentJson());
    const second = renderEditorialPostText(documentJson());
    expect(first).toEqual(second);
  });

  it('round-trips through the defensive envelope reader unchanged', () => {
    const outcome = renderEditorialPostText(documentJson());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const serialized = JSON.stringify({
      schemaVersion: outcome.envelope.schemaVersion,
      kind: outcome.envelope.kind,
      text: outcome.envelope.text,
      entities: outcome.envelope.entities,
    });
    const read = readRichTextEnvelope(serialized);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.envelope.text).toBe(outcome.text);
      expect(read.envelope.entities).toEqual(outcome.envelope.entities);
    }
  });

  it('renders a document without claims/source as headline+summary+note only (nothing invented)', () => {
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: HEADLINE,
        summaryFa: SUMMARY,
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(
      [HEADLINE, SUMMARY, EDITORIAL_POST_LABELS.unverifiedNote].join('\n\n'),
    );
  });

  it('fails typed on malformed JSON / non-object / unsupported version', () => {
    expect(renderEditorialPostText('not json')).toEqual({
      ok: false,
      reason: 'malformed_json',
    });
    expect(renderEditorialPostText('[]')).toEqual({ ok: false, reason: 'malformed_document' });
    expect(
      renderEditorialPostText(JSON.stringify({ schemaVersion: 2, headlineFa: HEADLINE })),
    ).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  it('fails typed on an empty/missing headline and wrong-typed core fields', () => {
    expect(renderEditorialPostText(JSON.stringify({ schemaVersion: 1 }))).toEqual({
      ok: false,
      reason: 'empty_headline',
    });
    expect(renderEditorialPostText(JSON.stringify({ schemaVersion: 1, headlineFa: '' }))).toEqual({
      ok: false,
      reason: 'empty_headline',
    });
    expect(renderEditorialPostText(JSON.stringify({ schemaVersion: 1, headlineFa: 42 }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
    expect(
      renderEditorialPostText(
        JSON.stringify({ schemaVersion: 1, headlineFa: HEADLINE, summaryFa: 7 }),
      ),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(renderEditorialPostText(documentJson({ sourceReport: 'not an object' }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
  });

  it('fails typed when a stored claim is not exactly the unverified mapper shape (never laundered)', () => {
    // A tampered/legacy document claiming a verified status must NEVER
    // render as a post — the unverified status is structural.
    expect(
      renderEditorialPostText(
        documentJson({
          modelClaims: [{ text: CLAIM, evidenceIds: ['item-1'], status: 'verified' }],
        }),
      ),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(
      renderEditorialPostText(
        documentJson({ modelClaims: [{ text: CLAIM, evidenceIds: ['item-1'] }] }),
      ),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(
      renderEditorialPostText(documentJson({ modelClaims: [{ text: '' }], summaryFa: SUMMARY })),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(renderEditorialPostText(documentJson({ modelClaims: 'not a list' }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
  });

  it('fails typed (no truncation) when the composed text exceeds the 4096-unit post limit', () => {
    // A summary just under the cap forces the composition past 4096 UTF-16
    // units once the headline/claims/note are added.
    const hugeSummary = 'خ'.repeat(4200);
    const outcome = renderEditorialPostText(
      JSON.stringify({ schemaVersion: 1, headlineFa: HEADLINE, summaryFa: hugeSummary }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The envelope's own typed overflow reason surfaces verbatim — the
    // render never shortens the content to fit.
    expect(outcome.reason).toBe('text_too_large');
    // And the honest behavior is observable: no envelope was produced.
  });
});
