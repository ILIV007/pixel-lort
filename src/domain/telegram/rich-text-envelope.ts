/**
 * R1.19 — Telegram rich-text foundation: the pure versioned envelope
 * (faithful entities IN -> validated entities OUT).
 *
 * Telegram's native rich text is `text + entities` (or `caption +
 * caption_entities`), NOT raw Markdown. This module is the CANONICAL, bounded
 * representation of that content for the whole application:
 *
 * - `createRichTextEnvelope` validates raw shallow-extracted metadata (the
 *   shape produced by the real update parser) into a versioned value
 *   `{ schemaVersion: 1, kind, text, entities }`. Plain text with an EMPTY
 *   entity list is a valid distinct case.
 * - `serializeRichTextEnvelope` produces the canonical JSON document for
 *   FUTURE persistence (no DB adapter lives here), enforcing a total
 *   serialized-byte cap with a typed failure — never truncation-to-fit.
 * - `readRichTextEnvelope` defensively re-reads that document (strict UTF-8
 *   byte pre-check, schemaVersion gate, full re-validation of every field)
 *   so absent/unsupported-version/malformed outcomes stay explicit and
 *   distinct. Unknown extra envelope-level fields are IGNORED (documented
 *   forward-compatibility policy); every REQUIRED field is still validated.
 * - `richTextEntitiesWire` projects the validated entity list into the exact
 *   Bot API wire shape so the transport client can send direct-entity
 *   payloads (`text` + `entities`, never `parse_mode`) without re-mapping.
 *
 * Text identity is ABSOLUTE: the canonical text is preserved byte-for-byte —
 * no trim, no NFC normalization, no HTML escaping, no Markdown
 * interpretation. Changing the text would change the UTF-16 offsets.
 *
 * Bounds are conservative APPLICATION caps (clearly named; not claims about
 * Telegram's exact character-count semantics): text <= 4096 and caption <=
 * 1024 UTF-16 code units, <= 100 entities per content value, URL <= 2048
 * UTF-8 bytes, pre language <= 64 UTF-16 units, custom_emoji id <= 128
 * UTF-16 units, and a 128 KiB total serialized-envelope byte limit measured
 * on the ACTUAL UTF-8 bytes before any success. Oversized input fails typed;
 * nothing is ever truncated to fit.
 *
 * Validation is fail-closed with explicit typed reasons:
 * - offsets/lengths must be finite safe integers with `offset >= 0`,
 *   `length > 0` and overflow-safe `offset + length <= text.length`;
 *   offsets are UTF-16 code units and are NOT converted to code-point
 *   indexes;
 * - no range boundary may fall inside a surrogate pair, and text containing
 *   unpaired surrogates is rejected explicitly (never repaired);
 * - the documented nesting restrictions are enforced: crossing overlaps are
 *   invalid; code/pre are isolated (they can neither contain nor be
 *   contained); the formatting styles (bold, italic, underline,
 *   strikethrough, spoiler) can contain AND be part of any other entity
 *   except pre/code (official formatting-options rules; R1.19.1 corrected
 *   the be-part-of direction — a bold INSIDE a link is legal); quote types
 *   never nest (blockquote / expandable_blockquote may hold non-quote
 *   children but never nest inside anything); all other entity types remain
 *   atomic leaves among themselves;
 * - identical ranges with the SAME type are rejected as duplicates
 *   (deterministic; no silent widening/repositioning/deduplication); equal
 *   ranges of DIFFERENT types are legal when at least one containment
 *   direction is legal (e.g. bold+italic, bold+text_link);
 * - the canonical envelope imposes a DETERMINISTIC entity ordering (offset
 *   ascending, length descending, type, then metadata) — entity array order
 *   carries no Telegram semantics, and byte-identical original JSON array
 *   order is explicitly NOT claimed;
 * - metadata is validated per type (URL scheme policy below, bounded
 *   minimal text_mention User with no arbitrary raw fields, custom_emoji id,
 *   date_time unix_time + the exact `r|w?[dD]?[tT]?` full-match grammar
 *   including the valid empty string); documented metadata on a type that
 *   must not carry it is rejected (never forwarded unchecked).
 *
 * URL safety: validation is NOT a fetch. Nothing here dereferences URLs,
 * mentions or custom-emoji ids. The conservative output scheme policy
 * allows http/https, legitimate tg://, and mailto/tel; dangerous schemes
 * (javascript:, data:, file:, and anything unknown) are typed-rejected with
 * no unsafe fallback. Opaque URLs are preserved EXACTLY within the policy —
 * no forced decoding, no case folding, no query rewriting.
 *
 * `date_time` unix_time accepts safe integers 0..4102444800 — the SAME
 * conservative epoch-seconds bound the update parser applies to message
 * dates (application policy, not a Telegram claim). No invented tighter cap.
 *
 * custom_emoji: valid input metadata is RETAINED here. Output eligibility is
 * a transport concern — the Bot API client requires an explicit trusted
 * capability before attempting such a send; retaining an id is never a
 * promise of delivery or rendering.
 *
 * No DB access, no fetch, no clock — a pure domain value module. This round
 * adds NO durable persistence: later slices will persist authorized posts.
 */

