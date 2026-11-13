/**
 * Phase 9D — the pure album-capture module (ac1) RED-first suite.
 */
import { describe, expect, it } from 'vitest';

import {
  ALBUM_CAPTURE_MAX_ITEMS,
  ALBUM_CAPTURE_MIN_ITEMS,
  ALBUM_CAPTURE_SESSION_TTL_MS,
  ALBUM_CAPTURE_VERSION,
  appendCaptureItem,
  capturedItemCanonicalUrl,
  parseAlbumCaptureArgument,
  readAlbumCaptureState,
} from '../../src/domain/media/album-capture';

function freshState(storyId = 'story-cap-1') {
  return { version: 'ac1', storyId, items: [] };
}

describe('album-capture ac1 — the argument grammar', () => {
  it('carries the pinned version and bounds', () => {
    expect(ALBUM_CAPTURE_VERSION).toBe('ac1');
    expect(ALBUM_CAPTURE_MAX_ITEMS).toBe(10);
    expect(ALBUM_CAPTURE_MIN_ITEMS).toBe(2);
    expect(ALBUM_CAPTURE_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('the no-argument form is the status view', () => {
    expect(parseAlbumCaptureArgument(undefined)).toEqual({ kind: 'status' });
    expect(parseAlbumCaptureArgument('')).toEqual({ kind: 'status' });
  });

  it('finish / cancel are reserved words', () => {
    expect(parseAlbumCaptureArgument('finish')).toEqual({ kind: 'finish' });
    expect(parseAlbumCaptureArgument('cancel')).toEqual({ kind: 'cancel' });
    expect(parseAlbumCaptureArgument('status')).toEqual({ kind: 'invalid' });
  });

  it('a valid story id starts the capture', () => {
    expect(parseAlbumCaptureArgument('story-123')).toEqual({
      kind: 'start',
      storyId: 'story-123',
    });
  });

  it('whitespace/newline/control/oversized arguments are invalid grammar', () => {
    expect(parseAlbumCaptureArgument('two words')).toEqual({ kind: 'invalid' });
    expect(parseAlbumCaptureArgument('story\nid')).toEqual({ kind: 'invalid' });
    expect(parseAlbumCaptureArgument('story\x01id')).toEqual({ kind: 'invalid' });
    expect(parseAlbumCaptureArgument('s'.repeat(129))).toEqual({ kind: 'invalid' });
  });

  it('a 128-unit story id is exactly at the bound', () => {
    const id = 'ی'.repeat(64); // 128 bytes
    expect(parseAlbumCaptureArgument(id)).toEqual({ kind: 'start', storyId: id });
  });
});

describe('album-capture ac1 — the state reader (TOTAL, never repaired)', () => {
  it('reads the fresh empty state', () => {
    const read = readAlbumCaptureState(freshState());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.state.items).toEqual([]);
      expect(read.state.storyId).toBe('story-cap-1');
    }
  });

  it('rejects non-object, foreign-version, and shape-broken states', () => {
    expect(readAlbumCaptureState(null)).toEqual({ ok: false, reason: 'not_json_object' });
    expect(readAlbumCaptureState('x')).toEqual({ ok: false, reason: 'not_json_object' });
    expect(readAlbumCaptureState({ version: 'v9', storyId: 's', items: [] })).toEqual({
      ok: false,
      reason: 'not_version_ac1',
    });
    expect(readAlbumCaptureState({ version: 'ac1', storyId: '', items: [] })).toEqual({
      ok: false,
      reason: 'shape_invalid',
    });
    expect(readAlbumCaptureState({ version: 'ac1', storyId: 's', items: 'x' })).toEqual({
      ok: false,
      reason: 'shape_invalid',
    });
    expect(
      readAlbumCaptureState({ version: 'ac1', storyId: 's', items: [{ ordinal: 0 }] }),
    ).toEqual({ ok: false, reason: 'shape_invalid' });
    expect(
      readAlbumCaptureState({
        version: 'ac1',
        storyId: 's',
        items: [{ ordinal: 0, kind: 'document', fileId: 'f' }],
      }),
    ).toEqual({ ok: false, reason: 'shape_invalid' });
    // More than 10 items is invalid even if every entry is well-formed.
    expect(
      readAlbumCaptureState({
        version: 'ac1',
        storyId: 's',
        items: Array.from({ length: 11 }, (_v, i) => ({
          ordinal: i,
          kind: 'photo',
          fileId: `f${i}`,
        })),
      }),
    ).toEqual({ ok: false, reason: 'shape_invalid' });
  });
});

describe('album-capture ac1 — the append rules', () => {
  it('appends photo/video items with growing ordinals', () => {
    const first = appendCaptureItem(freshState(), { kind: 'photo', fileId: 'file-A' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.items).toEqual([{ ordinal: 0, kind: 'photo', fileId: 'file-A' }]);
    const second = appendCaptureItem(first.state, { kind: 'video', fileId: 'file-B' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.items[1]).toEqual({ ordinal: 1, kind: 'video', fileId: 'file-B' });
  });

  it('captures the caption ONCE (the first caption-carrying member wins)', () => {
    const first = appendCaptureItem(freshState(), { kind: 'photo', fileId: 'f1' }, 'کپشن اول');
    if (!first.ok) throw new Error('unreachable');
    expect(first.state.captionText).toBe('کپشن اول');
    const second = appendCaptureItem(first.state, { kind: 'photo', fileId: 'f2' }, 'کپشن دوم');
    if (!second.ok) throw new Error('unreachable');
    expect(second.state.captionText).toBe('کپشن اول');
  });

  it('refuses unsupported kinds and broken states typed', () => {
    expect(appendCaptureItem(freshState(), { kind: 'document', fileId: 'f' })).toEqual({
      ok: false,
      reason: 'kind_unsupported',
    });
    expect(appendCaptureItem('corrupt', { kind: 'photo', fileId: 'f' })).toEqual({
      ok: false,
      reason: 'state_invalid',
    });
  });

  it('refuses the duplicate file_id typed', () => {
    const first = appendCaptureItem(freshState(), { kind: 'photo', fileId: 'same' });
    if (!first.ok) throw new Error('unreachable');
    expect(appendCaptureItem(first.state, { kind: 'photo', fileId: 'same' })).toEqual({
      ok: false,
      reason: 'duplicate_item',
    });
  });

  it('refuses the 11th member typed (the 2..10 media-group bound)', () => {
    let state: unknown = freshState();
    for (let index = 0; index < ALBUM_CAPTURE_MAX_ITEMS; index += 1) {
      const result = appendCaptureItem(state, { kind: 'photo', fileId: `f${index}` });
      if (!result.ok) throw new Error(`append ${index} failed: ${result.reason}`);
      state = result.state;
    }
    expect(appendCaptureItem(state, { kind: 'photo', fileId: 'f10' })).toEqual({
      ok: false,
      reason: 'album_full',
    });
  });

  it('is deterministic (JSON-equal repeated appends)', () => {
    const a = appendCaptureItem(freshState(), { kind: 'video', fileId: 'v1' });
    const b = appendCaptureItem(freshState(), { kind: 'video', fileId: 'v1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('album-capture ac1 — the synthetic canonical identity', () => {
  it('is deterministic, bounded, and from the capture-only namespace', () => {
    const url = capturedItemCanonicalUrl('session-1', 3);
    expect(url).toBe('album-capture:session-1/3');
    expect(url.length).toBeLessThanOrEqual(128);
    expect(url.startsWith('album-capture:')).toBe(true);
    expect(url).toBe(capturedItemCanonicalUrl('session-1', 3));
  });
});
