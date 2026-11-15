/**
 * Phase V4-carry — the ALBUM SEND PLAN suite (the outbox wiring's pure
 * derivation, ADR-0060): the ONLY legal path from a durable album content
 * document + destination to the media-group wire plan.
 *
 * Pinned here:
 *  - the wire items ride the document's file_ids IN ORDINAL ORDER and the
 *    caption rides ordinal 0 ONLY (the no-separation layer, extended);
 *  - the attachments array is ALWAYS empty at publication-send time — the
 *    fresh-bytes contract (MediaGroupAttachmentV1) exists for the UPLOAD
 *    path; a send-time album travels file_id-only, never re-fetched;
 *  - the versioned send identity ('album-send:v1') is the SAME derivation
 *    the upload path pins (one shared function — byte-identical);
 *  - every malformed / out-of-bound / non-album input fails TYPED — a text
 *    draft or a broken document can never be guessed into a send plan;
 *  - the discriminator is TOTAL: parse failure / oversize / non-album
 *    route BACK to the text path (prior-phase behavior unchanged).
 */

import { describe, expect, it } from 'vitest';

import { ALBUM_CONTENT_LIMITS } from '../../src/domain/media/album-content';
import {
  deriveAlbumSendIdentityKey,
  deriveAlbumSendPlan,
  discriminateAlbumDocument,
} from '../../src/domain/media/album-send-plan';

const DESTINATION = '@pixel_lores';

function albumDocumentJson(options: {
  items?: readonly { kind: 'photo' | 'video'; fileId: string; canonicalUrl: string }[];
  caption?: { schemaVersion: 1; kind: 'caption'; text: string; entities: readonly unknown[] };
  schemaVersion?: number;
  extraKey?: string;
}): string {
  const body: Record<string, unknown> = {
    schemaVersion: options.schemaVersion ?? 1,
    media: 'album',
    items: options.items ?? [
      { kind: 'photo', fileId: 'file-photo-1', canonicalUrl: 'https://media.example/img/1.jpg' },
      { kind: 'photo', fileId: 'file-photo-2', canonicalUrl: 'https://media.example/img/2.jpg' },
    ],
  };
  if (options.caption !== undefined) body['caption'] = options.caption;
  if (options.extraKey !== undefined) body[options.extraKey] = 'x';
  return JSON.stringify(body);
}

const CAPTION = {
  schemaVersion: 1 as const,
  kind: 'caption' as const,
  text: 'کپشن آلبوم خبری',
  entities: [],
};

describe('album-send-plan: the legal derivation', () => {
  it('a valid two-item document derives the file_id-only wire plan with an empty attachments array', async () => {
    const outcome = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({}),
      destination: DESTINATION,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.planVersion).toBe('alsp1');
    expect(outcome.plan.destination).toBe(DESTINATION);
    expect(outcome.plan.items).toHaveLength(2);
    expect(outcome.plan.items[0]).toEqual({
      ordinal: 0,
      type: 'photo',
      media: 'file-photo-1',
      canonicalUrl: 'https://media.example/img/1.jpg',
    });
    expect(outcome.plan.items[1]).toEqual({
      ordinal: 1,
      type: 'photo',
      media: 'file-photo-2',
      canonicalUrl: 'https://media.example/img/2.jpg',
    });
    expect(outcome.plan.caption).toBeUndefined();
    expect(outcome.plan.attachments).toHaveLength(0);
    expect(outcome.plan.sendIdentityKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the caption rides ordinal 0 ONLY and its entities are carried verbatim', async () => {
    const outcome = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({ caption: CAPTION }),
      destination: DESTINATION,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.caption).toEqual({ text: CAPTION.text, entities: [] });
    // One plan, one caption: there is no per-item caption anywhere.
    const captionedItems = outcome.plan.items.filter(
      (item) => (item as unknown as { caption?: unknown }).caption !== undefined,
    );
    expect(captionedItems).toHaveLength(0);
  });

  it('the derivation is deterministic — JSON-equal plans and the same identity key', async () => {
    const input = {
      documentJson: albumDocumentJson({ caption: CAPTION }),
      destination: DESTINATION,
    };
    const first = await deriveAlbumSendPlan(input);
    const second = await deriveAlbumSendPlan(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
    expect(first.plan.sendIdentityKey).toBe(second.plan.sendIdentityKey);
  });

  it('a three-item mixed-kind album keeps the document ordinal order', async () => {
    const outcome = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({
        items: [
          { kind: 'video', fileId: 'file-video-1', canonicalUrl: 'https://media.example/v/1' },
          { kind: 'photo', fileId: 'file-photo-1', canonicalUrl: 'https://media.example/i/1' },
          { kind: 'photo', fileId: 'file-photo-2', canonicalUrl: 'https://media.example/i/2' },
        ],
      }),
      destination: DESTINATION,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items.map((item) => item.media)).toEqual([
      'file-video-1',
      'file-photo-1',
      'file-photo-2',
    ]);
    expect(outcome.plan.items.map((item) => item.type)).toEqual(['video', 'photo', 'photo']);
  });
});

