/**
 * Phase 7.3 — the ALBUM CONTENT DOCUMENT (the "album media kind": the
 * blueprint §14 step 7 «Album: 2–10 compatible items; caption only on
 * ordinal 0» as a VERSIONED, PERSISTABLE document model).
 *
 * THE 7.1 PRESERVATION CONDITIONS, STRUCTURALLY:
 * - the caption rides ONLY ordinal 0 (the caption travels OUTSIDE the
 *   items list — there is NO per-item caption field to even misuse; the
 *   transport places it on the ordinal-0 media group item and NOWHERE
 *   else — the no-separation layer EXTENDED, never weakened);
 * - an album is a NEW kind, NOT a loosening of the existing single-media
 *   kinds: the existing `PostContentDocument` (none/photo/video) is
 *   UNTOUCHED — this is a SIBLING document for the post pipeline's later
 *   album slice;
 * - the only legal CONSTRUCTION path maps a 7.2 `MediaAlbumPlanV1` (the
 *   alp1 shape: items already ordered, ≤2-per-visualKey and ≤10 caps
 *   already applied) PLUS the upload path's resolved per-item file_ids
 *   into the document — a hand-built item list outside the plan
 *   discipline has no entry point;
 * - every item's fileId re-validates under the EXISTING bounded
 *   printable-ASCII contract (1..256 units, ≤1024 UTF-8 bytes — the same
 *   opaque reference discipline as post-content).
 *
 * FINGERPRINT: the deterministic serialization covers EVERY item (kind +
 * fileId + canonicalUrl + ordinal) and the caption — any change anywhere
 * is a different fingerprint, so the send-integrity layer can bind
 * approvals to the WHOLE album without special-casing.
 *
 * BOUNDARY: pure — no I/O, no Telegram client types. The sendMediaGroup
 * transport and the post-pipeline integration are the later slices
 * (recorded in the roadmap).
 */

import {
  RICH_TEXT_LIMITS,
  readRichTextEnvelopeValue,
  serializeRichTextEnvelope,
  type RichTextEnvelope,
} from '../telegram/rich-text-envelope';
import { fingerprintOfSerializedEnvelope } from '../admin-post/fingerprint';
import { readMediaCandidateV1, type MediaCandidateV1 } from './media-candidate';
import type { MediaAlbumPlanV1 } from './album-plan';

export type AlbumItemKindV1 = 'photo' | 'video';

export interface AlbumContentItemV1 {
  readonly kind: AlbumItemKindV1;
  readonly fileId: string;
  /** The item's canonical source URL provenance (the ledger anchor). */
  readonly canonicalUrl: string;
}

export interface AlbumContentDocumentV1 {
  readonly schemaVersion: 1;
  readonly media: 'album';
  readonly items: readonly AlbumContentItemV1[];
  /** kind 'caption'; present IFF the album carries a caption (ordinal 0 ONLY). */
  readonly caption?: RichTextEnvelope;
}

export type AlbumContentReasonV1 =
  | 'album_plan_required'
  | 'album_items_out_of_bounds'
  | 'album_file_ids_mismatched'
  | 'album_file_id_invalid'
  | 'album_caption_kind_invalid'
  | 'album_url_not_canonical'
  | 'album_serialized_too_large'
  | 'album_read_malformed'
  | 'album_read_version_unsupported';

export type AlbumContentCreateOutcome =
  | { ok: true; document: AlbumContentDocumentV1; serialized: string; fingerprint: string }
  | { ok: false; reason: AlbumContentReasonV1 };

export type AlbumContentReadOutcome =
  | { ok: true; document: AlbumContentDocumentV1; fingerprint: string }
  | { ok: false; reason: AlbumContentReasonV1 };

/** Conservative APPLICATION caps for the album document. */
export const ALBUM_CONTENT_LIMITS = {
  /** The Bot API media group: 2..10 items (blueprint §14 step 7). */
  minItems: 2,
  maxItems: 10,
  /** The EXISTING file_id contract (printable ASCII 1..256 units, ≤1024 UTF-8 bytes). */
  maxFileIdUnits: 256,
  maxFileIdBytes: 1024,
  /** The canonical source URL bound (same as the candidate contract). */
  maxUrlUnits: 2048,
  /** The serialized-document bound: the caption envelope cap + a conservative album margin. */
  maxSerializedBytes: RICH_TEXT_LIMITS.maxSerializedBytes * 4,
} as const;