/** Named conservative application caps (UTF-16 code units unless stated). */
export const RICH_TEXT_LIMITS = {
  /** `text` kind application cap. */
  maxTextUnits: 4096,
  /** `caption` kind application cap. */
  maxCaptionUnits: 1024,
  /** Maximum entities per content value. */
  maxEntities: 100,
  /** Maximum text_link URL size in UTF-8 BYTES. */
  maxUrlBytes: 2048,
  /** Maximum `pre` language length. */
  maxLanguageUnits: 64,
  /** Maximum custom_emoji id length. */
  maxCustomEmojiIdUnits: 128,
  /** Total canonical serialized envelope byte cap (128 KiB). */
  maxSerializedBytes: 131_072,
  /**
   * Conservative epoch-seconds bound for date_time unix_time (2100-01-01) —
   * the SAME bound the update parser applies to message dates (ADR-0035).
   */
  maxUnixTime: 4_102_444_800,
  /** Bounded text_mention display fields. */
  maxUserDisplayNameUnits: 64,
  maxUsernameUnits: 32,
  maxUserLanguageCodeUnits: 35,
  /** Parser-side type-string bound (malformed beyond this before classify). */
  maxEntityTypeUnits: 64,
} as const;

/**
 * The EXACT current Bot API MessageEntity type set (all 20 documented types,
 * including date_time). Unknown future types are typed-unsupported.
 */
export const MESSAGE_ENTITY_TYPES = [
  'mention',
  'hashtag',
  'cashtag',
  'bot_command',
  'url',
  'email',
  'phone_number',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'blockquote',
  'expandable_blockquote',
  'code',
  'pre',
  'text_link',
  'text_mention',
  'custom_emoji',
  'date_time',
] as const;

export type MessageEntityType = (typeof MESSAGE_ENTITY_TYPES)[number];
export type RichTextKind = 'text' | 'caption';

/** Minimal documented User shape for text_mention (no arbitrary raw fields). */
export interface RichTextMentionUser {
  /** Positive safe integer Telegram user id. */
  readonly id: number;
  readonly isBot: boolean;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly languageCode?: string;
}

/** One validated entity in the canonical (camelCase) form. */
export interface RichTextEntity {
  readonly type: MessageEntityType;
  readonly offset: number;
  readonly length: number;
  /** text_link only. */
  readonly url?: string;
  /** pre only (optional). */
  readonly language?: string;
  /** custom_emoji only. */
  readonly customEmojiId?: string;
  /** text_mention only. */
  readonly user?: RichTextMentionUser;
  /** date_time only (required there). */
  readonly unixTime?: number;
  /** date_time only (optional). */
  readonly dateTimeFormat?: string;
}

