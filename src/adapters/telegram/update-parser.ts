/**
 * Bounded, defensive parser for the Telegram Update types needed by the
 * initial admin panel (Phase 2A): `message`, `edited_message` and
 * `callback_query`.
 *
 * Design rules (blueprint discipline; ADR-0010 keeps Zod out of this phase):
 * - A small EXPLICIT parser is preferred over schema dependencies.
 * - The full Telegram API is NOT modeled: unknown Update kinds are classified
 *   as `unsupported` (still carrying their `update_id` so durable
 *   deduplication can acknowledge them) and never crash.
 * - Message-ORDER metadata (v1.2.6, ADR-0035): `message.date` (server-assigned
 *   Unix seconds) is extracted with strict bounds so preference writes can be
 *   ordered by TELEGRAM's own message chronology, never by `update_id`
 *   (which Telegram may randomize after a week without updates) and never by
 *   local processing time (an old retry arrives later).
 * - Numeric fields must be JSON numbers AND safe integers (no numeric
 *   strings, no NaN/Infinity, no values beyond Number.MAX_SAFE_INTEGER).
 * - Strings are bounded; oversized or malformed strings are treated as
 *   ABSENT rather than truncated (a truncated value must never be processed).
 * - Only fixed, known paths are read — no recursive traversal — so Telegram
 *   payload fields can never become log fields automatically. Callers log
 *   only the stable fields this module returns (never the raw payload).
 */

import type { RichTextKind } from '../../domain/telegram/rich-text-envelope';
import { RICH_TEXT_LIMITS } from '../../domain/telegram/rich-text-envelope';

export const TELEGRAM_UPDATE_LIMITS = {
  /** Telegram message text hard limit (4096 characters). */
  maxTextLength: 4096,
  /** Conservative command-word maximum (e.g. "/status"). */
  maxCommandLength: 32,
  /** Telegram callback_data byte limit. */
  maxCallbackDataBytes: 64,
  /** Conservative callback_query.id length bound. */
  maxCallbackQueryIdLength: 64,
  /** Hard pre-encode character bound before measuring UTF-8 bytes. */
  maxCallbackDataChars: 64,
} as const;

/** Numeric Telegram identifiers are represented as safe JS integers. */
const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

/**
 * R1.21 — SINGLE-media extraction application bound for a Telegram file_id
 * (an opaque reference string). Mirrors the post-content document cap so a
 * file_id accepted by the parser can never fail the document validator.
 */
const MAX_MEDIA_FILE_ID_CHARS = 256;

/** Photo dimensions can be huge but not unbounded — capped for area math. */
const MAX_PHOTO_DIMENSION = 100_000;

/**
 * R1.21 — the typed SINGLE-media attachment extracted from a message.
 * `photo` / `video` carry the LARGEST variant's (photo) or the video's
 * Telegram file_id; EVERY other media shape (documents, audio, animation,
 * voice, video_note, sticker, albums via media_group_id, conflicting or
 * malformed media fields) maps to `unsupported` — the caller REJECTS it
 * explicitly, nothing is ever degraded into a partial post.
 */
export type ParsedMediaAttachment =
  | { readonly kind: 'photo'; readonly fileId: string }
  | { readonly kind: 'video'; readonly fileId: string }
  | { readonly kind: 'unsupported' };

/**
 * Bounded file_id validation: a non-empty printable-ASCII string within the
 * application cap. file_id is opaque — never interpreted, only carried.
 */
function boundedFileId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_FILE_ID_CHARS) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) {
      return undefined;
    }
  }
  return value;
}

/** Largest photo variant by bounded (width*height); ties keep the later entry. */
function largestPhotoFileId(photo: readonly unknown[]): string | undefined {
  let best: { readonly fileId: string; readonly area: number } | undefined;
  for (const entry of photo) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const fileId = boundedFileId(record['file_id']);
    if (fileId === undefined) {
      continue;
    }
    const width = toSafeInteger(record['width'], { min: 1, max: MAX_PHOTO_DIMENSION }) ?? 0;
    const height = toSafeInteger(record['height'], { min: 1, max: MAX_PHOTO_DIMENSION }) ?? 0;
    const area = width * height;
    if (best === undefined || area >= best.area) {
      best = { fileId, area };
    }
  }
  return best?.fileId;
}

