/**
 * Admin UI language selection (Phase 2B correction, v1.2.5; ordering
 * corrected in v1.2.6 — ADR-0035).
 *
 * STRICT SEPARATION (the reason this module exists): the ADMIN BOT UI
 * language — the language the BOT ANSWERS an authorized admin in — is a
 * per-admin presentation preference ONLY. It is NOT the editorial language,
 * NOT the channel-post language, and NOT a publishing setting:
 *   - Editorial/channel output remains Persian (fa, RTL) per the blueprint;
 *     `drafts.language` keeps its 'fa' default and no editorial or blueprint
 *     file is touched by this feature.
 *   - This module therefore uses EXPLICITLY NAMED `AdminUiLanguage` types and
 *     a dedicated `admin_ui_language:` settings-key namespace — never the
 *     editorial language fields, never shared keys.
 *
 * Rules:
 * - ENGLISH is the DEFAULT admin UI language: an admin without a stored
 *   preference (including the bootstrap owner) is served English.
 * - Each authorized admin selects their OWN UI language via /language
 *   (`/language`, `/language en`, `/language fa`). The command always
 *   resolves the SENDER's numeric Telegram user ID — there is no syntax that
 *   can change another admin's preference.
 * - The preference is persisted DURABLY by numeric Telegram user ID in the
 *   existing `settings` table (no schema change; blueprint settings table,
 *   ADR-0019) under the `admin_ui_language:<user_id>` key namespace. One
 *   admin's row is fully isolated from every other admin's row.
 * - Writes are ORDER-FENCED by VALIDATED TELEGRAM MESSAGE-ORDER METADATA
 *   (v1.2.6, ADR-0035): `(message.date, message.message_id)` — the
 *   server-assigned chronology of the changing message. `update_id` is NOT
 *   used as a chronological fence: Telegram documents that update_id may be
 *   RANDOMIZED after one week without updates, so its numeric value is not a
 *   trustworthy order. `update_id` remains exactly what it is elsewhere in
 *   the system — the DURABLE DEDUPLICATION boundary (ADR-0025 claims layer,
 *   recorded here for audit) — while preference ordering uses the message
 *   metadata Telegram guarantees to be chronological. An OLDER retried
 *   message (older date/message_id, arriving later) can never overwrite a
 *   NEWER choice; local processing/arrival time is deliberately NOT used
 *   because an old retry arrives later. The fence lives in the single UPSERT
 *   statement, so the read-decide-write race is impossible.
 * - CORRUPT-ROW RECOVERY (v1.2.6, ADR-0035): a stored value that is
 *   unreadable (malformed JSON, or valid JSON with invalid field
 *   types/values) behaves as "no preference" (English default) AND the next
 *   valid save atomically REPAIRS it — a presentation preference must never
 *   become a permanently stuck row. The fence for VALID rows is never
 *   weakened by the recovery path.
 * - `updated_by` is stored as NULL: the column carries a foreign key to the
 *   `admins` table, and the bootstrap owner is authorized WITHOUT an admins
 *   row — a non-null value would make the owner's first save fail on a
 *   foreign-key violation.
 */

/**
 * The Admin BOT UI languages. `en` is the default; `fa` is the Persian
 * (RTL) presentation of the SAME admin surface. These values are presentation
 * codes for the admin UI only — they are never written to editorial fields.
 */
export const ADMIN_UI_LANGUAGES = ['en', 'fa'] as const;

export type AdminUiLanguage = (typeof ADMIN_UI_LANGUAGES)[number];

/** English is the DEFAULT admin bot UI language (v1.2.5 requirement). */
export const DEFAULT_ADMIN_UI_LANGUAGE: AdminUiLanguage = 'en';

