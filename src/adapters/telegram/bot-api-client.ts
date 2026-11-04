/**
 * Telegram Bot API client boundary (Phase 2A).
 *
 * A small typed client over HTTPS POST calls to api.telegram.org:
 * - injectable fetch implementation (tests NEVER touch the network);
 * - strict timeout via AbortSignal (single attempt — NO automatic retries,
 *   hence no retry storm; callers decide policy from the error class);
 * - `redirect: "manual"` on every request — redirects are NEVER followed;
 *   any 3xx is a retryable network error without exposing Location, the
 *   token or the request URL (live-compatibility correction, ADR-0033);
 * - BOUNDED response reading (shared bounded-stream reader): an early,
 *   untrusted Content-Length check plus a strict byte cap enforced while
 *   streaming (the stream is CANCELLED once the cap is crossed) — the full
 *   response is never buffered before the limit is applied. Applied to the
 *   success path AND the error/429 payload path; response bodies are never
 *   logged;
 * - Telegram errors mapped into stable application error codes with an
 *   explicit retryable/permanent classification;
 * - `retry_after` parsed SAFELY (integer seconds 1..3600) when provided;
 * - request/response bodies and the BOT_TOKEN are NEVER logged — logs carry
 *   the method name and a stable code only, and error messages are authored
 *   constants (raw Telegram descriptions are inspected for classification
 *   and otherwise discarded);
 * - runtime Telegram-safe HTML gate: `sendMessage`/`editMessageText`
 *   re-validate their text with `isSafeTelegramHtml` even though the type
 *   is branded — a forged cast cannot bypass the runtime boundary;
 * - HTML parse mode is set by the callers via the typed inputs; MarkdownV2
 *   is deliberately not implemented (blueprint: HTML is the safe default).
 */
import { isSafeTelegramHtml, type TelegramSafeHtml } from '../../admin/telegram-html';
import {
  createRichTextEnvelope,
  richTextEntitiesWire,
  type RichTextEnvelope,
  type RichTextKind,
} from '../../domain/telegram/rich-text-envelope';
import { AppError } from '../../shared/errors/app-error';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from '../../shared/http/bounded-reader';
import type { Logger } from '../../observability/logger';

export type TelegramApiErrorCode =
  | 'telegram_timeout'
  | 'telegram_network_error'
  | 'telegram_rate_limited'
  | 'telegram_server_error'
  | 'telegram_unauthorized'
  | 'telegram_forbidden'
  | 'telegram_not_found'
  | 'telegram_bad_request'
  | 'telegram_response_invalid';

/**
 * Retryability classification:
 * - retryable:   timeout, network failure, 429 rate limit, 5xx server error
 *   (a later phase may act on these with a bounded policy — this client
 *   itself never retries);
 * - permanent:   4xx client errors (including bad token / forbidden chat)
 *   and malformed responses.
 */
const ERROR_MESSAGES: Readonly<Record<TelegramApiErrorCode, string>> = {
  telegram_timeout: 'Telegram API timeout',
  telegram_network_error: 'Telegram API network failure',
  telegram_rate_limited: 'Telegram API rate limited',
  telegram_server_error: 'Telegram API server error',
  telegram_unauthorized: 'Telegram API rejected the bot token',
  telegram_forbidden: 'Telegram API forbidden for this target',
  telegram_not_found: 'Telegram API target not found',
  telegram_bad_request: 'Telegram API rejected the request',
  telegram_response_invalid: 'Telegram API returned an invalid response',
};