/**
 * Extract the typed SINGLE-media attachment. A message carrying MORE than
 * one media field (photo + video, photo + document, ...) is malformed by
 * Telegram's own model and maps to `unsupported` (never one-half of it).
 */
function extractMediaAttachment(payload: Record<string, unknown>): ParsedMediaAttachment {
  const photo = payload['photo'];
  const video = payload['video'];
  const otherMedia =
    payload['document'] !== undefined ||
    payload['audio'] !== undefined ||
    payload['animation'] !== undefined ||
    payload['voice'] !== undefined ||
    payload['video_note'] !== undefined ||
    payload['sticker'] !== undefined;
  const photoPresent = photo !== undefined;
  const videoPresent = video !== undefined;
  if (photoPresent && videoPresent) {
    return { kind: 'unsupported' };
  }
  if (photoPresent && otherMedia) {
    return { kind: 'unsupported' };
  }
  if (videoPresent && otherMedia) {
    return { kind: 'unsupported' };
  }
  if (photoPresent) {
    if (!Array.isArray(photo)) {
      return { kind: 'unsupported' };
    }
    const fileId = largestPhotoFileId(photo);
    return fileId === undefined ? { kind: 'unsupported' } : { kind: 'photo', fileId };
  }
  if (videoPresent) {
    if (typeof video !== 'object' || video === null || Array.isArray(video)) {
      return { kind: 'unsupported' };
    }
    const fileId = boundedFileId((video as Record<string, unknown>)['file_id']);
    return fileId === undefined ? { kind: 'unsupported' } : { kind: 'video', fileId };
  }
  return { kind: 'unsupported' };
}

/**
 * The exact Telegram chat types the admin surface may reason about (Phase 2B:
 * /language requires a PRIVATE chat). Fixed allowlist — any other or
 * malformed `chat.type` value is treated as ABSENT (fail closed).
 */
const KNOWN_CHAT_TYPES: ReadonlySet<string> = new Set([
  'private',
  'group',
  'supergroup',
  'channel',
]);

/**
 * R1.20-R: media attachment field names checked for PRESENCE only (the
 * admin post surface must be able to reject media posts EXPLICITLY instead
 * of silently treating them as contentless). Values are never read.
 */
const MEDIA_ATTACHMENT_FIELDS: ReadonlySet<string> = new Set([
  'photo',
  'video',
  'document',
  'audio',
  'animation',
  'voice',
  'video_note',
  'sticker',
]);

function hasMediaAttachment(payload: Record<string, unknown>): boolean {
  for (const field of MEDIA_ATTACHMENT_FIELDS) {
    if (payload[field] !== undefined) {
      return true;
    }
  }
  return false;
}

/** Bounded chat-type extraction: known values only, everything else absent. */
function boundedChatType(value: unknown): string | undefined {
  if (typeof value !== 'string' || !KNOWN_CHAT_TYPES.has(value)) {
    return undefined;
  }
  return value;
}

