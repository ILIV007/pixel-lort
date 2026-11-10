/**
 * Phase 7.3 — the MEDIA UPLOAD PORTS (the ADR-0042 §6 seam discipline
 * applied to the media path): the upload/cleanup service is REAL code,
 * and the FOUR seams below are its ONLY artificial pieces in tests.
 *
 * THE SEAMS (and what is REAL around them):
 * - `MediaFetchPort` — the rights-cleared byte fetcher (the real adapter
 *   will enforce the mrp1 transport rules + streaming caps; tests fake
 *   it; the REAL fetch is a live surface, BLOCKED_LIVE).
 * - `MediaStoragePort` — the R2 temporary object store (put / head /
 *   delete). The REAL R2 binding is a live Cloudflare surface
 *   (BLOCKED_LIVE, Posidon only); tests fake it.
 * - `MediaLedgerStore` — the DURABLE media state over migration 0007's
 *   two tables (`media_usage` + `media_staging`). The D1-backed adapter
 *   (`src/adapters/db/media-store.ts`) is REAL and the integration tests
 *   drive it over real workerd D1 — this port exists so the service can
 *   also be unit-tested in isolation.
 * - `TelegramMediaPort` — the media-group send that produces Telegram
 *   file_ids (the real adapter wraps the Bot API client's media-group
 *   send; the tests fake it; the LIVE send is BLOCKED_LIVE).
 *
 * NOTHING in this file performs I/O. The service consumes the ports in
 * the documented order: reuse resolution → rights decision → fetch →
 * stage (rtp1 lifecycle) → media-group send → ledger save → R2 delete.
 * Every failure is typed and recoverable-by-policy; nothing is
 * auto-resent (the R1.21 discipline).
 */

import type { MediaRightsInputV1, MediaRightsDecisionV1 } from './media-rights';
import type { MediaAssetRecordV1 } from './media-usage';

export interface MediaFetchRequestV1 {
  readonly canonicalUrl: string;
  /** The rights decision that authorized THIS fetch (provenance, echoed to the port). */
  readonly rightsDecision: MediaRightsDecisionV1;
  /** The mrp1 transport contract the real adapter must enforce. */
  readonly maxBytes: number;
}

export type MediaFetchResultV1 =
  | { ok: true; bytes: Uint8Array; contentType: string; byteLength: number; contentHash: string }
  | { ok: false; reason: 'fetch_failed' | 'fetch_over_bound' | 'fetch_content_type_mismatch' };

export interface MediaFetchPort {
  fetch(request: MediaFetchRequestV1): Promise<MediaFetchResultV1>;
}

export interface MediaStoragePutInputV1 {
  readonly objectKey: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export type MediaStorageResultV1 =
  { ok: true } | { ok: false; reason: 'storage_unavailable' | 'storage_rejected' };

export interface MediaStoragePort {
  /** Stage the object under its key (the rtp1 'staged' write). */
  put(input: MediaStoragePutInputV1): Promise<MediaStorageResultV1>;
  /** Delete the object (the retention/after-save cleanup). Missing = ok. */
  delete(objectKey: string): Promise<MediaStorageResultV1>;
}

/**
 * The DURABLE media state over the BLUEPRINT-APPROVED `media_assets`
 * table (migration 0001 — NO parallel tables; ADR-0056). The D1-backed
 * adapter (`src/adapters/db/media-asset-store.ts`) is REAL and the
 * integration tests drive it over real workerd D1 — this port exists so
 * the service can also be unit-tested in isolation.
 */
export interface MediaAssetStore {
  /** All asset rows for the given URLs (bounded IN-list read). */
  findAssetsByUrls(urls: readonly string[]): Promise<readonly MediaAssetRecordV1[]>;
  /** All asset rows for the given content hashes (bounded IN-list read). */
  findAssetsByHashes(hashes: readonly string[]): Promise<readonly MediaAssetRecordV1[]>;
  /** All rows still HOLDING an R2 object whose deadline has passed (bounded). */
  findExpiredAssets(nowMs: number, limit: number): Promise<readonly MediaAssetRecordV1[]>;
  /** Insert ONE staged candidate row (status 'candidate', r2_key set, deadline set). */
  insertAsset(
    record: MediaAssetRecordV1,
    mime: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'asset_write_failed' }>;
  /** The successful-send transition: file_id saved, R2 object cleared, status 'uploaded'. */
  markUploaded(
    id: string,
    fileId: string,
    updatedAtMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: 'asset_write_failed' }>;
  /** The failed-send transition: status 'failed' (the R2 object stays for the backstop). */
  markFailed(
    id: string,
    updatedAtMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: 'asset_write_failed' }>;
  /** The retention-cleanup transition: object cleared, status 'expired' (the ledger value stays). */
  clearExpired(
    id: string,
    updatedAtMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: 'asset_write_failed' }>;
}

export interface MediaGroupItemWireV1 {
  readonly type: 'photo' | 'video';
  /** The Telegram reference: an existing file_id (reuse) OR an attach:// id (fresh upload). */
  readonly media: string;
  /** The caption — present ONLY on the ordinal-0 item (the house invariant). */
  readonly caption?: { readonly text: string; readonly entities: readonly unknown[] };
}

export type MediaGroupSendResultV1 =
  { ok: true; fileIds: readonly string[] } | { ok: false; reason: 'send_failed' | 'send_rejected' };

export interface TelegramMediaPort {
  /**
   * Send ONE media group (2..10 items; caption rides ordinal 0 ONLY) and
   * return the per-item file_ids IN ORDINAL ORDER — the upload path's
   * sole source of fresh file_ids. (The REAL adapter wraps the client's
   * sendMediaGroupRich; tests fake it; the LIVE send is BLOCKED_LIVE.)
   */
  sendMediaGroup(
    chatId: string,
    items: readonly MediaGroupItemWireV1[],
  ): Promise<MediaGroupSendResultV1>;
}

export interface MediaUploadRightsPort {
  /** The 7.2 total rights decision (mrp1) — the service never re-implements it. */
  decide(input: MediaRightsInputV1): MediaRightsDecisionV1;
}