/** The validated versioned envelope value. */
export interface RichTextEnvelope {
  readonly schemaVersion: 1;
  readonly kind: RichTextKind;
  /** Canonical text — preserved byte-for-byte (UTF-16 code units). */
  readonly text: string;
  /** Canonical, deterministically ordered validated entities. */
  readonly entities: readonly RichTextEntity[];
}

/**
 * Typed failure reasons. Entity-scoped failures carry `entityIndex`; whole-
 * content failures (nesting/crossing/duplicates) and envelope-level failures
 * do not. `unsupported_entity_type` is distinguishable from malformed ranges
 * by design.
 */
export type RichTextFailureReason =
  | 'invalid_kind'
  | 'text_invalid'
  | 'text_too_large'
  | 'caption_too_large'
  | 'text_unpaired_surrogate'
  | 'entities_not_list'
  | 'entities_too_many'
  | 'entity_invalid'
  | 'unsupported_entity_type'
  | 'unexpected_metadata'
  | 'range_invalid'
  | 'range_surrogate_split'
  | 'url_invalid'
  | 'url_malformed'
  | 'url_too_large'
  | 'url_unsafe_scheme'
  | 'language_invalid'
  | 'custom_emoji_id_invalid'
  | 'user_invalid'
  | 'unix_time_invalid'
  | 'date_time_format_invalid'
  | 'nesting_violation'
  | 'crossing_overlap'
  | 'duplicate_entity'
  | 'malformed_json'
  | 'unsupported_version'
  | 'malformed_envelope'
  | 'serialized_too_large';

export type RichTextOutcome =
  | { readonly ok: true; readonly envelope: RichTextEnvelope }
  | { readonly ok: false; readonly reason: RichTextFailureReason; readonly entityIndex?: number };

export type RichTextSerializeOutcome =
  | { readonly ok: true; readonly json: string; readonly byteLength: number }
  | { readonly ok: false; readonly reason: 'serialized_too_large' };

/** Raw entity input: the parser's shallow documented-field projection. */
export interface RichTextEntityInput {
  readonly type: unknown;
  readonly offset: unknown;
  readonly length: unknown;
  readonly url?: unknown;
  readonly language?: unknown;
  readonly customEmojiId?: unknown;
  readonly user?: unknown;
  readonly unixTime?: unknown;
  readonly dateTimeFormat?: unknown;
}

export interface RichTextEnvelopeInput {
  readonly kind: unknown;
  readonly text: unknown;
  readonly entities: unknown;
}

// ---------------------------------------------------------------------------
// Nesting policy (documented Bot API restrictions, conservative matrix)
// ---------------------------------------------------------------------------

const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'blockquote',
  'expandable_blockquote',
]);

/**
 * The five formatting styles: per the official Bot API formatting-options
 * rules they "can contain and can be part of any other entities, except pre
 * and code". The containing direction is enforced by CONTAINER_TYPES; the
 * BE-PART-OF direction is the R1.19.1 (N1) correction in `canContain`.
 */
const STYLE_TYPES: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
]);

const QUOTE_TYPES: ReadonlySet<string> = new Set(['blockquote', 'expandable_blockquote']);

/** code/pre can neither contain others nor be contained (leaf-isolated). */
const ISOLATED_TYPES: ReadonlySet<string> = new Set(['code', 'pre']);

function isContainableType(type: string): boolean {
  return !QUOTE_TYPES.has(type) && !ISOLATED_TYPES.has(type);
}

function canContain(outer: RichTextEntity, inner: RichTextEntity): boolean {
  if (ISOLATED_TYPES.has(outer.type) || ISOLATED_TYPES.has(inner.type)) {
    return false;
  }
  // R1.19.1 (N1): a style may BE PART OF any other entity except pre/code
  // (checked above) — bold/italic/underline/strikethrough/spoiler inside a
  // text_link, mention, quote, ... are legal formatted links/mentions per the
  // official rules. The reverse direction (a style CONTAINING others) stays
  // governed by CONTAINER_TYPES below; crossing/overlap rejection, code/pre
  // isolation, quote non-nesting, duplicate and non-container rules are
  // unchanged.
  if (STYLE_TYPES.has(inner.type)) {
    return true;
  }
  if (!CONTAINER_TYPES.has(outer.type)) {
    return false;
  }
  if (!isContainableType(inner.type)) {
    return false;
  }
  if (QUOTE_TYPES.has(outer.type) && QUOTE_TYPES.has(inner.type)) {
    return false; // quote types cannot nest
  }
  return true;
}

