/**
 * Admin PANEL UI strings (slice 3 — the `/menu` settings surface: mode
 * toggle + adjustable daily cap + event mode) — presentation strings for
 * the admin panel, one table per AdminUiLanguage. The SAME strict
 * separation as `admin-manage-strings.ts`: the labels localize; the
 * managed DATA (mode names, cap numbers, Tehran dates, stable error
 * codes) is never translated or re-cased.
 */
import type { AdminUiLanguage } from './ui-language';
import type { PublishMode } from '../domain/publishing/publishing-settings';
import type { RetentionRule } from '../domain/publishing/post-management';

/** The allowlisted admin-panel command word (the slice-3 screen). */
export const MENU_COMMAND = 'menu' as const;

/** Panel screens: one job per screen, max 3–4 buttons per screen. */
export type PanelScreen = 'main' | 'mode' | 'cap' | 'event' | 'posts';

export interface AdminPanelUiStrings {
  /** /help line advertising the admin panel (gated). */
  readonly helpMenuLine: string;
  /** Denial text for an AUTHORIZED actor whose role may not change settings. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text. */
  readonly invalidUsage: string;
  /** Main panel. */
  readonly mainTitle: string;
  readonly mainModeLabel: string;
  readonly mainCapLabel: string;
  readonly mainTodayLabel: string;
  readonly mainEventLabel: string;
  readonly mainEventOn: string;
  readonly mainEventOff: string;
  readonly modeButton: string;
  readonly capButton: string;
  readonly eventButton: string;
  /** Mode screen: one line per mode. */
  readonly modeTitle: string;
  readonly modeAutoDesc: string;
  readonly modeSafeAutoDesc: string;
  readonly modeApprovalDesc: string;
  readonly modePausedDesc: string;
  readonly modeCurrentMarker: string;
  readonly modeHint: string;
  /** Cap screen. */
  readonly capTitle: string;
  readonly capCurrentLabel: string;
  readonly capTodayLabel: string;
  readonly capPendingLabel: string;
  readonly capHint: string;
  /** Event screen. */
  readonly eventTitle: string;
  readonly eventActiveLine: string;
  readonly eventInactiveLine: string;
  readonly eventEndsLine: string;
  readonly eventOnButton: string;
  readonly eventOffButton: string;
  readonly eventHint: string;
  /** Main panel: the active pin line. */
  readonly mainPinLabel: string;
  readonly mainPinNone: string;
  readonly postsButton: string;
  /** Posts screen (slice 6 — housekeeping). */
  readonly postsTitle: string;
  readonly postsEmpty: string;
  readonly postsFilterAll: string;
  readonly postsFilterExpired: string;
  readonly postsAutoPinLabel: string;
  readonly postsAutoPinOnButton: string;
  readonly postsAutoPinOffButton: string;
  readonly postsRetentionLine: (rule: RetentionRule) => string;
  readonly postsRetentionOnButton: string;
  readonly postsRetentionOffButton: string;
  readonly postsHint: string;
  /** Post detail screen (slice 6). */
  readonly postDetailTitle: string;
  readonly postDetailCategoryLabel: string;
  readonly postDetailPublishedLabel: string;
  readonly postDetailPinnedLabel: string;
  readonly postDetailExpiredLabel: string;
  readonly postDetailPinButton: string;
  readonly postDetailUnpinButton: string;
  readonly postDetailEditButton: string;
  readonly postDetailDeleteButton: string;
  /** Delete confirmation (slice 6). */
  readonly deleteConfirmTitle: string;
  readonly deleteConfirmButton: string;
  readonly deleteCancelButton: string;
  /** Edit capture prompt (slice 6). */
  readonly editPrompt: string;
  /** Shared navigation. */
  readonly backButton: string;
  /** Callback answers (toasts). */
  readonly callbackInvalidToken: string;
  readonly callbackPermissionDenied: string;
  readonly callbackNoChange: string;
  readonly callbackModeSet: Readonly<Record<PublishMode, string>>;
  readonly callbackCapSet: (cap: number, effectiveFrom: string) => string;
  readonly callbackCapNoChange: (cap: number) => string;
  readonly callbackEventOn: string;
  readonly callbackEventOff: string;
  readonly callbackPostMgmtUnavailable: string;
  readonly callbackPinned: string;
  readonly callbackAlreadyPinned: string;
  readonly callbackPinFailed: string;
  readonly callbackUnpinned: string;
  readonly callbackNotPinned: string;
  readonly callbackDeleted: string;
  readonly callbackDeleteFailed: string;
  readonly callbackEditStarted: string;
  /** Slice 6 — the edit-capture completion replies (ingress, not panel). */
  readonly callbackEditDone: string;
  readonly callbackEditFailed: string;
  readonly callbackEditFailedRetryable: string;
  readonly callbackEditInvalidText: string;
  readonly callbackAutoPinOn: string;
  readonly callbackAutoPinOff: string;
  readonly callbackRetentionOn: string;
  readonly callbackRetentionOff: string;
}

