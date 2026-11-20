/**
 * Slice 7 — the RICH SLIDESHOW planner (DESIGN §10.3: slideshow rich
 * inside ONE rich message for media + long text).
 *
 * A slideshow is ONE media-led message unit: the gallery travels as the
 * native album (chunked groups of at most 10, caption on chunk 0) and
 * the long text travels WITH it — the first 1024 units as the album
 * caption, the remainder as the reply chain the caption-overflow planner
 * derives. The whole unit is decided and validated HERE, before any
 * send, so the sender never improvises a split mid-flight.
 *
 * DECISION: slideshow applies ONLY when there is media (2+ items) AND
 * non-empty text. A text-only input routes back to the text path
 * (`not_slideshow`); a media-only input is a plain album, not a
 * slideshow (`not_slideshow` — the caller keeps the plain album plan).
 * When the text fits the caption, the slideshow is a single album with
 * no continuations.
 *
 * ENTITIES: entities fully inside a part survive with shifted offsets;
 * an entity STRADDLING a cut cannot be represented in either part, so
 * it is dropped — and the drop is COUNTED on the plan
 * (`entitiesDropped`), never silent. The CONTENT is never lost: only
 * formatting of a straddling span degrades, and the caller sees the
 * count before sending.
 *
 * BOUNDARY: pure — no I/O, no clock, no SQL, no Telegram/R2/KV types.
 * The send identity key is a caller input (opaque, non-empty) — the
 * planner never invents identity.
 */

import { chunkAlbumItems, type AlbumChunkV1 } from './album-chunking';
import { planCaptionOverflow } from './caption-overflow';
import type { RichTextEntity } from '../telegram/rich-text-envelope';
import type { AlbumSendPlanItemV1 } from './album-send-plan';

export const SLIDESHOW_PLAN_VERSION = 'slideshow1' as const;

export interface SlideshowCaptionV1 {
  readonly text: string;
  readonly entities: readonly RichTextEntity[];
}

export interface SlideshowContinuationV1 {
  readonly page: number;
  readonly totalPages: number;
  readonly pageLabel: string;
  readonly pageMarker: string;
  readonly text: string;
  readonly entities: readonly RichTextEntity[];
  readonly isLast: boolean;
}

export interface SlideshowPlanV1 {
  readonly planVersion: 'slideshow1';
  readonly chunks: readonly AlbumChunkV1[];
  readonly caption: SlideshowCaptionV1;
  readonly continuations: readonly SlideshowContinuationV1[];
  /** Entities dropped for straddling a cut (formatting only, counted). */
  readonly entitiesDropped: number;
}

export type SlideshowPlanReasonV1 =
  'invalid_input' | 'not_slideshow' | 'invalid_entities' | 'chunking_failed';

export type SlideshowPlanOutcome =
  | { readonly ok: true; readonly plan: SlideshowPlanV1 }
  | { readonly ok: false; readonly reason: SlideshowPlanReasonV1 };

function isValidEntity(value: unknown, textLength: number): value is RichTextEntity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const offset = record['offset'];
  const length = record['length'];
  return (
    typeof offset === 'number' &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    typeof length === 'number' &&
    Number.isSafeInteger(length) &&
    length > 0 &&
    offset + length <= textLength
  );
}

/**
 * Place entities into part windows: an entity fully inside exactly one
 * window survives there with a shifted offset; an entity straddling a
 * cut fits NO window and is dropped — counted ONCE (never once per
 * part it fails to fit).
 */
function placeEntities(
  entities: readonly RichTextEntity[],
  windows: readonly { readonly start: number; readonly end: number }[],
): { perPart: RichTextEntity[][]; dropped: number } {
  const perPart: RichTextEntity[][] = windows.map(() => []);
  let dropped = 0;
  for (const entity of entities) {
    let placed = false;
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index]!;
      if (entity.offset >= window.start && entity.offset + entity.length <= window.end) {
        perPart[index]!.push({ ...entity, offset: entity.offset - window.start });
        placed = true;
        break;
      }
    }
    if (!placed) dropped += 1;
  }
  return { perPart, dropped };
}

/**
 * Plan the slideshow for a media gallery + long text. `sendIdentityKey`
 * is the caller-derived album identity (opaque, non-empty) the chunk
 * keys derive from.
 */
export function planRichSlideshow(input: {
  readonly items: readonly AlbumSendPlanItemV1[];
  readonly text: string;
  readonly entities?: readonly RichTextEntity[];
  readonly sendIdentityKey: string;
}): SlideshowPlanOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Array.isArray(input.items) || input.items.length < 2) {
    // No media (or a single medium): not a slideshow — the caller routes
    // to the text path / single-media path unchanged.
    return { ok: false, reason: 'not_slideshow' };
  }
  if (typeof input.text !== 'string' || input.text.length === 0) {
    // Media without text is a plain album, not a slideshow.
    return { ok: false, reason: 'not_slideshow' };
  }
  if (typeof input.sendIdentityKey !== 'string' || input.sendIdentityKey.length === 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  const entities = input.entities ?? [];
  if (!Array.isArray(entities)) return { ok: false, reason: 'invalid_entities' };
  for (const entity of entities) {
    if (!isValidEntity(entity, input.text.length)) {
      return { ok: false, reason: 'invalid_entities' };
    }
  }
  const overflow = planCaptionOverflow(input.text);
  if (!overflow.ok) return { ok: false, reason: 'invalid_input' };
  const plan = overflow.plan;
  const captionText = plan.caption;
  // Part windows in order: the caption, then each continuation.
  const windows: { start: number; end: number }[] = [{ start: 0, end: captionText.length }];
  let cursor = captionText.length;
  if (plan.kind === 'overflow') {
    for (const part of plan.continuations) {
      windows.push({ start: cursor, end: cursor + part.text.length });
      cursor += part.text.length;
    }
  }
  const placed = placeEntities(entities, windows);
  const continuations: SlideshowContinuationV1[] = [];
  if (plan.kind === 'overflow') {
    plan.continuations.forEach((part, index) => {
      continuations.push({
        page: part.page,
        totalPages: part.totalPages,
        pageLabel: part.pageLabel,
        pageMarker: part.pageMarker,
        text: part.text,
        entities: placed.perPart[index + 1] ?? [],
        isLast: part.isLast,
      });
    });
  }
  const entitiesDropped = placed.dropped;
  const chunked = chunkAlbumItems({
    items: input.items,
    sendIdentityKey: input.sendIdentityKey,
    caption: {
      text: captionText,
      entities: placed.perPart[0] ?? [],
    },
  });
  if (!chunked.ok) return { ok: false, reason: 'chunking_failed' };
  // The caption the chunks carry MUST be the planned caption (the chunk
  // planner pins it on chunk 0); the plan echoes it for the caller.
  return {
    ok: true,
    plan: {
      planVersion: SLIDESHOW_PLAN_VERSION,
      chunks: chunked.chunks,
      caption: { text: captionText, entities: placed.perPart[0] ?? [] },
      continuations,
      entitiesDropped,
    },
  };
}
