/**
 * Phase 7.3 — the D1-backed MEDIA ASSET store over the BLUEPRINT-APPROVED
 * `media_assets` table (migration 0001 — NO parallel tables; ADR-0056).
 * The REAL durable half of the upload path: the integration tests drive
 * THIS over real workerd D1 (the fetch/storage/telegram ports are the
 * only fakes).
 *
 * House discipline:
 * - parameterized SQL ONLY (values are never logged — the DbExecutor
 *   contract; the IN-lists are BOUNDED: the upload path reads the plan's
 *   ≤10 URLs/hashes, the cleanup reads a bounded chunk);
 * - every read maps through the typed reader (`readMediaAssetRecordV1`) —
 *   a stored lie surfaces as a SKIP, never a guessed record;
 * - the rtp1 machine's durable invariant is enforced BY THE TABLE (the
 *   rows holding an R2 object are exactly the rows carrying expires_at —
 *   asserted again by the reader) and driven by the typed transitions;
 * - the reuse lookups ride the APPROVED indexes (idx_media_hash,
 *   idx_media_expiry) and the canonical_url match;
 * - `media_usages` (the per-publication ordinal record) is untouched by
 *   this store: it belongs to the publication slice that CONSUMES the
 *   uploaded assets.
 */

import type { DbExecutor } from './db-executor';
import { readMediaAssetRecordV1, type MediaAssetRecordV1 } from '../../domain/media/media-usage';
import type { MediaAssetStore } from '../../domain/media/media-ports';

const BOUNDED_IN_LIST = 32;

interface AssetDbRow {
  readonly id: string;
  readonly type: string;
  readonly canonical_url: string | null;
  readonly sha256: string | null;
  readonly visual_key: string | null;
  readonly rights_status: string;
  readonly r2_key: string | null;
  readonly telegram_file_id: string | null;
  readonly status: string;
  readonly expires_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function toAssetRecord(row: AssetDbRow): MediaAssetRecordV1 | null {
  const read = readMediaAssetRecordV1({
    id: row.id,
    type: row.type,
    canonicalUrl: row.canonical_url ?? undefined,
    sha256: row.sha256 ?? undefined,
    visualKey: row.visual_key ?? undefined,
    rightsStatus: row.rights_status,
    r2Key: row.r2_key ?? undefined,
    telegramFileId: row.telegram_file_id ?? undefined,
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return read.ok ? read.record : null;
}

export function createMediaAssetStore(executor: DbExecutor): MediaAssetStore {
  return {
    async findAssetsByUrls(urls) {
      if (urls.length === 0) return [];
      const bounded = urls.slice(0, BOUNDED_IN_LIST);
      const result = await executor.query<AssetDbRow>({
        sql: `SELECT id, type, canonical_url, sha256, visual_key, rights_status, r2_key, telegram_file_id, status, expires_at, created_at, updated_at
              FROM media_assets WHERE canonical_url IN (${placeholders(bounded.length)})`,
        params: [...bounded],
      });
      return result.rows
        .map(toAssetRecord)
        .filter((row): row is MediaAssetRecordV1 => row !== null);
    },

    async findAssetsByHashes(hashes) {
      const meaningful = hashes.filter((hash) => typeof hash === 'string' && hash.length > 0);
      if (meaningful.length === 0) return [];
      const bounded = meaningful.slice(0, BOUNDED_IN_LIST);
      const result = await executor.query<AssetDbRow>({
        sql: `SELECT id, type, canonical_url, sha256, visual_key, rights_status, r2_key, telegram_file_id, status, expires_at, created_at, updated_at
              FROM media_assets WHERE sha256 IN (${placeholders(bounded.length)})`,
        params: [...bounded],
      });
      return result.rows
        .map(toAssetRecord)
        .filter((row): row is MediaAssetRecordV1 => row !== null);
    },

    async findExpiredAssets(nowMs, limit) {
      const bounded = Math.max(1, Math.min(64, limit));
      const result = await executor.query<AssetDbRow>({
        sql: `SELECT id, type, canonical_url, sha256, visual_key, rights_status, r2_key, telegram_file_id, status, expires_at, created_at, updated_at
              FROM media_assets
              WHERE r2_key IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?
              ORDER BY expires_at ASC
              LIMIT ${bounded}`,
        params: [nowMs],
      });
      return result.rows
        .map(toAssetRecord)
        .filter((row): row is MediaAssetRecordV1 => row !== null);
    },

    async insertAsset(record, mime) {
      const result = await executor.run({
        sql: `INSERT INTO media_assets
                (id, type, canonical_url, sha256, visual_key, rights_status, mime_type, r2_key, status, expires_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
        params: [
          record.id,
          record.type,
          record.canonicalUrl ?? null,
          record.sha256 ?? null,
          record.visualKey ?? null,
          record.rightsStatus,
          mime,
          record.r2Key ?? null,
          record.expiresAt ?? null,
          record.createdAt,
          record.updatedAt,
        ],
      });
      return result.changes >= 1 ? { ok: true } : { ok: false, reason: 'asset_write_failed' };
    },

    async markUploaded(id, fileId, updatedAtMs) {
      // The blueprint step-10 rule IN ONE TRANSITION: the file_id is saved
      // (the ledger value), the temporary R2 object is cleared (r2_key +
      // expires_at NULL — the object is deleted by the caller right after),
      // and the asset's status becomes 'uploaded' — the durable ledger row.
      const result = await executor.run({
        sql: `UPDATE media_assets
                 SET telegram_file_id = ?, r2_key = NULL, expires_at = NULL, status = 'uploaded', updated_at = ?
               WHERE id = ?`,
        params: [fileId, updatedAtMs, id],
      });
      return result.changes >= 1 ? { ok: true } : { ok: false, reason: 'asset_write_failed' };
    },

    async markFailed(id, updatedAtMs) {
      const result = await executor.run({
        sql: `UPDATE media_assets SET status = 'failed', updated_at = ? WHERE id = ?`,
        params: [updatedAtMs, id],
      });
      return result.changes >= 1 ? { ok: true } : { ok: false, reason: 'asset_write_failed' };
    },

    async clearExpired(id, updatedAtMs) {
      const result = await executor.run({
        sql: `UPDATE media_assets
                 SET r2_key = NULL, expires_at = NULL, status = 'expired', updated_at = ?
               WHERE id = ?`,
        params: [updatedAtMs, id],
      });
      return result.changes >= 1 ? { ok: true } : { ok: false, reason: 'asset_write_failed' };
    },
  };
}
