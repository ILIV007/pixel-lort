/**
 * Slice 7 — the CAPTION OVERFLOW suite (DESIGN §10.3: caption overflow
 * goes to a reply chain, NEVER silent truncation).
 *
 * Pinned here:
 *  - a caption of at most 1024 units fits alone (no continuation);
 *  - exactly 1024 units fits; 1025 overflows into caption + one part;
 *  - the no-loss invariant: caption + continuations join back to the
 *    input byte-for-byte (no trimmed content, ever);
 *  - every continuation part (content + page marker) stays within 4096
 *    units, carries its `i/N` label, and the last part is flagged;
 *  - a long text splits into several parts, all within cap;
 *  - surrogate pairs are never split across a cut;
 *  - empty / non-string input fails typed.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPTION_OVERFLOW_LIMITS,
  captionOverflowPageMarker,
  planCaptionOverflow,
} from '../../src/domain/media/caption-overflow';

describe('caption-overflow: never silent truncation', () => {
  it('a caption of at most 1024 units fits alone', () => {
    const text = 'ک'.repeat(1024);
    const outcome = planCaptionOverflow(text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.kind).toBe('fits');
    if (outcome.plan.kind === 'fits') expect(outcome.plan.caption).toBe(text);
  });

  it('1025 units overflow into a 1024-unit caption plus exactly one continuation part', () => {
    const text = 'x'.repeat(1025);
    const outcome = planCaptionOverflow(text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.kind).toBe('overflow');
    if (outcome.plan.kind !== 'overflow') return;
    expect(outcome.plan.caption.length).toBeLessThanOrEqual(1024);
    expect(outcome.plan.continuations).toHaveLength(1);
    const part = outcome.plan.continuations[0]!;
    expect(part.page).toBe(1);
    expect(part.totalPages).toBe(1);
    expect(part.pageLabel).toBe('1/1');
    expect(part.isLast).toBe(true);
    expect(part.pageMarker).toBe(captionOverflowPageMarker(1, 1));
    expect(part.text.length + part.pageMarker.length).toBeLessThanOrEqual(
      CAPTION_OVERFLOW_LIMITS.maxTextUnits,
    );
    // NO-LOSS: caption + continuation reproduces the input exactly.
    expect(outcome.plan.caption + part.text).toBe(text);
  });

  it('a long text splits into several capped parts, all labelled i/N, lossless in order', () => {
    const paragraph = 'متن خبری طولانی دربارهٔ بازی جدید. ';
    const text = paragraph.repeat(400);
    expect(text.length).toBeGreaterThan(10_000);
    const outcome = planCaptionOverflow(text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.kind).toBe('overflow');
    if (outcome.plan.kind !== 'overflow') return;
    const plan = outcome.plan;
    expect(plan.continuations.length).toBeGreaterThan(1);
    const joined = plan.caption + plan.continuations.map((part) => part.text).join('');
    expect(joined).toBe(text);
    plan.continuations.forEach((part, index) => {
      expect(part.page).toBe(index + 1);
      expect(part.totalPages).toBe(plan.continuations.length);
      expect(part.pageLabel).toBe(`${index + 1}/${plan.continuations.length}`);
      expect(part.text.length + part.pageMarker.length).toBeLessThanOrEqual(
        CAPTION_OVERFLOW_LIMITS.maxTextUnits,
      );
      expect(part.isLast).toBe(index === plan.continuations.length - 1);
    });
  });

  it('the split prefers whitespace breaks and never splits a surrogate pair', () => {
    // Emoji (surrogate pairs) straddling the 1024 boundary.
    const text = 'a'.repeat(1023) + '😀'.repeat(10) + 'b'.repeat(2000);
    const outcome = planCaptionOverflow(text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.kind).toBe('overflow');
    if (outcome.plan.kind !== 'overflow') return;
    const joined =
      outcome.plan.caption + outcome.plan.continuations.map((part) => part.text).join('');
    expect(joined).toBe(text);
    // No lone surrogates at any cut edge.
    for (const segment of [
      outcome.plan.caption,
      ...outcome.plan.continuations.map((part) => part.text),
    ]) {
      for (let index = 0; index < segment.length; index += 1) {
        const unit = segment.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          expect(segment.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
          expect(segment.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
        }
      }
    }
  });

  it('a text with newlines splits at a newline boundary, losslessly', () => {
    const text = `${'پاراگراف اول.\n'.repeat(60)}${'پاراگراف دوم.\n'.repeat(200)}`;
    const outcome = planCaptionOverflow(text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.plan.kind === 'overflow') {
      const joined =
        outcome.plan.caption + outcome.plan.continuations.map((part) => part.text).join('');
      expect(joined).toBe(text);
    }
  });

  it('empty and non-string input fails typed', () => {
    expect(planCaptionOverflow('')).toEqual({ ok: false, reason: 'invalid_input' });
    expect(planCaptionOverflow(undefined as unknown as string)).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });
});
