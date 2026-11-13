import { describe, expect, it } from 'vitest';
import {
  evaluateAlbumDeliveryEvidence,
  type AlbumDeliveryMessageViewV1,
} from '../../src/domain/media/album-send-plan';
import {
  isPublishableRightsStatus,
  PUBLICATION_MEDIA_RIGHTS_V1,
  resolveAssetReuse,
  type MediaAssetRecordV1,
} from '../../src/domain/media/media-usage';
import {
  uploadAlbumMediaGroup,
  type AlbumUploadOutcome,
  type MediaUploadPorts,
} from '../../src/application/media/upload-service';
import type { RichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';
import { decideMediaRights } from '../../src/domain/media/media-rights';
import type {
  MediaGroupSendInputV1,
  MediaGroupSendResultV1,
} from '../../src/domain/media/media-ports';
import { cryptoIdGenerator } from '../../src/shared/ids/id';

/**
 * THE INDEPENDENT REVIEW (PIXEL_REVIEW_d65d811_FA.md) RED-FIRST FIX ROUND —
 * the four P1 flaws re-claimed as SAFE behavior tests. These suites were
 * written BEFORE the fix and failed on the unfixed d65d811 tree (real RED);
 * they pin the FIXED behavior:
 *
 *  F1 — a send whose lease expires mid-flight can never be re-sent by a
 *       concurrent generation (the durable send-started state; the reclaim
 *       only touches rows PROVABLY before the send; the unknown outcome
 *       parks for human reconciliation, never auto-resends).
 *  F2 — an album's delivery proof is complete ONLY when EVERY ordinal is
 *       recorded to the configured destination AND the media usages are
 *       bound; a partial proof NEVER heals to published and NEVER re-sends.
 *  F3 — the send-time gate re-checks the durable rights echo: blocked and
 *       unknown never pass; the reuse predicate accepts ONLY the
 *       affirmative clearances (official / licensed / attribution_required).
 *  F4 — the album caption is validated by the REAL rich-text envelope
 *       reader (UTF-16 entity ranges included) BEFORE any rights, fetch,
 *       staging or channel effect — a malformed caption can never reach a
 *       transport call.
 */

// ---------------------------------------------------------------------------
// F2 — the album delivery-evidence completeness (pure)
// ---------------------------------------------------------------------------

const TWO_ITEM_PLAN_ORDINALS = 2;

describe('F2: evaluateAlbumDeliveryEvidence — the completeness proof is ALL ordinals + destination + usages', () => {
  const message = (ordinal: number, chatId = '@pixel_lores'): AlbumDeliveryMessageViewV1 => ({
    ordinal,
    chatId,
  });

  it('a full proof (both ordinals, our destination, usages bound) is complete', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: TWO_ITEM_PLAN_ORDINALS,
      destination: '@pixel_lores',
      messages: [message(0), message(1)],
      boundUsageOrdinals: [0, 1],
    });
    expect(verdict).toEqual({ kind: 'complete' });
  });

  it('a PARTIAL proof (only ordinal 0 of 2) is incomplete — never healable, never re-sendable', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: TWO_ITEM_PLAN_ORDINALS,
      destination: '@pixel_lores',
      messages: [message(0)],
      boundUsageOrdinals: [],
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'missing_ordinals',
      missingOrdinals: [1],
    });
  });

  it('an empty ledger proves nothing', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: TWO_ITEM_PLAN_ORDINALS,
      destination: '@pixel_lores',
      messages: [],
      boundUsageOrdinals: [],
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'missing_ordinals',
      missingOrdinals: [0, 1],
    });
  });

  it('a record to a FOREIGN destination is not a proof for this publication', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: TWO_ITEM_PLAN_ORDINALS,
      destination: '@pixel_lores',
      messages: [message(0, '@other_channel'), message(1)],
      boundUsageOrdinals: [0, 1],
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'foreign_destination',
      missingOrdinals: [],
    });
  });

  it('complete ordinals WITHOUT the usage binding are not a complete proof yet', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: TWO_ITEM_PLAN_ORDINALS,
      destination: '@pixel_lores',
      messages: [message(0), message(1)],
      boundUsageOrdinals: [0],
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'unbound_usages',
      missingOrdinals: [],
    });
  });

  it('an out-of-range expectation proves nothing (total, no throw)', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 0,
      destination: '@pixel_lores',
      messages: [],
      boundUsageOrdinals: [],
    });
    expect(verdict.kind).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------
// F3 — the durable rights echo gates USE and PUBLICATION (pure)
// ---------------------------------------------------------------------------

