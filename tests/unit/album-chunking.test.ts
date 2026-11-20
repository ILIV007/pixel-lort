/**
 * Slice 7 — the ALBUM CHUNKING suite (DESIGN §10.3: native album via
 * `sendMediaGroupChunked`, max 10 media per group).
 *
 * Pinned here:
 *  - 2..10 items → exactly ONE media-group chunk, caption on ordinal 0;
 *  - 11 items → a 10-group + a trailing SINGLE (never a 1-item group);
 *  - 20 items → two 10-groups; 21 → 10 + 10 + single; ordinals preserved;
 *  - the caption rides chunk 0 ONLY — later chunks carry no caption;
 *  - chunk identity keys are deterministic per plan key + index;
 *  - <2 items, >100 items, broken ordinals, bad kinds/media/URLs fail typed.
 */

import { describe, expect, it } from 'vitest';

import {
  ALBUM_CHUNK_LIMITS,
  chunkAlbumItems,
  chunkAlbumSendPlan,
} from '../../src/domain/media/album-chunking';
import type { AlbumSendPlanItemV1 } from '../../src/domain/media/album-send-plan';

const PLAN_KEY = 'plan-key-hex';

function item(ordinal: number): AlbumSendPlanItemV1 {
  return {
    ordinal,
    type: ordinal % 2 === 0 ? 'photo' : 'video',
    media: `file-id-${ordinal}`,
    canonicalUrl: `https://media.example/img/${ordinal}.jpg`,
  };
}

function items(count: number): AlbumSendPlanItemV1[] {
  return Array.from({ length: count }, (_unused, index) => item(index));
}

const CAPTION = { text: 'کپشن گالری', entities: [] };

describe('album-chunking: sendMediaGroupChunked', () => {
  it('2..10 items chunk into exactly one media group with the caption on ordinal 0', () => {
    for (const count of [2, 3, 10]) {
      const outcome = chunkAlbumItems({
        items: items(count),
        sendIdentityKey: PLAN_KEY,
        caption: CAPTION,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.chunks).toHaveLength(1);
      const chunk = outcome.chunks[0]!;
      expect(chunk.kind).toBe('media_group');
      if (chunk.kind !== 'media_group') continue;
      expect(chunk.items).toHaveLength(count);
      expect(chunk.items.map((entry) => entry.ordinal)).toEqual(
        Array.from({ length: count }, (_unused, index) => index),
      );
      expect(chunk.caption?.text).toBe(CAPTION.text);
      expect(chunk.chunkIdentityKey).toBe(`${PLAN_KEY}/chunk/0`);
    }
  });

  it('11 items split into a 10-group plus a trailing single (never a 1-item group)', () => {
    const outcome = chunkAlbumItems({
      items: items(11),
      sendIdentityKey: PLAN_KEY,
      caption: CAPTION,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.chunks).toHaveLength(2);
    const [first, second] = outcome.chunks;
    expect(first?.kind).toBe('media_group');
    expect(second?.kind).toBe('single');
    if (first?.kind === 'media_group' && second?.kind === 'single') {
      expect(first.items).toHaveLength(10);
      expect(first.caption?.text).toBe(CAPTION.text);
      expect(second.item.ordinal).toBe(10);
      expect(second.item.type).toBe('photo');
      expect('caption' in second).toBe(false);
      expect(second.chunkIdentityKey).toBe(`${PLAN_KEY}/chunk/1`);
    }
  });

  it('20 items split into two 10-groups; 21 into 10 + 10 + single, ordinals preserved', () => {
    const twenty = chunkAlbumItems({ items: items(20), sendIdentityKey: PLAN_KEY });
    expect(twenty.ok).toBe(true);
    if (twenty.ok) {
      expect(twenty.chunks).toHaveLength(2);
      expect(twenty.chunks.every((chunk) => chunk.kind === 'media_group')).toBe(true);
      expect(twenty.chunks[1]?.kind).toBe('media_group');
      if (twenty.chunks[1]?.kind === 'media_group') {
        expect(twenty.chunks[1].items[0]?.ordinal).toBe(10);
        expect(twenty.chunks[1].caption).toBeUndefined();
      }
    }
    const twentyOne = chunkAlbumItems({ items: items(21), sendIdentityKey: PLAN_KEY });
    expect(twentyOne.ok).toBe(true);
    if (twentyOne.ok) {
      expect(twentyOne.chunks).toHaveLength(3);
      expect(twentyOne.chunks[2]?.kind).toBe('single');
    }
  });

  it('the caption never rides a later chunk', () => {
    const outcome = chunkAlbumItems({
      items: items(25),
      sendIdentityKey: PLAN_KEY,
      caption: CAPTION,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const chunk of outcome.chunks.slice(1)) {
      if (chunk.kind === 'media_group') expect(chunk.caption).toBeUndefined();
    }
  });

  it('a gallery without a caption chunks with no caption anywhere', () => {
    const outcome = chunkAlbumItems({ items: items(12), sendIdentityKey: PLAN_KEY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const chunk of outcome.chunks) {
      if (chunk.kind === 'media_group') expect(chunk.caption).toBeUndefined();
    }
  });

  it('fewer than 2 items, more than the gallery cap, and malformed items fail typed', () => {
    expect(chunkAlbumItems({ items: items(1), sendIdentityKey: PLAN_KEY }).ok).toBe(false);
    expect(chunkAlbumItems({ items: [], sendIdentityKey: PLAN_KEY }).ok).toBe(false);
    expect(
      chunkAlbumItems({
        items: items(ALBUM_CHUNK_LIMITS.maxGalleryItems + 1),
        sendIdentityKey: PLAN_KEY,
      }),
    ).toEqual({ ok: false, reason: 'too_many_items' });
    expect(chunkAlbumItems({ items: items(2), sendIdentityKey: '' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    const brokenOrdinal = items(3);
    brokenOrdinal[2] = { ...brokenOrdinal[2]!, ordinal: 5 };
    expect(chunkAlbumItems({ items: brokenOrdinal, sendIdentityKey: PLAN_KEY })).toEqual({
      ok: false,
      reason: 'ordinal_mismatch',
    });
    const badKind = items(2);
    badKind[1] = { ...badKind[1]!, type: 'audio' as 'photo' };
    expect(chunkAlbumItems({ items: badKind, sendIdentityKey: PLAN_KEY })).toEqual({
      ok: false,
      reason: 'item_kind_invalid',
    });
    const badMedia = items(2);
    badMedia[0] = { ...badMedia[0]!, media: '' };
    expect(chunkAlbumItems({ items: badMedia, sendIdentityKey: PLAN_KEY })).toEqual({
      ok: false,
      reason: 'item_media_invalid',
    });
  });

  it('chunkAlbumSendPlan chunks a scheduler plan and keeps its caption on chunk 0', () => {
    const outcome = chunkAlbumSendPlan({
      schemaVersion: 1,
      planVersion: 'alsp1',
      destination: '@pixellores',
      items: items(11),
      caption: CAPTION,
      attachments: [],
      sendIdentityKey: PLAN_KEY,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.chunks).toHaveLength(2);
    expect(outcome.chunks[0]?.kind).toBe('media_group');
    if (outcome.chunks[0]?.kind === 'media_group') {
      expect(outcome.chunks[0].caption?.text).toBe(CAPTION.text);
    }
    expect(outcome.chunks[1]?.kind).toBe('single');
  });
});
