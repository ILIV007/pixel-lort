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

/** The allowlisted admin-panel command word (the slice-3 screen). */
export const MENU_COMMAND = 'menu' as const;

/** Panel screens: one job per screen, max 3–4 buttons per screen. */
export type PanelScreen = 'main' | 'mode' | 'cap' | 'event';

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
  },
};