export interface ParsedMessageFields {
  readonly messageId?: number;
  /**
   * Telegram's SERVER-assigned message time (Unix seconds) — the validated
   * message-ORDER metadata (ADR-0035). Present only when it is a safe
   * integer within a sane epoch-seconds bound (0..2100-01-01); anything else
   * is treated as ABSENT so callers can fail safely instead of ordering on
   * garbage. This is the ordering input for admin UI language preference
   * writes; it is NEVER a local clock reading and never logged.
   */
  readonly date?: number;
  /** Chat IDs may be negative (groups/channels) — any safe integer. */
  readonly chatId?: number;
  /** Sender user ID (positive safe integer) when present. */
  readonly fromUserId?: number;
  /** Message text, present only when within the documented bound. */
  readonly text?: string;
  /** Lowercase command word (e.g. "start") when the text starts with a bot command. */
  readonly command?: string;
  /**
   * Lowercase target username when the command explicitly addressed a bot
   * ("/status@some_bot"); absent for unqualified commands.
   */
  readonly commandTarget?: string;
  /**
   * Exact Telegram chat type when it is one of the known values
   * (private | group | supergroup | channel); absent otherwise. Presentation
   * input for chat-scope rules (e.g. /language is private-chat only) — never
   * logged.
   */
  readonly chatType?: string;
  /**
   * R1.19: bounded typed native rich-text metadata extracted from
   * `text` + `entities` (message and edited_message). PASSIVE metadata:
   * command extraction, routing and every legacy gate are untouched by it.
   * `undefined` = no rich metadata on the update (plain text). An explicit
   * `ok: false` outcome means the metadata was present but malformed —
   * never silently dropped, and it never erases the command text.
   */
  readonly richText?: ParsedRichTextExtraction;
  /**
   * R1.19: the same extraction for `caption` + `caption_entities`. A caption
   * is NEVER a bot command; captions beyond the 1024-unit application cap
   * are reported explicitly (`caption_too_large`), never silently dropped.
   * R1.19.1: a plain caption with OMITTED optional `caption_entities` is
   * preserved as `ok: true` with an EMPTY entity list (metadata absence is
   * not content absence); explicit null/primitive metadata stays a typed
   * `entities_malformed` outcome, never repaired into absence/empty.
   */
  readonly richCaption?: ParsedRichTextExtraction;
  /**
   * R1.20-R: PASSIVE presence flag — the raw `text` field is a non-empty
   * string, REGARDLESS of the application bound. This lets callers
   * distinguish "no text" from "text present but beyond the bound" so an
   * oversized post can be rejected EXPLICITLY instead of silently
   * mis-classified as contentless. Never logged.
   */
  readonly hasText?: boolean;
  /**
   * R1.20-R: PASSIVE presence flag — the message carries a media attachment
   * (photo/video/document/audio/animation/voice/video_note/sticker).
   * Presence only: no attachment content, id, or file reference is extracted
   * or retained. Never logged.
   */
  readonly hasMediaAttachment?: boolean;
  /**
   * R1.21: the typed SINGLE-media extraction. `photo`/`video` carry the
   * Telegram file_id (largest photo variant / the video itself); every other
   * media shape is `unsupported`. Never logged.
   */
  readonly media?: ParsedMediaAttachment;
  /**
   * R1.21: PASSIVE presence flag — the message belongs to an ALBUM
   * (`media_group_id` present). Album members are rejected explicitly by the
   * capture surface; a single album member is never degraded into a post.
   * Never logged.
   */
  readonly inMediaGroup?: boolean;
}

export interface ParsedCallbackFields {
  readonly callbackQueryId?: string;
  readonly fromUserId?: number;
  /** Callback data, present only when it satisfies the 64-byte Telegram limit. */
  readonly callbackData?: string;
  /** Chat/message the callback button was attached to, when present. */
  readonly callbackChatId?: number;
  readonly callbackMessageId?: number;
}

export type ParsedUpdate =
  | ({ readonly kind: 'message'; readonly updateId: number } & ParsedMessageFields)
  | ({ readonly kind: 'edited_message'; readonly updateId: number } & ParsedMessageFields)
  | ({ readonly kind: 'callback_query'; readonly updateId: number } & ParsedCallbackFields)
  | { readonly kind: 'unsupported'; readonly updateId: number };

export type UpdateParseFailureReason =
  'root_not_object' | 'missing_update_id' | 'invalid_update_id';

export type UpdateParseResult =
  | { readonly ok: true; readonly update: ParsedUpdate }
  | { readonly ok: false; readonly reason: UpdateParseFailureReason };

/**
 * Validate a value as a safe integer within an inclusive range.
 * JSON numeric strings, floats, NaN/Infinity and out-of-range values are
 * all rejected (fail-safe: undefined).
 */
function toSafeInteger(
  value: unknown,
  options: { readonly min?: number; readonly max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }
  const min = options.min ?? -MAX_SAFE_ID;
  const max = options.max ?? MAX_SAFE_ID;
  if (value < min || value > max) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A successfully extracted bot command with its optional explicit target. */
export interface ParsedBotCommand {
  /** Lowercase command word (e.g. "status"). */
  readonly command: string;
  /** Lowercase target username for "/cmd@target"; absent when unqualified. */
  readonly targetUsername?: string;
}

/**
 * Extract the bot command from message text.
 * Accepts "/command" and "/command@botname" forms; the command word and the
 * optional target username are normalized to lowercase and must satisfy the
 * conservative length bounds. Returns undefined for anything else (including
 * malformed commands — those are simply not commands).
 */
export function extractBotCommand(text: string): ParsedBotCommand | undefined {
  if (!text.startsWith('/')) {
    return undefined;
  }
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?=\s|$)/.exec(text);
  if (match === null) {
    return undefined;
  }
  const command = match[1];
  if (command === undefined) {
    return undefined;
  }
  const target = match[2];
  return {
    command: command.toLowerCase(),
    ...(target !== undefined ? { targetUsername: target.toLowerCase() } : {}),
  };
}

