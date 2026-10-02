/**
 * Deterministic idempotency-key helpers (interface only in Phase 0).
 *
 * Blueprint §1.3: every externally visible action needs a unique idempotency
 * key. Keys must be derivable from stable business inputs — never random.
 * Business idempotency logic (claim queries, publication keys) arrives with
 * its own phase; this module only provides the deterministic formatting and
 * hashing primitives.
 */

/** Unit-separator used to join parts, preventing ["a:b"] vs ["a","b"] collisions. */
const PART_SEPARATOR = '\u001f';

/** Uppercases scope separators are forbidden; scopes are normalized to [a-z0-9._-]. */
export function sanitizeScope(scope: string): string {
  return scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}

/** Normalize an individual key part: trimmed, lowercased, inner spaces collapsed. */
export function normalizeKeyPart(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** SHA-256 of the input, hex-encoded. Uses Web Crypto (Workers-compatible). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Build a deterministic idempotency key: `<scope>:<sha256(canonical parts)>`.
 * Same inputs always produce the same key; different inputs never collide in
 * practice because parts are separated by a unit separator before hashing.
 */
export async function formatIdempotencyKey(
  scope: string,
  parts: readonly string[],
): Promise<string> {
  const canonical = parts.map(normalizeKeyPart).join(PART_SEPARATOR);
  const hash = await sha256Hex(canonical);
  return `${sanitizeScope(scope)}:${hash}`;
}