/** Exact-match guard (no normalization — for stored/typed values). */
export function isAdminUiLanguage(value: string): value is AdminUiLanguage {
  return (ADMIN_UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Normalize a user-supplied command argument to an AdminUiLanguage:
 * trimmed and lowercased first, so `/language EN`, `/language Fa` and
 * `/language fa ` are accepted; anything else (unknown codes, empty,
 * oversized junk) is rejected as undefined.
 */
export function normalizeAdminUiLanguage(value: string): AdminUiLanguage | undefined {
  const normalized = value.trim().toLowerCase();
  return isAdminUiLanguage(normalized) ? normalized : undefined;
}

/**
 * Settings-table key namespace (STRICT SEPARATION): every admin UI language
 * preference lives under this prefix followed by the admin's numeric
 * Telegram user ID, e.g. `admin_ui_language:1000000001`. The prefix can
 * never collide with editorial or system settings keys. Parameterized SQL
 * only; the key is never logged (ADR-0022).
 */
export const ADMIN_UI_LANGUAGE_SETTINGS_KEY_PREFIX = 'admin_ui_language:';

export function adminUiLanguageSettingsKey(telegramUserId: number): string {
  return `${ADMIN_UI_LANGUAGE_SETTINGS_KEY_PREFIX}${telegramUserId}`;
}

/** A durably stored per-admin UI language preference. */
export interface AdminUiLanguagePreference {
  readonly language: AdminUiLanguage;
  /**
   * Epoch ms of the most recent accepted change, derived from the Telegram
   * message's SERVER-assigned `date` (seconds × 1000) — never a local clock
   * reading (ADR-0035).
   */
  readonly changedAtMs: number;
  /**
   * update_id of the message that performed the most recent accepted change —
   * the durable DEDUPLICATION boundary (ADR-0025), recorded for audit only.
   * It is deliberately NOT the chronological fence (Telegram may randomize
   * update_id after one week without updates — ADR-0035).
   */
  readonly lastUpdateId: number;
  /**
   * Telegram `message_id` of the winning message — the same-second
   * tiebreak of the ordering fence (per-chat monotonic). Absent when the
   * write could not provide validated ordering metadata for it.
   */
  readonly lastMessageId?: number;
}

/** Outcome of a fenced preference write. */
export type AdminUiLanguageSaveOutcome = { readonly kind: 'saved' } | { readonly kind: 'stale' };

/**
 * Storage port for admin UI language preferences (implemented by the D1
 * adapter over the existing `settings` table — no schema change).
 *
 * Failure semantics: storage failures THROW (mapped AppError) — a caller
 * must never answer a language change with a success confirmation when the
 * preference was not durably persisted.
 */
export interface AdminUiLanguageStore {
  /**
   * The admin's stored preference, or null when none exists or the stored
   * value is unreadable (corrupt rows behave as "no preference" — English
   * default — while the write fence still applies).
   */
  findPreference(telegramUserId: number): Promise<AdminUiLanguagePreference | null>;
  /**
   * Persist a language choice ORDER-FENCED by VALIDATED TELEGRAM
   * MESSAGE-ORDER METADATA (ADR-0035): `changedAtMs` is the changing
   * message's server-assigned `date` in epoch ms (never a local clock
   * reading) and `messageId` its per-chat `message_id` (same-second
   * tiebreak). The write applies only when no strictly newer change is
   * already stored — lexicographic `(changedAtMs, messageId)` ordering;
   * an equal-ordering write is a duplicate delivery and re-applies
   * idempotently. An OLDER retried message (older date/message_id, no
   * matter when it ARRIVES) resolves `stale` — without writing — so it can
   * never overwrite a newer selection. A stored value that is unreadable
   * (malformed JSON or invalid field types) never blocks the next valid
   * save: it is atomically repaired (ADR-0035) — without weakening the
   * fence for valid rows.
   */
  savePreference(input: {
    readonly telegramUserId: number;
    readonly language: AdminUiLanguage;
    /** Durable deduplication boundary (ADR-0025); audit value only. */
    readonly updateId: number;
    /** Server-assigned message time (epoch ms) — the ordering key. */
    readonly changedAtMs: number;
    /** Per-chat message_id — the same-second ordering tiebreak. */
    readonly messageId?: number;
  }): Promise<AdminUiLanguageSaveOutcome>;
}

/**
 * Author-authored admin UI string tables (one per UI language). These are
 * presentation strings for the ADMIN BOT UI; channel/editorial content is
 * out of scope and untouched. The router composes them into Telegram-safe
 * HTML (escaping stays centralized there).
 */
export interface AdminUiStrings {
  readonly startTitle: string;
  readonly startBody: string;
  readonly startHint: string;
  readonly helpTitle: string;
  readonly helpStart: string;
  readonly helpHelp: string;
  readonly helpStatus: string;
  readonly helpVersion: string;
  readonly helpLanguage: string;
  readonly statusTitle: string;
  readonly statusActive: string;
  readonly statusVersionLabel: string;
  readonly versionLabel: string;
  readonly languageTitle: string;
  readonly languageCurrentLabel: string;
  readonly languageHint: string;
  /** Display names of each selectable language IN this UI language. */
  readonly languageNames: Readonly<Record<AdminUiLanguage, string>>;
}

export const ADMIN_UI_STRINGS: Readonly<Record<AdminUiLanguage, AdminUiStrings>> = {
  en: {
    startTitle: 'Pixel',
    startBody: 'Admin panel is active.',
    startHint: 'Send /help for the command list.',
    helpTitle: 'Commands',
    helpStart: '/start — Start the panel',
    helpHelp: '/help — Show this help',
    helpStatus: '/status — System status',
    helpVersion: '/version — Application version',
    helpLanguage: '/language — Admin UI language',
    statusTitle: 'Status',
    statusActive: 'System: active',
    statusVersionLabel: 'Application version:',
    versionLabel: 'Application version:',
    languageTitle: 'Admin UI language',
    languageCurrentLabel: 'Current:',
    languageHint: 'Send /language fa for Persian or /language en for English.',
    languageNames: { en: 'English', fa: 'Persian' },
  },
  fa: {
    startTitle: 'پیکسل',
    startBody: 'پنل مدیریت فعال است.',
    startHint: 'برای فهرست دستورها /help را بفرستید.',
    helpTitle: 'دستورها',
    helpStart: '/start — شروع پنل',
    helpHelp: '/help — راهنما',
    helpStatus: '/status — وضعیت سیستم',
    helpVersion: '/version — نسخه برنامه',
    helpLanguage: '/language — زبان رابط مدیریت',
    statusTitle: 'وضعیت',
    statusActive: 'سیستم: فعال',
    statusVersionLabel: 'نسخه برنامه:',
    versionLabel: 'نسخه برنامه:',
    languageTitle: 'زبان رابط مدیریت',
    languageCurrentLabel: 'زبان فعلی:',
    languageHint: 'برای فارسی /language fa و برای انگلیسی /language en را بفرستید.',
    languageNames: { en: 'انگلیسی', fa: 'فارسی' },
  },
};

/**
 * Confirmation for an ACCEPTED language change, keyed by the TARGET
 * language (the admin just switched to it, so the confirmation is written
 * in the language they switched TO).
 */
export const LANGUAGE_SAVED_TEXT: Readonly<Record<AdminUiLanguage, string>> = {
  en: 'Admin UI language set to English.',
  fa: 'زبان رابط مدیریت به فارسی تغییر کرد.',
};

/**
 * Honest reply when a language-change message is STALE (an older retried
 * message arriving after a newer choice was already stored): nothing was
 * applied. Keyed by the admin's CURRENT (stored) UI language.
 */
export const LANGUAGE_STALE_TEXT: Readonly<Record<AdminUiLanguage, string>> = {
  en: 'Not applied: a newer language choice is already saved.',
  fa: 'اعمال نشد: انتخاب جدیدتری برای زبان ذخیره شده است.',
};

/**
 * Minimal denial for unauthorized senders — ENGLISH by requirement (v1.2.5):
 * an unauthorized user has no admin preference to consult, so the denial is
 * always the fixed minimal English string (supersedes the Phase 2A Persian
 * denial; ADR-0034).
 */
export const ADMIN_UI_DENIAL_TEXT = 'Access denied.';