// ---------------------------------------------------------------------------
// URL scheme policy
// ---------------------------------------------------------------------------

const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'tg:',
  'mailto:',
  'tel:',
]);

type UrlCheck = 'ok' | 'url_invalid' | 'url_malformed' | 'url_too_large' | 'url_unsafe_scheme';

function checkUrl(value: unknown): UrlCheck {
  if (typeof value !== 'string' || value.length === 0) {
    return 'url_invalid';
  }
  // Chars <= bytes for UTF-8, so a cheap char pre-check first avoids
  // encoding oversized hostile strings.
  if (value.length > RICH_TEXT_LIMITS.maxUrlBytes) {
    return 'url_too_large';
  }
  if (new TextEncoder().encode(value).byteLength > RICH_TEXT_LIMITS.maxUrlBytes) {
    return 'url_too_large';
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'url_malformed';
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    return 'url_unsafe_scheme';
  }
  return 'ok';
}

// ---------------------------------------------------------------------------
// date_time format grammar: `r|w?[dD]?[tT]?` INCLUDING the empty string.
// Anchored full-match — partial matches are rejected.
// ---------------------------------------------------------------------------

const DATE_TIME_FORMAT_PATTERN = /^(?:r|w?[dD]?[tT]?)$/;

// ---------------------------------------------------------------------------
// Surrogate helpers (UTF-16 code units)
// ---------------------------------------------------------------------------

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when the text contains an unpaired (malformed) surrogate. */
function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (!isLowSurrogate(next)) {
        return true;
      }
      index += 1; // skip the paired low surrogate
    } else if (isLowSurrogate(code)) {
      return true; // low surrogate with no high surrogate before it
    }
  }
  return false;
}

