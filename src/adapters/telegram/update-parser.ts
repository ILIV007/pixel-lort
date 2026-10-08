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
 * - Numeric fields must be JSON numbers AND safe integers (no numeric
 *   strings, no NaN/Infinity, no values beyond Number.MAX_SAFE_INTEGER).
 * - Strings are bounded; oversized or malformed strings are treated as
 *   ABSENT rather than truncated (a truncated value must never be processed).
 * - Only fixed, known paths are read — no recursive traversal — so Telegram
 *   payload fields can never become log fields automatically. Callers log
 *   only the stable fields this module returns (never the raw payload).
 */

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

export interface ParsedMessageFields {
  readonly messageId?: number;
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
  const text = boundedText(payload['text']);
  const parsedCommand = text === undefined ? undefined : extractBotCommand(text);
  return {
    kind,
    updateId,
    messageId: toSafeInteger(payload['message_id'], { min: 1 }),
    chatId: isRecord(chat) ? toSafeInteger(chat['id']) : undefined,
    fromUserId: isRecord(from) ? toSafeInteger(from['id'], { min: 1 }) : undefined,
    text,
    command: parsedCommand?.command,
    commandTarget: parsedCommand?.targetUsername,
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
