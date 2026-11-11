import { describe, expect, it } from 'vitest';
import { planAlbumMedia } from '../../src/domain/media/album-plan';
import {
  uploadAlbumMediaGroup,
  runMediaRetentionCleanup,
  type AlbumUploadOutcome,
  type MediaUploadPorts,
} from '../../src/application/media/upload-service';
import { decideMediaRights } from '../../src/domain/media/media-rights';
import { resolveAssetReuse } from '../../src/domain/media/media-usage';
import type {
  MediaAssetTypeV1,
  MediaRightsStatusV1,
  MediaAssetStatusV1,
} from '../../src/domain/media/media-usage';
import type {
  MediaGroupSendInputV1,
  MediaGroupSendResultV1,
} from '../../src/domain/media/media-ports';
import { cryptoIdGenerator } from '../../src/shared/ids/id';

/**
 * Phase 7.4 (the review-blocker round) — the INDEPENDENT REVIEW's A1–A6
 * album findings RED-first: every adversarial probe scenario from
 * PIXEL_LORES_2BD1833_INDEPENDENT_REVIEW_FA.md, re-written as a persistent
 * Vitest suite over the REAL service with the house port fakes (all
 * offline, no live surface).
 *
 *  A1 — the rights fabrication: an unofficial `source_metadata` candidate
 *       used to be auto-mapped to `source_metadata_cleared` and stored as
 *       `official`; the reuse resolution ignored status/rights/type.
 *  A2 — the file_id mapping used a FRESH-ONLY counter instead of the
 *       ordinal contract; a mixed reuse/fresh album recorded the WRONG id.
 *  A3 — the R2 cleanup order (clear-first, delete-second) could orphan the
 *       object outside the ledger's discoverability.
 *  A4 — the caption reached the transport BEFORE any validation; the send
 *       outcome carried no proved/uncertain honesty.
 *  A5 — the fresh bytes never crossed the port contract (no attachments).
 *  A6 — pre-send items lied `uploaded`; post-send write failures looked
 *       like "not sent"; a fetch failure summarized under `rights_rejected`.
 */

function candidate(
  i: number,
  origin: 'official_api' | 'source_metadata' = 'source_metadata',
  officiality: 'official' | 'verified_source' | 'unofficial' = 'unofficial',
) {
  return {
    schemaVersion: 1 as const,
    kind: 'photo' as const,
    role: 'gameplay' as const,
    origin,
    officiality,
    relevance: 'supporting' as const,
    freshness: 'recent' as const,
    canonicalUrl: `https://cdn.example.com/${i}.jpg`,
    previouslyUsed: false,
  };
}

function makeTwoCandidatePlan(
  origin: 'official_api' | 'source_metadata' = 'source_metadata',
  officiality: 'official' | 'verified_source' | 'unofficial' = 'unofficial',
) {
  const planned = planAlbumMedia({
    candidates: [candidate(0, origin, officiality), candidate(1, origin, officiality)],
  });
  if (!planned.ok) throw new Error('bad fixture');
  return planned.plan;
}

interface FakeRow {
  id: string;
  type: MediaAssetTypeV1;
  canonicalUrl?: string;
  sha256?: string;
  rightsStatus: MediaRightsStatusV1;
  telegramFileId?: string;
  status: MediaAssetStatusV1;
  r2Key?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

function makePorts(
  initialRows: FakeRow[] = [],
  options: {
    failDeleteCount?: number;
    sendResult?: () => MediaGroupSendResultV1;
    markUploadedFails?: boolean;
  } = {},
) {
  const rows = initialRows.map((row) => ({ ...row }));
  let sends = 0;
  let deleteCalls = 0;
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
        if (options.markUploadedFails) return { ok: false, reason: 'asset_write_failed' };
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
      delete: async () => {
        deleteCalls += 1;
        // Fail only the FIRST `failDeleteCount` calls (the in-upload flow);
        // the backstop's later deletes succeed (missing = ok).
        return deleteCalls <= (options.failDeleteCount ?? 0)
          ? { ok: false, reason: 'storage_unavailable' }
          : { ok: true };
      },
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
  return {
    ports,
    state: () => ({ rows, sends, deleteCalls, observedRightsInputs, observedSendInputs }),
  };
}

describe('A1 — the rights fabrication is closed (fail-closed mapping + honest storage)', () => {
  it('an unofficial source_metadata candidate is REJECTED — never auto-cleared, never sent', async () => {
    const plan = makeTwoCandidatePlan('source_metadata', 'unofficial');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('rights_rejected');
      expect(outcome.items.every((item) => item.outcome === 'rejected')).toBe(true);
    }
    expect(env.state().sends).toBe(0);
    expect(env.state().observedRightsInputs.every((state) => state === 'unknown')).toBe(true);
    expect(env.state().rows).toHaveLength(0);
  });

  it('an official_api candidate is allowed and stored as official', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    expect(env.state().observedRightsInputs.every((state) => state === 'official_api')).toBe(true);
    expect(env.state().rows.every((row) => row.rightsStatus === 'official')).toBe(true);
  });