function boundedText(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > TELEGRAM_UPDATE_LIMITS.maxTextLength
  ) {
    return undefined;
  }
  return value;
}

// -------------------------------------------------------------------------
// R1.19 — bounded typed native rich-text extraction (PASSIVE metadata).
//
// The parser performs a SHALLOW, bounded extraction only: each entity must
// be an object with a bounded non-empty string `type`; the documented
// metadata fields are projected as-is and everything else is DROPPED (the
// documented consistent ignore policy — arbitrary raw payload fields are
// never retained). FULL range/nesting/metadata/cap validation belongs to the
// versioned envelope (src/domain/telegram/rich-text-envelope.ts); the parser
// never judges ranges. Outcomes are EXPLICIT: malformed metadata is
// `ok: false` — never silently absent, never silently empty — and it can
// never erase the command text or alter routing.
// -------------------------------------------------------------------------

/** Shallow projection of one raw MessageEntity (documented fields only). */
export interface ParsedMessageEntityMetadata {
  readonly type: string;
  /** Raw values — judged by the versioned envelope, never here. */
  readonly offset: unknown;
  readonly length: unknown;
  readonly url?: unknown;
  readonly language?: unknown;
  readonly customEmojiId?: unknown;
  readonly user?: unknown;
  readonly unixTime?: unknown;
  readonly dateTimeFormat?: unknown;
}

export type RichTextExtractionReason =
  'entities_malformed' | 'entities_too_many' | 'caption_too_large';

export type ParsedRichTextExtraction =
  | {
      readonly ok: true;
      readonly kind: RichTextKind;
      readonly text: string;
      readonly entities: readonly ParsedMessageEntityMetadata[];
    }
  | {
      readonly ok: false;
      readonly kind: RichTextKind;
      readonly reason: RichTextExtractionReason;
    };

/** Wire -> projection key mapping for the documented metadata fields. */
const ENTITY_WIRE_FIELD_MAP = [
  ['url', 'url'],
  ['language', 'language'],
  ['custom_emoji_id', 'customEmojiId'],
  ['user', 'user'],
  ['unix_time', 'unixTime'],
  ['date_time_format', 'dateTimeFormat'],
] as const;

/**
 * R1.19.1 (M1): bounded shallow projection of the documented minimal
 * text_mention User fields from the REAL incoming WIRE shape to the canonical
 * camelCase shape the envelope validates — the same wire->canonical mapping
 * the storage reader and wire writer already use, now applied on the parser
 * path so a real `user:{id,is_bot,first_name,...}` object survives into the
 * domain instead of failing `user_invalid` there.
 *
 * Documented minimal field set ONLY: `id` / `is_bot` / `first_name` (required
 * by the domain) plus the allowed optional `last_name` / `username` /
 * `language_code`. Every OTHER key — including unrelated optional Telegram
 * flags a real User payload commonly carries (is_premium,
 * added_to_attachment_menu, ...) — is DROPPED by the documented ignore
 * policy: dropped extras never reject an ordinary real User payload, and no
 * arbitrary nested raw User object is ever retained.
 *
 * A non-object `user` is forwarded UNCHANGED so the envelope fails it typed
 * (`user_invalid`) — the parser never judges field types or bounds (wrong
 * id/boolean/name types and oversized names fail EXPLICITLY at the envelope
 * boundary, which re-validates the full canonical shape).
 */
const MENTION_USER_WIRE_FIELD_MAP = [
  ['id', 'id'],
  ['is_bot', 'isBot'],
  ['first_name', 'firstName'],
  ['last_name', 'lastName'],
  ['username', 'username'],
  ['language_code', 'languageCode'],
] as const;

