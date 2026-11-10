/**
 * Phase 7.3 — the ALBUM CONTENT DOCUMENT suite (the "album media kind":
 * the ONLY legal construction path is the 7.2 plan + the resolved
 * file_ids; the caption rides ordinal 0 ONLY; the fingerprint covers the
 * WHOLE album).
 */

import { describe, expect, it } from 'vitest';

import { planAlbumMedia } from '../../src/domain/media/album-plan';
import {
  readMediaCandidateV1,
  type MediaCandidateV1,
} from '../../src/domain/media/media-candidate';
import {
  createAlbumContentDocument,
  readAlbumContentDocumentV1,
  serializeAlbumContentDocument,
} from '../../src/domain/media/album-content';
import { createRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';

function photo(overrides: Partial<Omit<MediaCandidateV1, 'schemaVersion'>> = {}): MediaCandidateV1 {
  const read = readMediaCandidateV1({
    schemaVersion: 1,
    kind: 'photo',
    role: 'gameplay',
    origin: 'official_api',
    officiality: 'official',
    relevance: 'supporting',
    freshness: 'recent',
    canonicalUrl: 'https://cdn.example.com/media/photo.jpg',
    previouslyUsed: false,
    ...overrides,
  });
  if (!read.ok) throw new Error('fixture candidate invalid');
  return read.candidate;
}

function captionEnvelope(text: string) {
  const outcome = createRichTextEnvelope({ kind: 'caption', text, entities: [] });
  if (!outcome.ok) throw new Error('fixture caption invalid');
  return outcome.envelope;
}

function albumPlan(count: number) {
  const outcome = planAlbumMedia({
    candidates: Array.from({ length: count }, (_, index) =>
      photo({ canonicalUrl: `https://cdn.example.com/media/p${index}.jpg` }),
    ),
  });
  if (!outcome.ok) throw new Error('fixture plan invalid');
  return outcome.plan;
}

describe('the ONLY legal construction path (plan + resolved file_ids)', () => {
  it('builds the document from a 3-item plan + per-ordinal file_ids, with the ordinal-0 caption', async () => {
    const outcome = await createAlbumContentDocument(
      albumPlan(3),
      ['AgAC-1', 'AgAC-2', 'AgAC-3'],
      captionEnvelope('تیتر آلبوم'),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.document.items.map((item) => item.fileId)).toEqual([
      'AgAC-1',
      'AgAC-2',
      'AgAC-3',
    ]);
    expect(outcome.document.caption?.kind).toBe('caption');
    expect(outcome.document.items.every((item) => !('caption' in item))).toBe(true);
    expect(outcome.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a caption-less album is a valid distinct case (the caption field stays ABSENT)', async () => {
    const outcome = await createAlbumContentDocument(albumPlan(2), ['AgAC-1', 'AgAC-2']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.document.caption).toBeUndefined();
    const roundTrip = await readAlbumContentDocumentV1(JSON.parse(outcome.serialized));
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) expect(roundTrip.document.caption).toBeUndefined();
  });

  it('a fileIds array whose length mismatches the plan fails typed (album_file_ids_mismatched)', async () => {
    expect(await createAlbumContentDocument(albumPlan(3), ['AgAC-1', 'AgAC-2'])).toMatchObject({
      ok: false,
      reason: 'album_file_ids_mismatched',
    });
  });

  it('a hand-built list outside the plan discipline has NO entry point (album_plan_required)', async () => {
    expect(
      await createAlbumContentDocument({ ...albumPlan(3), planningVersion: 'forged' } as never, [
        'AgAC-1',
        'AgAC-2',
        'AgAC-3',
      ]),
    ).toMatchObject({ ok: false, reason: 'album_plan_required' });
    expect(await createAlbumContentDocument(null as never, ['AgAC-1', 'AgAC-2'])).toMatchObject({
      ok: false,
      reason: 'album_plan_required',
    });
  });

  it('the 2..10 bounds are enforced at construction (1 item and 11 items fail typed)', async () => {
    expect(await createAlbumContentDocument(albumPlan(1), ['AgAC-1'])).toMatchObject({
      ok: false,
      reason: 'album_items_out_of_bounds',
    });
    expect(
      await createAlbumContentDocument(
        albumPlan(10),
        Array.from({ length: 10 }, (_, i) => `AgAC-${i}`),
      ),
    ).toMatchObject({ ok: true });
  });

  it('an invalid fileId (empty, non-printable, over 256 units) fails typed', async () => {
    expect(await createAlbumContentDocument(albumPlan(2), ['', 'AgAC-2'])).toMatchObject({
      ok: false,
      reason: 'album_file_id_invalid',
    });
    expect(await createAlbumContentDocument(albumPlan(2), ['bad\nid', 'AgAC-2'])).toMatchObject({
      ok: false,
      reason: 'album_file_id_invalid',
    });
    expect(
      await createAlbumContentDocument(albumPlan(2), ['a'.repeat(257), 'AgAC-2']),
    ).toMatchObject({
      ok: false,
      reason: 'album_file_id_invalid',
    });
  });
});

describe('the strict reader (a stored lie is malformed — never guessed)', () => {
  it('round-trips through serialize → read with the SAME fingerprint (determinism)', async () => {
    const created = await createAlbumContentDocument(
      albumPlan(3),
      ['AgAC-1', 'AgAC-2', 'AgAC-3'],
      captionEnvelope('کپشن'),
    );
    if (!created.ok) return expect.unreachable();
    const roundTrip = await readAlbumContentDocumentV1(JSON.parse(created.serialized));
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.fingerprint).toBe(created.fingerprint);
    expect(serializeAlbumContentDocument(roundTrip.document)).toBe(created.serialized);
  });

  it('a wrong schemaVersion is version-unsupported; an absent one is malformed', async () => {
    const created = await createAlbumContentDocument(albumPlan(2), ['AgAC-1', 'AgAC-2']);
    if (!created.ok) return expect.unreachable();
    const parsed = JSON.parse(created.serialized) as Record<string, unknown>;
    expect(await readAlbumContentDocumentV1({ ...parsed, schemaVersion: 2 })).toMatchObject({
      ok: false,
      reason: 'album_read_version_unsupported',
    });
    const { schemaVersion: _omitted, ...withoutVersion } = parsed;
    expect(await readAlbumContentDocumentV1(withoutVersion)).toMatchObject({
      ok: false,
      reason: 'album_read_malformed',
    });
  });

  it('a caption-kind item list lie (3 items in a claimed 2-item album, extra keys, wrong media) is malformed', async () => {
    const created = await createAlbumContentDocument(albumPlan(2), ['AgAC-1', 'AgAC-2']);
    if (!created.ok) return expect.unreachable();
    const parsed = JSON.parse(created.serialized) as Record<string, unknown>;
    expect(await readAlbumContentDocumentV1({ ...parsed, extra: true })).toMatchObject({
      ok: false,
      reason: 'album_read_malformed',
    });
    expect(await readAlbumContentDocumentV1({ ...parsed, media: 'photo' })).toMatchObject({
      ok: false,
      reason: 'album_read_malformed',
    });
    const itemLie = {
      ...(parsed['items'] as readonly Record<string, unknown>[])[0]!,
      kind: 'audio',
    };
    expect(
      await readAlbumContentDocumentV1({
        ...parsed,
        items: [itemLie, (parsed['items'] as readonly unknown[])[1]],
      }),
    ).toMatchObject({ ok: false, reason: 'album_read_malformed' });
  });

  it('a text-kind caption smuggled into the album fails typed (the caption kind is structural)', async () => {
    const textEnvelope = createRichTextEnvelope({
      kind: 'text',
      text: 'not a caption',
      entities: [],
    });
    expect(textEnvelope.ok).toBe(true);
    if (!textEnvelope.ok) return;
    expect(
      await createAlbumContentDocument(albumPlan(2), ['AgAC-1', 'AgAC-2'], textEnvelope.envelope),
    ).toMatchObject({ ok: false, reason: 'album_caption_kind_invalid' });
  });
});

describe('the fingerprint covers the WHOLE album (any change = a different fingerprint)', () => {
  it('a changed fileId / caption / item order changes the fingerprint', async () => {
    const base = await createAlbumContentDocument(
      albumPlan(2),
      ['AgAC-1', 'AgAC-2'],
      captionEnvelope('کپشن'),
    );
    const changedFile = await createAlbumContentDocument(
      albumPlan(2),
      ['AgAC-1', 'AgAC-X'],
      captionEnvelope('کپشن'),
    );
    const changedCaption = await createAlbumContentDocument(
      albumPlan(2),
      ['AgAC-1', 'AgAC-2'],
      captionEnvelope('کپشن ۲'),
    );
    if (!base.ok || !changedFile.ok || !changedCaption.ok) return expect.unreachable();
    expect(base.fingerprint).not.toBe(changedFile.fingerprint);
    expect(base.fingerprint).not.toBe(changedCaption.fingerprint);
  });
});