/** True when position `position` splits a surrogate pair. */
function splitsSurrogatePair(text: string, position: number): boolean {
  if (position <= 0 || position >= text.length) {
    return false;
  }
  return (
    isHighSurrogate(text.charCodeAt(position - 1)) && isLowSurrogate(text.charCodeAt(position))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

// ---------------------------------------------------------------------------
// Per-entity validation and canonical projection
// ---------------------------------------------------------------------------

type EntityResult =
  | { readonly ok: true; readonly entity: RichTextEntity }
  | { readonly ok: false; readonly reason: RichTextFailureReason; readonly entityIndex: number };

/**
 * Validate ONE raw entity against the (already-validated) text and project
 * it to the canonical camelCase value. Undocumented extra fields are DROPPED
 * (consistent ignore policy, documented on the module; the parser projection
 * applies the same policy). Documented metadata on a type that must not
 * carry it is REJECTED — never forwarded unchecked.
 */
function validateAndProjectEntity(
  raw: Record<string, unknown>,
  index: number,
  text: string,
): EntityResult {
  const type = raw['type'];
  if (typeof type !== 'string') {
    return { ok: false, reason: 'entity_invalid', entityIndex: index };
  }
  if (!(MESSAGE_ENTITY_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'unsupported_entity_type', entityIndex: index };
  }

  const has = (key: string): boolean => raw[key] !== undefined;
  const unexpected = (): EntityResult => ({
    ok: false,
    reason: 'unexpected_metadata',
    entityIndex: index,
  });
  let url: string | undefined;
  let language: string | undefined;
  let customEmojiId: string | undefined;
  let user: RichTextMentionUser | undefined;
  let unixTime: number | undefined;
  let dateTimeFormat: string | undefined;

  switch (type) {
    case 'text_link': {
      const check = checkUrl(raw['url']);
      if (check !== 'ok') {
        return { ok: false, reason: check, entityIndex: index };
      }
      url = raw['url'] as string;
      if (
        has('language') ||
        has('customEmojiId') ||
        has('user') ||
        has('unixTime') ||
        has('dateTimeFormat')
      ) {
        return unexpected();
      }
      break;
    }
    case 'pre': {
      if (has('language')) {
        const value = raw['language'];
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > RICH_TEXT_LIMITS.maxLanguageUnits
        ) {
          return { ok: false, reason: 'language_invalid', entityIndex: index };
        }
        language = value;
      }
      if (
        has('url') ||
        has('customEmojiId') ||
        has('user') ||
        has('unixTime') ||
        has('dateTimeFormat')
      ) {
        return unexpected();
      }
      break;
    }
    case 'text_mention': {
      if (!has('user')) {
        return { ok: false, reason: 'user_invalid', entityIndex: index };
      }
      const check = validateMentionUser(raw['user']);
      if (!check.ok) {
        return { ok: false, reason: check.reason, entityIndex: index };
      }
      user = raw['user'] as RichTextMentionUser;
      if (
        has('url') ||
        has('language') ||
        has('customEmojiId') ||
        has('unixTime') ||
        has('dateTimeFormat')
      ) {
        return unexpected();
      }
      break;
    }
    case 'custom_emoji': {
      const value = raw['customEmojiId'];
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > RICH_TEXT_LIMITS.maxCustomEmojiIdUnits
      ) {
        return { ok: false, reason: 'custom_emoji_id_invalid', entityIndex: index };
      }
      customEmojiId = value;
      if (
        has('url') ||
        has('language') ||
        has('user') ||
        has('unixTime') ||
        has('dateTimeFormat')
      ) {
        return unexpected();
      }
      break;
    }
    case 'date_time': {
      const value = raw['unixTime'];
      if (
        !isSafeInteger(value) ||
        (value as number) < 0 ||
        (value as number) > RICH_TEXT_LIMITS.maxUnixTime
      ) {
        return { ok: false, reason: 'unix_time_invalid', entityIndex: index };
      }
      unixTime = value as number;
      if (has('dateTimeFormat')) {
        const format = raw['dateTimeFormat'];
        if (typeof format !== 'string' || !DATE_TIME_FORMAT_PATTERN.test(format)) {
          return { ok: false, reason: 'date_time_format_invalid', entityIndex: index };
        }
        dateTimeFormat = format;
      }
      if (has('url') || has('language') || has('customEmojiId') || has('user')) {
        return unexpected();
      }
      break;
    }
    default:
      if (
        has('url') ||
        has('language') ||
        has('customEmojiId') ||
        has('user') ||
        has('unixTime') ||
        has('dateTimeFormat')
      ) {
        return unexpected();
      }
      break;
  }

  // --- range validation (UTF-16 code units, overflow-safe) ----------------
  const offset = raw['offset'];
  const length = raw['length'];
  if (!isSafeInteger(offset) || !isSafeInteger(length)) {
    return { ok: false, reason: 'range_invalid', entityIndex: index };
  }
  if ((offset as number) < 0 || (length as number) <= 0) {
    return { ok: false, reason: 'range_invalid', entityIndex: index };
  }
  // Overflow-safe end bound: never compute offset + length for the check.
  if ((offset as number) > text.length || (length as number) > text.length - (offset as number)) {
    return { ok: false, reason: 'range_invalid', entityIndex: index };
  }
  if (
    splitsSurrogatePair(text, offset as number) ||
    splitsSurrogatePair(text, (offset as number) + (length as number))
  ) {
    return { ok: false, reason: 'range_surrogate_split', entityIndex: index };
  }

  const projected: RichTextEntity = {
    type: type as MessageEntityType,
    offset: offset as number,
    length: length as number,
    ...(url !== undefined ? { url } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(customEmojiId !== undefined ? { customEmojiId } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(unixTime !== undefined ? { unixTime } : {}),
    ...(dateTimeFormat !== undefined ? { dateTimeFormat } : {}),
  };
  return { ok: true, entity: projected };
}

function validateMentionUser(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'user_invalid' } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'user_invalid' };
  }
  // EXACT documented field set — arbitrary raw nested fields never pass.
  const allowedKeys = new Set(['id', 'isBot', 'firstName', 'lastName', 'username', 'languageCode']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: 'user_invalid' };
    }
  }
  if (!isSafeInteger(value['id']) || (value['id'] as number) < 1) {
    return { ok: false, reason: 'user_invalid' };
  }
  if (typeof value['isBot'] !== 'boolean') {
    return { ok: false, reason: 'user_invalid' };
  }
  const firstName = value['firstName'];
  if (
    typeof firstName !== 'string' ||
    firstName.length === 0 ||
    firstName.length > RICH_TEXT_LIMITS.maxUserDisplayNameUnits
  ) {
    return { ok: false, reason: 'user_invalid' };
  }
  const lastName = value['lastName'];
  if (
    lastName !== undefined &&
    (typeof lastName !== 'string' ||
      lastName.length === 0 ||
      lastName.length > RICH_TEXT_LIMITS.maxUserDisplayNameUnits)
  ) {
    return { ok: false, reason: 'user_invalid' };
  }
  const username = value['username'];
  if (
    username !== undefined &&
    (typeof username !== 'string' ||
      username.length === 0 ||
      username.length > RICH_TEXT_LIMITS.maxUsernameUnits)
  ) {
    return { ok: false, reason: 'user_invalid' };
  }
  const languageCode = value['languageCode'];
  if (
    languageCode !== undefined &&
    (typeof languageCode !== 'string' ||
      languageCode.length === 0 ||
      languageCode.length > RICH_TEXT_LIMITS.maxUserLanguageCodeUnits)
  ) {
    return { ok: false, reason: 'user_invalid' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Canonical deterministic ordering + pair validation
// ---------------------------------------------------------------------------

function canonicalSortKey(entity: RichTextEntity): string {
  // Deterministic metadata tie-break (only reached for identical
  // offset+length+type, which the duplicate policy rejects anyway).
  return JSON.stringify([
    entity.url,
    entity.language,
    entity.customEmojiId,
    entity.user,
    entity.unixTime,
    entity.dateTimeFormat,
  ]);
}

function compareEntities(a: RichTextEntity, b: RichTextEntity): number {
  if (a.offset !== b.offset) return a.offset - b.offset;
  if (a.length !== b.length) return b.length - a.length; // longer (outer) first
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const metaA = canonicalSortKey(a);
  const metaB = canonicalSortKey(b);
  if (metaA !== metaB) return metaA < metaB ? -1 : 1;
  return 0;
}

type PairFailure = 'nesting_violation' | 'crossing_overlap' | 'duplicate_entity' | null;

/**
 * Validate ONE ordered pair. Disjoint ranges are always fine. Overlapping
 * ranges must either nest legally (strict containment or — for equal ranges
 * of different types — at least one legal containment direction) or the
 * pair fails typed. Isolation (code/pre) is checked FIRST so any overlap
 * involving an isolated type is a nesting violation regardless of shape.
 */
function validatePair(a: RichTextEntity, b: RichTextEntity): PairFailure {
  const aEnd = a.offset + a.length;
  const bEnd = b.offset + b.length;
  const disjoint = aEnd <= b.offset || bEnd <= a.offset;
  if (disjoint) {
    return null;
  }
  if (ISOLATED_TYPES.has(a.type) || ISOLATED_TYPES.has(b.type)) {
    return 'nesting_violation';
  }
  if (a.offset === b.offset && aEnd === bEnd) {
    if (a.type === b.type) {
      return 'duplicate_entity';
    }
    // Equal ranges of different types: legal when one direction is legal.
    return canContain(a, b) || canContain(b, a) ? null : 'nesting_violation';
  }
  if (a.offset <= b.offset && aEnd >= bEnd) {
    return canContain(a, b) ? null : 'nesting_violation';
  }
  if (b.offset <= a.offset && bEnd >= aEnd) {
    return canContain(b, a) ? null : 'nesting_violation';
  }
  return 'crossing_overlap';
}

// ---------------------------------------------------------------------------
// Core validation pipeline (shared by create and read)
// ---------------------------------------------------------------------------

/** Validates kind/text/entities (all unknown) into the canonical envelope. */
function buildEnvelope(input: RichTextEnvelopeInput): RichTextOutcome {
  const kind = input.kind;
  if (kind !== 'text' && kind !== 'caption') {
    return { ok: false, reason: 'invalid_kind' };
  }
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'text_invalid' };
  }
  if (kind === 'text' && text.length > RICH_TEXT_LIMITS.maxTextUnits) {
    return { ok: false, reason: 'text_too_large' };
  }
  if (kind === 'caption' && text.length > RICH_TEXT_LIMITS.maxCaptionUnits) {
    return { ok: false, reason: 'caption_too_large' };
  }
  if (hasUnpairedSurrogate(text)) {
    return { ok: false, reason: 'text_unpaired_surrogate' };
  }

  const entities = input.entities;
  if (!Array.isArray(entities)) {
    return { ok: false, reason: 'entities_not_list' };
  }
  if (entities.length > RICH_TEXT_LIMITS.maxEntities) {
    return { ok: false, reason: 'entities_too_many' };
  }

  const projected: RichTextEntity[] = [];
  for (let index = 0; index < entities.length; index += 1) {
    const raw = entities[index];
    if (!isPlainObject(raw)) {
      return { ok: false, reason: 'entity_invalid', entityIndex: index };
    }
    const result = validateAndProjectEntity(raw, index, text);
    if (!result.ok) {
      return result;
    }
    projected.push(result.entity);
  }

  // Deterministic canonical ordering on a COPY — caller input is never
  // mutated, and original array order is explicitly not preserved.
  const ordered = [...projected].sort(compareEntities);

  // Bounded pair validation: O(n^2) over <= 100 entities is fine.
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const failure = validatePair(ordered[i]!, ordered[j]!);
      if (failure !== null) {
        return { ok: false, reason: failure };
      }
    }
  }

  return {
    ok: true,
    envelope: {
      schemaVersion: 1,
      kind,
      text,
      entities: ordered,
    },
  };
}