describe('F3: the publication rights gate — blocked and unknown never pass', () => {
  it('the publishable set is EXACTLY the affirmative clearances', () => {
    expect(PUBLICATION_MEDIA_RIGHTS_V1).toEqual(['official', 'licensed', 'attribution_required']);
  });

  it('blocked and unknown are never publishable', () => {
    expect(isPublishableRightsStatus('blocked')).toBe(false);
    expect(isPublishableRightsStatus('unknown')).toBe(false);
  });

  it('official, licensed and attribution_required are publishable', () => {
    expect(isPublishableRightsStatus('official')).toBe(true);
    expect(isPublishableRightsStatus('licensed')).toBe(true);
    expect(isPublishableRightsStatus('attribution_required')).toBe(true);
  });

  function assetRow(overrides: Partial<MediaAssetRecordV1> = {}): MediaAssetRecordV1 {
    return {
      id: 'a1',
      type: 'photo',
      canonicalUrl: 'https://cdn.example.com/0.jpg',
      rightsStatus: 'official',
      telegramFileId: 'file-1',
      status: 'uploaded',
      createdAt: 100,
      updatedAt: 100,
      ...overrides,
    };
  }

  it('a row with UNKNOWN rights is never reused (at the moment of use)', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://cdn.example.com/0.jpg', kind: 'photo' }],
      [assetRow({ rightsStatus: 'unknown' })],
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('a row with BLOCKED rights is never reused (revocation holds at use)', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: 'https://cdn.example.com/0.jpg', kind: 'photo' }],
      [assetRow({ rightsStatus: 'blocked' })],
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('each affirmative clearance stays reusable (official / licensed / attribution_required)', () => {
    for (const rightsStatus of PUBLICATION_MEDIA_RIGHTS_V1) {
      const resolutions = resolveAssetReuse(
        [{ canonicalUrl: 'https://cdn.example.com/0.jpg', kind: 'photo' }],
        [assetRow({ rightsStatus })],
      );
      expect(resolutions).toEqual([
        { item: 0, outcome: 'reuse', fileId: 'file-1', matchedBy: 'canonical_url' },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// F4 — the caption envelope is fully validated BEFORE any effect (service)
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  type: 'photo' | 'video';
  canonicalUrl?: string;
  sha256?: string;
  rightsStatus: 'official' | 'licensed' | 'attribution_required' | 'unknown' | 'blocked';
  telegramFileId?: string;
  status: 'candidate' | 'uploaded' | 'failed' | 'blocked' | 'expired';
  r2Key?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

function makePorts(options: { sendResult?: () => MediaGroupSendResultV1 } = {}) {
  const rows: FakeRow[] = [];
  let sends = 0;
  const observedRightsInputs: string[] = [];
  const observedSendInputs: MediaGroupSendInputV1[] = [];
  const ports: MediaUploadPorts = {
    assets: {
      findAssetsByUrls: async (urls) =>
        rows.filter((r) => r.canonicalUrl !== undefined && urls.includes(r.canonicalUrl)),
      findAssetsByHashes: async (hashes) =>
        rows.filter((r) => r.sha256 !== undefined && hashes.includes(r.sha256)),
      findExpiredAssets: async (nowMs) =>
        rows.filter(
          (r) => r.r2Key !== undefined && r.expiresAt !== undefined && r.expiresAt <= nowMs,
        ),
      insertAsset: async (record) => {
        rows.push({ ...(record as unknown as FakeRow) });
        return { ok: true };
      },
      markUploaded: async (id, fileId, at) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return { ok: false, reason: 'asset_write_failed' };
        row.telegramFileId = fileId;
        row.r2Key = undefined;
        row.expiresAt = undefined;
        row.status = 'uploaded';
        row.updatedAt = at;
        return { ok: true };
      },
      markFailed: async (id, at) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return { ok: false, reason: 'asset_write_failed' };
        row.status = 'failed';
        row.updatedAt = at;
        return { ok: true };
      },
      clearExpired: async (id, at) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return { ok: false, reason: 'asset_write_failed' };
        row.r2Key = undefined;
        row.expiresAt = undefined;
        row.status = 'expired';
        row.updatedAt = at;
        return { ok: true };
      },
    },
    rights: {
      decide: (input) => {
        observedRightsInputs.push(input.rightsState);
        return decideMediaRights(input);
      },
    },
    fetch: {
      fetch: async ({ canonicalUrl }) => ({
        ok: true,
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
        byteLength: 3,
        contentHash: `hash-${canonicalUrl}`,
      }),
    },
    storage: {
      put: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
    telegram: {
      sendMediaGroup: async (input) => {
        sends += 1;
        observedSendInputs.push(input);
        if (options.sendResult) return options.sendResult();
        return {
          ok: true,
          fileIds: input.items.map((_item, index) => `returned-ordinal-${index}`),
        };
      },
    },
    ids: cryptoIdGenerator,
  };
  return { ports, state: () => ({ rows, sends, observedRightsInputs, observedSendInputs }) };
}

function twoItemPlan() {
  return {
    schemaVersion: 1 as const,
    planningVersion: 'alp1' as const,
    mode: 'album' as const,
    captionOrdinal: 0 as const,
    excluded: [],
    items: [0, 1].map((ordinal) => ({
      ordinal,
      captionAllowed: ordinal === 0,
      candidate: {
        schemaVersion: 1 as const,
        kind: 'photo' as const,
        role: 'gameplay' as const,
        origin: 'official_api' as const,
        officiality: 'official' as const,
        relevance: 'supporting' as const,
        freshness: 'recent' as const,
        canonicalUrl: `https://cdn.example.com/${ordinal}.jpg`,
        previouslyUsed: false,
      },
    })),
  };
}

describe('F4: the album caption gate — the REAL envelope validation before ANY effect', () => {
  it('an entity offset beyond the text length is rejected TYPED with ZERO effects', async () => {
    const env = makePorts();
    const outcome: AlbumUploadOutcome = await uploadAlbumMediaGroup(
      {
        chatId: '@pixel_lores',
        plan: twoItemPlan(),
        nowMs: 1000,
        caption: {
          schemaVersion: 1,
          kind: 'caption',
          text: 'x',
          entities: [{ type: 'bold', offset: 50, length: 1 }],
        },
      },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('caption_invalid');
      // The honest pre-send rejection: NO send was attempted (absent, the
      // A6 vocabulary — never a post-send honesty flag).
      expect(outcome.sentConfirmed).toBeUndefined();
    }
    expect(env.state().sends).toBe(0);
    expect(env.state().observedRightsInputs).toHaveLength(0);
    expect(env.state().rows).toHaveLength(0);
  });

  it('an entity splitting a surrogate pair is rejected before any effect', async () => {
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      {
        chatId: '@pixel_lores',
        plan: twoItemPlan(),
        nowMs: 1000,
        caption: {
          schemaVersion: 1,
          kind: 'caption',
          text: 'a\u{1F3AE}b',
          entities: [{ type: 'bold', offset: 1, length: 1 }],
        },
      },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('caption_invalid');
    expect(env.state().sends).toBe(0);
    expect(env.state().observedRightsInputs).toHaveLength(0);
  });

  it('an entity length overshooting the text end is rejected before any effect', async () => {
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      {
        chatId: '@pixel_lores',
        plan: twoItemPlan(),
        nowMs: 1000,
        caption: {
          schemaVersion: 1,
          kind: 'caption',
          text: 'hello',
          entities: [{ type: 'italic', offset: 3, length: 9 }],
        },
      },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('caption_invalid');
    expect(env.state().sends).toBe(0);
  });

  it('a wrong envelope kind or version is rejected before any effect', async () => {
    for (const caption of [
      { schemaVersion: 1 as const, kind: 'text' as const, text: 'x', entities: [] },
      { schemaVersion: 2 as const, kind: 'caption' as const, text: 'x', entities: [] },
    ]) {
      const env = makePorts();
      const outcome = await uploadAlbumMediaGroup(
        {
          chatId: '@pixel_lores',
          plan: twoItemPlan(),
          nowMs: 1000,
          caption: caption as unknown as RichTextEnvelope,
        },
        env.ports,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok === false) expect(outcome.reason).toBe('caption_invalid');
      expect(env.state().sends).toBe(0);
      expect(env.state().observedRightsInputs).toHaveLength(0);
    }
  });

  it('a VALID caption still rides ordinal 0 and the album sends (no over-blocking)', async () => {
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      {
        chatId: '@pixel_lores',
        plan: twoItemPlan(),
        nowMs: 1000,
        caption: {
          schemaVersion: 1,
          kind: 'caption',
          text: 'کپشن آلبوم خبری',
          entities: [{ type: 'bold', offset: 0, length: 5 }],
        },
      },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    expect(env.state().sends).toBe(1);
    const sendInput = env.state().observedSendInputs[0]!;
    expect(sendInput.items[0]!.caption?.text).toBe('کپشن آلبوم خبری');
    expect(sendInput.items[1]!.caption).toBeUndefined();
  });
});
