/**
 * Phase 8.2 — the publication identity (pidek1): the versioned deterministic
 * idempotency key derivation and the per-message content hash.
 *
 * The key is the blueprint §7 identity («publication: idempotency_key
 * unique»): the UNIQUE constraint on the derived key is the enqueue-side
 * duplicate SUPPRESSION — a second enqueue for the same draft + destination
 * can never create a second publication row. The derivation is DETERMINISTIC
 * (the same inputs always yield the same key) and VERSIONED (the format tag
 * `pidek1` is INSIDE the hashed bytes, so a future format change is a new
 * derivation, never a silent meaning shift over old rows).
 *
 * `contentTextHash` records the SHA-256 of the EXACT sent text into
 * `publication_messages.text_hash` — the reconciliation identity anchor (the
 * blueprint's own column purpose) and the Phase 13.1 readiness evidence for
 * "what exactly was published".
 *
 * Workers-native Web Crypto subtle digest — no Node APIs, no new
 * dependencies (the fingerprintOfSerializedEnvelope house pattern). Both
 * functions are TOTAL: invalid inputs fail typed, never a weakened value.
 */

export const PUBLICATION_IDEMPOTENCY_VERSION = 'pidek1' as const;

const MAX_IDENTITY_FIELD_LENGTH = 256;
/** The serialized-envelope cap (the R1.19 house bound) applies to the hashed text. */
const MAX_TEXT_BYTES = 128 * 1024;

export type IdentityDerivation =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: 'invalid_input' };

export type ContentHashDerivation =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: 'invalid_input' };

function isValidIdentityField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_FIELD_LENGTH;
}

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  const hex: string[] = [];
  for (const byte of new Uint8Array(digest)) {
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Derive the publication idempotency key: sha256 over the tagged, delimited
 * serialization of (version, draftId, destination). The delimiter and tag
 * are inside the digest — the key cannot be forged by recombining field
 * values across rows.
 */
export async function derivePublicationIdempotencyKey(input: {
  readonly draftId: string;
  readonly destination: string;
}): Promise<IdentityDerivation> {
  if (!isValidIdentityField(input?.draftId) || !isValidIdentityField(input?.destination)) {
    return { ok: false, reason: 'invalid_input' };
  }
  const serialized = `${PUBLICATION_IDEMPOTENCY_VERSION}|draft=${input.draftId}|destination=${input.destination}`;
  const key = await sha256HexOfBytes(new TextEncoder().encode(serialized));
  return { ok: true, key };
}

/**
 * The per-message content hash: sha256 over the exact UTF-8 bytes of the
 * sent text. Byte-sensitive (no normalization, no trimming — text identity
 * is absolute, the R1.19 rule).
 */
export async function contentTextHash(text: string): Promise<ContentHashDerivation> {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TEXT_BYTES) {
    return { ok: false, reason: 'invalid_input' };
  }
  return { ok: true, hash: await sha256HexOfBytes(bytes) };
}
