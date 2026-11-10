/**
 * Phase 7.3 — the MEDIA UPLOAD SERVICE (the roadmap's «Telegram upload
 * with file_id reuse and R2 retention cleanup»): the REAL orchestration
 * over the FOUR documented seams (ADR-0042 §6 discipline — the ports are
 * the ONLY artificial pieces in tests; the asset store over the
 * BLUEPRINT-APPROVED `media_assets` table is REAL D1).
 *
 * THE DOCUMENTED FLOW (per album plan, ALL-OR-NOTHING at the group send):
 *  1. reuse resolution — the uploaded assets (a saved telegram_file_id)
 *     are looked up for the plan's URLs (and, after a fetch, content
 *     hashes): a hit reuses the stored file_id with ZERO fetch/storage/
 * upload for that item (the economy rule, durable in media_assets);
 *  2. rights — every NOT-reused item passes the 7.2 TOTAL decision
 *     (mrp1; the v1 upload path derives the input from the candidate —
 *     kind⇒mime, origin⇒rightsState); a defer/reject is a TYPED per-item
 *     outcome and — because a media group cannot silently drop a member —
 *     the WHOLE send is withheld (no partial album, no silent degrade);
 *  3. fetch — allowed items are fetched through the MediaFetchPort (the
 *     real adapter enforces the mrp1 transport rules and the streaming
 *     byte cap; an unknown size NEVER bypasses it);
 *  4. hash reuse — the fetched bytes' hash is resolved against the
 *     uploaded assets BEFORE any staging: the same bytes under another
 *     URL reuse their file_id and the fetched bytes are discarded;
 *  5. staging — genuinely new items INSERT a 'candidate' media_assets row
 *     (r2_key = the deterministic `media/staging/<id>` key, expires_at =
 *     the deterministic 72h deadline — blueprint §23) and the bytes go to
 *     the MediaStoragePort; a crashed round leaves the row honest for the
 *     retention backstop;
 *  6. ONE media-group send (2..10 items, caption rides ordinal 0 ONLY)
 *     through the TelegramMediaPort returns the per-item file_ids in
 *     ordinal order;
 *  7. EVERY freshly-uploaded asset walks the blueprint step-10 transition
 *     IN ONE STORE CALL: telegram_file_id saved + r2_key/expires_at
 *     cleared + status 'uploaded' — then the R2 object is deleted
 *     IMMEDIATELY (the 72h deadline remains the BACKSTOP for anything
 *     that died earlier); a failed send marks the staged rows 'failed'
 *     (their objects stay for the backstop; NOTHING is auto-resent).
 *
 * THE RETENTION CLEANUP (`runMediaRetentionCleanup`): a BOUNDED, chunked
 * scan selects the assets still HOLDING an R2 object past their
 * deterministic deadline, deletes the objects (missing = ok) and clears
 * the rows (status 'expired'; an uploaded row KEEPS its file_id — the
 * ledger value outlives the temporary object).
 *
 * LIVE BOUNDARY: the REAL fetch/storage/send adapters are live surfaces
 * (BLOCKED_LIVE — Posidon only). This service + the D1 store are the
 * local-engineering slice; the tests drive the REAL service + REAL D1
 * with faked ports.
 */

import {
  resolveAssetReuse,
  readMediaAssetRecordV1,
  type MediaAssetRecordV1,
} from '../../domain/media/media-usage';
import { MEDIA_FETCH_POLICY_V1, type MediaRightsDecisionV1 } from '../../domain/media/media-rights';
import { R2_TEMPORARY_POLICY_V1 } from '../../domain/media/r2-temporary';
import type { MediaAlbumPlanV1, PlannedMediaItemV1 } from '../../domain/media/album-plan';
import type { MediaCandidateV1 } from '../../domain/media/media-candidate';
import {
  createAlbumContentDocument,
  type AlbumContentDocumentV1,
} from '../../domain/media/album-content';
import type { RichTextEnvelope } from '../../domain/telegram/rich-text-envelope';
import type {
  MediaFetchPort,
  MediaGroupItemWireV1,
  MediaAssetStore,
  MediaStoragePort,
  TelegramMediaPort,
  MediaUploadRightsPort,
} from '../../domain/media/media-ports';
import type { IdGenerator } from '../../shared/ids/id';

const RETENTION_MS = R2_TEMPORARY_POLICY_V1.retentionHours * 60 * 60 * 1000;

export interface AlbumUploadItemOutcomeV1 {
  readonly ordinal: number;
  readonly canonicalUrl: string;
  readonly outcome: 'reused' | 'uploaded' | 'deferred' | 'rejected';
  readonly fileId?: string;
  readonly reason?: MediaRightsDecisionV1['reason'] | 'fetch_failed';
}

