/**
 * Slice 7 — the CHUNKED ALBUM + SLIDESHOW sender
 * (`sendMediaGroupChunked`, DESIGN §10.3).
 *
 * Executes a chunked album plan (or a full slideshow plan) against the
 * Telegram transport seams, IN ORDER:
 *
 *   1. each album chunk in order — a `media_group` chunk via the
 *      media-group port (caption rides chunk 0 ONLY, per the plan),
 *      a trailing `single` chunk via sendPhoto/sendVideo;
 *   2. for a slideshow, each continuation part as a reply to the FIRST
 *      sent message (the album's first message), text + page marker.
 *
 * FIRST FAILURE STOPS THE SEND — the outcome reports exactly which
 * messages landed (`sent`) and which step failed. NOTHING is retried
 * and NOTHING is auto-resent here: a partial send is the caller's
 * problem to reconcile against the D1 ledger (the scheduler owns that
 * reconciliation); re-sending from this service could double-post.
 * This service writes NOTHING durable — it is transport only.
 *
 * THE SEAMS (the house discipline — the ONLY artificial pieces in
 * tests): the three ports below. The REAL adapters wrap the Bot API
 * client (`sendMediaGroupRich` / `sendPhotoRich` / `sendVideoRich` /
 * `sendMessageRich`); the LIVE send is a later wiring slice — this
 * slice proves the ORDER, the caption placement, and the stop-on-failure
 * with fakes.
 */

import type { AlbumChunkItemV1, AlbumChunkV1 } from '../../domain/media/album-chunking';
import type { SlideshowPlanV1 } from '../../domain/media/slideshow-plan';

export interface ChunkedAlbumMediaGroupItemV1 {
  readonly type: 'photo' | 'video';
  readonly media: string;
  readonly caption?: { readonly text: string; readonly entities: readonly unknown[] };
}

export type ChunkedAlbumMediaGroupOutcome =
  | { readonly ok: true; readonly messages: readonly { readonly messageId: number }[] }
  | {
      readonly ok: false;
      readonly reason: 'send_failed' | 'send_rejected';
      readonly code?: string;
    };

export interface ChunkedAlbumMediaGroupPort {
  sendMediaGroup(input: {
    readonly chatId: string;
    readonly items: readonly ChunkedAlbumMediaGroupItemV1[];
    readonly chunkIdentityKey: string;
  }): Promise<ChunkedAlbumMediaGroupOutcome>;
}

export type ChunkedAlbumSingleOutcome =
  | { readonly ok: true; readonly messageId: number }
  | {
      readonly ok: false;
      readonly reason: 'send_failed' | 'send_rejected';
      readonly code?: string;
    };

export interface ChunkedAlbumSingleMediaPort {
  sendPhoto(input: {
    readonly chatId: string;
    readonly photo: string;
  }): Promise<ChunkedAlbumSingleOutcome>;
  sendVideo(input: {
    readonly chatId: string;
    readonly video: string;
  }): Promise<ChunkedAlbumSingleOutcome>;
}

export type ChunkedAlbumTextOutcome =
  | { readonly ok: true; readonly messageId: number }
  | {
      readonly ok: false;
      readonly reason: 'send_failed' | 'send_rejected';
      readonly code?: string;
    };

export interface ChunkedAlbumTextPort {
  sendMessage(input: {
    readonly chatId: string;
    readonly text: string;
    readonly replyToMessageId?: number;
  }): Promise<ChunkedAlbumTextOutcome>;
}

export interface ChunkedSendPorts {
  readonly mediaGroup: ChunkedAlbumMediaGroupPort;
  readonly singleMedia: ChunkedAlbumSingleMediaPort;
  readonly text: ChunkedAlbumTextPort;
}

export interface ChunkedSentMessageV1 {
  readonly messageId: number;
  readonly kind: 'media_group' | 'single' | 'continuation';
  readonly chunkIndex?: number;
  readonly page?: number;
}

export type ChunkedSendOutcome =
  | { readonly ok: true; readonly messages: readonly ChunkedSentMessageV1[] }
  | {
      readonly ok: false;
      readonly reason: 'invalid_input' | 'send_failed';
      readonly code?: string;
      /** Messages that landed before the failure (partial-send honesty). */
      readonly sent: readonly ChunkedSentMessageV1[];
    };

function isValidChatId(chatId: unknown): chatId is string {
  return typeof chatId === 'string' && chatId.length >= 1 && chatId.length <= 256;
}

function isValidMessageId(messageId: unknown): messageId is number {
  return typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0;
}