const FILE_ID_PATTERN = /^[ -~]+$/;

function isBoundedFileId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > ALBUM_CONTENT_LIMITS.maxFileIdUnits
  ) {
    return false;
  }
  if (!FILE_ID_PATTERN.test(value)) return false;
  return new TextEncoder().encode(value).byteLength <= ALBUM_CONTENT_LIMITS.maxFileIdBytes;
}

function isBoundedUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= ALBUM_CONTENT_LIMITS.maxUrlUnits
  );
}

function isCaptionEnvelope(value: RichTextEnvelope | undefined): boolean {
  if (value === undefined) return true;
  const read = readRichTextEnvelopeValue(value as unknown);
  return read.ok && read.envelope.kind === 'caption';
}

/**
 * The ONLY legal construction path: a 7.2 album plan (alp1) + the upload
 * path's per-ordinal resolved file_ids (+ the optional ordinal-0 caption)
 * mapped into the album content document. Re-validates EVERYTHING
 * (defense in depth) and fails typed; never truncates.
 */
export async function createAlbumContentDocument(
  plan: MediaAlbumPlanV1,
  fileIds: readonly string[],
  caption?: RichTextEnvelope,
): Promise<AlbumContentCreateOutcome> {
  if (
    typeof plan !== 'object' ||
    plan === null ||
    plan.schemaVersion !== 1 ||
    plan.planningVersion !== 'alp1'
  ) {
    return { ok: false, reason: 'album_plan_required' };
  }
  if (
    !Array.isArray(plan.items) ||
    !Array.isArray(fileIds) ||
    plan.items.length !== fileIds.length
  ) {
    return { ok: false, reason: 'album_file_ids_mismatched' };
  }
  const planItems = plan.items;
  if (
    planItems.length < ALBUM_CONTENT_LIMITS.minItems ||
    planItems.length > ALBUM_CONTENT_LIMITS.maxItems
  ) {
    return { ok: false, reason: 'album_items_out_of_bounds' };
  }
  if (!isCaptionEnvelope(caption)) {
    return { ok: false, reason: 'album_caption_kind_invalid' };
  }
  const items: AlbumContentItemV1[] = [];
  for (let index = 0; index < planItems.length; index += 1) {
    const planItem = planItems[index]!;
    // Re-validate the candidate through ITS OWN strict reader (the plan is
    // trusted input, the document is the persisted artifact).
    const candidate: { ok: true; candidate: MediaCandidateV1 } | { ok: false } =
      readMediaCandidateV1(planItem.candidate);
    if (!candidate.ok) return { ok: false, reason: 'album_url_not_canonical' };
    if (planItem.ordinal !== index) return { ok: false, reason: 'album_items_out_of_bounds' };
    // The plan's caption contract: allowed ONLY at ordinal 0.
    if ((planItem.ordinal === 0) !== (planItem.captionAllowed === true)) {
      return { ok: false, reason: 'album_caption_kind_invalid' };
    }
    const fileId = fileIds[index]!;
    if (!isBoundedFileId(fileId)) return { ok: false, reason: 'album_file_id_invalid' };
    if (!isBoundedUrl(candidate.candidate.canonicalUrl))
      return { ok: false, reason: 'album_url_not_canonical' };
    items.push({
      kind: candidate.candidate.kind,
      fileId,
      canonicalUrl: candidate.candidate.canonicalUrl,
    });
  }
  const document: AlbumContentDocumentV1 = {
    schemaVersion: 1,
    media: 'album',
    items,
    ...(caption !== undefined ? { caption } : {}),
  };
  const serialized = serializeAlbumContentDocument(document);
  if (serialized === null) return { ok: false, reason: 'album_serialized_too_large' };
  if (new TextEncoder().encode(serialized).byteLength > ALBUM_CONTENT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'album_serialized_too_large' };
  }
  const fingerprint = await fingerprintOfSerializedEnvelope(serialized);
  return { ok: true, document, serialized, fingerprint };
}

/**
 * The canonical deterministic serialization (fixed key order; the EXACT
 * bytes a caller stores — the fingerprint can always be re-derived from
 * the stored document). NULL = the caption failed to serialize (a stored
 * lie — the caller maps it to its typed failure).
 */
