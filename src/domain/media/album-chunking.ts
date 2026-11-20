/**
 * Slice 7 — the ALBUM CHUNKING planner (DESIGN §10.3: native album via
 * `sendMediaGroupChunked`, max 10 media per group, for screenshot
 * galleries).
 *
 * The Bot API media group is 2..10 items. A gallery larger than 10 is
 * NEVER squeezed into one group (Telegram rejects it) and NEVER silently
 * dropped to 10: it is split into sequential groups of at most 10, and a
 * trailing single item travels as ONE single-media send (sendPhoto /
 * sendVideo — a 1-item media group is not a legal Bot API call).
 *
 * The caption rides the FIRST chunk's ordinal-0 item ONLY (the 7.1
 * no-separation layer, extended through the chunk boundary); later chunks
 * carry no caption. Global ordinals are preserved on every chunk item so
 * the delivery ledger can still bind per-ordinal evidence.
 *
 * Each chunk carries a deterministic chunk identity key derived from the
 * plan's send identity (`<plan-key>/chunk/<index>`) — the at-most-once
 * anchor for that chunk's send, never re-derived from mutable state.
 *
 * BOUNDARY: pure — no I/O, no clock, no SQL, no Telegram/R2/KV types.
 * TOTAL over its inputs: every malformed / out-of-bound input fails
 * typed; nothing is ever truncated to fit.
 */

import type { AlbumSendPlanItemV1, AlbumSendPlanV1 } from './album-send-plan';

/** The Bot API media-group bound (blueprint §14 step 7). */
export const ALBUM_CHUNK_LIMITS = {
  /** Items per media group. */
  maxItemsPerGroup: 10,
  /** The largest gallery this planner accepts (bounded work, never a scan). */
  maxGalleryItems: 100,
  /** The file_id contract (printable ASCII 1..256 units — album-content). */
  maxFileIdUnits: 256,
} as const;

export interface AlbumChunkItemV1 {
  readonly ordinal: number;
  readonly type: 'photo' | 'video';
  readonly media: string;
  readonly canonicalUrl: string;
}

export type AlbumChunkV1 =
  | {
      readonly kind: 'media_group';
      readonly index: number;
      readonly items: readonly AlbumChunkItemV1[];
      /** Present ONLY on chunk 0, IFF the gallery carries a caption. */
      readonly caption?: { readonly text: string; readonly entities: readonly unknown[] };
      readonly chunkIdentityKey: string;
    }
  | {
      readonly kind: 'single';
      readonly index: number;
      readonly item: AlbumChunkItemV1;
      /** A trailing single NEVER carries the caption (ordinal 0 is never last). */
      readonly caption?: never;
      readonly chunkIdentityKey: string;
    };

export type AlbumChunkingReasonV1 =
  | 'invalid_input'
  | 'too_few_items'
  | 'too_many_items'
  | 'ordinal_mismatch'
  | 'item_kind_invalid'
  | 'item_media_invalid'
  | 'item_url_invalid';

export type AlbumChunkingOutcome =
  | { readonly ok: true; readonly chunks: readonly AlbumChunkV1[] }
  | { readonly ok: false; readonly reason: AlbumChunkingReasonV1 };

const FILE_ID_PATTERN = /^[ -~]+$/;

function isBoundedFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= ALBUM_CHUNK_LIMITS.maxFileIdUnits &&
    FILE_ID_PATTERN.test(value)
  );
}

function isValidItem(
  value: unknown,
  ordinal: number,
): { ok: true; item: AlbumChunkItemV1 } | { ok: false; reason: AlbumChunkingReasonV1 } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_input' };
  }
  const record = value as Record<string, unknown>;
  if (record['ordinal'] !== ordinal) return { ok: false, reason: 'ordinal_mismatch' };
  if (record['type'] !== 'photo' && record['type'] !== 'video') {
    return { ok: false, reason: 'item_kind_invalid' };
  }
  if (!isBoundedFileId(record['media'])) return { ok: false, reason: 'item_media_invalid' };
  if (
    typeof record['canonicalUrl'] !== 'string' ||
    record['canonicalUrl'].length === 0 ||
    record['canonicalUrl'].length > 2048
  ) {
    return { ok: false, reason: 'item_url_invalid' };
  }
  return {
    ok: true,
    item: {
      ordinal,
      type: record['type'] as 'photo' | 'video',
      media: record['media'] as string,
      canonicalUrl: record['canonicalUrl'] as string,
    },
  };
}