export type AlbumUploadOutcome =
  | {
      ok: true;
      fileIds: readonly string[];
      document: AlbumContentDocumentV1;
      serialized: string;
      fingerprint: string;
      items: readonly AlbumUploadItemOutcomeV1[];
      reusedCount: number;
      uploadedCount: number;
    }
  | {
      ok: false;
      reason:
        | 'plan_mode_unsupported'
        | 'plan_items_out_of_bounds'
        | 'rights_deferred'
        | 'rights_rejected'
        | 'fetch_failed'
        | 'storage_failed'
        | 'send_failed'
        | 'asset_write_failed';
      items: readonly AlbumUploadItemOutcomeV1[];
    };

export interface AlbumUploadInput {
  readonly chatId: string;
  readonly plan: MediaAlbumPlanV1;
  /** The ordinal-0 caption envelope (rides the group's FIRST item ONLY). */
  readonly caption?: RichTextEnvelope;
  readonly nowMs: number;
}

export interface MediaUploadPorts {
  readonly rights: MediaUploadRightsPort;
  readonly fetch: MediaFetchPort;
  readonly storage: MediaStoragePort;
  readonly assets: MediaAssetStore;
  readonly telegram: TelegramMediaPort;
  readonly ids: IdGenerator;
}

interface ResolvedItem {
  readonly ordinal: number;
  readonly candidate: MediaCandidateV1;
  readonly fileId?: string;
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
  readonly contentHash?: string;
  readonly outcome: AlbumUploadItemOutcomeV1['outcome'];
  readonly reason?: MediaRightsDecisionV1['reason'] | 'fetch_failed';
}

/** The DETERMINISTIC R2 object key for a staged asset (derivable by the cleanup too). */
export function stagingObjectKey(assetId: string): string {
  return `media/staging/${assetId}`;
}

/** The durable rights echo: the mrp1 allow maps onto the blueprint rights vocabulary. */
function rightsStatusFor(): MediaAssetRecordV1['rightsStatus'] {
  // The v1 upload path's allow decisions come from the three cleared
  // states; the durable echo uses the blueprint's vocabulary.
  return 'official';
}

