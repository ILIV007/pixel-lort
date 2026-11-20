/**
 * Slice 7 — the RICH SLIDESHOW suite (DESIGN §10.3: slideshow rich
 * inside ONE rich message for media + long text).
 *
 * Pinned here:
 *  - media + short text → one album, caption carried, no continuations;
 *  - media + long text → album caption + reply-chain continuations with
 *    i/N labels; caption + continuations reproduce the text losslessly;
 *  - a gallery over 10 items chunks (10-group + trailing single);
 *  - text-only input is NOT a slideshow (routes to the text path);
 *  - media without text is a plain album, NOT a slideshow;
 *  - entities fully inside a part survive with shifted offsets; an
 *    entity straddling a cut is dropped AND counted (never silent);
 *  - invalid entities fail typed.
 */

import { describe, expect, it } from 'vitest';

import { planRichSlideshow } from '../../src/domain/media/slideshow-plan';
import type { AlbumSendPlanItemV1 } from '../../src/domain/media/album-send-plan';
import type { RichTextEntity } from '../../src/domain/telegram/rich-text-envelope';

function item(ordinal: number): AlbumSendPlanItemV1 {
  return {
    ordinal,
    type: 'photo',
    media: `file-id-${ordinal}`,
    canonicalUrl: `https://media.example/img/${ordinal}.jpg`,
  };
}

function items(count: number): AlbumSendPlanItemV1[] {
  return Array.from({ length: count }, (_unused, index) => item(index));
}

const KEY = 'slideshow-identity-key';

describe('slideshow-plan: media + long text in one rich unit', () => {
  it('media + short text plans a single album with the caption and no continuations', () => {
    const outcome = planRichSlideshow({
      items: items(3),
      text: 'تریلر جدید بازی',
      sendIdentityKey: KEY,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.planVersion).toBe('slideshow1');
    expect(outcome.plan.chunks).toHaveLength(1);
    expect(outcome.plan.caption.text).toBe('تریلر جدید بازی');
    expect(outcome.plan.continuations).toHaveLength(0);
    expect(outcome.plan.entitiesDropped).toBe(0);
  });

  it('media + long text overflows into caption + labelled continuations, losslessly', () => {
    const text = `معرفی بازی جدید. `.repeat(300);
    const outcome = planRichSlideshow({ items: items(4), text, sendIdentityKey: KEY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.continuations.length).toBeGreaterThan(0);
    const joined =
      outcome.plan.caption.text + outcome.plan.continuations.map((part) => part.text).join('');
    expect(joined).toBe(text);
    outcome.plan.continuations.forEach((part, index) => {
      expect(part.page).toBe(index + 1);
      expect(part.pageLabel).toBe(`${index + 1}/${outcome.plan.continuations.length}`);
      expect(part.text.length + part.pageMarker.length).toBeLessThanOrEqual(4096);
    });
    // The caption the chunks carry IS the planned caption (chunk 0).
    const first = outcome.plan.chunks[0]!;
    expect(first.kind).toBe('media_group');
    if (first.kind === 'media_group') {
      expect(first.caption?.text).toBe(outcome.plan.caption.text);
    }
  });

  it('a 12-item gallery chunks into 10 + 2 while the slideshow text still overflows losslessly', () => {
    const text = 'x'.repeat(3000);
    const outcome = planRichSlideshow({ items: items(12), text, sendIdentityKey: KEY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.chunks).toHaveLength(2);
    expect(outcome.plan.chunks[1]?.kind).toBe('media_group');
    if (outcome.plan.chunks[1]?.kind === 'media_group') {
      expect(outcome.plan.chunks[1].items).toHaveLength(2);
    }
    const joined =
      outcome.plan.caption.text + outcome.plan.continuations.map((part) => part.text).join('');
    expect(joined).toBe(text);
  });

  it('text without media is not a slideshow; media without text is a plain album', () => {
    expect(planRichSlideshow({ items: [], text: 'متن', sendIdentityKey: KEY })).toEqual({
      ok: false,
      reason: 'not_slideshow',
    });
    expect(planRichSlideshow({ items: items(1), text: 'متن', sendIdentityKey: KEY })).toEqual({
      ok: false,
      reason: 'not_slideshow',
    });
    expect(planRichSlideshow({ items: items(3), text: '', sendIdentityKey: KEY })).toEqual({
      ok: false,
      reason: 'not_slideshow',
    });
  });

  it('entities fully inside a part survive with shifted offsets', () => {
    const text = `${'a'.repeat(100)}bold-part ${'b'.repeat(2000)}`;
    const boldOffset = 100;
    const entities: RichTextEntity[] = [
      { offset: boldOffset, length: 9, type: 'bold' } as RichTextEntity,
    ];
    const outcome = planRichSlideshow({ items: items(2), text, entities, sendIdentityKey: KEY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The bold span sits inside the caption (first 1024 units).
    expect(outcome.plan.caption.entities).toHaveLength(1);
    expect(outcome.plan.caption.entities[0]?.offset).toBe(boldOffset);
    expect(outcome.plan.caption.entities[0]?.length).toBe(9);
    expect(outcome.plan.entitiesDropped).toBe(0);
  });

  it('an entity straddling the caption cut is dropped and COUNTED, never silent', () => {
    // A bold span from 1000 to 1100 straddles the 1024 caption cut.
    const text = 'x'.repeat(2000);
    const entities: RichTextEntity[] = [
      { offset: 1000, length: 100, type: 'bold' } as RichTextEntity,
    ];
    const outcome = planRichSlideshow({ items: items(2), text, entities, sendIdentityKey: KEY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.entitiesDropped).toBe(1);
    expect(outcome.plan.caption.entities).toHaveLength(0);
    // The CONTENT still survives losslessly.
    const joined =
      outcome.plan.caption.text + outcome.plan.continuations.map((part) => part.text).join('');
    expect(joined).toBe(text);
  });

  it('an entity in a continuation part is remapped to that part', () => {
    const text = `${'a'.repeat(1500)}bold-here ${'b'.repeat(500)}`;
    const entities: RichTextEntity[] = [
      { offset: 1500, length: 9, type: 'bold' } as RichTextEntity,
    ];
    const outcome = planRichSlideshow({ items: items(2), text, entities, sendIdentityKey: KEY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.entitiesDropped).toBe(0);
    expect(outcome.plan.continuations.length).toBeGreaterThan(0);
    const first = outcome.plan.continuations[0]!;
    // The span starts inside the first continuation; its offset is shifted.
    const found = first.entities.find((entity) => entity.length === 9);
    expect(found).toBeDefined();
    expect(found?.offset).toBe(1500 - outcome.plan.caption.text.length);
  });

  it('invalid entities fail typed', () => {
    const text = 'short text';
    const bad: RichTextEntity[] = [{ offset: 5, length: 100, type: 'bold' } as RichTextEntity];
    expect(
      planRichSlideshow({ items: items(2), text, entities: bad, sendIdentityKey: KEY }),
    ).toEqual({
      ok: false,
      reason: 'invalid_entities',
    });
    expect(planRichSlideshow({ items: items(2), text, sendIdentityKey: '' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });
});
