/**
 * Slice 7 — the EDIT MEDIA GUARD (DESIGN §10.2/§10.3: media files are
 * NEVER replaced by edit, only the caption).
 *
 * The Bot API cannot replace a message's media with an edit — there is
 * no editMessageMedia on the edit transport at all
 * (`PublicationEditTransport` exposes ONLY editMessageTextRich and
 * editMessageCaptionRich). This guard is the defense-in-depth check the
 * correction engine runs over every planned edit BEFORE any transport
 * call: an edit is legal IFF its shape is `text` or `caption`, its
 * content carries no media reference, and NO media field rides anywhere
 * on the edit object (top level or inside content).
 *
 * A smuggled media payload refuses the WHOLE pass typed
 * (`media_replacement_refused`) with ZERO transport calls — the caller
 * must re-plan the correction as a caption-only edit (or a delete +
 * re-send, which is a different, explicitly approved action).
 *
 * BOUNDARY: pure — no I/O, no clock, no SQL, no Telegram/R2/KV types.
 * TOTAL over its inputs: runtime-invalid values fail typed, never throw.
 */

/** Own-property names that would carry a media replacement. */
const MEDIA_FIELD_NAMES = new Set([
  'media',
  'fileId',
  'file_id',
  'photo',
  'video',
  'document',
  'animation',
  'audio',
  'voice',
  'video_note',
  'sticker',
]);

export type MediaEditGuardReason = 'invalid_input' | 'media_replacement_refused';

export type MediaEditGuardOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: MediaEditGuardReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function carriesMediaField(record: Record<string, unknown>): boolean {
  for (const key of Object.keys(record)) {
    if (MEDIA_FIELD_NAMES.has(key)) return true;
  }
  return false;
}

/**
 * The ONE media-replacement check: `edit` must be a plain object with
 * shape `text` | `caption`, a plain-object `content`, and no media field
 * on itself or inside `content`.
 */
export function assertEditHasNoMedia(edit: unknown): MediaEditGuardOutcome {
  if (!isPlainObject(edit)) return { ok: false, reason: 'invalid_input' };
  if (edit['shape'] !== 'text' && edit['shape'] !== 'caption') {
    // An unknown shape can never be a caption/text edit — and the
    // engine's else-branch would otherwise misroute it as a text edit.
    return { ok: false, reason: 'media_replacement_refused' };
  }
  if (carriesMediaField(edit)) return { ok: false, reason: 'media_replacement_refused' };
  const content = edit['content'];
  if (!isPlainObject(content)) return { ok: false, reason: 'invalid_input' };
  if (carriesMediaField(content)) return { ok: false, reason: 'media_replacement_refused' };
  return { ok: true };
}

/**
 * Validate a whole planned edit batch: the first offending edit refuses
 * the batch with its index (the engine reports the refusal before any
 * write — the caller re-plans, never partially applies).
 */
export function assertEditsHaveNoMedia(
  edits: readonly unknown[],
):
  | MediaEditGuardOutcome
  | { readonly ok: false; readonly reason: MediaEditGuardReason; readonly index: number } {
  if (!Array.isArray(edits)) return { ok: false, reason: 'invalid_input' };
  for (let index = 0; index < edits.length; index += 1) {
    const checked = assertEditHasNoMedia(edits[index]);
    if (!checked.ok) return { ...checked, index };
  }
  return { ok: true };
}
