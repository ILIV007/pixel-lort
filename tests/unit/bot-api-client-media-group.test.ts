/**
 * Phase 7.3 — the sendMediaGroupRich transport suite (the album media-group
 * send on the REAL client factory with a captured fake fetch): the JSON
 * path (file_id/URL references — the reuse/direct-URL paths), the MULTIPART
 * path (attach uploads — the staged-bytes path), the caption-ONLY-ordinal-0
 * invariant AT THE TRANSPORT BOUNDARY, and the 2..10 bound.
 */

import { describe, expect, it } from 'vitest';

import {
  createBotApiClient,
  type TelegramMediaGroupItemInput,
} from '../../src/adapters/telegram/bot-api-client';
import { createRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';

function captionFor(text: string) {
  const outcome = createRichTextEnvelope({ kind: 'caption', text, entities: [] });
  if (!outcome.ok) throw new Error('fixture caption invalid');
  return outcome.envelope;
}

const GROUP_REPLY = {
  ok: true,
  result: [
    {
      message_id: 101,
      photo: [
        { width: 640, height: 480, file_id: 'AgAC-small' },
        { width: 1280, height: 960, file_id: 'AgAC-large' },
      ],
    },
    { message_id: 102, video: { file_id: 'BAAC-video-1' } },
  ],
};

function clientWith(
  reply: unknown,
  captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return createBotApiClient({
    botToken: 'test-token',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.headers = Object.fromEntries(new Headers(init?.headers).entries());
      captured.body = init?.body;
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    logger: undefined,
  });
}

describe('the media-group JSON transport (file_id / URL references — the reuse paths)', () => {
  it('sends 2..10 items with NO parse_mode and parses the per-item file_ids (photo = the LARGEST variant)', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const client = clientWith(GROUP_REPLY, captured);
    const messages = await client.sendMediaGroupRich({
      chatId: '@pixellores',
      items: [
        { type: 'photo', fileId: 'AgAC-existing-1' },
        { type: 'video', fileId: 'BAAC-existing-2' },
      ],
    });
    expect(captured.url).toContain('/sendMediaGroup');
    expect(captured.headers?.['content-type']).toBe('application/json');
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>;
    expect(body['chat_id']).toBe('@pixellores');
    expect(JSON.stringify(body)).not.toContain('parse_mode');
    const media = JSON.parse(String(body['media'])) as readonly Record<string, unknown>[];
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({ type: 'photo', media: 'AgAC-existing-1' });
    expect(messages).toEqual([
      { messageId: 101, fileId: 'AgAC-large' },
      { messageId: 102, fileId: 'BAAC-video-1' },
    ]);
  });

  it('a caption rides the ordinal-0 item ONLY (the transport-boundary invariant)', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const client = clientWith(GROUP_REPLY, captured);
    await client.sendMediaGroupRich({
      chatId: 12345,
      items: [
        { type: 'photo', fileId: 'AgAC-1', caption: captionFor('تیتر آلبوم') },
        { type: 'photo', fileId: 'AgAC-2' },
      ],
    });
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>;
    const media = JSON.parse(String(body['media'])) as readonly Record<string, unknown>[];
    expect(media[0]).toHaveProperty('caption', 'تیتر آلبوم');
    expect(media[0]).toHaveProperty('caption_entities');
    expect(media[1]).not.toHaveProperty('caption');
  });
});

describe('the media-group multipart transport (attach uploads — the staged-bytes path)', () => {
  it('sends a FormData body WITHOUT a JSON content-type and attaches the bytes under their refs', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const client = clientWith(GROUP_REPLY, captured);
    const items: readonly TelegramMediaGroupItemInput[] = [
      {
        type: 'photo',
        attach: { ref: 'item-0', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' },
      },
      {
        type: 'video',
        attach: { ref: 'item-1', bytes: new Uint8Array([4, 5, 6]), contentType: 'video/mp4' },
      },
    ];
    const messages = await client.sendMediaGroupRich({ chatId: 12345, items });
    expect(captured.headers?.['content-type']).toBeUndefined();
    const form = captured.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe('12345');
    const media = JSON.parse(String(form.get('media'))) as readonly Record<string, unknown>[];
    expect(media.map((item) => item['media'])).toEqual(['attach://item-0', 'attach://item-1']);
    expect((form.get('item-0') as Blob).size).toBe(3);
    expect(messages).toHaveLength(2);
  });

  it('a MIXED group (a reused file_id + a staged attach) takes the multipart path', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const client = clientWith(GROUP_REPLY, captured);
    await client.sendMediaGroupRich({
      chatId: 12345,
      items: [
        { type: 'photo', fileId: 'AgAC-reused' },
        {
          type: 'photo',
          attach: { ref: 'item-1', bytes: new Uint8Array([9]), contentType: 'image/png' },
        },
      ],
    });
    expect(captured.body).toBeInstanceOf(FormData);
    const form = captured.body as FormData;
    const media = JSON.parse(String(form.get('media'))) as readonly Record<string, unknown>[];
    expect(media[0]).toMatchObject({ media: 'AgAC-reused' });
    expect(media[1]).toMatchObject({ media: 'attach://item-1' });
  });
});

describe('the typed pre-fetch rejections (ZERO fetch calls)', () => {
  async function expectRejected(items: readonly TelegramMediaGroupItemInput[]): Promise<void> {
    const captured: { url?: string } = {};
    const client = clientWith(GROUP_REPLY, captured);
    await expect(client.sendMediaGroupRich({ chatId: 12345, items })).rejects.toThrow();
    expect(captured.url).toBeUndefined();
  }

  it('a caption on a NON-ordinal-0 item fails typed before any fetch', async () => {
    await expectRejected([
      { type: 'photo', fileId: 'AgAC-1' },
      { type: 'photo', fileId: 'AgAC-2', caption: captionFor('contraband') },
    ]);
  });

  it('fewer than 2 or more than 10 items fail typed', async () => {
    await expectRejected([{ type: 'photo', fileId: 'AgAC-1' }]);
    await expectRejected(
      Array.from({ length: 11 }, (_, index) => ({
        type: 'photo' as const,
        fileId: `AgAC-${index}`,
      })),
    );
  });

  it('an item with ZERO or MULTIPLE references fails typed', async () => {
    await expectRejected([
      { type: 'photo' } as TelegramMediaGroupItemInput,
      { type: 'photo', fileId: 'AgAC-2' },
    ]);
    await expectRejected([
      { type: 'photo', fileId: 'AgAC-1', url: 'https://cdn.example.com/x.jpg' },
      { type: 'photo', fileId: 'AgAC-2' },
    ]);
  });

  it('a plain-http direct URL fails typed (https-only at the client boundary)', async () => {
    await expectRejected([
      { type: 'photo', url: 'http://cdn.example.com/x.jpg' },
      { type: 'photo', fileId: 'AgAC-2' },
    ]);
  });

  it('a malformed reply (a message without its media) is telegram_response_invalid — never guessed', async () => {
    const captured: { url?: string } = {};
    const client = clientWith(
      { ok: true, result: [{ message_id: 1 }, { message_id: 2 }] },
      captured,
    );
    await expect(
      client.sendMediaGroupRich({
        chatId: 12345,
        items: [
          { type: 'photo', fileId: 'AgAC-1' },
          { type: 'photo', fileId: 'AgAC-2' },
        ],
      }),
    ).rejects.toThrow();
  });
});
