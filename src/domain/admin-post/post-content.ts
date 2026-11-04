/**
 * R1.21 — the versioned POST-CONTENT document: the canonical, bounded
 * representation of ONE complete admin post version — optional SINGLE media
 * attachment (photo | video, by Telegram file_id) plus its rich-text content
 * (a text envelope for text-only posts, a caption envelope for media posts
 * that carry a caption).
 *
 * This document is WHAT IS STORED in `admin_post_versions.envelope_json` and
 * WHAT THE FINGERPRINT COVERS — media identity, caption text and caption
 * entities are all inside the fingerprint, so any later change to ANY part
 * of the version is detectable by re-deriving the fingerprint from the
 * stored bytes.
 *
 * Contract (mirrors the R1.19 envelope discipline):
 * - `createPostContentDocument` validates raw parts into the canonical
 *   versioned value. Invariants are structural, not conventions:
 *     media 'none'  <=> text envelope (kind 'text') present, no fileId,
 *                      no caption — a caption can NEVER exist without
 *                      media (a caption is never published alone);
 *     media 'photo'|'video' <=> a valid bounded fileId is REQUIRED, no text
 *                      envelope, caption OPTIONAL (a media post without a
 *                      caption is a valid distinct case).
 * - `serializePostContentDocument` produces the canonical JSON document,
 *   enforcing a total serialized-byte cap with a typed failure — never
 *   truncation-to-fit. Key order and shape are fixed by construction, so
 *   the serialization is deterministic (same content => same bytes).
 * - `readPostContentDocument` defensively re-reads a stored document:
 *   strict byte pre-checks, schemaVersion gate, FULL re-validation of every
 *   part (the nested envelopes through the shared envelope validator).
 *   LEGACY rows (R1.20-R1 text-only versions stored as a BARE envelope
 *   document) are read via the documented fallback and wrapped into the
 *   equivalent text-only document — the `legacy` read outcome carries the
 *   re-validated bare envelope so the caller can re-derive the legacy
 *   fingerprint EXACTLY the way R1.20-R1 stored it.
 *
 * The fileId is an opaque Telegram reference: bounded (printable ASCII,
 * 1..256 units, <=1024 UTF-8 bytes) and never interpreted. It is NOT a
 * guarantee of eternal availability — a send-time Bot API failure for an
 * invalid/expired/unusable file is an explicit, honest failure, never a
 * silent skip.
 *
 * Text identity stays ABSOLUTE inside both envelope kinds: the caption text
 * is preserved byte-for-byte with its UTF-16 offsets (no trim, no
 * normalization, no Markdown interpretation — raw Markdown remains out of
 * scope for the whole pipeline).
 */
import {
  RICH_TEXT_LIMITS,
  readRichTextEnvelope,
  readRichTextEnvelopeValue,
  serializeRichTextEnvelope,
  type RichTextEnvelope,
  type RichTextFailureReason,
  type RichTextOutcome,
} from '../telegram/rich-text-envelope';
import { fingerprintOfSerializedEnvelope } from './fingerprint';

/** The media kinds a post version may carry. */
export type PostMediaKind = 'none' | 'photo' | 'video';

/** Conservative APPLICATION caps for the post-content document. */
export const POST_CONTENT_LIMITS = {
  /** Telegram file_id application bound: printable ASCII, 1..256 units. */
  maxFileIdUnits: 256,
  /** file_id UTF-8 byte bound (redundant with the char bound, both enforced). */
  maxFileIdBytes: 1024,
  /**
   * Total serialized-document bound: the embedded envelope is already
   * individually capped; the document adds the media fields, so the total
   * cap is the envelope cap plus a conservative margin.
   */
  maxSerializedBytes: RICH_TEXT_LIMITS.maxSerializedBytes + 1024,
} as const;

export interface PostContentDocument {
  readonly schemaVersion: 1;
  readonly media: PostMediaKind;
  /** Present IFF media is 'photo' | 'video'. */
  readonly fileId: string | undefined;
  /** kind 'text'; present IFF media is 'none'. */
  readonly text: RichTextEnvelope | undefined;
  /** kind 'caption'; present IFF media is 'photo' | 'video' AND a caption exists. */
  readonly caption: RichTextEnvelope | undefined;
}

export type PostContentInput =
  | { readonly media: 'none'; readonly text: RichTextEnvelope }
  | {
      readonly media: 'photo' | 'video';
      readonly fileId: string;
      readonly caption?: RichTextEnvelope;
    };