function chunkIdentityKey(planKey: string, index: number): string {
  return `${planKey}/chunk/${index}`;
}

/**
 * Split a validated gallery (2..100 items, ordinals 0..n-1 in order) into
 * sequential send chunks of at most 10. A trailing single item becomes a
 * `single` chunk; every other chunk is a `media_group` of 2..10 items.
 * The caption (when given) rides chunk 0's ordinal-0 item ONLY.
 */
export function chunkAlbumItems(input: {
  readonly items: readonly AlbumSendPlanItemV1[];
  readonly sendIdentityKey: string;
  readonly caption?: { readonly text: string; readonly entities: readonly unknown[] };
}): AlbumChunkingOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Array.isArray(input.items)) return { ok: false, reason: 'invalid_input' };
  if (typeof input.sendIdentityKey !== 'string' || input.sendIdentityKey.length === 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.items.length < 2) return { ok: false, reason: 'too_few_items' };
  if (input.items.length > ALBUM_CHUNK_LIMITS.maxGalleryItems) {
    return { ok: false, reason: 'too_many_items' };
  }
  if (
    input.caption !== undefined &&
    (typeof input.caption !== 'object' ||
      input.caption === null ||
      typeof input.caption.text !== 'string' ||
      !Array.isArray(input.caption.entities))
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  const items: AlbumChunkItemV1[] = [];
  for (let index = 0; index < input.items.length; index += 1) {
    const validated = isValidItem(input.items[index], index);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    items.push(validated.item);
  }
  const chunks: AlbumChunkV1[] = [];
  let cursor = 0;
  let chunkIndex = 0;
  while (cursor < items.length) {
    const remaining = items.length - cursor;
    // A trailing single item is a `single` chunk, never a 1-item group.
    if (remaining === 1) {
      chunks.push({
        kind: 'single',
        index: chunkIndex,
        item: items[cursor]!,
        chunkIdentityKey: chunkIdentityKey(input.sendIdentityKey, chunkIndex),
      });
      cursor += 1;
      chunkIndex += 1;
      continue;
    }
    const take = Math.min(ALBUM_CHUNK_LIMITS.maxItemsPerGroup, remaining);
    const group = items.slice(cursor, cursor + take);
    chunks.push({
      kind: 'media_group',
      index: chunkIndex,
      items: group,
      ...(chunkIndex === 0 && input.caption !== undefined
        ? { caption: { text: input.caption.text, entities: input.caption.entities } }
        : {}),
      chunkIdentityKey: chunkIdentityKey(input.sendIdentityKey, chunkIndex),
    });
    cursor += take;
    chunkIndex += 1;
  }
  return { ok: true, chunks };
}

/**
 * Chunk an already-derived `AlbumSendPlanV1` (the scheduler's plan shape)
 * — the same split, the caption taken from the plan itself.
 */
export function chunkAlbumSendPlan(plan: AlbumSendPlanV1): AlbumChunkingOutcome {
  if (
    typeof plan !== 'object' ||
    plan === null ||
    !Array.isArray(plan.items) ||
    typeof plan.sendIdentityKey !== 'string'
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  return chunkAlbumItems({
    items: plan.items.map((item) => ({
      ordinal: item.ordinal,
      type: item.type,
      media: item.media,
      canonicalUrl: item.canonicalUrl,
    })),
    sendIdentityKey: plan.sendIdentityKey,
    ...(plan.caption !== undefined ? { caption: plan.caption } : {}),
  });
}
