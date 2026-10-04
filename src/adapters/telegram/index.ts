/**
 * Telegram adapter boundary (Phase 2A).
 * Public surface of the Telegram-facing adapters: the bounded Update parser
 * and the durable update-claim lifecycle on `telegram_updates`. The Bot API
 * client boundary and repositories are added by their owning slices; no live
 * Telegram connection exists in Phase 2A.
 */
export {
  parseTelegramUpdate,
  extractBotCommand,
  TELEGRAM_UPDATE_LIMITS,
  type ParsedUpdate,
  type ParsedMessageFields,
  type ParsedCallbackFields,
  type UpdateParseResult,
  type UpdateParseFailureReason,
} from './update-parser';
export {
  claimTelegramUpdate,
  markTelegramUpdateProcessed,
  markTelegramUpdateFailed,
  type TelegramUpdateClaim,
  type TelegramUpdateRowStatus,
} from './update-claims';