export const ADMIN_PANEL_STRINGS: Readonly<Record<AdminUiLanguage, AdminPanelUiStrings>> = {
  en: {
    helpMenuLine: '/menu — Admin panel (mode, daily cap, event)',
    permissionDenied:
      'Access denied: only the owner and chief editor can change publishing settings.',
    invalidUsage: 'Invalid argument. Usage: /menu — /menu mode — /menu cap — /menu event.',
    mainTitle: 'Admin panel',
    mainModeLabel: 'Mode:',
    mainCapLabel: 'Daily cap:',
    mainTodayLabel: 'Today:',
    mainEventLabel: 'Event mode:',
    mainEventOn: 'ON',
    mainEventOff: 'off',
    modeButton: 'Mode',
    capButton: 'Daily cap',
    eventButton: 'Event mode',
    modeTitle: 'Publishing mode',
    modeAutoDesc: 'auto — scheduled + direct, no preview',
    modeSafeAutoDesc: 'safe-auto — auto, but rumor/leak and low-score items go to approval',
    modeApprovalDesc: 'approval — every post needs a preview first',
    modePausedDesc: 'paused — nothing publishes; inbound posts are rejected',
    modeCurrentMarker: '● current',
    modeHint: 'Tap a mode to switch. Send /menu for the main panel.',
    capTitle: 'Daily cap',
    capCurrentLabel: 'Cap in force today:',
    capTodayLabel: 'Published today:',
    capPendingLabel: 'New cap from tomorrow:',
    capHint: 'A cap change takes effect from the next Tehran day, never mid-day.',
    eventTitle: 'Event mode',
    eventActiveLine: 'Event mode is ON — the daily cap is lifted.',
    eventInactiveLine: 'Event mode is off.',
    eventEndsLine:
      'It ends when you turn it off, after 6 hours, or after 2 hours with no fresh P0.',
    eventOnButton: 'Turn event ON',
    eventOffButton: 'Turn event OFF',
    eventHint: 'While active, the minimum gap is 8–15 minutes.',
    mainPinLabel: 'Pinned:',
    mainPinNone: 'none',
    postsButton: 'Posts',
    postsTitle: 'Channel posts',
    postsEmpty: 'No published posts yet.',
    postsFilterAll: 'All',
    postsFilterExpired: 'Expired',
    postsAutoPinLabel: 'Auto-pin P0:',
    postsAutoPinOnButton: 'Auto-pin P0: ON',
    postsAutoPinOffButton: 'Auto-pin P0: OFF',
    postsRetentionLine: (rule) =>
      `Retention: ${rule.enabled ? 'on' : 'off'} — expired after ${rule.defaultDays}d (${rule.freeGameDays}d for free games).`,
    postsRetentionOnButton: 'Retention: ON',
    postsRetentionOffButton: 'Retention: OFF',
    postsHint: 'Tap a post to open it. Send /menu for the main panel.',
    postDetailTitle: 'Post',
    postDetailCategoryLabel: 'Category:',
    postDetailPublishedLabel: 'Published:',
    postDetailPinnedLabel: 'Pinned:',
    postDetailExpiredLabel: 'Expired:',
    postDetailPinButton: 'Pin',
    postDetailUnpinButton: 'Unpin',
    postDetailEditButton: 'Edit',
    postDetailDeleteButton: 'Delete',
    deleteConfirmTitle: 'Delete this post?',
    deleteConfirmButton: 'Yes, delete',
    deleteCancelButton: 'Cancel',
    editPrompt: 'Send the new text for this post now (30 minutes).',
    backButton: '‹ Back',
    callbackInvalidToken: 'This button is no longer valid.',
    callbackPermissionDenied:
      'Access denied: only the owner and chief editor can change publishing settings.',
    callbackNoChange: 'Nothing changed — the setting already has that value.',
    callbackModeSet: {
      auto: 'Mode set to auto.',
      'safe-auto': 'Mode set to safe-auto.',
      approval: 'Mode set to approval.',
      paused: 'Mode set to paused. Nothing will publish.',
    },
    callbackCapSet: (cap, effectiveFrom) => `Daily cap set to ${cap} from ${effectiveFrom}.`,
    callbackCapNoChange: (cap) => `Daily cap is already ${cap}.`,
    callbackEventOn: 'Event mode ON — the daily cap is lifted.',
    callbackEventOff: 'Event mode OFF.',
    callbackPostMgmtUnavailable: 'Post management is not available right now.',
    callbackPinned: 'Post pinned.',
    callbackAlreadyPinned: 'This post is already pinned.',
    callbackPinFailed: 'Pin failed — the post was not pinned.',
    callbackUnpinned: 'Post unpinned.',
    callbackNotPinned: 'This post is not pinned.',
    callbackDeleted: 'Post deleted.',
    callbackDeleteFailed: 'Delete failed — the post was not deleted.',
    callbackEditStarted: 'Edit started — send the new text now.',
    callbackEditDone: 'Post edited.',
    callbackEditFailed: 'Edit failed — the post was not changed.',
    callbackEditFailedRetryable: 'Edit failed for now — send the new text again to retry.',
    callbackEditInvalidText: 'The new text must be 1–4096 characters.',
    callbackAutoPinOn: 'Auto-pin P0 ON — very big news pins itself.',
    callbackAutoPinOff: 'Auto-pin P0 OFF.',
    callbackRetentionOn: 'Retention ON.',
    callbackRetentionOff: 'Retention OFF.',
  },
  fa: {
    helpMenuLine: '/menu — پنل مدیریت (حالت، سقف روزانه، ایونت)',
    permissionDenied: 'دسترسی رد شد: فقط مالک و سردبیر ارشد می‌توانند تنظیمات انتشار را عوض کنند.',
    invalidUsage: 'پارامتر نامعتبر است. کاربرد: /menu — /menu mode — /menu cap — /menu event.',
    mainTitle: 'پنل مدیریت',
    mainModeLabel: 'حالت:',
    mainCapLabel: 'سقف روزانه:',
    mainTodayLabel: 'امروز:',
    mainEventLabel: 'حالت ایونت:',
    mainEventOn: 'روشن',
    mainEventOff: 'خاموش',
    modeButton: 'حالت',
    capButton: 'سقف روزانه',
    eventButton: 'حالت ایونت',
    modeTitle: 'حالت انتشار',
    modeAutoDesc: 'auto — زمان‌بندی‌شده + مستقیم، بدون پیش‌نمایش',
    modeSafeAutoDesc: 'safe-auto — خودکار، ولی شایعه/لیک و آیتم کم‌امتیاز به تأیید می‌رود',
    modeApprovalDesc: 'approval — هر پست اول پیش‌نمایش می‌خواهد',
    modePausedDesc: 'paused — هیچ‌چیز منتشر نمی‌شود؛ پست‌های ورودی رد می‌شوند',
    modeCurrentMarker: '● فعلی',
    modeHint: 'برای تغییر حالت، روی آن بزنید. برای پنل اصلی /menu را بفرستید.',
    capTitle: 'سقف روزانه',
    capCurrentLabel: 'سقف امروز:',
    capTodayLabel: 'منتشرشدهٔ امروز:',
    capPendingLabel: 'سقف جدید از فردا:',
    capHint: 'تغییر سقف از روز بعد تهران اثر می‌کند، هرگز وسط روز.',
    eventTitle: 'حالت ایونت',
    eventActiveLine: 'حالت ایونت روشن است — سقف روزانه برداشته شده است.',
    eventInactiveLine: 'حالت ایونت خاموش است.',
    eventEndsLine: 'با خاموش‌کردن دستی، بعد از ۶ ساعت، یا بعد از ۲ ساعت بدون P0 تازه تمام می‌شود.',
    eventOnButton: 'روشن‌کردن ایونت',
    eventOffButton: 'خاموش‌کردن ایونت',
    eventHint: 'تا وقتی فعال است، حداقل فاصله ۸ تا ۱۵ دقیقه است.',
    mainPinLabel: 'پین‌شده:',
    mainPinNone: 'هیچ',
    postsButton: 'پست‌ها',
    postsTitle: 'پست‌های چنل',
    postsEmpty: 'هنوز پستی منتشر نشده است.',
    postsFilterAll: 'همه',
    postsFilterExpired: 'منقضی‌شده',
    postsAutoPinLabel: 'پین خودکار P0:',
    postsAutoPinOnButton: 'پین خودکار P0: روشن',
    postsAutoPinOffButton: 'پین خودکار P0: خاموش',
    postsRetentionLine: (rule) =>
      `نگهداری: ${rule.enabled ? 'روشن' : 'خاموش'} — انقضا بعد از ${rule.defaultDays} روز (${rule.freeGameDays} روز برای بازی رایگان).`,
    postsRetentionOnButton: 'نگهداری: روشن',
    postsRetentionOffButton: 'نگهداری: خاموش',
    postsHint: 'برای بازکردن یک پست روی آن بزنید. برای پنل اصلی /menu را بفرستید.',
    postDetailTitle: 'پست',
    postDetailCategoryLabel: 'دسته:',
    postDetailPublishedLabel: 'منتشرشده:',
    postDetailPinnedLabel: 'پین‌شده:',
    postDetailExpiredLabel: 'منقضی‌شده:',
    postDetailPinButton: 'پین',
    postDetailUnpinButton: 'آنپین',
    postDetailEditButton: 'ادیت',
    postDetailDeleteButton: 'حذف',
    deleteConfirmTitle: 'این پست حذف شود؟',
    deleteConfirmButton: 'بله، حذف کن',
    deleteCancelButton: 'لغو',
    editPrompt: 'متن جدید این پست را همین حالا بفرستید (۳۰ دقیقه).',
    backButton: '‹ بازگشت',
    callbackInvalidToken: 'این دکمه دیگر معتبر نیست.',
    callbackPermissionDenied:
      'دسترسی رد شد: فقط مالک و سردبیر ارشد می‌توانند تنظیمات انتشار را عوض کنند.',
    callbackNoChange: 'چیزی تغییر نکرد — تنظیم همین حالا همین مقدار را داشت.',
    callbackModeSet: {
      auto: 'حالت روی auto تنظیم شد.',
      'safe-auto': 'حالت روی safe-auto تنظیم شد.',
      approval: 'حالت روی approval تنظیم شد.',
      paused: 'حالت روی paused تنظیم شد. هیچ‌چیز منتشر نمی‌شود.',
    },
    callbackCapSet: (cap, effectiveFrom) => `سقف روزانه از ${effectiveFrom} روی ${cap} تنظیم شد.`,
    callbackCapNoChange: (cap) => `سقف روزانه همین حالا ${cap} است.`,
    callbackEventOn: 'حالت ایونت روشن شد — سقف روزانه برداشته شد.',
    callbackEventOff: 'حالت ایونت خاموش شد.',
    callbackPostMgmtUnavailable: 'مدیریت پست در حال حاضر در دسترس نیست.',
    callbackPinned: 'پست پین شد.',
    callbackAlreadyPinned: 'این پست همین حالا پین است.',
    callbackPinFailed: 'پین ناموفق بود — پست پین نشد.',
    callbackUnpinned: 'پین پست برداشته شد.',
    callbackNotPinned: 'این پست پین نیست.',
    callbackDeleted: 'پست حذف شد.',
    callbackDeleteFailed: 'حذف ناموفق بود — پست حذف نشد.',
    callbackEditStarted: 'ادیت شروع شد — متن جدید را همین حالا بفرستید.',
    callbackEditDone: 'پست ویرایش شد.',
    callbackEditFailed: 'ادیت ناموفق بود — پست تغییر نکرد.',
    callbackEditFailedRetryable:
      'ادیت فعلاً ناموفق بود — متن جدید را دوباره بفرستید تا دوباره تلاش شود.',
    callbackEditInvalidText: 'متن جدید باید ۱ تا ۴۰۹۶ کاراکتر باشد.',
    callbackAutoPinOn: 'پین خودکار P0 روشن شد — خبر خیلی بزرگ خودش پین می‌شود.',
    callbackAutoPinOff: 'پین خودکار P0 خاموش شد.',
    callbackRetentionOn: 'نگهداری روشن شد.',
    callbackRetentionOff: 'نگهداری خاموش شد.',
  },
};