export class TelegramApiError extends Error {
  readonly code: TelegramApiErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: TelegramApiErrorCode,
    options: {
      readonly httpStatus?: number;
      readonly retryAfterMs?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(ERROR_MESSAGES[code], { cause: options.cause });
    this.name = 'TelegramApiError';
    this.code = code;
    this.retryable =
      code === 'telegram_timeout' ||
      code === 'telegram_network_error' ||
      code === 'telegram_rate_limited' ||
      code === 'telegram_server_error';
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface TelegramSentMessage {
  readonly messageId: number;
}
export interface TelegramSendMessageInput {
  readonly chatId: number;
  readonly text: TelegramSafeHtml;
  readonly disableLinkPreview?: boolean;
  /**
   * R1.20-R: optional inline keyboard for CONTROL messages (admin post
   * preview/status buttons). Absent = identical payload as before. Callback
   * data strings are the opaque `a:<token>` contract only.
   */
  readonly replyMarkup?: {
    readonly inline_keyboard: ReadonlyArray<
      ReadonlyArray<{ readonly text: string; readonly callbackData: string }>
    >;
  };
}

export interface TelegramEditMessageInput {
  readonly chatId: number;
  readonly messageId: number;
  readonly text: TelegramSafeHtml;
}

export interface TelegramAnswerCallbackInput {
  readonly callbackQueryId: string;
  readonly text?: string;
}

// -------------------------------------------------------------------------
// R1.19 — separate typed entity-based transport (the rich-text capability).
//
// Direct entity payloads use EXACT `text` + `entities` (or `caption` +
// `caption_entities`) with NO `parse_mode` property — the two output modes
// are distinct typed operations on the SAME client factory, so an ambiguous
// or raw-invalid combination is impossible by construction. Every input is
// RE-VALIDATED at runtime (the branded envelope type alone is compile-time;
// a forged cast cannot bypass the boundary), and any rejection happens
// BEFORE fetch: zero network calls for invalid content. custom_emoji output
// requires an explicit trusted eligibility capability; without it the send
// fails typed (custom_emoji_not_eligible) — never dropped silently, never a
// pretend formatting success. Retaining a custom-emoji id is NOT a claim of
// delivery or rendering; Telegram's bot/chat capabilities decide that.
// -------------------------------------------------------------------------

export type TelegramRichContentErrorReason =
  'kind_mismatch' | 'invalid_content' | 'custom_emoji_not_eligible';

/** Typed pre-fetch rejection for entity-based output (never reaches fetch). */
export class TelegramRichContentError extends Error {
  readonly reason: TelegramRichContentErrorReason;

  constructor(reason: TelegramRichContentErrorReason) {
    super(`Telegram rich content rejected: ${reason}`);
    this.name = 'TelegramRichContentError';
    this.reason = reason;
  }
}

export interface TelegramSendRichInput {
  /**
   * Numeric chat id, or an operator-configured @username target (Telegram
   * resolves usernames server-side; never user input).
   */
  readonly chatId: number | string;
  /** kind must be 'text' — a caption envelope fails typed before fetch. */
  readonly content: RichTextEnvelope;
  /** Existing documented policy: link previews disabled by default. */
  readonly disableLinkPreview?: boolean;
  /**
   * Explicit trusted capability authorizing custom_emoji OUTPUT for this
   * send. Default/absent = restricted: any custom_emoji entity fails typed
   * with ZERO fetch calls.
   */
  readonly customEmojiEligible?: boolean;
}

/**
 * R1.21 — the SINGLE-media sends. The media is referenced by its Telegram
 * file_id (opaque, already bounded upstream); the caption is a REQUIRED-kind
 * 'caption' envelope or absent (a media post without a caption is valid).
 * A caption envelope here is carried as `caption` + `caption_entities` with
 * NO parse_mode; there is no text field and no text entities on a media
 * send — kind mismatches fail typed BEFORE fetch.
 */
export interface TelegramSendPhotoRichInput {
  readonly chatId: number | string;
  /** Telegram file_id of the photo (opaque reference, never a URL here). */
  readonly photo: string;
  /** kind must be 'caption'. Absent = the photo is sent without a caption. */
  readonly caption?: RichTextEnvelope;
  readonly customEmojiEligible?: boolean;
}

export interface TelegramSendVideoRichInput {
  readonly chatId: number | string;
  /** Telegram file_id of the video (opaque reference, never a URL here). */
  readonly video: string;
  /** kind must be 'caption'. Absent = the video is sent without a caption. */
  readonly caption?: RichTextEnvelope;
  readonly customEmojiEligible?: boolean;
}

export interface TelegramEditRichInput {
  readonly chatId: number;
  readonly messageId: number;
  /** kind must be 'text'. */
  readonly content: RichTextEnvelope;
  readonly customEmojiEligible?: boolean;
}

export interface TelegramEditCaptionRichInput {
  readonly chatId: number;
  readonly messageId: number;
  /** kind must be 'caption'. */
  readonly content: RichTextEnvelope;
  readonly customEmojiEligible?: boolean;
}

/**
 * The cohesive entity-based capability returned by the SAME client factory
 * implementation. Kept SEPARATE from `TelegramBotApiClient` so every
 * existing consumer/fake of the admin HTML surface stays untouched.
 */
export interface TelegramRichTextClient {
  sendMessageRich(input: TelegramSendRichInput): Promise<TelegramSentMessage>;
  /** R1.21: the single-photo channel/preview send (sendPhoto, no parse_mode). */
  sendPhotoRich(input: TelegramSendPhotoRichInput): Promise<TelegramSentMessage>;
  /** R1.21: the single-video channel/preview send (sendVideo, no parse_mode). */
  sendVideoRich(input: TelegramSendVideoRichInput): Promise<TelegramSentMessage>;
  editMessageTextRich(input: TelegramEditRichInput): Promise<boolean>;
  editMessageCaptionRich(input: TelegramEditCaptionRichInput): Promise<boolean>;
}

export interface TelegramBotApiClient {
  getMe(): Promise<{ readonly id: number; readonly username?: string }>;
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSentMessage>;
  editMessageText(input: TelegramEditMessageInput): Promise<boolean>;
  answerCallbackQuery(input: TelegramAnswerCallbackInput): Promise<void>;
}

export const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 10_000;
/** Strict byte cap on any single Telegram API response (stream-enforced). */
export const MAX_TELEGRAM_RESPONSE_BYTES = 1_000_000;
/** Conservative retry_after bound: 1 second .. 1 hour. */
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 3600;

export interface BotApiClientOptions {
  /** Bot token — used ONLY in the request URL; never logged or echoed. */
  readonly botToken: string;
  /** Injectable fetch (default: global fetch). Tests pass a fake. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }
  return value >= min && value <= max ? value : undefined;
}

function safeRetryAfterMs(value: unknown): number | undefined {
  const seconds = safeInteger(value, MIN_RETRY_AFTER_SECONDS, MAX_RETRY_AFTER_SECONDS);
  return seconds === undefined ? undefined : seconds * 1000;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function classifyHttpStatus(status: number): TelegramApiErrorCode {
  if (status >= 300 && status < 400) return 'telegram_network_error';
  if (status === 429) return 'telegram_rate_limited';
  if (status >= 500) return 'telegram_server_error';
  if (status === 401) return 'telegram_unauthorized';
  if (status === 403) return 'telegram_forbidden';
  if (status === 404) return 'telegram_not_found';
  return 'telegram_bad_request';
}

/**
 * Read a Telegram response body under the strict byte cap (ADR-0028):
 * - declared Content-Length is checked early when present, but never
 *   trusted as the only check;
 * - the body is STREAMED with the byte limit — reading stops and the stream
 *   is cancelled as soon as the cap is crossed (the full body is never
 *   buffered first);
 * - decoding is strict UTF-8 (malformed sequences are response-invalid);
 * - mid-stream transport failures are network errors (retryable).
 * Content is never logged; only stable error codes leave this boundary.
 */
async function readResponseBounded(response: Response): Promise<string> {
  const declared = parseContentLengthHeader(
    response.headers.get('content-length'),
    MAX_TELEGRAM_RESPONSE_BYTES,
  );
  if (declared.kind === 'invalid' || declared.kind === 'oversized') {
    throw new TelegramApiError('telegram_response_invalid');
  }
  try {
    const bytes = await readStreamBounded(response.body, MAX_TELEGRAM_RESPONSE_BYTES);
    return decodeUtf8Strict(bytes);
  } catch (error) {
    if (error instanceof BoundedReadError) {
      if (error.reason === 'stream_read_failed') {
        throw new TelegramApiError('telegram_network_error', { cause: error });
      }
      throw new TelegramApiError('telegram_response_invalid', { cause: error });
    }
    throw error;
  }
}

export function createBotApiClient(
  options: BotApiClientOptions,
): TelegramBotApiClient & TelegramRichTextClient {
  const { botToken, logger } = options;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_API_TIMEOUT_MS;

  // The token lives ONLY here; the URL is never logged, stored, or embedded
  // in error objects.
  const baseUrl = `https://api.telegram.org/bot${botToken}/`;

  async function callMethod<T>(
    method: string,
    payload: Record<string, unknown>,
    parseResult: (result: unknown) => T | null,
  ): Promise<T> {
    logger?.debug('telegram.api.request', { method });

    let response: Response;
    try {
      response = await fetchImpl(baseUrl + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // Observe and reject 3xx ourselves; never follow a redirect or
        // read/log Location. This preserves the token boundary on live
        // Cloudflare fetch, including runtimes that reject error mode.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code: TelegramApiErrorCode = isAbortLike(error)
        ? 'telegram_timeout'
        : 'telegram_network_error';
      logger?.warn('telegram.api.error', { method, code });
      throw new TelegramApiError(code, { cause: error });
    }

    if (response.status !== 200) {
      const code = classifyHttpStatus(response.status);
      const retryAfterMs =
        code === 'telegram_rate_limited' ? await readRetryAfterMs(response) : undefined;
      logger?.warn('telegram.api.error', { method, code });
      throw new TelegramApiError(code, { httpStatus: response.status, retryAfterMs });
    }

    // 2xx: parse the bounded JSON envelope { ok, result, ... }.
    const text = await readResponseBounded(response);
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      logger?.warn('telegram.api.error', { method, code: 'telegram_response_invalid' });
      throw new TelegramApiError('telegram_response_invalid');
    }
    if (!isRecord(envelope) || typeof envelope['ok'] !== 'boolean') {
      logger?.warn('telegram.api.error', { method, code: 'telegram_response_invalid' });
      throw new TelegramApiError('telegram_response_invalid');
    }
    if (!envelope['ok']) {
      // ok:false with HTTP 200: classify by the embedded error_code if any;
      // a missing code defaults to the conservative permanent bad_request
      // (this client never retries, so no transient guess is needed).
      const status = safeInteger(envelope['error_code'], 100, 599) ?? 400;
      const code = classifyHttpStatus(status);
      const parameters = isRecord(envelope['parameters']) ? envelope['parameters'] : undefined;
      const retryAfterMs =
        code === 'telegram_rate_limited'
          ? safeRetryAfterMs(parameters?.['retry_after'])
          : undefined;
      logger?.warn('telegram.api.error', { method, code });
      throw new TelegramApiError(code, { httpStatus: status, retryAfterMs });
    }

    const parsed = parseResult(envelope['result']);
    if (parsed === null) {
      logger?.warn('telegram.api.error', { method, code: 'telegram_response_invalid' });
      throw new TelegramApiError('telegram_response_invalid');
    }
    return parsed;
  }

  /** Bounded 429/error payload read — failures only mean "no retry_after". */
  async function readRetryAfterMs(response: Response): Promise<number | undefined> {
    try {
      const text = await readResponseBounded(response);
      const body: unknown = JSON.parse(text);
      if (!isRecord(body)) return undefined;
      const parameters = isRecord(body['parameters']) ? body['parameters'] : undefined;
      return safeRetryAfterMs(parameters?.['retry_after']);
    } catch {
      // An unreadable/unbounded error payload never masks the classified
      // status error; retry_after is best-effort and stays bounded.
      return undefined;
    }
  }

  /**
   * RUNTIME safety gate (ADR-0029): the branded type is compile-time only.
   * A forged cast must be rejected here — before any fetch is made — as a
   * deterministic internal error (permanent, no retry).
   */
  function requireSafeHtml(text: TelegramSafeHtml): TelegramSafeHtml {
    if (!isSafeTelegramHtml(text)) {
      throw new AppError('internal_error');
    }
    return text;
  }

  function parseSentMessage(result: unknown): TelegramSentMessage | null {
    const messageId = isRecord(result)
      ? safeInteger(result['message_id'], 1, Number.MAX_SAFE_INTEGER)
      : undefined;
    return messageId === undefined ? null : { messageId };
  }

  /**
   * RUNTIME file_id gate (R1.21): the media reference is an opaque string —
   * bounded, printable ASCII, never a URL and never interpreted. A malformed
   * reference is a typed pre-fetch rejection (permanent; nothing was sent).
   */
  function requireFileId(fileId: string): string {
    if (
      typeof fileId !== 'string' ||
      fileId.length === 0 ||
      fileId.length > 256 ||
      new TextEncoder().encode(fileId).byteLength > 1024
    ) {
      throw new TelegramRichContentError('invalid_content');
    }
    for (let index = 0; index < fileId.length; index += 1) {
      const code = fileId.charCodeAt(index);
      if (code <= 0x20 || code >= 0x7f) {
        throw new TelegramRichContentError('invalid_content');
      }
    }
    return fileId;
  }

  /**
   * RUNTIME rich-content gate: the branded envelope type is compile-time
   * only, so the value's OWN fields are re-validated through the domain
   * validator before any fetch. A forged/malformed value fails typed with
   * ZERO fetch calls; a valid envelope of the WRONG kind fails
   * kind_mismatch; custom_emoji output without the explicit capability
   * fails custom_emoji_not_eligible. The canonical re-validated value is
   * what actually reaches the payload — nothing unvalidated is forwarded.
   */
  function requireRichContent(
    content: RichTextEnvelope,
    expectedKind: RichTextKind,
    customEmojiEligible: boolean,
  ): RichTextEnvelope {
    const candidate = content as unknown;
    const validated = isRecord(candidate)
      ? createRichTextEnvelope({
          kind: candidate['kind'],
          text: candidate['text'],
          entities: candidate['entities'],
        })
      : { ok: false as const, reason: 'invalid_kind' as const };
    if (!validated.ok) {
      throw new TelegramRichContentError('invalid_content');
    }
    if (validated.envelope.kind !== expectedKind) {
      throw new TelegramRichContentError('kind_mismatch');
    }
    if (
      !customEmojiEligible &&
      validated.envelope.entities.some((entity) => entity.type === 'custom_emoji')
    ) {
      throw new TelegramRichContentError('custom_emoji_not_eligible');
    }
    return validated.envelope;
  }

  return {
    async getMe() {
      return callMethod('getMe', {}, (result) => {
        if (!isRecord(result)) return null;
        const id = safeInteger(result['id'], 1, Number.MAX_SAFE_INTEGER);
        if (id === undefined) return null;
        const username = result['username'];
        if (typeof username !== 'string' || username === '') {
          return { id };
        }
        return { id, username };
      });
    },

    async sendMessage(input) {
      return callMethod(
        'sendMessage',
        {
          chat_id: input.chatId,
          text: requireSafeHtml(input.text),
          parse_mode: 'HTML',
          disable_web_page_preview: input.disableLinkPreview ?? true,
          ...(input.replyMarkup !== undefined
            ? {
                reply_markup: {
                  inline_keyboard: input.replyMarkup.inline_keyboard.map((row) =>
                    row.map((button) => ({
                      text: button.text,
                      callback_data: button.callbackData,
                    })),
                  ),
                },
              }
            : {}),
        },
        parseSentMessage,
      );
    },

    async editMessageText(input) {
      return callMethod(
        'editMessageText',
        {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: requireSafeHtml(input.text),
          parse_mode: 'HTML',
        },
        (result) => {
          // Telegram answers `true` or the edited Message.
          if (result === true || parseSentMessage(result) !== null) {
            return true;
          }
          return null;
        },
      );
    },

    async answerCallbackQuery(input) {
      await callMethod(
        'answerCallbackQuery',
        {
          callback_query_id: input.callbackQueryId,
          ...(input.text !== undefined ? { text: input.text } : {}),
        },
        (result) => (result === true ? true : null),
      );
    },

    // ---- R1.19: direct entity-based transport (NO parse_mode anywhere) --
    async sendMessageRich(input) {
      const content = requireRichContent(input.content, 'text', input.customEmojiEligible === true);
      return callMethod(
        'sendMessage',
        {
          chat_id: input.chatId,
          text: content.text,
          entities: richTextEntitiesWire(content.entities),
          disable_web_page_preview: input.disableLinkPreview ?? true,
        },
        parseSentMessage,
      );
    },

    // ---- R1.21: single-media sends (file_id + caption envelope) --------
    async sendPhotoRich(input) {
      // file_id re-checked at the boundary (bounded printable ASCII): a
      // malformed reference fails typed with ZERO fetch calls.
      const photo = requireFileId(input.photo);
      const caption =
        input.caption === undefined
          ? undefined
          : requireRichContent(input.caption, 'caption', input.customEmojiEligible === true);
      return callMethod(
        'sendPhoto',
        {
          chat_id: input.chatId,
          photo,
          ...(caption !== undefined
            ? {
                caption: caption.text,
                caption_entities: richTextEntitiesWire(caption.entities),
              }
            : {}),
        },
        parseSentMessage,
      );
    },

    async sendVideoRich(input) {
      const video = requireFileId(input.video);
      const caption =
        input.caption === undefined
          ? undefined
          : requireRichContent(input.caption, 'caption', input.customEmojiEligible === true);
      return callMethod(
        'sendVideo',
        {
          chat_id: input.chatId,
          video,
          ...(caption !== undefined
            ? {
                caption: caption.text,
                caption_entities: richTextEntitiesWire(caption.entities),
              }
            : {}),
        },
        parseSentMessage,
      );
    },

    async editMessageTextRich(input) {
      const content = requireRichContent(input.content, 'text', input.customEmojiEligible === true);
      return callMethod(
        'editMessageText',
        {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: content.text,
          entities: richTextEntitiesWire(content.entities),
        },
        (result) => {
          // Telegram answers `true` or the edited Message.
          if (result === true || parseSentMessage(result) !== null) {
            return true;
          }
          return null;
        },
      );
    },

    async editMessageCaptionRich(input) {
      const content = requireRichContent(
        input.content,
        'caption',
        input.customEmojiEligible === true,
      );
      return callMethod(
        'editMessageCaption',
        {
          chat_id: input.chatId,
          message_id: input.messageId,
          caption: content.text,
          caption_entities: richTextEntitiesWire(content.entities),
        },
        (result) => {
          if (result === true || parseSentMessage(result) !== null) {
            return true;
          }
          return null;
        },
      );
    },
  };
}