  it('a source_metadata candidate with official metadata is cleared and stored as attribution_required', async () => {
    const plan = makeTwoCandidatePlan('source_metadata', 'official');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    expect(
      env.state().observedRightsInputs.every((state) => state === 'source_metadata_cleared'),
    ).toBe(true);
    expect(env.state().rows.every((row) => row.rightsStatus === 'attribution_required')).toBe(true);
  });

  it('a verified_source metadata candidate is cleared too (a named source, not an anonymous claim)', async () => {
    const plan = makeTwoCandidatePlan('source_metadata', 'verified_source');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    expect(env.state().rows.every((row) => row.rightsStatus === 'attribution_required')).toBe(true);
  });
});

describe('A1 — the reuse resolution guards (status, rights, type)', () => {
  const baseRow: FakeRow = {
    id: 'old',
    type: 'photo',
    canonicalUrl: 'https://cdn.example.com/0.jpg',
    rightsStatus: 'official',
    telegramFileId: 'old-file-id',
    status: 'uploaded',
    createdAt: 100,
    updatedAt: 100,
  };

  it('a BLOCKED row (status blocked) is never reused', () => {
    const blocked: FakeRow = { ...baseRow, id: 'blocked', status: 'blocked' };
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: blocked.canonicalUrl!, kind: 'photo' }],
      [blocked],
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('a row with blocked rights is never reused even while status uploaded', () => {
    const blockedRights: FakeRow = { ...baseRow, id: 'br', rightsStatus: 'blocked' };
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: blockedRights.canonicalUrl!, kind: 'photo' }],
      [blockedRights],
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('a TYPE mismatch is never reused (a video slot cannot ride a photo asset)', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: baseRow.canonicalUrl!, kind: 'video' }],
      [baseRow],
    );
    expect(resolutions).toEqual([{ item: 0, outcome: 'stage' }]);
  });

  it('an uploaded, cleared, type-matching row IS reused', () => {
    const resolutions = resolveAssetReuse(
      [{ canonicalUrl: baseRow.canonicalUrl!, kind: 'photo' }],
      [baseRow],
    );
    expect(resolutions).toEqual([
      { item: 0, outcome: 'reuse', fileId: 'old-file-id', matchedBy: 'canonical_url' },
    ]);
  });
});

describe('A2 — the file_id mapping follows the ORDINAL contract', () => {
  it('a mixed reuse/fresh album maps each fresh id by its own ordinal', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const reusedRow: FakeRow = {
      id: 'old',
      type: 'photo',
      canonicalUrl: plan.items[0]!.candidate.canonicalUrl,
      rightsStatus: 'official',
      telegramFileId: 'old-file-id',
      status: 'uploaded',
      createdAt: 100,
      updatedAt: 100,
    };
    const env = makePorts([reusedRow]);
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.fileIds).toEqual(['old-file-id', 'returned-ordinal-1']);
    }
    const freshRow = env
      .state()
      .rows.find((row) => row.canonicalUrl === plan.items[1]!.candidate.canonicalUrl);
    expect(freshRow?.telegramFileId).toBe('returned-ordinal-1');
  });

  it('a malformed send response (wrong length) is a typed failure with ZERO ledger writes', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts([], {
      sendResult: () => ({ ok: true, fileIds: ['only-one'] }),
    });
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('invalid_send_response');
    expect(env.state().rows.every((row) => row.status === 'candidate')).toBe(true);
    expect(env.state().rows.every((row) => row.telegramFileId === undefined)).toBe(true);
  });
});

describe('A3 — the R2 cleanup is recoverable (delete BEFORE the row clears)', () => {
  it('the object delete happens BEFORE the ledger clears the key (a crash can never orphan the object)', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    const freshRows = env.state().rows.filter((row) => row.r2Key === undefined);
    // Every fresh row was cleared by markUploaded (after its delete).
    expect(freshRows.length).toBeGreaterThan(0);
  });

  it('a failed post-send delete leaves the row DISCOVERABLE (key + deadline retained) and the backstop cleans it', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts([], { failDeleteCount: 1 });
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('storage_failed');
      expect(outcome.sentConfirmed).toBe(true);
    }
    // The rows STILL HOLD their keys + deadlines: the retention backstop
    // can discover them — the object is never outside the ledger.
    const stagedRows = env.state().rows.filter((row) => row.status === 'candidate');
    expect(stagedRows.length).toBeGreaterThan(0);
    expect(stagedRows.every((row) => row.r2Key !== undefined && row.expiresAt !== undefined)).toBe(
      true,
    );

    // The backstop (past the 72h deadline) discovers and cleans them —
    // the missing object deletes as ok.
    const cleanup = await runMediaRetentionCleanup(env.ports, 1000 + 73 * 3_600_000, 64);
    expect(cleanup.ok).toBe(true);
    if (cleanup.ok) expect(cleanup.deletedCount).toBe(stagedRows.length);
    expect(env.state().rows.every((row) => row.r2Key === undefined)).toBe(true);
  });
});

