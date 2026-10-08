import { describe, expect, it } from 'vitest';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from '../../src/shared/http/bounded-reader';

/**
 * Bounded stream reader tests (Phase 2A correction, ADR-0028).
 * The reader must bound ACTUAL BYTES (never trust Content-Length), stop and
 * cancel immediately after the cap is crossed, and fail safely on malformed
 * UTF-8 — without ever retaining or echoing body content.
 */

const MAX = 64;

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

function bytes(...parts: readonly (number | string)[]): Uint8Array {
  const encoded = parts.map((p) =>
    typeof p === 'string' ? new TextEncoder().encode(p) : new Uint8Array([p]),
  );
  const total = encoded.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('parseContentLengthHeader', () => {
  it('accepts an absent header', () => {
    expect(parseContentLengthHeader(null, MAX)).toEqual({ kind: 'absent' });
  });

  it('accepts a declared length within the cap', () => {
    expect(parseContentLengthHeader('10', MAX)).toEqual({ kind: 'declared', bytes: 10 });
    expect(parseContentLengthHeader('0', MAX)).toEqual({ kind: 'declared', bytes: 0 });
    expect(parseContentLengthHeader('64', MAX)).toEqual({ kind: 'declared', bytes: 64 });
  });

  it('rejects an oversized declared length before any read', () => {
    expect(parseContentLengthHeader('65', MAX)).toEqual({ kind: 'oversized' });
    // Beyond the safe-integer range: still oversized (never underestimated).
    expect(parseContentLengthHeader('99999999999999999999', MAX)).toEqual({ kind: 'oversized' });
  });

  it('rejects invalid, negative, non-integer, and non-numeric values', () => {
    for (const invalid of ['abc', '-1', '1.5', '', ' 5', '5 ', '+5', '0x10', '1e3', 'NaN']) {
      expect(parseContentLengthHeader(invalid, MAX)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('readStreamBounded', () => {
  it('reads a body at the exact limit', async () => {
    const body = byteStream([bytes('a'.repeat(MAX / 2)), bytes('b'.repeat(MAX / 2))]);
    const result = await readStreamBounded(body, MAX);
    expect(result.byteLength).toBe(MAX);
  });

  it('reads an empty and a null body', async () => {
    const empty = await readStreamBounded(byteStream([]), MAX);
    expect(empty.byteLength).toBe(0);
    const nullBody = await readStreamBounded(null, MAX);
    expect(nullBody.byteLength).toBe(0);
  });

  it('rejects a body one byte over the limit (limit+1)', async () => {
    const body = byteStream([bytes('x'.repeat(MAX)), bytes('y')]);
    await expect(readStreamBounded(body, MAX)).rejects.toMatchObject({
      name: 'BoundedReadError',
      reason: 'too_large',
    });
  });

  it('rejects a single chunk already over the limit', async () => {
    const body = byteStream([bytes('x'.repeat(MAX + 1))]);
    await expect(readStreamBounded(body, MAX)).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('bounds actual bytes for multibyte UTF-8 content (not characters)', async () => {
    // 'سلام' is 4 characters but 8 UTF-8 bytes.
    const persian = bytes('سلام');
    expect(persian.byteLength).toBe(8);
    const body = byteStream([persian, persian, persian, persian, persian]);
    // 40 bytes > a byte cap of 8, even though only 20 characters.
    await expect(readStreamBounded(body, 8)).rejects.toMatchObject({ reason: 'too_large' });
    const exact = await readStreamBounded(byteStream([persian]), 8);
    expect(exact.byteLength).toBe(8);
  });

  it('cancels the reader and consumes no further chunks after overflow', async () => {
    let pulls = 0;
    let cancelCalls = 0;
    const lateChunk = bytes('LATE-CONTENT-AFTER-OVERFLOW');
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(bytes('x'.repeat(MAX + 1)));
        } else {
          // Must NEVER be consumed after the overflow chunk.
          controller.enqueue(lateChunk);
        }
      },
      cancel() {
        cancelCalls += 1;
      },
    });

    await expect(readStreamBounded(stream, MAX)).rejects.toMatchObject({ reason: 'too_large' });
    expect(cancelCalls).toBe(1);
    const pullsAtFailure = pulls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No further pulls after cancellation.
    expect(pulls).toBe(pullsAtFailure);
  });

  it('maps a mid-stream read failure to a stable reason', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('simulated transport failure'));
      },
    });
    await expect(readStreamBounded(stream, MAX)).rejects.toMatchObject({
      reason: 'stream_read_failed',
    });
  });
});

describe('decodeUtf8Strict', () => {
  it('decodes valid UTF-8 including Persian and emoji', () => {
    expect(decodeUtf8Strict(bytes('سلام دنیا 🎮'))).toBe('سلام دنیا 🎮');
  });

  it('rejects malformed UTF-8 instead of silent replacement', () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(BoundedReadError);
    expect(() => decodeUtf8Strict(new Uint8Array([0xff, 0xfe]))).toThrow(BoundedReadError);
    // Truncated multibyte sequence.
    expect(() => decodeUtf8Strict(new Uint8Array([0xd8]))).toThrow(BoundedReadError);
  });

  it('preserves valid boundary byte patterns', () => {
    // U+0633 'س' = 0xD8 0xB3 — split across chunks must still decode when
    // assembled by the reader (byte-accurate concatenation).
    const assembled = new Uint8Array([0xd8, 0xb3]);
    expect(decodeUtf8Strict(assembled)).toBe('س');
  });
});

describe('body content never leaks through error objects', () => {
  it('carries only stable reasons (no chunk content) in failures', async () => {
    const SECRET = 'BODY-CANARY-مخفی';
    const error = await readStreamBounded(byteStream([bytes(SECRET.repeat(10))]), MAX).catch(
      (e: unknown) => e as BoundedReadError,
    );
    expect(error).toBeInstanceOf(BoundedReadError);
    expect(JSON.stringify(error)).not.toContain('BODY-CANARY');
    expect(JSON.stringify(error)).not.toContain('مخفی');
  });
});