export function serializeAlbumContentDocument(document: AlbumContentDocumentV1): string | null {
  const items = document.items.map((item) => ({
    kind: item.kind,
    fileId: item.fileId,
    canonicalUrl: item.canonicalUrl,
  }));
  const body: Record<string, unknown> = {
    schemaVersion: document.schemaVersion,
    media: document.media,
    items,
  };
  if (document.caption !== undefined) {
    const caption = serializeRichTextEnvelope(document.caption);
    if (!caption.ok) return null;
    body['caption'] = JSON.parse(caption.json);
  }
  return JSON.stringify(body);
}

/**
 * The strict typed reader (fail-closed): a claimed album document that
 * does not re-derive every invariant — bounds, kinds, URL/fileId
 * discipline, caption-envelope kind, exact key set — is malformed; a
 * wrong/absent version is version-unsupported/malformed. NEVER a crash,
 * never a guessed document.
 */
export async function readAlbumContentDocumentV1(value: unknown): Promise<AlbumContentReadOutcome> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'album_read_malformed' };
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] === undefined || record['schemaVersion'] === null) {
    return { ok: false, reason: 'album_read_malformed' };
  }
  if (record['schemaVersion'] !== 1) {
    return { ok: false, reason: 'album_read_version_unsupported' };
  }
  if (record['media'] !== 'album') return { ok: false, reason: 'album_read_malformed' };
  if (!Array.isArray(record['items'])) return { ok: false, reason: 'album_read_malformed' };
  const rawItems = record['items'] as readonly unknown[];
  if (
    rawItems.length < ALBUM_CONTENT_LIMITS.minItems ||
    rawItems.length > ALBUM_CONTENT_LIMITS.maxItems
  ) {
    return { ok: false, reason: 'album_items_out_of_bounds' };
  }
  const items: AlbumContentItemV1[] = [];
  for (const rawItem of rawItems) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      return { ok: false, reason: 'album_read_malformed' };
    }
    const itemRecord = rawItem as Record<string, unknown>;
    const itemKeys = Object.keys(itemRecord);
    if (
      itemKeys.length !== 3 ||
      !itemKeys.includes('kind') ||
      !itemKeys.includes('fileId') ||
      !itemKeys.includes('canonicalUrl')
    ) {
      return { ok: false, reason: 'album_read_malformed' };
    }
    const kind = itemRecord['kind'];
    if (kind !== 'photo' && kind !== 'video') return { ok: false, reason: 'album_read_malformed' };
    if (!isBoundedFileId(itemRecord['fileId']))
      return { ok: false, reason: 'album_file_id_invalid' };
    if (!isBoundedUrl(itemRecord['canonicalUrl']))
      return { ok: false, reason: 'album_url_not_canonical' };
    items.push({
      kind: kind as AlbumItemKindV1,
      fileId: itemRecord['fileId'] as string,
      canonicalUrl: itemRecord['canonicalUrl'] as string,
    });
  }
  let caption: RichTextEnvelope | undefined;
  if (record['caption'] !== undefined) {
    const captionRead = readRichTextEnvelopeValue(record['caption']);
    if (!captionRead.ok) return { ok: false, reason: 'album_caption_kind_invalid' };
    if (captionRead.envelope.kind !== 'caption')
      return { ok: false, reason: 'album_caption_kind_invalid' };
    caption = captionRead.envelope;
  }
  const allowedTopKeys = new Set(['schemaVersion', 'media', 'items', 'caption']);
  for (const key of Object.keys(record)) {
    if (!allowedTopKeys.has(key)) return { ok: false, reason: 'album_read_malformed' };
  }
  const document: AlbumContentDocumentV1 = {
    schemaVersion: 1,
    media: 'album',
    items,
    ...(caption !== undefined ? { caption } : {}),
  };
  const serialized = serializeAlbumContentDocument(document);
  if (serialized === null) return { ok: false, reason: 'album_read_malformed' };
  if (new TextEncoder().encode(serialized).byteLength > ALBUM_CONTENT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'album_serialized_too_large' };
  }
  const fingerprint = await fingerprintOfSerializedEnvelope(serialized);
  return { ok: true, document, fingerprint };
}

/** SHA-256 hex over the canonical serialization (the send-integrity anchor). */
export async function fingerprintAlbumContentDocument(
  document: AlbumContentDocumentV1,
): Promise<string> {
  const serialized = serializeAlbumContentDocument(document);
  if (serialized === null) return '';
  return fingerprintOfSerializedEnvelope(serialized);
}
