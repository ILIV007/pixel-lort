/**
 * Slice 7 — the EDIT MEDIA GUARD suite (DESIGN §10.2/§10.3: media files
 * are NEVER replaced by edit, only the caption).
 *
 * Pinned here:
 *  - a text edit and a caption edit pass the guard;
 *  - ANY media field — top-level or inside content — refuses the edit
 *    with `media_replacement_refused`;
 *  - an unknown shape refuses (it must never be misrouted as a text edit);
 *  - a batch refusal names the offending index; a clean batch passes.
 */

import { describe, expect, it } from 'vitest';

import {
  assertEditHasNoMedia,
  assertEditsHaveNoMedia,
} from '../../src/domain/media/media-edit-guard';

function textEdit() {
  return {
    shape: 'text',
    content: { kind: 'rich_text_v1', text: 'متن اصلاح‌شده', entities: [] },
  };
}

function captionEdit() {
  return {
    shape: 'caption',
    content: { kind: 'caption', text: 'کپشن اصلاح‌شده', entities: [] },
  };
}

describe('media-edit-guard: edits never replace media', () => {
  it('a text edit and a caption edit pass', () => {
    expect(assertEditHasNoMedia(textEdit())).toEqual({ ok: true });
    expect(assertEditHasNoMedia(captionEdit())).toEqual({ ok: true });
  });

  it('any media field on the edit refuses with media_replacement_refused', () => {
    for (const field of ['media', 'fileId', 'file_id', 'photo', 'video', 'document']) {
      const smuggled = { ...captionEdit(), [field]: 'new-file-id' };
      expect(assertEditHasNoMedia(smuggled)).toEqual({
        ok: false,
        reason: 'media_replacement_refused',
      });
    }
  });

  it('a media field inside the content refuses too', () => {
    const smuggled = {
      shape: 'caption',
      content: { kind: 'caption', text: 'کپشن', entities: [], photo: 'new-file-id' },
    };
    expect(assertEditHasNoMedia(smuggled)).toEqual({
      ok: false,
      reason: 'media_replacement_refused',
    });
  });

  it('an unknown shape refuses — it must never be misrouted as a text edit', () => {
    expect(
      assertEditHasNoMedia({
        shape: 'media',
        content: { kind: 'caption', text: 'x', entities: [] },
      }),
    ).toEqual({ ok: false, reason: 'media_replacement_refused' });
    expect(assertEditHasNoMedia({ shape: 'text' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(assertEditHasNoMedia(null)).toEqual({ ok: false, reason: 'invalid_input' });
    expect(assertEditHasNoMedia('caption')).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('a batch refusal names the offending index; a clean batch passes', () => {
    const smuggled = { ...textEdit(), video: 'new-file-id' };
    expect(assertEditsHaveNoMedia([textEdit(), captionEdit(), smuggled])).toEqual({
      ok: false,
      reason: 'media_replacement_refused',
      index: 2,
    });
    expect(assertEditsHaveNoMedia([textEdit(), captionEdit()])).toEqual({ ok: true });
    expect(assertEditsHaveNoMedia([])).toEqual({ ok: true });
  });
});