/**
 * Send the album chunks (`sendMediaGroupChunked`): groups of at most 10
 * via the media-group port, a trailing single via sendPhoto/sendVideo.
 * Stops at the first failure; never retries.
 */
export async function sendAlbumChunked(input: {
  readonly chatId: string;
  readonly chunks: readonly AlbumChunkV1[];
  readonly ports: ChunkedSendPorts;
}): Promise<ChunkedSendOutcome> {
  if (
    typeof input !== 'object' ||
    input === null ||
    !isValidChatId(input.chatId) ||
    !Array.isArray(input.chunks) ||
    input.chunks.length === 0 ||
    typeof input.ports !== 'object' ||
    input.ports === null
  ) {
    return { ok: false, reason: 'invalid_input', sent: [] };
  }
  const sent: ChunkedSentMessageV1[] = [];
  for (const chunk of input.chunks) {
    try {
      if (chunk.kind === 'media_group') {
        // Locals (not `chunk.*` inside the callback): narrowing of a
        // union member does not survive into a closure.
        const groupItems = chunk.items;
        const groupCaption = chunk.caption;
        const result = await input.ports.mediaGroup.sendMediaGroup({
          chatId: input.chatId,
          items: groupItems.map((item: AlbumChunkItemV1) => ({
            type: item.type,
            media: item.media,
            ...(item.ordinal === 0 && groupCaption !== undefined ? { caption: groupCaption } : {}),
          })),
          chunkIdentityKey: chunk.chunkIdentityKey,
        });
        if (!result.ok) {
          return { ok: false, reason: 'send_failed', code: result.code, sent };
        }
        if (!Array.isArray(result.messages) || result.messages.length !== chunk.items.length) {
          return { ok: false, reason: 'send_failed', sent };
        }
        for (const message of result.messages) {
          if (!isValidMessageId(message.messageId)) {
            return { ok: false, reason: 'send_failed', sent };
          }
          sent.push({ messageId: message.messageId, kind: 'media_group', chunkIndex: chunk.index });
        }
      } else {
        const single =
          chunk.item.type === 'photo'
            ? await input.ports.singleMedia.sendPhoto({
                chatId: input.chatId,
                photo: chunk.item.media,
              })
            : await input.ports.singleMedia.sendVideo({
                chatId: input.chatId,
                video: chunk.item.media,
              });
        if (!single.ok) {
          return { ok: false, reason: 'send_failed', code: single.code, sent };
        }
        if (!isValidMessageId(single.messageId)) {
          return { ok: false, reason: 'send_failed', sent };
        }
        sent.push({ messageId: single.messageId, kind: 'single', chunkIndex: chunk.index });
      }
    } catch {
      return { ok: false, reason: 'send_failed', sent };
    }
  }
  return { ok: true, messages: sent };
}

/**
 * Send a whole slideshow plan: the album chunks first, then each
 * continuation part as a reply to the FIRST album message (text +
 * page marker — the footer blockquote rides the last part's text, put
 * there by the renderer, never by this sender).
 */
export async function sendSlideshow(input: {
  readonly chatId: string;
  readonly plan: SlideshowPlanV1;
  readonly ports: ChunkedSendPorts;
}): Promise<ChunkedSendOutcome> {
  if (
    typeof input !== 'object' ||
    input === null ||
    !isValidChatId(input.chatId) ||
    typeof input.plan !== 'object' ||
    input.plan === null ||
    !Array.isArray(input.plan.chunks) ||
    input.plan.chunks.length === 0 ||
    typeof input.ports !== 'object' ||
    input.ports === null
  ) {
    return { ok: false, reason: 'invalid_input', sent: [] };
  }
  const album = await sendAlbumChunked({
    chatId: input.chatId,
    chunks: input.plan.chunks,
    ports: input.ports,
  });
  if (!album.ok) return album;
  const sent: ChunkedSentMessageV1[] = [...album.messages];
  const firstMessageId = sent[0]?.messageId;
  if (firstMessageId === undefined) return { ok: false, reason: 'send_failed', sent };
  for (const part of input.plan.continuations) {
    try {
      const result = await input.ports.text.sendMessage({
        chatId: input.chatId,
        text: `${part.text}${part.pageMarker}`,
        replyToMessageId: firstMessageId,
      });
      if (!result.ok) {
        return { ok: false, reason: 'send_failed', code: result.code, sent };
      }
      if (!isValidMessageId(result.messageId)) {
        return { ok: false, reason: 'send_failed', sent };
      }
      sent.push({ messageId: result.messageId, kind: 'continuation', page: part.page });
    } catch {
      return { ok: false, reason: 'send_failed', sent };
    }
  }
  return { ok: true, messages: sent };
}
