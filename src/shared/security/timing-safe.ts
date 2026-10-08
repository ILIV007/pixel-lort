/**
 * Timing-safe string comparison for secret verification (Phase 2A).
 *
 * Strategy: both inputs are signed with the SAME freshly generated, random
 * HMAC-SHA256 key and only the resulting digests are compared byte-by-byte.
 *
 * Why HMAC instead of comparing raw strings:
 * - A naive loop over raw strings leaks information through early exit and
 *   through length-dependent timing. A direct plain-string comparison is
 *   NOT accepted for webhook secret verification.
 * - Signing with a per-comparison random key first normalizes lengths (the
 *   digest is always exactly 32 bytes) and decorrelates the comparison from
 *   the input bytes: an attacker who can measure the comparison sees only
 *   HMAC-derivations, never a usable prefix oracle.
 * - Equality of digests under the same key implies equality of inputs
 *   (collision-resistant hash), so the result is exact.
 *
 * The final digest comparison is a fixed 32-iteration XOR accumulate — the
 * iteration count is constant for every input pair.
 *
 * Runs on standard Web Crypto (`crypto.subtle`), available in Workers,
 * Node 19+, and the vitest/workerd test runtime. No Node-only API.
 */

const DIGEST_BYTE_LENGTH = 32; // HMAC-SHA256
const KEY_BYTE_LENGTH = 32;

export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // Fresh, non-extractable, sign-only key per comparison; the key itself
  // never leaves this function and cannot be re-used to forge digests.
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH));
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  if (bytesA.length !== DIGEST_BYTE_LENGTH || bytesB.length !== DIGEST_BYTE_LENGTH) {
    // Defensive: never reachable with SHA-256, but fail CLOSED on surprise.
    return false;
  }

  let diff = 0;
  for (let index = 0; index < DIGEST_BYTE_LENGTH; index += 1) {
    diff |= (bytesA[index] ?? 0) ^ (bytesB[index] ?? 0);
  }
  return diff === 0;
}
