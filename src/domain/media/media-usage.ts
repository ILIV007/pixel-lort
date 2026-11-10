/**
 * Phase 7.3 — the media ASSET domain layer over the BLUEPRINT-APPROVED
 * durable schema (migration 0001's `media_assets` — the §3 `domain/media`
 * "Media candidate, rights state, album plan and usage history" plan — and
 * `media_usages`, the per-publication ordinal record). The DELIBERATE
 * design decision (ADR-0056): the approved blueprint tables ARE the ledger
 * + staging anchor — NO parallel tables were created. The mapping:
 *
 *   media_assets.canonical_url / sha256  ⇔ the ledger keys (the EXACT
 *     identity-grade dedup: URL and content hash);
 *   media_assets.telegram_file_id        ⇔ the LEDGER VALUE (a saved
 *     file_id — its presence IS "uploaded, reusable");
 *   media_assets.r2_key + expires_at     ⇔ the rtp1 STAGING state (a
 *     non-null r2_key = the temporary object still exists; expires_at =
 *     the deterministic 72h retention deadline, blueprint §23);
 *   media_assets.status                  ⇔ the DURABLE lifecycle
 *     vocabulary ('candidate' = staged, 'validated' = checked, 'selected'
 *     = chosen, 'uploaded' = file_id saved, 'failed', 'blocked',
 *     'expired' = the retention cleanup ran) — the rtp1 policy machine
 *     MAPS onto this vocabulary (ADR-0056 §mapping; the machine stays the
 *     policy-level truth, the table stays the durable truth);
 *   media_assets.rights_status           ⇔ the mrp1 decision's durable
 *     echo.
 *
 * This module is the PURE layer:
 * - the strict typed reader for an asset row (fail-closed — a claimed row
 *   that does not re-derive the invariants is skipped by the store, never
 *   guessed);
 * - `resolveAssetReuse` — the TOTAL per-item resolution: EXACT
 *   canonical-url or EXACT sha256 equality against an UPLOADED asset (a
 *   saved file_id) reuses it; anything else must be freshly staged. URL
 *   similarity NEVER establishes identity (the 5.3 lesson);
 * - `selectExpiredAssets` — the pure retention-cleanup selection
 *   (blueprint §23 «temporary R2: 72 hours»): exactly the rows still
 *   HOLDING an R2 object whose deadline has passed, oldest-first, capped.
 *
 * BOUNDARY: pure — no I/O, no clock (timestamps arrive as numbers).
 */

export type MediaAssetTypeV1 = 'photo' | 'video';

export type MediaAssetStatusV1 =
  'candidate' | 'validated' | 'selected' | 'uploaded' | 'failed' | 'blocked' | 'expired';

export type MediaRightsStatusV1 =
  'official' | 'licensed' | 'attribution_required' | 'unknown' | 'blocked';

export interface MediaAssetRecordV1 {
  readonly id: string;
  readonly type: MediaAssetTypeV1;
  readonly canonicalUrl?: string;
  readonly sha256?: string;
  readonly visualKey?: string;
  readonly rightsStatus: MediaRightsStatusV1;
  readonly r2Key?: string;
  readonly telegramFileId?: string;
  readonly status: MediaAssetStatusV1;
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type AssetReadReasonV1 = 'asset_record_malformed';

const OPAQUE_BOUND = 256;
const URL_BOUND = 2048;
const KEY_BOUND = 512;
const TIME_BOUND = 253402300799000; // year 9999

function isBoundedOpaque(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= OPAQUE_BOUND &&
    /^[ -~]+$/.test(value)
  );
}

function isBoundedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= KEY_BOUND;
}

function isBoundedUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= URL_BOUND;
}

function isBoundedTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= TIME_BOUND;
}

const TYPES: readonly MediaAssetTypeV1[] = ['photo', 'video'];
const STATUSES: readonly MediaAssetStatusV1[] = [
  'candidate',
  'validated',
  'selected',
  'uploaded',
  'failed',
  'blocked',
  'expired',
];
const RIGHTS: readonly MediaRightsStatusV1[] = [
  'official',
  'licensed',
  'attribution_required',
  'unknown',
  'blocked',
];

/**
 * The strict typed reader for a media_assets row. The rtp1 machine's
 * durable invariant is re-derived: a row HOLDING an R2 object must carry
 * expires_at; an UPLOADED row must carry its telegram_file_id.
 */
