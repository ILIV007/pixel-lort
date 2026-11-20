/**
 * Slice 4 — Persian format + normalization (blueprint persona §4, DESIGN
 * §10.1/§10.3).
 *
 * The deterministic renderer-side step: Arabic ي/ك/ة → Persian, whitespace
 * normalization, ZWNJ preserved, bidirectional isolation for Latin/URL
 * runs, and chunking that NEVER silently truncates — long text splits on
 * paragraph/line/word boundaries with `i/N` page numbers, the footer lives
 * only on the last part.
 *
 * The footer `👾 @pixellores` is rendered here, never by the model.
 * Pure: same input, same output.
 */

export const INBOUND_FOOTER = '👾 @pixellores';

/** Telegram text limit (RICH_TEXT_LIMITS.maxTextUnits) and caption limit. */
export const INBOUND_TEXT_LIMIT = 4096;
export const INBOUND_CAPTION_LIMIT = 1024;

const FOOTER_BLOCK = `\n\n${INBOUND_FOOTER}`;

/** Latin/URL runs embedded in Persian text get bidi isolation (LRI/PDI). */
const LATIN_RUN = /[A-Za-z0-9@][A-Za-z0-9@:/?#._~%+&=;,-]*[A-Za-z0-9@/?#._~%+&=;-]|[A-Za-z0-9@]/g;
const HAS_PERSIAN = /[\u0600-\u06FF]/;

export function normalizePersianText(text: string): string {
  let normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ى/g, 'ی')
    .replace(/ة/g, 'ه')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  if (HAS_PERSIAN.test(normalized)) {
    normalized = normalized.replace(LATIN_RUN, (run) => `\u2066${run}\u2069`);
  }
  return normalized;
}

export interface InboundPostPart {
  /** 'caption' = the media caption (first part of a media post). */
  readonly kind: 'text' | 'caption';
  readonly text: string;
}

/**
 * Split text into chunks of at most `maxUnits` UTF-16 units, on paragraph,
 * line, then word boundaries — never mid-word unless a single word exceeds
 * the limit (then it is hard-split: the only way to stay within the bound).
 * The chunks partition the input exactly: joining them reproduces it.
 */
export function chunkPostText(text: string, maxUnits: number): string[] {
  if (text.length <= maxUnits) {
    return text === '' ? [] : [text];
  }
  // Atoms keep their separators, so the chunk join reproduces the input.
  const atoms = text.split(/(\n\n|\n| )/g).filter((atom) => atom !== '');
  const chunks: string[] = [];
  let current = '';
  for (const atom of atoms) {
    if (current.length + atom.length <= maxUnits) {
      current += atom;
      continue;
    }
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
    if (atom.length <= maxUnits) {
      current = atom;
      continue;
    }
    // One atom longer than the limit: hard-split it (a single word/URL).
    for (let offset = 0; offset < atom.length; offset += maxUnits) {
      const piece = atom.slice(offset, offset + maxUnits);
      if (offset + maxUnits >= atom.length) {
        current = piece;
      } else {
        chunks.push(piece);
      }
    }
  }
  if (current !== '') {
    chunks.push(current);
  }
  return chunks;
}

function withPageNumbers(parts: readonly string[]): string[] {
  if (parts.length <= 1) {
    return [...parts];
  }
  return parts.map((part, index) => `${index + 1}/${parts.length}\n\n${part}`);
}

function withFooter(parts: readonly string[], maxUnits: number): string[] {
  if (parts.length === 0) {
    return [];
  }
  const result = [...parts];
  const last = result[result.length - 1] as string;
  if (last.length + FOOTER_BLOCK.length <= maxUnits) {
    result[result.length - 1] = `${last}${FOOTER_BLOCK}`;
    return result;
  }
  // The last chunk cannot hold the footer: re-chunk it under the smaller
  // budget so the footer always fits and nothing is truncated.
  const rechunked = chunkPostText(last, maxUnits - FOOTER_BLOCK.length);
  result.splice(result.length - 1, 1, ...rechunked);
  const finalLast = result[result.length - 1] as string;
  result[result.length - 1] = `${finalLast}${FOOTER_BLOCK}`;
  return result;
}

/**
 * Format one processed post into sendable parts. Media posts: the first
 * part is the caption (≤1024), the overflow continues as text parts
 * (AI-admin v2.19.1 pattern — never silently truncated). Every part is
 * ≤ its Telegram limit including page number and footer.
 */
export function formatInboundPost(input: {
  readonly text: string;
  readonly media: 'none' | 'photo' | 'video';
}): InboundPostPart[] {
  const normalized = normalizePersianText(input.text);
  // Multi-part posts carry an `i/N` page-number prefix (at most `NN/NN\n\n`
  // = 8 units); the body budget reserves it on every part so no part can
  // exceed its Telegram limit after the prefix is added.
  const PAGE_PREFIX_RESERVE = 8;
  if (input.media === 'none') {
    const body = chunkPostText(normalized, INBOUND_TEXT_LIMIT - PAGE_PREFIX_RESERVE);
    const withNumbers = withPageNumbers(body);
    const finished = withFooter(withNumbers, INBOUND_TEXT_LIMIT);
    return finished.map((text) => ({ kind: 'text' as const, text }));
  }
  // Room for the `i/N` page-number prefix on the caption part (at most
  // `NN/NN\n\n` = 8 units) so the caption never exceeds its 1024 limit.
  const captionChunks = chunkPostText(normalized, INBOUND_CAPTION_LIMIT - 8);
  const firstCaption = captionChunks[0] ?? '';
  const rest = normalized.slice(firstCaption.length).replace(/^\s+/, '');
  const overflow = rest === '' ? [] : chunkPostText(rest, INBOUND_TEXT_LIMIT - PAGE_PREFIX_RESERVE);
  const rawParts: InboundPostPart[] = [
    { kind: 'caption', text: firstCaption },
    ...overflow.map((text) => ({ kind: 'text' as const, text })),
  ];
  const numbered = withPageNumbers(rawParts.map((part) => part.text));
  // The footer budget belongs to the LAST part: the caption limit for a
  // single-part media post, the text limit otherwise.
  const lastLimit = numbered.length === 1 ? INBOUND_CAPTION_LIMIT : INBOUND_TEXT_LIMIT;
  const finished = withFooter(numbered, lastLimit);
  return finished.map((text, index) => ({
    kind: rawParts[index]?.kind ?? 'text',
    text,
  }));
}
