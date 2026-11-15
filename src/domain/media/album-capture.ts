/**
 * Phase 9D — the album CAPTURE session state machine (ac1).
 *
 * The pure half of the album-draft CAPTURE surface: the argument grammar
 * of `/album_capture`, the bounded session-state shape, and the TOTAL item
 * append rules. The capture is EVIDENCE GATHERING — every item is recorded
 * candidate + rights-unknown downstream (OD-010: the machine invents no
 * permission); this module never touches rights, publication, or transport.
 *
 * Pure: no I/O, no clock, no SQL, no randomness.
 */

/** The capture state/schema version (the state_json reader's pin). */
export const ALBUM_CAPTURE_VERSION = 'ac1' as const;

/** The session TTL (bounded — an abandoned session expires honestly). */
export const ALBUM_CAPTURE_SESSION_TTL_MS = 15 * 60 * 1000;

/** The Telegram media-group bound (MAX_MEDIA_GROUP_ORDINAL 9 => 10 items). */
export const ALBUM_CAPTURE_MAX_ITEMS = 10;
/** An album is a media GROUP: fewer than 2 members is not an album. */
export const ALBUM_CAPTURE_MIN_ITEMS = 2;

/** The bounded file_id cap (the parser's own bound — mirrored, never re-derived). */
export const ALBUM_CAPTURE_FILE_ID_MAX_CHARS = 256;
/** The bounded synthetic canonical identity of one captured item. */
export const ALBUM_CAPTURE_CANONICAL_MAX_UNITS = 128;
/** The bounded story-reference shape (the stories-table PK reality). */
export const ALBUM_CAPTURE_STORY_ID_MAX_UNITS = 128;

/** The admin_sessions flow name of this surface. */
export const ALBUM_CAPTURE_SESSION_FLOW = 'album_capture' as const;

export type AlbumCaptureKind = 'photo' | 'video';

export interface AlbumCaptureItem {
  readonly ordinal: number;
  readonly kind: AlbumCaptureKind;
  readonly fileId: string;
}

export interface AlbumCaptureState {
  readonly version: 'ac1';
  readonly storyId: string;
  readonly items: readonly AlbumCaptureItem[];
  /** The FIRST caption-carrying member's plain text (the ordinal-0 caption rule). */
  readonly captionText?: string;
}

export type AlbumCaptureArgumentParse =
  | { readonly kind: 'start'; readonly storyId: string }
  | { readonly kind: 'finish' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'status' }
  | { readonly kind: 'invalid' };

function isBoundedUnits(value: unknown, maxUnits: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxUnits;
}

/** The whole-token grammar shared with the queue/story surfaces. */
function isValidWholeToken(value: string, maxBytes: number): boolean {
  if (/\s/u.test(value)) return false;
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0 || bytes.length > maxBytes) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * The `/album_capture` argument grammar. A grammar failure happens BEFORE
 * any query could exist; the raw text is never echoed back.
 */
export function parseAlbumCaptureArgument(
  remainder: string | undefined,
): AlbumCaptureArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'status' };
  }
  if (remainder === 'finish') return { kind: 'finish' };
  if (remainder === 'cancel') return { kind: 'cancel' };
  if (isValidWholeToken(remainder, ALBUM_CAPTURE_STORY_ID_MAX_UNITS)) {
    // A reserved word is never a story id (the grammar is unambiguous).
    if (remainder === 'status') return { kind: 'invalid' };
    return { kind: 'start', storyId: remainder };
  }
  return { kind: 'invalid' };
}

/**
 * Validate the session state read from `admin_sessions.state_json`. The
 * reader is TOTAL: a corrupt/foreign shape is INVALID (never repaired,
 * never silently truncated) — the surface refuses and the session can be
 * restarted explicitly.
 */