/**
 * Validate raw shallow-extracted rich text into the canonical versioned
 * envelope. Never mutates its input; never throws; failures are typed.
 */
export function createRichTextEnvelope(input: RichTextEnvelopeInput): RichTextOutcome {
  return buildEnvelope(input);
}

// ---------------------------------------------------------------------------
// Canonical serialization (future-persistence shape) and defensive reading
// ---------------------------------------------------------------------------

function mentionUserWire(user: RichTextMentionUser): Record<string, unknown> {
  return {
    id: user.id,
    is_bot: user.isBot,
    first_name: user.firstName,
    ...(user.lastName !== undefined ? { last_name: user.lastName } : {}),
    ...(user.username !== undefined ? { username: user.username } : {}),
    ...(user.languageCode !== undefined ? { language_code: user.languageCode } : {}),
  };
}

function entityWire(entity: RichTextEntity): Record<string, unknown> {
  return {
    type: entity.type,
    offset: entity.offset,
    length: entity.length,
    ...(entity.url !== undefined ? { url: entity.url } : {}),
    ...(entity.language !== undefined ? { language: entity.language } : {}),
    ...(entity.customEmojiId !== undefined ? { custom_emoji_id: entity.customEmojiId } : {}),
    ...(entity.user !== undefined ? { user: mentionUserWire(entity.user) } : {}),
    ...(entity.unixTime !== undefined ? { unix_time: entity.unixTime } : {}),
    ...(entity.dateTimeFormat !== undefined ? { date_time_format: entity.dateTimeFormat } : {}),
  };
}