export type PostContentFailureReason =
  /** media is not one of the three allowed kinds. */
  | 'invalid_media'
  /** fileId missing/out-of-bounds/characters for a media post. */
  | 'file_id_invalid'
  /** fileId carried by a text-only post. */
  | 'file_id_unexpected'
  /** the envelope kind does not match the media shape (caption without media, text with media). */
  | 'content_kind_mismatch'
  | 'serialized_too_large';

export type PostContentCreateOutcome =
  | { readonly ok: true; readonly document: PostContentDocument }
  | { readonly ok: false; readonly reason: PostContentFailureReason };

export type PostContentReadFailureReason =
  | 'malformed_json'
  | 'unsupported_version'
  | 'malformed_document'
  | 'serialized_too_large'
  | PostContentFailureReason
  | RichTextFailureReason;

export type PostContentReadOutcome =
  | {
      readonly ok: true;
      /** A current-format post-content document. */
      readonly kind: 'document';
      readonly document: PostContentDocument;
    }
  | {
      readonly ok: true;
      /**
       * A LEGACY bare-envelope row (R1.20-R1 text-only storage). `document`
       * is the equivalent text-only post-content document; `envelope` is the
       * re-validated bare envelope — the legacy fingerprint is re-derived
       * from ITS canonical serialization exactly as stored.
       */
      readonly kind: 'legacy';
      readonly document: PostContentDocument;
      readonly envelope: RichTextEnvelope;
    }
  | { readonly ok: false; readonly reason: PostContentReadFailureReason };

function isValidFileId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > POST_CONTENT_LIMITS.maxFileIdUnits
  ) {
    return false;
  }
  if (new TextEncoder().encode(value).byteLength > POST_CONTENT_LIMITS.maxFileIdBytes) {
    return false;
  }
  // Opaque reference, conservatively bounded: printable ASCII only (no
  // whitespace, no control characters, no non-ASCII). A real Telegram
  // file_id satisfies this; anything else is rejected EXPLICITLY (fail
  // closed) instead of being stored for a send that cannot succeed.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Validate raw parts into the canonical post-content document. Never
 * mutates its input; never throws; failures are typed.
 */
export function createPostContentDocument(input: PostContentInput): PostContentCreateOutcome {
  if (input.media === 'none') {
    if ('fileId' in input && input.fileId !== undefined) {
      return { ok: false, reason: 'file_id_unexpected' };
    }
    if ('caption' in input && input.caption !== undefined) {
      return { ok: false, reason: 'content_kind_mismatch' };
    }
    if (input.text.kind !== 'text') {
      return { ok: false, reason: 'content_kind_mismatch' };
    }
    return {
      ok: true,
      document: {
        schemaVersion: 1,
        media: 'none',
        fileId: undefined,
        text: input.text,
        caption: undefined,
      },
    };
  }
  if (input.media !== 'photo' && input.media !== 'video') {
    return { ok: false, reason: 'invalid_media' };
  }
  if (!isValidFileId(input.fileId)) {
    return { ok: false, reason: 'file_id_invalid' };
  }
  if ('text' in input && input.text !== undefined) {
    return { ok: false, reason: 'content_kind_mismatch' };
  }
  if (input.caption !== undefined && input.caption.kind !== 'caption') {
    return { ok: false, reason: 'content_kind_mismatch' };
  }
  return {
    ok: true,
    document: {
      schemaVersion: 1,
      media: input.media,
      fileId: input.fileId,
      text: undefined,
      caption: input.caption,
    },
  };
}

/** Envelope -> its canonical wire object (the exact serialized shape). */
function envelopeWire(envelope: RichTextEnvelope):
  | { readonly ok: true; readonly wire: Record<string, unknown> }
  | {
      readonly ok: false;
    } {
  const serialized = serializeRichTextEnvelope(envelope);
  if (!serialized.ok) {
    return { ok: false };
  }
  return { ok: true, wire: JSON.parse(serialized.json) as Record<string, unknown> };
}

/**
 * Canonical bounded serialization of the post-content document. The shape
 * and key order are fixed by construction (deterministic bytes); the
 * fingerprint over this JSON is the version's content proof.
 */
export function serializePostContentDocument(document: PostContentDocument):
  | { readonly ok: true; readonly json: string; readonly byteLength: number }
  | {
      readonly ok: false;
      readonly reason: 'serialized_too_large';
    } {
  const textWire =
    document.text === undefined ? { ok: true as const, wire: null } : envelopeWire(document.text);
  if (!textWire.ok) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  const captionWire =
    document.caption === undefined
      ? { ok: true as const, wire: null }
      : envelopeWire(document.caption);
  if (!captionWire.ok) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  const canonical = {
    schemaVersion: document.schemaVersion,
    media: document.media,
    fileId: document.fileId ?? null,
    text: textWire.wire,
    caption: captionWire.wire,
  };
  const json = JSON.stringify(canonical);
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength > POST_CONTENT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  return { ok: true, json, byteLength };
}