function projectMentionUser(value: unknown): unknown {
  if (!isRecord(value)) {
    return value; // not an object -> envelope fails it typed (user_invalid)
  }
  const projected: Record<string, unknown> = {};
  for (const [wireKey, camelKey] of MENTION_USER_WIRE_FIELD_MAP) {
    if (value[wireKey] !== undefined) {
      projected[camelKey] = value[wireKey];
    }
  }
  return projected;
}

/**
 * Shallow-project one raw entity. Undefined for anything that is not an
 * object with a bounded non-empty string type (the WHOLE metadata becomes
 * explicitly malformed — never a silently partial list). Telegram's wire
 * snake_case metadata keys are mapped to the camelCase projection shape the
 * envelope validates; everything undocumented is DROPPED.
 */
function projectEntityMetadata(entry: unknown): ParsedMessageEntityMetadata | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const type = entry['type'];
  if (
    typeof type !== 'string' ||
    type.length === 0 ||
    type.length > RICH_TEXT_LIMITS.maxEntityTypeUnits
  ) {
    return undefined;
  }
  const projected: Record<string, unknown> = {
    type,
    offset: entry['offset'],
    length: entry['length'],
  };
  for (const [wireKey, camelKey] of ENTITY_WIRE_FIELD_MAP) {
    if (entry[wireKey] !== undefined) {
      projected[camelKey] =
        wireKey === 'user' ? projectMentionUser(entry[wireKey]) : entry[wireKey];
    }
  }
  return projected as unknown as ParsedMessageEntityMetadata;
}

function extractRichTextMetadata(
  kind: RichTextKind,
  text: string,
  rawEntities: unknown,
): ParsedRichTextExtraction | undefined {
  if (rawEntities === undefined) {
    return undefined; // no rich metadata on this content (plain text)
  }
  if (!Array.isArray(rawEntities)) {
    return { ok: false, kind, reason: 'entities_malformed' };
  }
  if (rawEntities.length > RICH_TEXT_LIMITS.maxEntities) {
    return { ok: false, kind, reason: 'entities_too_many' };
  }
  const entities: ParsedMessageEntityMetadata[] = [];
  for (const entry of rawEntities) {
    const projected = projectEntityMetadata(entry);
    if (projected === undefined) {
      return { ok: false, kind, reason: 'entities_malformed' };
    }
    entities.push(projected);
  }
  return { ok: true, kind, text, entities };
}

function boundedCallbackData(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  // byteLength >= charLength holds for UTF-8, so a cheap char bound first
  // avoids encoding oversized hostile strings.
  if (value.length > TELEGRAM_UPDATE_LIMITS.maxCallbackDataChars) {
    return undefined;
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > TELEGRAM_UPDATE_LIMITS.maxCallbackDataBytes) {
    return undefined;
  }
  return value;
}

function boundedId(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > TELEGRAM_UPDATE_LIMITS.maxCallbackQueryIdLength
  ) {
    return undefined;
  }
  return value;
}

