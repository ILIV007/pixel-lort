/**
 * Admin ALBUM-CAPTURE UI strings (Phase 9D) — presentation strings for the
 * media-group capture surface, one table per AdminUiLanguage. The SAME
 * strict separation as `queue-strings.ts`: the labels localize; the machine
 * data (ids, kinds, ordinals, stable codes) is never translated or re-cased.
 */
import type { AdminUiLanguage } from './ui-language';

/** The allowlisted album-capture command word (the Phase 9D surface). */
export const ALBUM_CAPTURE_COMMAND = 'album_capture' as const;

export interface AlbumCaptureUiStrings {
  /** Denial text for an AUTHORIZED actor WITHOUT `draft.create`. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text (authorized actors only). */
  readonly invalidUsage: string;
  readonly startedTitle: string;
  readonly startedBody: string;
  readonly rightsNote: string;
  readonly statusTitle: string;
  readonly statusEmpty: string;
  readonly statusItems: string;
  readonly storyNotFound: string;
  readonly captureAppend: string;
  readonly captureNoSession: string;
  readonly captureKindUnsupported: string;
  readonly captureAlbumFull: string;
  readonly captureDuplicate: string;
  readonly captureCaptionStored: string;
  readonly finishTooFew: string;
  readonly finishDone: string;
  readonly finishUnavailable: string;
  readonly finishCancelled: string;
  readonly notFound: string;
}

export const ADMIN_ALBUM_CAPTURE_STRINGS: Readonly<Record<AdminUiLanguage, AlbumCaptureUiStrings>> =
  {
    en: {
      permissionDenied: 'Access denied: your role does not include the draft creation permission.',
      invalidUsage:
        'Invalid argument. Usage: /album_capture <storyId> to start · /album_capture for status · /album_capture finish · /album_capture cancel.',
      startedTitle: 'Album capture started',
      startedBody:
        'Send the media group (2-10 photos/videos) as ONE Telegram album in this chat, then run /album_capture finish. /album_capture cancel aborts.',
      rightsNote:
        'Honest boundary: captured media is stored as rights-unknown evidence. The machine invents no permission — the album can never send until the owner records rights evidence (OD-010). Nothing sends from this surface.',
      statusTitle: 'Album capture status',
      statusEmpty: 'No active capture session. Start one with /album_capture <storyId>.',
      statusItems: 'Gathered members:',
      storyNotFound: 'No story found under that id — the capture needs an existing story.',
      captureAppend: 'Captured (members now:',
      captureNoSession:
        'No active album capture session. Start one first with /album_capture <storyId>.',
      captureKindUnsupported: 'Not captured: only photo/video album members are gathered.',
      captureAlbumFull: 'Not captured: the album is full (10 members is the Telegram bound).',
      captureDuplicate: 'Not captured: this exact file reference is already in the session.',
      captureCaptionStored: 'Caption stored (the first caption wins).',
      finishTooFew:
        'Finish refused: an album needs at least 2 members. Keep sending the album members, or cancel.',
      finishDone:
        'Capture finished: the members are stored as durable rights-unknown candidate evidence. The album draft production stays BLOCKED on the rights-evidence model (OD-010) — the machine invents no permission, nothing sends.',
      finishUnavailable: 'Finish unavailable: the durable write failed — try again.',
      finishCancelled: 'Album capture cancelled. Nothing was stored.',
      notFound: 'No story found under that id.',
    },
    fa: {
      permissionDenied: 'دسترسی رد شد: نقش شما شامل اجازهٔ ساخت پیش‌نویس نیست.',
      invalidUsage:
        'پارامتر نامعتبر است. کاربرد: /album_capture <storyId> برای شروع · /album_capture برای وضعیت · /album_capture finish برای پایان · /album_capture cancel برای لغو.',
      startedTitle: 'جلسهٔ جمع‌آوری آلبوم شروع شد',
      startedBody:
        'آلبوم را به‌صورت یک رسانه‌گروه تلگرام (۲ تا ۱۰ عکس/ویدیو) در همین گفتگو بفرستید، سپس /album_capture finish را اجرا کنید. /album_capture cancel لغو می‌کند.',
      rightsNote:
        'مرز صادقانه: رسانه‌های گرفته‌شده به‌عنوان مدرک با حق ناشناس ذخیره می‌شوند. ماشین هیچ مجوزی نمی‌سازد — آلبوم تا زمانی که مالک مدرک حق ثبت نکند هرگز ارسال نمی‌شود (OD-010). از این سطح چیزی ارسال نمی‌شود.',
      statusTitle: 'وضعیت جمع‌آوری آلبوم',
      statusEmpty: 'جلسهٔ فعالی وجود ندارد. با /album_capture <storyId> شروع کنید.',
      statusItems: 'اعضای جمع‌آوری‌شده:',
      storyNotFound: 'داستانی با این شناسه یافت نشد — جمع‌آوری به داستان موجود نیاز دارد.',
      captureAppend: 'ثبت شد (تعداد اعضا:',
      captureNoSession:
        'جلسهٔ جمع‌آوری فعالی وجود ندارد. اول با /album_capture <storyId> شروع کنید.',
      captureKindUnsupported: 'ثبت نشد: فقط عضو عکس/ویدیوی آلبوم جمع‌آوری می‌شود.',
      captureAlbumFull: 'ثبت نشد: آلبوم پر است (۱۰ عضو سقف تلگرام است).',
      captureDuplicate: 'ثبت نشد: این مرجع فایل دقیقاً همین حالا در جلسه موجود است.',
      captureCaptionStored: 'کپشن ذخیره شد (اولین کپشن ملاک است).',
      finishTooFew:
        'پایان رد شد: آلبوم به حداقل ۲ عضو نیاز دارد. به ارسال اعضا ادامه دهید یا لغو کنید.',
      finishDone:
        'جمع‌آوری تمام شد: اعضا به‌عنوان مدرک پایا با حق ناشناس ذخیره شدند. تولید پیش‌نویس آلبوم روی مدل مدرک حق (OD-010) متوقف می‌ماند — ماشین هیچ مجوزی نمی‌سازد، چیزی ارسال نمی‌شود.',
      finishUnavailable: 'پایان در دسترس نیست: نوشتن پایا شکست خورد — دوباره تلاش کنید.',
      finishCancelled: 'جمع‌آوری آلبوم لغو شد. چیزی ذخیره نشد.',
      notFound: 'داستانی با این شناسه یافت نشد.',
    },
  };