describe('album-send-plan: the send identity is the shared versioned derivation', () => {
  it('the identity key is the 64-hex sha256 and reacts to every identity input', async () => {
    const items = [
      { kind: 'photo', canonicalUrl: 'https://media.example/i/1' },
      { kind: 'photo', canonicalUrl: 'https://media.example/i/2' },
    ] as const;
    const base = await deriveAlbumSendIdentityKey({ destination: DESTINATION, items: [...items] });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(base.key).toMatch(/^[0-9a-f]{64}$/);

    const otherDestination = await deriveAlbumSendIdentityKey({
      destination: '@other_channel',
      items: [...items],
    });
    const otherUrl = await deriveAlbumSendIdentityKey({
      destination: DESTINATION,
      items: [items[0], { kind: 'photo', canonicalUrl: 'https://media.example/i/CHANGED' }],
    });
    const otherCaption = await deriveAlbumSendIdentityKey({
      destination: DESTINATION,
      items: [...items],
      captionText: 'متن کپشن',
    });
    expect(otherDestination.ok && otherUrl.ok && otherCaption.ok).toBe(true);
    if (!otherDestination.ok || !otherUrl.ok || !otherCaption.ok) return;
    expect(otherDestination.key).not.toBe(base.key);
    expect(otherUrl.key).not.toBe(base.key);
    expect(otherCaption.key).not.toBe(base.key);
  });

  it('the identity derivation fails typed on invalid inputs (destination, bounds, kinds)', async () => {
    const two = [
      { kind: 'photo', canonicalUrl: 'https://media.example/i/1' },
      { kind: 'photo', canonicalUrl: 'https://media.example/i/2' },
    ];
    expect((await deriveAlbumSendIdentityKey({ destination: '', items: two })).ok).toBe(false);
    expect(
      (await deriveAlbumSendIdentityKey({ destination: 'x'.repeat(257), items: two })).ok,
    ).toBe(false);
    expect(
      (await deriveAlbumSendIdentityKey({ destination: 'bad\u0000dest', items: two })).ok,
    ).toBe(false);
    expect(
      (
        await deriveAlbumSendIdentityKey({
          destination: DESTINATION,
          items: [two[0]!],
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await deriveAlbumSendIdentityKey({
          destination: DESTINATION,
          items: [{ kind: 'sticker', canonicalUrl: 'https://media.example/i/1' }, two[0]!],
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await deriveAlbumSendIdentityKey({
          destination: DESTINATION,
          items: [{ kind: 'photo', canonicalUrl: '' }, two[0]!],
        })
      ).ok,
    ).toBe(false);
  });
});

describe('album-send-plan: the typed refusals (fail-closed)', () => {
  it('a malformed JSON document fails document_parse_failed', async () => {
    const outcome = await deriveAlbumSendPlan({
      documentJson: '{"schemaVersion": 1, "media": "album", "items": [',
      destination: DESTINATION,
    });
    expect(outcome).toEqual({ ok: false, reason: 'document_parse_failed' });
  });

  it('a text-shaped document is NOT an album — not_album_document (the text path owns it)', async () => {
    const textDocument = JSON.stringify({
      schemaVersion: 1,
      headlineFa: 'تیتر',
      summaryFa: 'خلاصه',
      modelClaims: [],
    });
    const outcome = await deriveAlbumSendPlan({
      documentJson: textDocument,
      destination: DESTINATION,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_album_document' });
  });

  it('an over-cap document fails document_too_large BEFORE any parse', async () => {
    const oversized = 'x'.repeat(ALBUM_CONTENT_LIMITS.maxSerializedBytes * 2);
    const outcome = await deriveAlbumSendPlan({
      documentJson: oversized,
      destination: DESTINATION,
    });
    expect(outcome).toEqual({ ok: false, reason: 'document_too_large' });
  });

  it('the strict reader refusals are carried verbatim', async () => {
    const oneItem = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({
        items: [{ kind: 'photo', fileId: 'f1', canonicalUrl: 'https://media.example/i/1' }],
      }),
      destination: DESTINATION,
    });
    expect(oneItem).toEqual({ ok: false, reason: 'album_items_out_of_bounds' });

    const badFileId = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({
        items: [
          {
            kind: 'photo',
            fileId: 'bad file id with spaces and\nnewline',
            canonicalUrl: 'https://media.example/i/1',
          },
          { kind: 'photo', fileId: 'f2', canonicalUrl: 'https://media.example/i/2' },
        ],
      }),
      destination: DESTINATION,
    });
    expect(badFileId).toEqual({ ok: false, reason: 'album_file_id_invalid' });

    const wrongVersion = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({ schemaVersion: 2 }),
      destination: DESTINATION,
    });
    expect(wrongVersion).toEqual({ ok: false, reason: 'album_read_version_unsupported' });

    const extraKey = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({ extraKey: 'surprise' }),
      destination: DESTINATION,
    });
    expect(extraKey).toEqual({ ok: false, reason: 'album_read_malformed' });

    const textKindCaption = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({
        caption: { schemaVersion: 1, kind: 'text', text: 'متن', entities: [] } as unknown as {
          schemaVersion: 1;
          kind: 'caption';
          text: string;
          entities: readonly unknown[];
        },
      }),
      destination: DESTINATION,
    });
    expect(textKindCaption).toEqual({ ok: false, reason: 'album_caption_kind_invalid' });
  });

  it('an invalid destination fails invalid_input', async () => {
    for (const destination of ['', 'x'.repeat(257), 'bad\u0001dest']) {
      const outcome = await deriveAlbumSendPlan({
        documentJson: albumDocumentJson({}),
        destination,
      });
      expect(outcome).toEqual({ ok: false, reason: 'invalid_input' });
    }
    const nonString = await deriveAlbumSendPlan({
      documentJson: albumDocumentJson({}),
      destination: 42 as unknown as string,
    });
    expect(nonString).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('album-send-plan: the TOTAL document discriminator', () => {
  it('an album document discriminates album; a text document routes back to the text path', async () => {
    expect(discriminateAlbumDocument(albumDocumentJson({}))).toBe('album');
    expect(
      discriminateAlbumDocument(
        JSON.stringify({ schemaVersion: 1, headlineFa: 'تیتر', summaryFa: 'خ', modelClaims: [] }),
      ),
    ).toBe('not_album');
    expect(discriminateAlbumDocument('{"broken":')).toBe('parse_failed');
    expect(discriminateAlbumDocument('x'.repeat(ALBUM_CONTENT_LIMITS.maxSerializedBytes * 2))).toBe(
      'too_large',
    );
  });
});
