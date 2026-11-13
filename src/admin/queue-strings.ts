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
  // ---- Phase 9C: the write-capable detail surface (ADMIN_QUEUE_WRITE_ENABLED) ----
  /** The detail view title (the id and the status names are machine data —
   *  never translated; the LABELS localize). */
  readonly detailTitle: string;
  readonly detailIdentityLabel: string;
  readonly detailStatusLabel: string;
  readonly detailPriorityLabel: string;
  readonly detailAttemptsLabel: string;
  readonly detailScheduleLabel: string;
  readonly detailErrorLabel: string;
  readonly detailDispositionLabel: string;
  readonly detailDispositionCancellable: string;
  readonly detailDispositionInFlight: string;
  readonly detailDispositionAlreadyPublished: string;
  readonly detailDispositionTerminal: string;
  readonly detailNotFound: string;
  /** The cancel button label (the ONLY write this surface offers). */
  readonly cancelButton: string;
  /** The callback answers (the single-use disposition flow). */
  readonly callbackCancelled: string;
  readonly callbackNotCancellable: string;
  readonly callbackNotFound: string;
  readonly callbackInvalidToken: string;
  readonly callbackPermissionDenied: string;
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
    detailTitle: 'Publication detail',
    detailIdentityLabel: 'Id:',
    detailStatusLabel: 'Status:',
    detailPriorityLabel: 'Priority:',
    detailAttemptsLabel: 'Attempts:',
    detailScheduleLabel: 'Run after:',
    detailErrorLabel: 'Last error:',
    detailDispositionLabel: 'Disposition:',
    detailDispositionCancellable: 'cancel available (this row can be stopped)',
    detailDispositionInFlight: 'unavailable — the row is in flight (a worker may hold the lease)',
    detailDispositionAlreadyPublished:
      'unavailable — the row is published (the correction supersede flow owns it)',
    detailDispositionTerminal: 'unavailable — the row is in a terminal state',
    detailNotFound: 'No publication found under that id.',
    cancelButton: 'Cancel publication',
    callbackCancelled: 'Cancelled: the publication will not send.',
    callbackNotCancellable: 'Not cancellable — the row is no longer in a cancellable state.',
    callbackNotFound: 'No publication found under that id.',
    callbackInvalidToken: 'This button is no longer valid.',
    callbackPermissionDenied:
      'Access denied: your role does not include the publication cancellation permission.',
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
    detailTitle: 'جزئیات نشریه',
    detailIdentityLabel: 'شناسه:',
    detailStatusLabel: 'وضعیت:',
    detailPriorityLabel: 'اولویت:',
    detailAttemptsLabel: 'تلاش‌ها:',
    detailScheduleLabel: 'زمان اجرا:',
    detailErrorLabel: 'آخرین خطا:',
    detailDispositionLabel: 'اقدام:',
    detailDispositionCancellable: 'امکان لغو موجود است (این ردیف قابل توقف است)',
    detailDispositionInFlight:
      'ناموجود — ردیف در حال اجراست (ممکن است worker آن را در اختیار داشته باشد)',
    detailDispositionAlreadyPublished: 'ناموجود — ردیف منتشر شده (جریان اصلاح/جانشینی مالک آن است)',
    detailDispositionTerminal: 'ناموجود — ردیف در وضعیت پایانی است',
    detailNotFound: 'نشریه‌ای با این شناسه یافت نشد.',
    cancelButton: 'لغو نشریه',
    callbackCancelled: 'لغو شد: این نشریه ارسال نخواهد شد.',
    callbackNotCancellable: 'قابل لغو نیست — ردیف دیگر در وضعیت قابل لغو نیست.',
    callbackNotFound: 'نشریه‌ای با این شناسه یافت نشد.',
    callbackInvalidToken: 'این دکمه دیگر معتبر نیست.',
    callbackPermissionDenied: 'دسترسی رد شد: نقش شما شامل اجازهٔ لغو انتشار نیست.',
  },
};