export async function uploadAlbumMediaGroup(
  input: AlbumUploadInput,
  ports: MediaUploadPorts,
): Promise<AlbumUploadOutcome> {
  const plan = input.plan;
  // The media-group upload is the ALBUM path only this round: a single-item
  // plan belongs to the existing sendPhoto/sendVideo surface (typed, honest).
  if (plan.mode !== 'album') {
    return { ok: false, reason: 'plan_mode_unsupported', items: [] };
  }
  const planItems: readonly PlannedMediaItemV1[] = plan.items;
  if (planItems.length < 2 || planItems.length > 10) {
    return { ok: false, reason: 'plan_items_out_of_bounds', items: [] };
  }

  // 1. URL-level reuse resolution (one bounded asset read for ALL urls).
  const urls = planItems.map((item) => item.candidate.canonicalUrl);
  const urlAssets = await ports.assets.findAssetsByUrls(urls);
  const urlResolutions = resolveAssetReuse(
    planItems.map((item) => ({ canonicalUrl: item.candidate.canonicalUrl })),
    urlAssets,
  );

  const resolved: ResolvedItem[] = [];
  const items: AlbumUploadItemOutcomeV1[] = [];

  // 2-4. rights + fetch + hash-level reuse for every not-yet-reused item.
  for (let index = 0; index < planItems.length; index += 1) {
    const planItem = planItems[index]!;
    const candidate = planItem.candidate;
    const urlResolution = urlResolutions[index]!;
    if (urlResolution.outcome === 'reuse') {
      resolved.push({ ordinal: index, candidate, fileId: urlResolution.fileId, outcome: 'reused' });
      items.push({
        ordinal: index,
        canonicalUrl: candidate.canonicalUrl,
        outcome: 'reused',
        fileId: urlResolution.fileId,
      });
      const reusedRow = urlAssets.find((row) => row.telegramFileId === urlResolution.fileId);
      if (reusedRow !== undefined) {
        await ports.assets.markUploaded(reusedRow.id, reusedRow.telegramFileId!, input.nowMs);
      }
      continue;
    }
    // 2. the 7.2 TOTAL decision (mrp1) — the v1 upload path derives the
    // input from the candidate (kind⇒mime, origin⇒rightsState).
    const rights = ports.rights.decide({
      rightsState: candidate.origin === 'official_api' ? 'official_api' : 'source_metadata_cleared',
      mime: candidate.kind === 'video' ? 'video/mp4' : 'image/jpeg',
      url: candidate.canonicalUrl,
      byteSize: undefined, // UNKNOWN size: the decision flags byteCapUnchecked for the fetch adapter
      redirectCount: 0,
    });
    if (rights.decision === 'defer') {
      resolved.push({ ordinal: index, candidate, outcome: 'deferred', reason: rights.reason });
      items.push({
        ordinal: index,
        canonicalUrl: candidate.canonicalUrl,
        outcome: 'deferred',
        reason: rights.reason,
      });
      continue;
    }
    if (rights.decision === 'reject') {
      resolved.push({ ordinal: index, candidate, outcome: 'rejected', reason: rights.reason });
      items.push({
        ordinal: index,
        canonicalUrl: candidate.canonicalUrl,
        outcome: 'rejected',
        reason: rights.reason,
      });
      continue;
    }
    const fetchResult = await ports.fetch.fetch({
      canonicalUrl: candidate.canonicalUrl,
      rightsDecision: rights,
      maxBytes:
        candidate.kind === 'video'
          ? MEDIA_FETCH_POLICY_V1.maxVideoBytes
          : MEDIA_FETCH_POLICY_V1.maxPhotoBytes,
    });
    if (!fetchResult.ok) {
      resolved.push({ ordinal: index, candidate, outcome: 'rejected', reason: 'fetch_failed' });
      items.push({
        ordinal: index,
        canonicalUrl: candidate.canonicalUrl,
        outcome: 'rejected',
        reason: 'fetch_failed',
      });
      continue;
    }
    // 4. hash-level reuse: the same bytes under another URL may already be uploaded.
    const hashAssets = await ports.assets.findAssetsByHashes([fetchResult.contentHash]);
    const hashResolutions = resolveAssetReuse(
      [{ canonicalUrl: candidate.canonicalUrl, sha256: fetchResult.contentHash }],
      hashAssets,
    );
    const hashResolution = hashResolutions[0]!;
    if (hashResolution.outcome === 'reuse') {
      resolved.push({
        ordinal: index,
        candidate,
        fileId: hashResolution.fileId,
        outcome: 'reused',
      });
      items.push({
        ordinal: index,
        canonicalUrl: candidate.canonicalUrl,
        outcome: 'reused',
        fileId: hashResolution.fileId,
      });
      const hashRow = hashAssets.find((row) => row.telegramFileId === hashResolution.fileId);
      if (hashRow !== undefined)
        await ports.assets.markUploaded(hashRow.id, hashRow.telegramFileId!, input.nowMs);
      continue;
    }
    resolved.push({
      ordinal: index,
      candidate,
      bytes: fetchResult.bytes,
      contentType: fetchResult.contentType,
      contentHash: fetchResult.contentHash,
      outcome: 'uploaded', // provisional: real only after the group send succeeds
    });
    items.push({ ordinal: index, canonicalUrl: candidate.canonicalUrl, outcome: 'uploaded' });
  }

  // ALL-OR-NOTHING: any deferred/rejected/failed item withholds the send.
  const blocking = items.find((item) => item.outcome !== 'reused' && item.outcome !== 'uploaded');
  if (blocking !== undefined) {
    return {
      ok: false,
      reason: blocking.outcome === 'deferred' ? 'rights_deferred' : 'rights_rejected',
      items,
    };
  }

  // 5. staging: the durable 'candidate' row FIRST (r2_key + the 72h
  // deadline), then the R2 put (deterministic key).
  const fresh = resolved.filter((item) => item.outcome === 'uploaded' && item.bytes !== undefined);
  const stagedIds = new Map<number, string>();
  for (const item of fresh) {
    const assetId = ports.ids.newId();
    stagedIds.set(item.ordinal, assetId);
    const inserted = await ports.assets.insertAsset(
      {
        id: assetId,
        type: item.candidate.kind,
        canonicalUrl: item.candidate.canonicalUrl,
        sha256: item.contentHash,
        rightsStatus: rightsStatusFor(),
        r2Key: stagingObjectKey(assetId),
        status: 'candidate',
        expiresAt: input.nowMs + RETENTION_MS,
        createdAt: input.nowMs,
        updatedAt: input.nowMs,
      },
      item.contentType!,
    );
    if (!inserted.ok) return { ok: false, reason: 'asset_write_failed', items };
    const storagePut = await ports.storage.put({
      objectKey: stagingObjectKey(assetId),
      bytes: item.bytes!,
      contentType: item.contentType!,
    });
    if (!storagePut.ok) return { ok: false, reason: 'storage_failed', items };
  }

  // 6. ONE media-group send: reuse items ride their file_id, fresh items
  // ride their attach ref; the caption rides ordinal 0 ONLY.
  const groupItems: MediaGroupItemWireV1[] = planItems.map((planItem, index) => {
    const item = resolved[index]!;
    const caption =
      index === 0 && input.caption !== undefined
        ? { text: input.caption.text, entities: input.caption.entities as readonly unknown[] }
        : undefined;
    if (item.fileId !== undefined) {
      return {
        type: planItem.candidate.kind,
        media: item.fileId,
        ...(caption !== undefined ? { caption } : {}),
      };
    }
    return {
      type: planItem.candidate.kind,
      media: `attach://item-${index}`,
      ...(caption !== undefined ? { caption } : {}),
    };
  });
  const sendResult = await ports.telegram.sendMediaGroup(input.chatId, groupItems);
  if (!sendResult.ok) {
    // The failed-send transition for every staged row (the objects stay
    // for the retention backstop; NOTHING is auto-resent).
    for (const assetId of stagedIds.values()) {
      await ports.assets.markFailed(assetId, input.nowMs);
    }
    return { ok: false, reason: 'send_failed', items };
  }

  // 7. the blueprint step-10 transition per fresh item: file_id saved +
  // the R2 reference cleared IN ONE STORE CALL, then the object deleted.
  let sentIndex = 0;
  for (const item of resolved) {
    if (item.outcome !== 'uploaded' || item.bytes === undefined) continue;
    const sentFileId = sendResult.fileIds[sentIndex];
    sentIndex += 1;
    if (sentFileId === undefined) return { ok: false, reason: 'send_failed', items };
    const assetId = stagedIds.get(item.ordinal)!;
    const marked = await ports.assets.markUploaded(assetId, sentFileId, input.nowMs);
    if (!marked.ok) return { ok: false, reason: 'asset_write_failed', items };
    const deleted = await ports.storage.delete(stagingObjectKey(assetId));
    if (!deleted.ok) return { ok: false, reason: 'storage_failed', items };
    items[item.ordinal] = {
      ordinal: item.ordinal,
      canonicalUrl: item.candidate.canonicalUrl,
      outcome: 'uploaded',
      fileId: sentFileId,
    };
  }

  const finalFileIds = resolved.map((item, index) =>
    item.fileId !== undefined ? item.fileId : items[index]?.fileId,
  );
  if (finalFileIds.some((fileId) => fileId === undefined)) {
    return { ok: false, reason: 'send_failed', items };
  }

  // The album content document: the ONLY legal construction path.
  const document = await createAlbumContentDocument(
    plan,
    finalFileIds as readonly string[],
    input.caption,
  );
  if (!document.ok) return { ok: false, reason: 'send_failed', items };

  return {
    ok: true,
    fileIds: finalFileIds as readonly string[],
    document: document.document,
    serialized: document.serialized,
    fingerprint: document.fingerprint,
    items,
    reusedCount: items.filter((item) => item.outcome === 'reused').length,
    uploadedCount: items.filter((item) => item.outcome === 'uploaded').length,
  };
}