export function readMediaAssetRecordV1(
  value: unknown,
): { ok: true; record: MediaAssetRecordV1 } | { ok: false; reason: AssetReadReasonV1 } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const type = record['type'];
  const rightsStatus = record['rightsStatus'];
  const status = record['status'];
  const createdAt = record['createdAt'];
  const updatedAt = record['updatedAt'];
  if (typeof id !== 'string' || id.length < 1 || id.length > 128)
    return { ok: false, reason: 'asset_record_malformed' };
  if (!TYPES.includes(type as MediaAssetTypeV1))
    return { ok: false, reason: 'asset_record_malformed' };
  if (!RIGHTS.includes(rightsStatus as MediaRightsStatusV1))
    return { ok: false, reason: 'asset_record_malformed' };
  if (!STATUSES.includes(status as MediaAssetStatusV1))
    return { ok: false, reason: 'asset_record_malformed' };
  if (!isBoundedTime(createdAt) || !isBoundedTime(updatedAt))
    return { ok: false, reason: 'asset_record_malformed' };
  if (record['canonicalUrl'] !== undefined && !isBoundedUrl(record['canonicalUrl'])) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  if (record['sha256'] !== undefined && !isBoundedOpaque(record['sha256'])) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  if (record['visualKey'] !== undefined && !isBoundedOpaque(record['visualKey'])) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  if (record['r2Key'] !== undefined && !isBoundedKey(record['r2Key'])) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  if (record['telegramFileId'] !== undefined && !isBoundedOpaque(record['telegramFileId'])) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  if (record['expiresAt'] !== undefined && !isBoundedTime(record['expiresAt'])) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  // The durable rtp1 invariant: holding an R2 object ⇔ carrying a deadline.
  const r2Key = record['r2Key'];
  const expiresAt = record['expiresAt'];
  if ((r2Key !== undefined) !== (expiresAt !== undefined)) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  // An UPLOADED row always carries its ledger value.
  if (status === 'uploaded' && record['telegramFileId'] === undefined) {
    return { ok: false, reason: 'asset_record_malformed' };
  }
  const allowedKeys = new Set([
    'id',
    'type',
    'canonicalUrl',
    'sha256',
    'visualKey',
    'rightsStatus',
    'r2Key',
    'telegramFileId',
    'status',
    'expiresAt',
    'createdAt',
    'updatedAt',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) return { ok: false, reason: 'asset_record_malformed' };
  }
  return {
    ok: true,
    record: {
      id: id as string,
      type: type as MediaAssetTypeV1,
      rightsStatus: rightsStatus as MediaRightsStatusV1,
      status: status as MediaAssetStatusV1,
      createdAt: createdAt as number,
      updatedAt: updatedAt as number,
      ...(record['canonicalUrl'] !== undefined
        ? { canonicalUrl: record['canonicalUrl'] as string }
        : {}),
      ...(record['sha256'] !== undefined ? { sha256: record['sha256'] as string } : {}),
      ...(record['visualKey'] !== undefined ? { visualKey: record['visualKey'] as string } : {}),
      ...(record['r2Key'] !== undefined ? { r2Key: record['r2Key'] as string } : {}),
      ...(record['telegramFileId'] !== undefined
        ? { telegramFileId: record['telegramFileId'] as string }
        : {}),
      ...(record['expiresAt'] !== undefined ? { expiresAt: record['expiresAt'] as number } : {}),
    },
  };
}

export type ReuseResolutionV1 =
  /** An UPLOADED asset already holds this media: reuse the file_id, stage NOTHING. */
  | {
      readonly item: number;
      readonly outcome: 'reuse';
      readonly fileId: string;
      readonly matchedBy: 'canonical_url' | 'sha256';
    }
  /** No uploaded-asset hit: the item must be freshly staged (rights + lifecycle next). */
  | { readonly item: number; readonly outcome: 'stage' };

export interface ReuseResolvableItem {
  readonly canonicalUrl: string;
  readonly sha256?: string;
}

/**
 * The TOTAL per-item reuse resolution (the upload economy's decision
 * rule): EXACT canonical-url or EXACT sha256 equality against an UPLOADED
 * asset (a saved telegram_file_id) reuses it; anything else is a `stage`
 * outcome. Deterministic: the FIRST matching row in the given order wins.
 */
export function resolveAssetReuse(
  items: readonly ReuseResolvableItem[],
  assets: readonly MediaAssetRecordV1[],
): readonly ReuseResolutionV1[] {
  return items.map((item, index) => {
    for (const row of assets) {
      if (row.telegramFileId === undefined) continue; // only UPLOADED assets carry a reusable file_id
      if (row.canonicalUrl !== undefined && row.canonicalUrl === item.canonicalUrl) {
        return {
          item: index,
          outcome: 'reuse' as const,
          fileId: row.telegramFileId,
          matchedBy: 'canonical_url' as const,
        };
      }
    }
    if (item.sha256 !== undefined) {
      for (const row of assets) {
        if (
          row.telegramFileId !== undefined &&
          row.sha256 !== undefined &&
          row.sha256 === item.sha256
        ) {
          return {
            item: index,
            outcome: 'reuse' as const,
            fileId: row.telegramFileId,
            matchedBy: 'sha256' as const,
          };
        }
      }
    }
    return { item: index, outcome: 'stage' as const };
  });
}

export interface ExpirableAssetRow {
  readonly id: string;
  readonly r2Key?: string;
  readonly expiresAt?: number;
}

/**
 * The pure retention-cleanup selection (blueprint §23): exactly the rows
 * still HOLDING an R2 object whose deadline has passed, OLDEST-DEADLINE-
 * FIRST, capped at `limit` (a bounded batch — chunked, never a sweep).
 */
export function selectExpiredAssets(
  rows: readonly ExpirableAssetRow[],
  nowMs: number,
  limit: number,
): readonly string[] {
  return rows
    .filter(
      (row) => row.r2Key !== undefined && row.expiresAt !== undefined && row.expiresAt <= nowMs,
    )
    .sort((a, b) => {
      const aDeadline = a.expiresAt ?? 0;
      const bDeadline = b.expiresAt ?? 0;
      return aDeadline === bDeadline ? (a.id < b.id ? -1 : 1) : aDeadline - bDeadline;
    })
    .slice(0, Math.max(0, limit))
    .map((row) => row.id);
}