export function readAlbumCaptureState(value: unknown):
  | { readonly ok: true; readonly state: AlbumCaptureState }
  | {
      readonly ok: false;
      readonly reason: 'not_json_object' | 'not_version_ac1' | 'shape_invalid';
    } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_json_object' };
  }
  const record = value as Record<string, unknown>;
  if (record['version'] !== 'ac1') {
    return { ok: false, reason: 'not_version_ac1' };
  }
  const storyId = record['storyId'];
  if (!isBoundedUnits(storyId, ALBUM_CAPTURE_STORY_ID_MAX_UNITS)) {
    return { ok: false, reason: 'shape_invalid' };
  }
  const items = record['items'];
  if (!Array.isArray(items) || items.length > ALBUM_CAPTURE_MAX_ITEMS) {
    return { ok: false, reason: 'shape_invalid' };
  }
  const parsed: AlbumCaptureItem[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, reason: 'shape_invalid' };
    }
    const entry = item as Record<string, unknown>;
    const ordinal = entry['ordinal'];
    const kind = entry['kind'];
    const fileId = entry['fileId'];
    if (
      typeof ordinal !== 'number' ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      (kind !== 'photo' && kind !== 'video') ||
      !isBoundedUnits(fileId, ALBUM_CAPTURE_FILE_ID_MAX_CHARS)
    ) {
      return { ok: false, reason: 'shape_invalid' };
    }
    parsed.push({ ordinal, kind, fileId });
  }
  const captionText = record['captionText'];
  if (captionText !== undefined && !isBoundedUnits(captionText, 1024)) {
    return { ok: false, reason: 'shape_invalid' };
  }
  return {
    ok: true,
    state: {
      version: 'ac1',
      storyId,
      items: parsed,
      ...(captionText !== undefined ? { captionText } : {}),
    },
  };
}

export type AppendCaptureItemResult =
  | { readonly ok: true; readonly state: AlbumCaptureState }
  | {
      readonly ok: false;
      readonly reason: 'state_invalid' | 'kind_unsupported' | 'album_full' | 'duplicate_item';
    };

/**
 * The TOTAL append rule over the CURRENT state: photo/video only, the
 * 2..10 media-group bound, the one-caption rule (the FIRST caption-carrying
 * member wins — later captions are noted, never swapped), a duplicate
 * file_id refuses typed (a real redelivery is already deduped by the
 * update-claims layer — a same-session duplicate is an anomaly).
 */
export function appendCaptureItem(
  state: unknown,
  item: { readonly kind: string; readonly fileId: string },
  captionText?: string,
): AppendCaptureItemResult {
  const read = readAlbumCaptureState(state);
  if (!read.ok) {
    return { ok: false, reason: 'state_invalid' };
  }
  const current = read.state;
  if (item.kind !== 'photo' && item.kind !== 'video') {
    return { ok: false, reason: 'kind_unsupported' };
  }
  if (!isBoundedUnits(item.fileId, ALBUM_CAPTURE_FILE_ID_MAX_CHARS)) {
    return { ok: false, reason: 'kind_unsupported' };
  }
  if (current.items.length >= ALBUM_CAPTURE_MAX_ITEMS) {
    return { ok: false, reason: 'album_full' };
  }
  if (current.items.some((existing) => existing.fileId === item.fileId)) {
    return { ok: false, reason: 'duplicate_item' };
  }
  const next: AlbumCaptureState = {
    version: 'ac1',
    storyId: current.storyId,
    items: [
      ...current.items,
      { ordinal: current.items.length, kind: item.kind, fileId: item.fileId },
    ],
    ...(current.captionText !== undefined
      ? { captionText: current.captionText }
      : captionText !== undefined && isBoundedUnits(captionText, 1024)
        ? { captionText }
        : {}),
  };
  return { ok: true, state: next };
}

/**
 * The synthetic canonical identity of one captured item: deterministic,
 * bounded, and from a namespace a REAL source URL can never collide with —
 * the reuse predicate's URL matching stays honest (a captured candidate is
 * never mistaken for an uploaded source asset).
 */
export function capturedItemCanonicalUrl(sessionId: string, ordinal: number): string {
  return `album-capture:${sessionId}/${ordinal}`;
}