function parseMessageLike(
  kind: 'message' | 'edited_message',
  updateId: number,
  payload: unknown,
): ParsedUpdate {
  if (!isRecord(payload)) {
    return { kind: 'unsupported', updateId };
  }
  const chat = payload['chat'];
  const from = payload['from'];
  // R1.20-R: raw presence flags BEFORE the bound projection — hasText is
  // true for ANY non-empty string text (even beyond the application bound),
  // so an oversized post stays explicitly distinguishable from no content.
  const rawText = payload['text'];
  const hasText = typeof rawText === 'string' && rawText.length > 0;
  const mediaAttachment = hasMediaAttachment(payload);
  const text = boundedText(rawText);
  const parsedCommand = text === undefined ? undefined : extractBotCommand(text);

  // R1.19: rich-text metadata is extracted from BOTH content kinds
  // independently — a malformed payload carrying both keeps BOTH (neither is
  // silently selected over the other). Extraction never touches the command
  // fields below.
  const richText =
    text === undefined ? undefined : extractRichTextMetadata('text', text, payload['entities']);
  let richCaption: ParsedRichTextExtraction | undefined;
  const rawCaption = payload['caption'];
  if (typeof rawCaption === 'string' && rawCaption.length > 0) {
    if (rawCaption.length > RICH_TEXT_LIMITS.maxCaptionUnits) {
      richCaption = { ok: false, kind: 'caption', reason: 'caption_too_large' };
    } else if (payload['caption_entities'] === undefined) {
      // R1.19.1 (P1): a plain caption with OMITTED optional caption_entities
      // is VALID content — metadata absence is not content absence. Plain
      // text has the legacy `text` field, plain captions have none, so the
      // caption is preserved here as the canonical plain-caption extraction
      // (exact text, empty entity list). Explicit null/primitive metadata is
      // NOT absence — extractRichTextMetadata below fails it typed
      // (entities_malformed); it is never repaired or treated as empty.
      richCaption = { ok: true, kind: 'caption', text: rawCaption, entities: [] };
    } else {
      richCaption = extractRichTextMetadata('caption', rawCaption, payload['caption_entities']);
    }
  }

  // R1.21: typed single-media extraction (photo/video file_id) + the album
  // membership flag. Purely additive to the presence flag above.
  const media = extractMediaAttachment(payload);
  const inMediaGroup = payload['media_group_id'] !== undefined;

  return {
    kind,
    updateId,
    messageId: toSafeInteger(payload['message_id'], { min: 1 }),
    // Bounded VALIDATION of the server-assigned ordering timestamp: Telegram
    // message dates are Unix SECONDS; anything beyond 4102444800 (2100-01-01)
    // or below 0 is garbage and is treated as ABSENT (fail-safe, ADR-0035).
    date: toSafeInteger(payload['date'], { min: 0, max: 4102444800 }),
    chatId: isRecord(chat) ? toSafeInteger(chat['id']) : undefined,
    chatType: isRecord(chat) ? boundedChatType(chat['type']) : undefined,
    fromUserId: isRecord(from) ? toSafeInteger(from['id'], { min: 1 }) : undefined,
    text,
    command: parsedCommand?.command,
    commandTarget: parsedCommand?.targetUsername,
    ...(richText !== undefined ? { richText } : {}),
    ...(richCaption !== undefined ? { richCaption } : {}),
    ...(hasText ? { hasText } : {}),
    ...(mediaAttachment ? { hasMediaAttachment: mediaAttachment } : {}),
    ...(media.kind !== 'unsupported' || mediaAttachment ? { media } : {}),
    ...(inMediaGroup ? { inMediaGroup } : {}),
  };
}

function parseCallbackQuery(updateId: number, payload: unknown): ParsedUpdate {
  if (!isRecord(payload)) {
    return { kind: 'unsupported', updateId };
  }
  const from = payload['from'];
  const message = payload['message'];
  const chat = isRecord(message) ? message['chat'] : undefined;
  return {
    kind: 'callback_query',
    updateId,
    callbackQueryId: boundedId(payload['id']),
    fromUserId: isRecord(from) ? toSafeInteger(from['id'], { min: 1 }) : undefined,
    callbackData: boundedCallbackData(payload['data']),
    callbackChatId: isRecord(chat) ? toSafeInteger(chat['id']) : undefined,
    callbackMessageId: isRecord(message)
      ? toSafeInteger(message['message_id'], { min: 1 })
      : undefined,
  };
}

/**
 * Parse one Telegram Update from an already-JSON-decoded value.
 * Never throws; failures carry a stable reason code only.
 */
export function parseTelegramUpdate(raw: unknown): UpdateParseResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'root_not_object' };
  }
  const updateId = toSafeInteger(raw['update_id'], { min: 0 });
  if (updateId === undefined) {
    return {
      ok: false,
      reason: raw['update_id'] === undefined ? 'missing_update_id' : 'invalid_update_id',
    };
  }

  if (raw['message'] !== undefined) {
    return { ok: true, update: parseMessageLike('message', updateId, raw['message']) };
  }
  if (raw['edited_message'] !== undefined) {
    return {
      ok: true,
      update: parseMessageLike('edited_message', updateId, raw['edited_message']),
    };
  }
  if (raw['callback_query'] !== undefined) {
    return { ok: true, update: parseCallbackQuery(updateId, raw['callback_query']) };
  }

  return { ok: true, update: { kind: 'unsupported', updateId } };
}
