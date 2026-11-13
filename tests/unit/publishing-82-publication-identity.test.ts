import { describe, expect, it } from 'vitest';
import {
  PUBLICATION_IDEMPOTENCY_VERSION,
  contentTextHash,
  derivePublicationIdempotencyKey,
} from '../../src/domain/publishing/publication-identity';

/**
 * Phase 8.2 — the publication identity (pidek1): the versioned deterministic
 * idempotency key derivation and the per-message content hash.
 *
 * The key is the blueprint §7 identity: `publication: idempotency_key`
 * UNIQUE. The derivation must be DETERMINISTIC (the same draft + destination
 * always derive the same key — a duplicate enqueue can never create a second
 * publication row) and VERSIONED (the derivation format carries its own tag,
 * so a future format change is a new derivation, never a silent meaning
 * shift). The per-message content hash records the EXACT sent bytes' digest
 * into `publication_messages.text_hash` (the reconciliation identity anchor).
 *
 * Both derivations use the Workers-native Web Crypto subtle digest — no Node
 * APIs, no new dependencies (the fingerprintOfSerializedEnvelope house
 * pattern).
 */

async function sha256HexOf(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('publishing-82 publication identity: the policy tag', () => {
  it('exposes the derivation version', () => {
    expect(PUBLICATION_IDEMPOTENCY_VERSION).toBe('pidek1');
  });
});

describe('publishing-82 publication identity: the idempotency key', () => {
  it('is deterministic for the same draft + destination', async () => {
    const first = await derivePublicationIdempotencyKey({
      draftId: 'draft-1',
      destination: '@pixel_lores',
    });
    const second = await derivePublicationIdempotencyKey({
      draftId: 'draft-1',
      destination: '@pixel_lores',
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.key).toBe(second.key);
    }
  });

  it('differs per draft and per destination', async () => {
    const base = await derivePublicationIdempotencyKey({
      draftId: 'draft-1',
      destination: '@pixel_lores',
    });
    const otherDraft = await derivePublicationIdempotencyKey({
      draftId: 'draft-2',
      destination: '@pixel_lores',
    });
    const otherDestination = await derivePublicationIdempotencyKey({
      draftId: 'draft-1',
      destination: '@other_channel',
    });
    if (!base.ok || !otherDraft.ok || !otherDestination.ok) {
      throw new Error('fixture derivations must succeed');
    }
    expect(base.key).not.toBe(otherDraft.key);
    expect(base.key).not.toBe(otherDestination.key);
  });

  it('pins the exact serialization format: sha256 of "pidek1|draft=<draftId>|destination=<destination>"', async () => {
    const outcome = await derivePublicationIdempotencyKey({
      draftId: 'draft-42',
      destination: '-1001234567890',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const expected = await sha256HexOf('pidek1|draft=draft-42|destination=-1001234567890');
      expect(outcome.key).toBe(expected);
      expect(/^[0-9a-f]{64}$/.test(outcome.key)).toBe(true);
    }
  });

  it('invalid inputs fail typed — never a silently weakened key', async () => {
    expect(
      await derivePublicationIdempotencyKey({ draftId: '', destination: '@pixel_lores' }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await derivePublicationIdempotencyKey({ draftId: 'draft-1', destination: '' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(
      await derivePublicationIdempotencyKey({
        draftId: 'x'.repeat(257),
        destination: '@pixel_lores',
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      await derivePublicationIdempotencyKey({ draftId: 'draft-1', destination: 'x'.repeat(257) }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      await derivePublicationIdempotencyKey({
        draftId: undefined as unknown as string,
        destination: '@pixel_lores',
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('publishing-82 publication identity: the per-message content hash', () => {
  it('pins sha256 over the exact UTF-8 bytes of the sent text', async () => {
    const text = 'تیتر خبر\n\nخلاصه';
    const outcome = await contentTextHash(text);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.hash).toBe(await sha256HexOf(text));
      expect(/^[0-9a-f]{64}$/.test(outcome.hash)).toBe(true);
    }
  });

  it('is deterministic and byte-sensitive (different bytes -> different hash)', async () => {
    const first = await contentTextHash('same');
    const second = await contentTextHash('same');
    const third = await contentTextHash('same ');
    if (!first.ok || !second.ok || !third.ok) throw new Error('fixture hashes must succeed');
    expect(first.hash).toBe(second.hash);
    expect(first.hash).not.toBe(third.hash);
  });

  it('invalid inputs fail typed', async () => {
    expect(await contentTextHash('')).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await contentTextHash('x'.repeat(128 * 1024 + 1))).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(await contentTextHash(42 as unknown as string)).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });
});
