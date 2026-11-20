/**
 * Slice 7 — the CHUNKED ALBUM + SLIDESHOW SENDER suite
 * (`sendMediaGroupChunked`, DESIGN §10.3).
 *
 * Pinned here (all transport seams faked — the service writes nothing
 * durable and never reaches the network):
 *  - a 12-item album sends a 10-group then a trailing single photo, in
 *    order, caption on the first group only;
 *  - a slideshow sends the album first, then each continuation as a
 *    reply to the FIRST album message, text + page marker;
 *  - the first failure stops the send: later chunks never fire, the
 *    outcome reports exactly what landed, nothing is retried;
 *  - a media-group reply with the wrong message count fails typed;
 *  - invalid input fails typed with zero port calls.
 */

import { describe, expect, it } from 'vitest';

import {
  sendAlbumChunked,
  sendSlideshow,
  type ChunkedSendPorts,
} from '../../src/application/media/album-chunked-send-service';
import { chunkAlbumItems } from '../../src/domain/media/album-chunking';
import { planRichSlideshow } from '../../src/domain/media/slideshow-plan';
import type { AlbumSendPlanItemV1 } from '../../src/domain/media/album-send-plan';

const CHAT_ID = '-1004402704217';

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

interface Call {
  readonly method: string;
  readonly detail: string;
}

function makePorts(
  options: { failGroupAt?: number; failSingleAt?: number; failTextAt?: number } = {},
): {
  ports: ChunkedSendPorts;
  calls: Call[];
} {
  const calls: Call[] = [];
  let groupCount = 0;
  let singleCount = 0;
  let textCount = 0;
  let nextMessageId = 100;
  const ports: ChunkedSendPorts = {
    mediaGroup: {
      async sendMediaGroup(input) {
        groupCount += 1;
        calls.push({ method: 'sendMediaGroup', detail: `items=${input.items.length}` });
        if (options.failGroupAt === groupCount) {
          return { ok: false, reason: 'send_failed', code: 'telegram_429' };
        }
        const messages = input.items.map(() => ({ messageId: nextMessageId++ }));
        return { ok: true, messages };
      },
    },
    singleMedia: {
      async sendPhoto(input) {
        singleCount += 1;
        calls.push({ method: 'sendPhoto', detail: input.photo });
        if (options.failSingleAt === singleCount) {
          return { ok: false, reason: 'send_failed', code: 'telegram_500' };
        }
        return { ok: true, messageId: nextMessageId++ };
      },
      async sendVideo(input) {
        singleCount += 1;
        calls.push({ method: 'sendVideo', detail: input.video });
        if (options.failSingleAt === singleCount) {
          return { ok: false, reason: 'send_failed', code: 'telegram_500' };
        }
        return { ok: true, messageId: nextMessageId++ };
      },
    },
    text: {
      async sendMessage(input) {
        textCount += 1;
        calls.push({
          method: 'sendMessage',
          detail: `replyTo=${input.replyToMessageId ?? 'none'} len=${input.text.length}`,
        });
        if (options.failTextAt === textCount) {
          return { ok: false, reason: 'send_failed', code: 'telegram_429' };
        }
        return { ok: true, messageId: nextMessageId++ };
      },
    },
  };
  return { ports, calls };
}

