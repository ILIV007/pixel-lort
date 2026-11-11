/**
 * Admin QUEUE UI strings (Phase 9A — the read-only `/queue` surface) —
 * presentation strings for the publication-outbox observation screen, one
 * table per AdminUiLanguage. The SAME strict separation as
 * `review-strings.ts`: the labels localize; the outbox DATA (ids, status
 * names, stable error codes) is never translated or re-cased.
 */
import type { AdminUiLanguage } from './ui-language';

/** The allowlisted queue command word (the Phase 9A screen). */
export const QUEUE_COMMAND = 'queue' as const;

export interface QueueUiStrings {
  /** /help line advertising the read-only queue surface (gated). */
  readonly helpQueueLine: string;
  /** Denial text for an AUTHORIZED actor WITHOUT `publication.view`. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text (authorized actors only). */
  readonly invalidUsage: string;
  readonly emptyTitle: string;
  readonly countsTitle: string;
  readonly recentTitle: string;
  /** Honest observation note: the send gate state is surfaced, never hidden. */
  readonly sendGateOn: string;
  readonly sendGateOff: string;
  readonly emptyQueue: string;
}

export const ADMIN_QUEUE_STRINGS: Readonly<Record<AdminUiLanguage, QueueUiStrings>> = {
  en: {
    helpQueueLine: '/queue — Publication outbox status (read-only)',
    permissionDenied: 'Access denied: your role does not include publication viewing permission.',
    invalidUsage:
      'Invalid argument. Usage: /queue (no arguments) — the bounded publication outbox status view (read-only).',
    emptyTitle: 'Publication queue (read-only)',
    countsTitle: 'Status counts:',
    recentTitle: 'Most recent (max 8):',
    sendGateOn: 'Send gate: ON (the scheduler may send due publications).',
    sendGateOff: 'Send gate: OFF — decision-only observation, nothing sends.',
    emptyQueue: 'The outbox is empty (no publications recorded yet).',
  },
  fa: {
    helpQueueLine: '/queue — وضعیت صف انتشار (فقط خواندنی)',
    permissionDenied: 'دسترسی رد شد: نقش شما شامل اجازهٔ مشاهدهٔ انتشار نیست.',
    invalidUsage:
      'پارامتر نامعتبر است. کاربرد: /queue (بدون پارامتر) — نمای محدود وضعیت صف انتشار (فقط خواندنی).',
    emptyTitle: 'صف انتشار (فقط خواندنی)',
    countsTitle: 'شمارش وضعیت‌ها:',
    recentTitle: 'تازه‌ترین‌ها (حداکثر ۸):',
    sendGateOn: 'گیت ارسال: روشن — زمان‌بند می‌تواند نشریات سررسید‌شده را بفرستد.',
    sendGateOff: 'گیت ارسال: خاموش — فقط مشاهده؛ چیزی ارسال نمی‌شود.',
    emptyQueue: 'صف خالی است (هنوز نشریاتی ثبت نشده).',
  },
};
