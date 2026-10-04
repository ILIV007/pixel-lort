/**
 * Bounded stream reading (Phase 2A correction).
 *
 * One primitive shared by the Telegram webhook (request bodies) and the
 * Bot API client (response bodies): read a `ReadableStream<Uint8Array>` up
 * to a STRICT BYTE limit, cancelling the stream immediately once the limit
 * is crossed.
 *
 * Why bytes and not `await response.text()`:
 * - `text()` buffers the COMPLETE body before any length check can run —
 *   a hostile or broken peer can force unbounded allocation. This reader
 *   stops consuming after the first chunk that crosses `maxBytes`, so the
 *   total allocation stays bounded by `maxBytes` plus one chunk.
 * - `Content-Length` headers are checked EARLY when present (cheap
 *   rejection before the first byte) but are NEVER trusted as the only
 *   check — a declared length can lie, be absent (chunked/streaming), or
 *   be malformed.
 *
 * UTF-8 decoding is strict (fatal): malformed sequences produce a stable
 * failure instead of silent U+FFFD replacement, so a corrupted body can
 * never be parsed "successfully" with mangled content.
 *
 * Nothing in this module logs, echoes, or retains body content — the only
 * information surfaced to callers is the stable failure reason.
 */

export type BoundedReadFailureReason = 'too_large' | 'invalid_utf8' | 'stream_read_failed';

/** Stable failure type so callers can map to their own error boundaries. */
export class BoundedReadError extends Error {
  readonly reason: BoundedReadFailureReason;

  constructor(reason: BoundedReadFailureReason) {
    super(`bounded read failed: ${reason}`);
    this.name = 'BoundedReadError';
    this.reason = reason;
  }
}

/**
 * Parse a Content-Length header value.
 *
 * Results:
 * - `absent`    — header missing (streaming bodies; the byte limit still
 *                 applies to the actual read).
 * - `declared`  — digits-only, within `maxBytes` (still verified on read).
 * - `oversized` — digits-only but exceeding `maxBytes` (reject BEFORE any
 *                 read; values beyond Number range are oversized by
 *                 definition).
 * - `invalid`   — negative, non-integer, empty, or non-numeric content
 *                 (a hostile or broken sender; reject before any read).
 */
export type ContentLengthDeclaration =
  | { readonly kind: 'absent' }
  | { readonly kind: 'declared'; readonly bytes: number }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'invalid' };

export function parseContentLengthHeader(
  value: string | null,
  maxBytes: number,
): ContentLengthDeclaration {
  if (value === null) {
    return { kind: 'absent' };
  }
  // Strict decimal digits only: rejects signs, decimals, whitespace,
  // exponents, and empty strings (negative/non-integer/invalid).
  if (!/^[0-9]+$/.test(value)) {
    return { kind: 'invalid' };
  }
  const parsed = Number(value);
  if (parsed > maxBytes) {
    // Also covers values beyond the safe-integer range (never underestimated).
    return { kind: 'oversized' };
  }
  return { kind: 'declared', bytes: parsed };
}

/**
 * Read a byte stream up to `maxBytes` INCLUSIVE.
 *
 * - Throws `BoundedReadError('too_large')` when the total would exceed the
 *   limit; the reader is cancelled FIRST so no further chunk is consumed
 *   by anyone downstream.
 * - Throws `BoundedReadError('stream_read_failed')` when the stream errors
 *   mid-read (network truncation, broken pipe).
 * - A null body is a documented empty read (callers decide whether an
 *   empty body is acceptable for their protocol).
 */
export async function readStreamBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body === null) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // The stream errored before completion — release it and fail safely.
      await cancelQuietly(reader);
      throw new BoundedReadError('stream_read_failed');
    }
    if (chunk.done) {
      break;
    }
    const value = chunk.value;
    if (value === undefined) {
      continue;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // Stop immediately: cancel releases the stream and signals the
      // producer to stop; no further chunk is consumed after the overflow.
      await cancelQuietly(reader);
      throw new BoundedReadError('too_large');
    }
    chunks.push(value);
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Decode bytes as strict UTF-8; malformed sequences fail with a stable reason. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new BoundedReadError('invalid_utf8');
  }
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancelling a broken/already-closed stream may reject; that must not
    // mask the original failure reason.
  }
}