/**
 * Canonical Bot API wire projection of the validated entity list — the exact
 * objects the transport client embeds in direct-entity payloads.
 */
export function richTextEntitiesWire(
  entities: readonly RichTextEntity[],
): readonly Record<string, unknown>[] {
  return entities.map(entityWire);
}

/** Canonical bounded serialization for FUTURE persistence (no DB here). */
export function serializeRichTextEnvelope(envelope: RichTextEnvelope): RichTextSerializeOutcome {
  const document = {
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    text: envelope.text,
    entities: richTextEntitiesWire(envelope.entities),
  };
  const json = JSON.stringify(document);
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength > RICH_TEXT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  return { ok: true, json, byteLength };
}

function mentionUserFromWire(value: unknown): RichTextMentionUser | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  // Strict documented field set on the wire shape as well.
  const allowedKeys = new Set([
    'id',
    'is_bot',
    'first_name',
    'last_name',
    'username',
    'language_code',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return undefined;
    }
  }
  return {
    // Field TYPES are re-validated downstream by the shared validator (a
    // wrong-typed id/flag/name fails user_invalid there); only the wire->camel
    // key mapping happens here.
    id: value['id'] as number,
    isBot: value['is_bot'] as boolean,
    firstName: value['first_name'] as string,
    ...(value['last_name'] !== undefined ? { lastName: value['last_name'] as string } : {}),
    ...(value['username'] !== undefined ? { username: value['username'] as string } : {}),
    ...(value['language_code'] !== undefined
      ? { languageCode: value['language_code'] as string }
      : {}),
  };
}

