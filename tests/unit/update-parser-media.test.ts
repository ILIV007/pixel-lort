import { describe, expect, it } from 'vitest';
import {
  parseTelegramUpdate,
  type ParsedMediaAttachment,
} from '../../src/adapters/telegram/update-parser';

function parseMessage(payload: Record<string, unknown>): ReturnType<typeof parseTelegramUpdate> {
  return parseTelegramUpdate({ update_id: 1, message: payload });
}

describe('R1.21 update parser — typed single-media extraction', () => {
  it('extracts the LARGEST photo variant file_id', () => {
    const result = parseMessage({
      message_id: 5,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      photo: [
        { file_id: 'small-id', file_unique_id: 'u1', width: 90, height: 90 },
        { file_id: 'mid-id', file_unique_id: 'u2', width: 320, height: 320 },
        { file_id: 'large-id', file_unique_id: 'u3', width: 800, height: 600 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    const media = result.update.media as ParsedMediaAttachment;
    expect(media).toEqual({ kind: 'photo', fileId: 'large-id' });
    expect(result.update.hasMediaAttachment).toBe(true);
    expect(result.update.inMediaGroup).toBeUndefined();
  });

  it('extracts the video file_id', () => {
    const result = parseMessage({
      message_id: 6,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      video: { file_id: 'video-id-1', file_unique_id: 'u', width: 640, height: 480, duration: 12 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.media).toEqual({ kind: 'video', fileId: 'video-id-1' });
  });

  it('extracts caption + caption_entities and a plain caption with an EMPTY entity list', () => {
    const rich = parseMessage({
      message_id: 7,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      photo: [{ file_id: 'p1', file_unique_id: 'u', width: 5, height: 5 }],
      caption: 'bold caption',
      caption_entities: [{ type: 'bold', offset: 0, length: 4 }],
    });
    expect(rich.ok).toBe(true);
    if (!rich.ok || rich.update.kind !== 'message') return;
    expect(rich.update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'bold caption',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
    });

    const plain = parseMessage({
      message_id: 8,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      photo: [{ file_id: 'p2', file_unique_id: 'u', width: 5, height: 5 }],
      caption: 'plain caption',
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok || plain.update.kind !== 'message') return;
    expect(plain.update.richCaption).toEqual({
      ok: true,
      kind: 'caption',
      text: 'plain caption',
      entities: [],
    });
  });

  it('maps EVERY other media shape to unsupported', () => {
    const cases: Record<string, unknown>[] = [
      { document: { file_id: 'd', file_unique_id: 'u' } },
      { audio: { file_id: 'a', file_unique_id: 'u', duration: 1 } },
      { animation: { file_id: 'an', file_unique_id: 'u' } },
      { voice: { file_id: 'v', file_unique_id: 'u', duration: 1 } },
      { video_note: { file_id: 'vn', file_unique_id: 'u', duration: 1 } },
      { sticker: { file_id: 's', file_unique_id: 'u' } },
      // Conflicting media fields are malformed -> unsupported (never half).
      {
        photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }],
        video: { file_id: 'v', file_unique_id: 'u' },
      },
      {
        photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }],
        document: { file_id: 'd', file_unique_id: 'u' },
      },
      // photo array present but NO usable entry (bad file ids).
      { photo: [{ file_unique_id: 'u', width: 1, height: 1 }] },
      // photo field of the wrong shape.
      { photo: { file_id: 'p', file_unique_id: 'u' } },
      // video without a usable file_id.
      { video: { file_unique_id: 'u' } },
    ];
    for (const extra of cases) {
      const result = parseMessage({
        message_id: 9,
        chat: { id: 10, type: 'private' },
        from: { id: 10 },
        ...extra,
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.update.kind !== 'message') return;
      expect(result.update.media).toEqual({ kind: 'unsupported' });
      expect(result.update.hasMediaAttachment).toBe(true);
    }
  });

  it('flags album membership (media_group_id) — the capture surface rejects it', () => {
    const result = parseMessage({
      message_id: 10,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      photo: [{ file_id: 'p', file_unique_id: 'u', width: 5, height: 5 }],
      media_group_id: '42',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.media).toEqual({ kind: 'photo', fileId: 'p' });
    expect(result.update.inMediaGroup).toBe(true);
  });

  it('a photo-size over the dimension cap cannot poison the area math (still extracts)', () => {
    const result = parseMessage({
      message_id: 11,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      photo: [
        { file_id: 'huge', file_unique_id: 'u', width: 9_000_000, height: 9_000_000 },
        { file_id: 'normal', file_unique_id: 'u', width: 100, height: 100 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    // The oversized dimensions fall outside the bounded area comparison
    // (area 0), so the normal variant wins — bounded, deterministic.
    expect(result.update.media).toEqual({ kind: 'photo', fileId: 'normal' });
  });

  it('a text message carries NO media field; an ordinary message parses untouched', () => {
    const result = parseMessage({
      message_id: 12,
      chat: { id: 10, type: 'private' },
      from: { id: 10 },
      text: 'سلام',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.update.kind !== 'message') return;
    expect(result.update.media).toBeUndefined();
    expect(result.update.hasMediaAttachment).toBeUndefined();
    expect(result.update.inMediaGroup).toBeUndefined();
  });
});
