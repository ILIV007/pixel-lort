/**
 * R1.10.3.1 DESIGN LAB — shared URL-expansion regression fixtures.
 *
 * The manager's counterexample shape: RSS items whose HTTPS paths contain
 * 5000 CJK characters. The accepted normalizer percent-encodes every
 * non-ASCII path byte (3 UTF-8 bytes → %XX%XX%XX = 9 URL bytes/char) and
 * enforces NO canonical-URL length cap, so the unchanged 2 MiB RSS feed
 * limit admits canonical URLs of
 *   'https://' (8) + 14-char host + '/' + 5000×9 = 45,023 bytes.
 *
 * Each item's path stays DISTINCT (one varying hiragana codepoint at the
 * end, still exactly 3 UTF-8 bytes) so the targeted conflict clause
 * `ON CONFLICT (source_id, canonical_url) DO NOTHING` cannot absorb rows
 * in these fixtures.
 */

/** 14-char host → canonical URL of a 5000-char CJK path is EXACTLY 45,023 bytes. */
export const CJK_HOST = 'example-source';
export const CJK_CANONICAL_URL_BYTES = 45_023;

/**
 * Deterministic percent-encoded CJK path: (cjkChars − 1) filler chars plus
 * one per-item CJK ideograph (U+4E00 + index, kept inside the 3-byte UTF-8
 * ideograph block so every char percent-encodes to exactly 9 URL bytes and
 * stays distinct for ≤ 500 items).
 */
export function cjkCanonicalUrl(cjkChars: number, index: number): string {
  const filler = 'あ'.repeat(Math.max(0, cjkChars - 1));
  const last = String.fromCharCode(0x4e00 + (index % 500));
  const rawPath = `${filler}${last}`;
  const encoded = [...rawPath].map((c) => encodeURIComponent(c)).join('');
  return `https://${CJK_HOST}/${encoded}`;
}

/** The raw (non-encoded) form, as it would appear inside the RSS XML. */
export function cjkRawLink(cjkChars: number, index: number): string {
  const filler = 'あ'.repeat(Math.max(0, cjkChars - 1));
  const last = String.fromCharCode(0x4e00 + (index % 500));
  return `https://${CJK_HOST}/${filler}${last}`;
}