export type MediaRetentionCleanupOutcome =
  | { ok: true; expiredCount: number; deletedCount: number }
  | { ok: false; reason: 'asset_write_failed' | 'storage_failed' };

/**
 * The retention cleanup (blueprint §23): a BOUNDED chunk of the assets
 * still HOLDING an R2 object past their deterministic deadline; the
 * objects are deleted (missing = ok) and the rows cleared (status
 * 'expired'; an uploaded row KEEPS its file_id — the ledger value
 * outlives the temporary object). Chunked — never a full-table sweep;
 * the next call resumes.
 */
export async function runMediaRetentionCleanup(
  ports: Pick<MediaUploadPorts, 'storage' | 'assets'>,
  nowMs: number,
  limit: number,
): Promise<MediaRetentionCleanupOutcome> {
  const expiredRows = await ports.assets.findExpiredAssets(nowMs, limit);
  const validRows: MediaAssetRecordV1[] = [];
  for (const row of expiredRows) {
    const read = readMediaAssetRecordV1(row);
    if (read.ok) validRows.push(read.record);
  }
  let deletedCount = 0;
  for (const row of validRows) {
    const deleted = await ports.storage.delete(row.r2Key!);
    if (!deleted.ok) return { ok: false, reason: 'storage_failed' };
    deletedCount += 1;
    const cleared = await ports.assets.clearExpired(row.id, nowMs);
    if (!cleared.ok) return { ok: false, reason: 'asset_write_failed' };
  }
  return { ok: true, expiredCount: validRows.length, deletedCount };
}
