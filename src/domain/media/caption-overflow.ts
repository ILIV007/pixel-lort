/**
 * Slice 7 — the CAPTION OVERFLOW planner (DESIGN §10.3: caption overflow
 * goes to a reply chain, NEVER silent truncation; long text chunks at
 * 4096 units / 1024 caption units with page numbers `i/N`).
 *
 * Telegram caps a media caption at 1024 UTF-16 units and a text message
 * at 4096. A caption longer than 1024 is NEVER cut to fit: the first
 * 1024 units ride the media as its caption and the REMAINDER travels as
 * a reply chain of text parts (each at most 4096 units INCLUDING its page
 * marker), sent as replies to the media message.
 *
 * THE NO-LOSS INVARIANT: concatenating `caption + continuations[*].text`
 * (in order) reproduces the input byte-for-byte — the splitter cuts AFTER
 * a whitespace break (the break character stays at the end of the earlier
 * part) or, failing a break, at a hard cut that never splits a surrogate
 * pair. Page markers live OUTSIDE the content (`pageMarker` — the exact
 * suffix the sender appends), so the content itself is never polluted
 * and the marker budget is reserved inside the 4096 cap.
 *
 * BOUNDARY: pure — no I/O, no clock, no SQL, no Telegram/R2/KV types.
 * Plain text only: entity remapping across the cut lives in the
 * slideshow planner (which owns the entity vocabulary); this module
 * never drops content.
 */

import { RICH_TEXT_LIMITS } from '../telegram/rich-text-envelope';

/** The Bot API caps this planner enforces (rich-text-envelope pins them). */
export const CAPTION_OVERFLOW_LIMITS = {
  /** Caption units on the media message. */
  maxCaptionUnits: RICH_TEXT_LIMITS.maxCaptionUnits,
  /** Text units per reply-chain part, INCLUDING its page marker. */
  maxTextUnits: RICH_TEXT_LIMITS.maxTextUnits,
} as const;

/** One reply-chain part carrying the overflow remainder. */
export interface CaptionOverflowPartV1 {
  /** 1-based page within the continuation chain. */
  readonly page: number;
  /** Total continuation pages. */
  readonly totalPages: number;
  /** The page label (`i/N`) the sender appends via `pageMarker`. */
  readonly pageLabel: string;
  /** The exact suffix the sender appends (marker text, marker-free content). */
  readonly pageMarker: string;
  /** Marker-free content — joins losslessly with the caption + siblings. */
  readonly text: string;
  /** True on the last part (the footer blockquote rides there, per DESIGN §10.3). */
  readonly isLast: boolean;
}

export type CaptionOverflowPlanV1 =
  | { readonly kind: 'fits'; readonly caption: string }
  | {
      readonly kind: 'overflow';
      readonly caption: string;
      readonly continuations: readonly CaptionOverflowPartV1[];
    };

export type CaptionOverflowOutcome =
  | { readonly ok: true; readonly plan: CaptionOverflowPlanV1 }
  | { readonly ok: false; readonly reason: 'invalid_input' };

/** The page-marker suffix format (kept short; the budget reserves it). */
export function captionOverflowPageMarker(page: number, totalPages: number): string {
  return `\n\n— ${page}/${totalPages}`;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * The cut position at-or-before `limit` (absolute index) that never splits
 * a surrogate pair and prefers a whitespace break: the LAST break
 * (newline first, then space/tab) strictly after `start + minChunk` and
 * at-or-before `limit`; the cut lands AFTER the break character so the
 * concatenation stays lossless. Falls back to a hard cut at `limit`
 * (surrogate-adjusted) when no usable break exists.
 */
function cutPosition(text: string, start: number, limit: number): number {
  const minChunk = 64;
  const windowStart = start + minChunk;
  if (limit - start <= minChunk) return adjustForSurrogates(text, limit);
  let best = -1;
  for (let index = limit; index >= windowStart; index -= 1) {
    const unit = text.charCodeAt(index - 1);
    if (unit === 0x0a) {
      best = index;
      break;
    }
  }
  if (best === -1) {
    for (let index = limit; index >= windowStart; index -= 1) {
      const unit = text.charCodeAt(index - 1);
      if (unit === 0x20 || unit === 0x09) {
        best = index;
        break;
      }
    }
  }
  if (best === -1) return adjustForSurrogates(text, limit);
  return best;
}

function adjustForSurrogates(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const before = text.charCodeAt(cut - 1);
  const after = text.charCodeAt(cut);
  if (isHighSurrogate(before) && isLowSurrogate(after)) return cut - 1;
  return cut;
}

/** Split `text` (starting at `start`) into marker-free content parts. */
function splitRemainder(text: string, start: number): string[] {
  // Every part carries a page marker on send, so EVERY part — including
  // the last — reserves the marker budget inside the 4096 cap.
  const markerReserve = 16;
  const contentLimit = CAPTION_OVERFLOW_LIMITS.maxTextUnits - markerReserve;
  const parts: string[] = [];
  let cursor = start;
  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= contentLimit) {
      parts.push(text.slice(cursor));
      break;
    }
    const limit = cursor + contentLimit;
    const cut = cutPosition(text, cursor, limit);
    parts.push(text.slice(cursor, cut));
    cursor = cut;
  }
  return parts;
}

/**
 * Plan the caption + reply chain for `text`: fits in 1024 units → the
 * caption alone; longer → the 1024-unit caption plus the lossless
 * continuation chain. NEVER truncates.
 */
export function planCaptionOverflow(text: string): CaptionOverflowOutcome {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (text.length <= CAPTION_OVERFLOW_LIMITS.maxCaptionUnits) {
    return { ok: true, plan: { kind: 'fits', caption: text } };
  }
  const captionCut = cutPosition(text, 0, CAPTION_OVERFLOW_LIMITS.maxCaptionUnits);
  const caption = text.slice(0, captionCut);
  const remainderParts = splitRemainder(text, captionCut);
  const totalPages = remainderParts.length;
  const continuations: CaptionOverflowPartV1[] = remainderParts.map((part, index) => {
    const page = index + 1;
    return {
      page,
      totalPages,
      pageLabel: `${page}/${totalPages}`,
      pageMarker: captionOverflowPageMarker(page, totalPages),
      text: part,
      isLast: index === totalPages - 1,
    };
  });
  return { ok: true, plan: { kind: 'overflow', caption, continuations } };
}