function entityFromWire(raw: Record<string, unknown>): Record<string, unknown> {
  // Undocumented extra fields are IGNORED here (forward compatibility); all
  // REQUIRED fields are re-validated by buildEnvelope below.
  const mapped: Record<string, unknown> = {
    type: raw['type'],
    offset: raw['offset'],
    length: raw['length'],
  };
  for (const [wireKey, camelKey] of [
    ['url', 'url'],
    ['language', 'language'],
    ['custom_emoji_id', 'customEmojiId'],
    ['unix_time', 'unixTime'],
    ['date_time_format', 'dateTimeFormat'],
  ] as const) {
    if (raw[wireKey] !== undefined) {
      mapped[camelKey] = raw[wireKey];
    }
  }
  if (raw['user'] !== undefined) {
    const user = mentionUserFromWire(raw['user']);
    mapped['user'] = user; // undefined stays undefined -> user_invalid downstream
  }
  return mapped;
}

/**
 * Defensively re-read a stored canonical envelope document. Outcomes are
 * explicit and distinct: malformed_json / unsupported_version /
 * malformed_envelope / serialized_too_large, or the full validation reasons.
 */
export function readRichTextEnvelope(json: string): RichTextOutcome {
  if (typeof json !== 'string' || json.length === 0) {
    return { ok: false, reason: 'malformed_envelope' };
  }
  // Chars <= bytes for UTF-8, so the char pre-check is a cheap bound first.
  if (json.length > RICH_TEXT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  if (new TextEncoder().encode(json).byteLength > RICH_TEXT_LIMITS.maxSerializedBytes) {
    return { ok: false, reason: 'serialized_too_large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'malformed_envelope' };
  }
  if (parsed['schemaVersion'] !== 1) {
    return { ok: false, reason: 'unsupported_version' };
  }
  if (!('kind' in parsed) || !('text' in parsed) || !('entities' in parsed)) {
    return { ok: false, reason: 'malformed_envelope' };
  }
  const kind = parsed['kind'];
  if (kind !== 'text' && kind !== 'caption') {
    return { ok: false, reason: 'malformed_envelope' };
  }
  if (!Array.isArray(parsed['entities'])) {
    return { ok: false, reason: 'malformed_envelope' };
  }
  // Unknown extra ENVELOPE-level fields are ignored (documented forward-
  // compatibility policy); required fields are re-validated in full below.
  return buildEnvelope({
    kind,
    text: parsed['text'],
    entities: (parsed['entities'] as unknown[]).map((entry) =>
      isPlainObject(entry) ? entityFromWire(entry) : entry,
    ),
  });
}
