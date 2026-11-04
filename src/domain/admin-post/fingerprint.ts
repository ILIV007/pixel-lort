/**
 * R1.20-R — stable content fingerprint for admin post versions.
 *
 * The fingerprint is the SHA-256 HEX digest of the CANONICAL serialized
 * rich-text envelope (the exact document `serializeRichTextEnvelope`
 * produces — the SAME bytes that are stored). Two properties matter for the
 * approval contract:
 *
 * - DETERMINISM: the same stored content always yields the same fingerprint,
 *   so a stored version's fingerprint can be RE-DERIVED at any later time to
 *   prove the stored bytes are intact (a mismatch means the stored document
 *   was corrupted or tampered with — always an explicit failure, never a
 *   silent pass).
 * - BINDING: approvals and publications pin the fingerprint of the EXACT
 *   version they were made against. The binding is enforced SERVER-SIDE
 *   through the durable preview-session row — a callback that omits the
 *   optional fingerprint field is still fully bound (session + stored version
 *   must agree), and a callback that carries a foreign fingerprint is
 *   rejected as tampered.
 *
 * Uses the Workers-native Web Crypto subtle digest (no Node APIs, no new
 * dependencies).
 */
import { serializeRichTextEnvelope, type RichTextEnvelope } from '../telegram/rich-text-envelope';

export function isHexDigest64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** SHA-256 hex of the canonical serialized envelope document. */
export async function fingerprintOfSerializedEnvelope(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex: string[] = [];
  for (const byte of new Uint8Array(digest)) {
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Serialize + fingerprint in one step. The `serialized` JSON is what callers
 * must STORE, guaranteeing fingerprint and stored bytes can never diverge.
 */
export async function serializeAndFingerprint(
  envelope: RichTextEnvelope,
): Promise<
  | { readonly ok: true; readonly json: string; readonly fingerprint: string }
  | { readonly ok: false }
> {
  const serialized = serializeRichTextEnvelope(envelope);
  if (!serialized.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    json: serialized.json,
    fingerprint: await fingerprintOfSerializedEnvelope(serialized.json),
  };
}

/** Random opaque id/token in the approved base64url callback-token shape. */
export function randomToken(): string {
  return crypto.randomUUID();
}
