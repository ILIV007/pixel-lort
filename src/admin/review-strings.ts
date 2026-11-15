/**
 * Admin REVIEW UI strings (R1.18 — ADR-0046) — presentation strings for the
 * read-only `/drafts` surface, one table per AdminUiLanguage.
 *
 * STRICT SEPARATION (mirrors `ui-language.ts`): these labels present the
 * ADMIN BOT surface only. The editorial content INSIDE a draft (Persian
 * headline/summary/excerpts, model claims, source text) is stored editorial
 * data and is NEVER translated, rewritten, or re-cased by this module — the
 * labels around it localize; the draft content stays exactly as stored.
 *
 * Everything these tables compose is escaped by the SAME centralized
 * Telegram-HTML builders the rest of the admin surface uses; no raw HTML is
 * ever interpolated.
 */
import type { AdminUiLanguage } from './ui-language';

/** The allowlisted review command word (blueprint admin map: `drafts`). */
export const REVIEW_COMMAND = 'drafts' as const;

/** Maximum UTF-8 byte length of an opaque draft-id command argument. */
export const REVIEW_DRAFT_ID_MAX_BYTES = 128;

export interface ReviewUiStrings {
  /** /help line advertising the read-only review surface (gated). */
  readonly helpDraftsLine: string;
  /** Denial text for an AUTHORIZED actor WITHOUT `draft.view`. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text (authorized actors only). */
  readonly invalidUsage: string;
}

export const ADMIN_REVIEW_STRINGS: Readonly<Record<AdminUiLanguage, ReviewUiStrings>> = {
  en: {
    helpDraftsLine: '/drafts — Review stored drafts (read-only)',
    permissionDenied: 'Access denied: your role does not include draft viewing permission.',
    invalidUsage:
      'Invalid argument. Usage: /drafts to list the newest ready drafts, or /drafts <draftId> to show one stored draft (read-only). The ID must be a single token of at most 128 bytes without spaces or control characters.',
  },
  fa: {
    helpDraftsLine: '/drafts — مرور پیش‌نویس‌های ذخیره‌شده (فقط خواندنی)',
    permissionDenied: 'دسترسی رد شد: نقش شما شامل اجازهٔ مشاهدهٔ پیش‌نویس نیست.',
    invalidUsage:
      'پارامتر نامعتبر است. کاربرد: /drafts برای فهرست تازه‌ترین پیش‌نویس‌های آماده، یا /drafts <draftId> برای نمایش یک پیش‌نویس ذخیره‌شده (فقط خواندنی). شناسه باید یک توکن واحد با حداکثر ۱۲۸ بایت و بدون فاصله یا نویسهٔ کنترلی باشد.',
  },
};
