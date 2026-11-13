/**
 * Phase 7.3 — the media ASSET domain suite (the RED-adversarial pinning
 * of the reuse-resolution and retention-cleanup rules over the
 * blueprint-approved `media_assets` model).
 */

import { describe, expect, it } from 'vitest';

import {
  readMediaAssetRecordV1,
  resolveAssetReuse,
  selectExpiredAssets,
  type MediaAssetRecordV1,
} from '../../src/domain/media/media-usage';

function assetRow(overrides: Partial<MediaAssetRecordV1> = {}): MediaAssetRecordV1 {
  return {
    id: 'asset-1',
    type: 'photo',
    canonicalUrl: 'https://cdn.example.com/media/shot.jpg',
    sha256: 'hash-1',
    rightsStatus: 'official',
    status: 'uploaded',
    telegramFileId: 'AgAC-ledger-file-id',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('the strict asset-record reader (fail-closed)', () => {
  it('accepts a valid uploaded record and echoes it verbatim', () => {
    const outcome = readMediaAssetRecordV1(assetRow());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.record.telegramFileId).toBe('AgAC-ledger-file-id');
  });

  it('rejects wrong types/statuses/rights vocabularies and every over-bound field', () => {
    expect(readMediaAssetRecordV1(assetRow({ type: 'gif' as never }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
    expect(readMediaAssetRecordV1(assetRow({ status: 'flying' as never }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
    expect(readMediaAssetRecordV1(assetRow({ rightsStatus: 'scraped' as never }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
    expect(readMediaAssetRecordV1(assetRow({ telegramFileId: '' }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
    expect(readMediaAssetRecordV1(assetRow({ sha256: 'ключ' }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
    expect(readMediaAssetRecordV1({ ...assetRow(), extra: 1 } as unknown)).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
  });

  it('the durable rtp1 invariant: holding an R2 object ⇔ carrying a deadline', () => {
    expect(
      readMediaAssetRecordV1(assetRow({ r2Key: 'media/staging/1', expiresAt: 5000 })),
    ).toMatchObject({ ok: true });
    expect(readMediaAssetRecordV1(assetRow({ r2Key: 'media/staging/1' }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
    expect(readMediaAssetRecordV1(assetRow({ expiresAt: 5000 }))).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
  });

  it('an UPLOADED row without its telegram_file_id is malformed (the ledger value is structural)', () => {
    const row = assetRow();
    const { telegramFileId: _omitted, ...withoutFileId } = row;
    expect(readMediaAssetRecordV1(withoutFileId)).toMatchObject({
      ok: false,
      reason: 'asset_record_malformed',
    });
  });
});

describe('the reuse resolution (EXACT equality only — the economy rule)', () => {
  const assets = [
    assetRow({
      id: 'a',
      canonicalUrl: 'https://cdn.example.com/media/a.jpg',
      sha256: 'hash-A',
      telegramFileId: 'AgAC-A',
    }),
    assetRow({
      id: 'b',
      canonicalUrl: 'https://cdn.example.com/media/b.jpg',
      sha256: 'hash-B',
      telegramFileId: 'AgAC-B',
    }),
    // A STAGED (non-uploaded) row carries NO reusable file_id.
    assetRow({
      id: 'c',
      canonicalUrl: 'https://cdn.example.com/media/c.jpg',
      status: 'candidate',
      telegramFileId: undefined,
      r2Key: 'media/staging/c',
      expiresAt: 9000,
    }),
  ];

  it('an exact canonical-url hit against an UPLOADED asset reuses the stored file_id', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://cdn.example.com/media/a.jpg' }],
      assets,
    );
    expect(resolutions).toEqual([
      { item: 0, outcome: 'reuse', fileId: 'AgAC-A', matchedBy: 'canonical_url' },
    ]);
  });

  it('an exact sha256 hit reuses the stored file_id (same bytes, another URL)', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://mirror.example.net/media/b-copy.jpg', sha256: 'hash-B' }],
      assets,
    );
    expect(resolutions).toEqual([
      { item: 0, outcome: 'reuse', fileId: 'AgAC-B', matchedBy: 'sha256' },
    ]);
  });

  it('a staged (non-uploaded) row NEVER resolves as reuse — only uploaded assets carry file_ids', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://cdn.example.com/media/c.jpg' }],
      assets,
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('a near-miss URL is a STAGE outcome (similarity never establishes identity)', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://cdn.example.com/media/a.JPG' }],
      assets,
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('an item WITHOUT a hash never matches by hash (no invented identity)', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://other.example.com/x.jpg' }],
      assets,
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('the resolution is per-item and ordinal-stable', () => {
    const resolutions = resolveAssetReuse(
      [
        { canonicalUrl: 'https://cdn.example.com/media/a.jpg' },
        { canonicalUrl: 'https://cdn.example.com/media/d.jpg' },
        { canonicalUrl: 'https://mirror.example.net/media/b-copy.jpg', sha256: 'hash-B' },
      ],
      assets,
    );
    expect(resolutions.map((resolution) => resolution.outcome)).toEqual([
      'reuse',
      'stage',
      'reuse',
    ]);
    expect(resolutions.map((resolution) => resolution.item)).toEqual([0, 1, 2]);
  });
});

describe('the retention-cleanup selection (bounded, oldest-deadline-first)', () => {
  const NOW = 10_000;

  it('selects exactly the R2-holding rows past their deadline, oldest first; terminal rows never', () => {
    const rows = [
      assetRow({ id: 'b', r2Key: 'k-b', expiresAt: NOW + 1 }), // NOT yet expired
      assetRow({
        id: 'a',
        r2Key: 'k-a',
        expiresAt: NOW - 1,
        status: 'candidate',
        telegramFileId: undefined,
      }), // expired
      assetRow({
        id: 'c',
        r2Key: 'k-c',
        expiresAt: NOW - 2,
        status: 'failed',
        telegramFileId: undefined,
      }), // expired
      assetRow({ id: 'd', expiresAt: undefined }), // no R2 object: NEVER selected
      assetRow({ id: 'e', r2Key: undefined, expiresAt: undefined, status: 'uploaded' }), // cleared: NEVER selected
    ];
    const selected = selectExpiredAssets(rows, NOW, 10);
    expect(selected).toEqual(['c', 'a']);
  });

  it('the exactly-at-deadline row IS expired (the deterministic boundary)', () => {
    const selected = selectExpiredAssets(
      [assetRow({ id: 'x', r2Key: 'k', expiresAt: NOW })],
      NOW,
      10,
    );
    expect(selected).toEqual(['x']);
  });

  it('the selection is CAPPED (a bounded chunk — the cleanup resumes on the next call)', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      assetRow({
        id: `row-${index}`,
        r2Key: `k-${index}`,
        expiresAt: NOW - index,
        status: 'candidate',
        telegramFileId: undefined,
      }),
    );
    const selected = selectExpiredAssets(rows, NOW, 2);
    expect(selected).toEqual(['row-4', 'row-3']);
  });

  it('a zero or negative limit selects NOTHING (never an unbounded sweep)', () => {
    const rows = [
      assetRow({
        id: 'x',
        r2Key: 'k',
        expiresAt: NOW - 1,
        status: 'candidate',
        telegramFileId: undefined,
      }),
    ];
    expect(selectExpiredAssets(rows, NOW, 0)).toEqual([]);
  });
});