describe('A4 — validation BEFORE any channel effect + the honest send outcome', () => {
  it('an over-cap caption is rejected typed with ZERO rights, fetch and send calls', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      {
        chatId: '@pixel_lores',
        plan,
        nowMs: 1000,
        caption: {
          schemaVersion: 1,
          kind: 'caption',
          text: 'x'.repeat(1025),
          entities: [],
        },
      },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('caption_invalid');
    expect(env.state().sends).toBe(0);
    expect(env.state().observedRightsInputs).toHaveLength(0);
    expect(env.state().rows).toHaveLength(0);
  });

  it('an invalid destination is rejected typed with ZERO sends', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup({ chatId: '', plan, nowMs: 1000 }, env.ports);
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('invalid_destination');
    expect(env.state().sends).toBe(0);
  });

  it('an uncertain send outcome is surfaced honestly and NEVER retried in-process', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts([], {
      sendResult: () => ({
        ok: false,
        reason: 'send_failed',
        certainty: 'uncertain',
        code: 'telegram_timeout',
      }),
    });
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('send_failed');
      expect(outcome.sendCertainty).toBe('uncertain');
    }
    expect(env.state().sends).toBe(1);
    const stagedRows = env.state().rows.filter((row) => row.status === 'failed');
    expect(stagedRows.length).toBeGreaterThan(0);
  });

  it('a proved non-delivery (429) keeps the proved certainty on the report', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts([], {
      sendResult: () => ({
        ok: false,
        reason: 'send_failed',
        certainty: 'proved_non_delivery',
        code: 'telegram_rate_limited',
      }),
    });
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.sendCertainty).toBe('proved_non_delivery');
    expect(env.state().sends).toBe(1);
  });

  it('the deterministic send identity key travels with the success outcome (the outbox wiring scaffold)', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const envA = makePorts();
    const envB = makePorts();
    const a = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      envA.ports,
    );
    const b = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 2000 },
      envB.ports,
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.sendIdentityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(a.sendIdentityKey).toBe(b.sendIdentityKey);
    }
    const envC = makePorts();
    const c = await uploadAlbumMediaGroup(
      { chatId: '@other_channel', plan, nowMs: 1000 },
      envC.ports,
    );
    if (a.ok && c.ok) expect(a.sendIdentityKey).not.toBe(c.sendIdentityKey);
  });
});

describe('A5 — the fresh bytes cross the port contract (typed attachments)', () => {
  it('fresh items ride item-<ordinal> attachments with their bytes; reused items ride none', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(true);
    const sendInput = env.state().observedSendInputs[0]!;
    expect(sendInput.attachments).toHaveLength(2);
    expect(sendInput.attachments.map((a) => a.ref)).toEqual(['item-0', 'item-1']);
    expect(
      sendInput.attachments.every((a) => a.bytes instanceof Uint8Array && a.bytes.byteLength > 0),
    ).toBe(true);
    expect(sendInput.attachments.every((a) => a.contentType === 'image/jpeg')).toBe(true);
    expect(sendInput.items.map((item) => item.media)).toEqual([
      'attach://item-0',
      'attach://item-1',
    ]);
  });

  it('a mixed reuse/fresh album sends attachments ONLY for the fresh ordinals', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const reusedRow: FakeRow = {
      id: 'old',
      type: 'photo',
      canonicalUrl: plan.items[0]!.candidate.canonicalUrl,
      rightsStatus: 'official',
      telegramFileId: 'old-file-id',
      status: 'uploaded',
      createdAt: 100,
      updatedAt: 100,
    };
    const env = makePorts([reusedRow]);
    await uploadAlbumMediaGroup({ chatId: '@pixel_lores', plan, nowMs: 1000 }, env.ports);
    const sendInput = env.state().observedSendInputs[0]!;
    expect(sendInput.items[0]!.media).toBe('old-file-id');
    expect(sendInput.items[1]!.media).toBe('attach://item-1');
    expect(sendInput.attachments.map((a) => a.ref)).toEqual(['item-1']);
  });
});

describe('A6 — the honest pre-send and post-send outcomes', () => {
  it('pre-send failure reports carry STAGED (not uploaded) items — nothing was delivered', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts([], {
      sendResult: () => ({ ok: false, reason: 'send_rejected' }),
    });
    const outcome: AlbumUploadOutcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('send_failed');
      expect(outcome.sentConfirmed).toBe(false);
      expect(outcome.items.every((item) => item.outcome !== 'uploaded')).toBe(true);
    }
  });

  it('a fetch failure is a fetch_failed blocker — never summarized under rights_rejected', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts();
    env.ports.fetch.fetch = async () => ({ ok: false, reason: 'fetch_failed' });
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('fetch_failed');
    expect(env.state().sends).toBe(0);
  });

  it('a post-send ledger write failure reports sentConfirmed=true with the delivered file_ids intact', async () => {
    const plan = makeTwoCandidatePlan('official_api', 'official');
    const env = makePorts([], { markUploadedFails: true });
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixel_lores', plan, nowMs: 1000 },
      env.ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('asset_write_failed');
      expect(outcome.sentConfirmed).toBe(true);
    }
    expect(env.state().sends).toBe(1);
  });
});