function readEnvelopeField(value: unknown): RichTextOutcome | undefined {
  if (value === null) {
    return undefined;
  }
  return readRichTextEnvelopeValue(value);
}

/**
 * Serialize + fingerprint in one step (R1.21): the `json` is what callers
 * must STORE, guaranteeing the fingerprint covers the media identity, the
 * caption text and the entities — the COMPLETE version content.
 */
export async function serializeAndFingerprintPostContent(
  document: PostContentDocument,
): Promise<
  | { readonly ok: true; readonly json: string; readonly fingerprint: string }
  | { readonly ok: false }
> {
  const serialized = serializePostContentDocument(document);
  if (!serialized.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    json: serialized.json,
    fingerprint: await fingerprintOfSerializedEnvelope(serialized.json),
  };
}

/**
 * Defensively re-read a stored post-content document. The LEGACY fallback
 * keeps R1.20-R1 text-only rows (bare envelope JSON) readable: they are
 * wrapped into the equivalent document and reported as `kind: 'legacy'`
 * with the re-validated bare envelope for exact legacy fingerprint
 * re-derivation. Nothing is ever repaired or silently reshaped — every
 * outcome is explicit.
 */
export function readPostContentDocument(json: string): PostContentReadOutcome {
  if (typeof json !== 'string' || json.length === 0) {
    return { ok: false, reason: 'malformed_document' };
  }
  // Chars <= bytes for UTF-8, so the char pre-check is a cheap bound first.
  if (json.length > POST_CONTENT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  if (new TextEncoder().encode(json).byteLength > POST_CONTENT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed_document' };
  }
  const record = parsed as Record<string, unknown>;
  if (!('media' in record)) {
    // LEGACY bare envelope row (R1.20-R1 format): a caption-kind bare
    // envelope can never be a complete text post and was never produced by
    // any capture path — it is a hard failure, not a wrapped media post.
    const legacy = readRichTextEnvelope(json);
    if (!legacy.ok) {
      return { ok: false, reason: legacy.reason };
    }
    if (legacy.envelope.kind !== 'text') {
      return { ok: false, reason: 'content_kind_mismatch' };
    }
    const wrapped = createPostContentDocument({ media: 'none', text: legacy.envelope });
    if (!wrapped.ok) {
      return { ok: false, reason: wrapped.reason };
    }
    return { ok: true, kind: 'legacy', document: wrapped.document, envelope: legacy.envelope };
  }

  // Current-format document: EVERY field is re-validated.
  if (record['schemaVersion'] !== 1) {
    return { ok: false, reason: 'unsupported_version' };
  }
  const media = record['media'];
  if (media !== 'none' && media !== 'photo' && media !== 'video') {
    return { ok: false, reason: 'invalid_media' };
  }
  const rawText = readEnvelopeField(record['text']);
  if (rawText !== undefined && !rawText.ok) {
    return { ok: false, reason: rawText.reason };
  }
  const rawCaption = readEnvelopeField(record['caption']);
  if (rawCaption !== undefined && !rawCaption.ok) {
    return { ok: false, reason: rawCaption.reason };
  }
  const rawFileId = record['fileId'];
  if (media === 'none') {
    if (rawFileId !== null && rawFileId !== undefined) {
      return { ok: false, reason: 'file_id_unexpected' };
    }
    if (rawText === undefined || rawText.envelope.kind !== 'text') {
      return { ok: false, reason: 'content_kind_mismatch' };
    }
    if (rawCaption !== undefined) {
      return { ok: false, reason: 'content_kind_mismatch' };
    }
    const rebuilt = createPostContentDocument({ media: 'none', text: rawText.envelope });
    if (!rebuilt.ok) {
      return { ok: false, reason: rebuilt.reason };
    }
    return { ok: true, kind: 'document', document: rebuilt.document };
  }
  if (!isValidFileId(rawFileId)) {
    return { ok: false, reason: 'file_id_invalid' };
  }
  if (rawText !== undefined) {
    return { ok: false, reason: 'content_kind_mismatch' };
  }
  if (rawCaption !== undefined && rawCaption.envelope.kind !== 'caption') {
    return { ok: false, reason: 'content_kind_mismatch' };
  }
  const rebuilt = createPostContentDocument({
    media,
    fileId: rawFileId,
    ...(rawCaption !== undefined ? { caption: rawCaption.envelope } : {}),
  });
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  return { ok: true, kind: 'document', document: rebuilt.document };
}