describe('album-chunked-send-service: sendMediaGroupChunked', () => {
  it('an 11-item album sends a 10-group then a trailing single, caption on the first group only', async () => {
    const chunked = chunkAlbumItems({
      items: items(11),
      sendIdentityKey: 'key-11',
      caption: { text: 'کپشن گالری', entities: [] },
    });
    expect(chunked.ok).toBe(true);
    if (!chunked.ok) return;
    const { ports, calls } = makePorts();
    const outcome = await sendAlbumChunked({ chatId: CHAT_ID, chunks: chunked.chunks, ports });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.messages).toHaveLength(11);
    expect(calls.map((call) => call.method)).toEqual(['sendMediaGroup', 'sendPhoto']);
    expect(calls[0]?.detail).toBe('items=10');
    // Caption placement is visible on the group input: only the first
    // group carries a caption — asserted via the plan (chunk 0 only).
    expect(chunked.chunks[0]?.kind).toBe('media_group');
    if (chunked.chunks[0]?.kind === 'media_group') {
      expect(chunked.chunks[0].caption?.text).toBe('کپشن گالری');
    }
  });

  it('a slideshow sends the album first, then continuations as replies to the first album message', async () => {
    const planned = planRichSlideshow({
      items: items(3),
      text: `متن بلند اسلایدشو. `.repeat(200),
      sendIdentityKey: 'key-slide',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.continuations.length).toBeGreaterThan(0);
    const { ports, calls } = makePorts();
    const outcome = await sendSlideshow({ chatId: CHAT_ID, plan: planned.plan, ports });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.messages[0]?.kind).toBe('media_group');
    const firstMessageId = outcome.messages[0]?.messageId;
    const replies = calls.filter((call) => call.method === 'sendMessage');
    expect(replies.length).toBe(planned.plan.continuations.length);
    for (const reply of replies) {
      expect(reply.detail.startsWith(`replyTo=${firstMessageId} `)).toBe(true);
    }
    expect(outcome.messages.filter((message) => message.kind === 'continuation')).toHaveLength(
      planned.plan.continuations.length,
    );
  });

  it('the first failure stops the send: later chunks never fire, the partial send is reported', async () => {
    const chunked = chunkAlbumItems({ items: items(21), sendIdentityKey: 'key-21' });
    expect(chunked.ok).toBe(true);
    if (!chunked.ok) return;
    const { ports, calls } = makePorts({ failGroupAt: 2 });
    const outcome = await sendAlbumChunked({ chatId: CHAT_ID, chunks: chunked.chunks, ports });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('send_failed');
    expect(outcome.code).toBe('telegram_429');
    // Only the first group landed (10 messages); the second group and
    // the trailing single never fired.
    expect(outcome.sent).toHaveLength(10);
    expect(calls.map((call) => call.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']);
  });

  it('a slideshow continuation failure stops after the album, reporting the album as sent', async () => {
    const planned = planRichSlideshow({
      items: items(2),
      text: `متن بلند. `.repeat(300),
      sendIdentityKey: 'key-slide-fail',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { ports } = makePorts({ failTextAt: 1 });
    const outcome = await sendSlideshow({ chatId: CHAT_ID, plan: planned.plan, ports });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.sent.filter((message) => message.kind === 'media_group')).toHaveLength(2);
    expect(outcome.sent.filter((message) => message.kind === 'continuation')).toHaveLength(0);
  });

  it('a media-group reply with the wrong message count fails typed', async () => {
    const chunked = chunkAlbumItems({ items: items(3), sendIdentityKey: 'key-3' });
    expect(chunked.ok).toBe(true);
    if (!chunked.ok) return;
    const { ports } = makePorts();
    const lyingPorts: ChunkedSendPorts = {
      ...ports,
      mediaGroup: {
        async sendMediaGroup() {
          return { ok: true, messages: [{ messageId: 1 }] };
        },
      },
    };
    const outcome = await sendAlbumChunked({
      chatId: CHAT_ID,
      chunks: chunked.chunks,
      ports: lyingPorts,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('send_failed');
  });

  it('invalid input fails typed with zero port calls', async () => {
    const chunked = chunkAlbumItems({ items: items(2), sendIdentityKey: 'key-2' });
    expect(chunked.ok).toBe(true);
    if (!chunked.ok) return;
    const { ports, calls } = makePorts();
    const outcome = await sendAlbumChunked({ chatId: '', chunks: chunked.chunks, ports });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_input', sent: [] });
    expect(calls).toHaveLength(0);
  });
});
