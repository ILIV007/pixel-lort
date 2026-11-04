/**
 * R1.20-R — admin post pipeline strings (EN + FA), following the admin UI
 * language contract (ADR-0034): presentation of the admin surface only.
 * Every string is a stable authored constant; NO user content, ids, chat
 * names, or error payloads are embedded by callers except the explicitly
 * documented numeric placeholders (version numbers) and short codes.
 */
import type { AdminUiLanguage } from './ui-language';

type Localized = Readonly<Record<AdminUiLanguage, string>>;

export const ADMIN_POST_STRINGS = {
  sessionStarted: {
    en: 'Capture session OPEN. Send the post TEXT — or a single PHOTO/VIDEO with an optional caption — every message you send becomes a new draft version until you use /post_cancel.',
    fa: 'نشست ثبت باز شد. متن پست — یا یک عکس/ویدئوی تکی با کپشن اختیاری — بفرستید؛ هر پیامی که بفرستید تا استفاده از /post_cancel به یک نسخهٔ جدید پیش‌نویس تبدیل می‌شود.',
  } satisfies Localized,
  sessionAlreadyOpen: {
    en: 'The capture session is ALREADY open — keep sending the post text, or use /post_cancel to stop capturing.',
    fa: 'نشست ثبت از قبل باز است — به ارسال متن پست ادامه دهید، یا برای توقف ثبت از /post_cancel استفاده کنید.',
  } satisfies Localized,
  capturePermissionDenied: {
    en: 'REJECTED: your role does not hold the draft creation permission. Nothing was saved.',
    fa: 'رد شد: نقش شما مجوز ایجاد پیش‌نویس ندارد. چیزی ذخیره نشد.',
  } satisfies Localized,
  previewInvalidUsage: {
    en: 'Invalid usage. Use /post_preview (your own open draft) or /post_preview <draftId>.',
    fa: 'استفادهٔ نامعتبر. از /post_preview (پیش‌نویس باز خودتان) یا /post_preview <شناسهٔ پیش‌نویس> استفاده کنید.',
  } satisfies Localized,
  previewPermissionDenied: {
    en: 'REJECTED: your role does not hold the draft view permission.',
    fa: 'رد شد: نقش شما مجوز مشاهدهٔ پیش‌نویس ندارد.',
  } satisfies Localized,
  draftNotFound: {
    en: 'REJECTED: no OPEN draft with that id exists.',
    fa: 'رد شد: پیش‌نویس بازی با آن شناسه وجود ندارد.',
  } satisfies Localized,
  captureSaved: (draftId: string, version: number): Localized => ({
    en: `Post captured as version ${version}. Draft id: ${draftId} — share this id with a reviewer for /post_preview <draftId>.`,
    fa: `پست به‌عنوان نسخهٔ ${version} ذخیره شد. شناسهٔ پیش‌نویس: ${draftId} — این شناسه را برای /post_preview <شناسه> در اختیار بررسی‌کننده بگذارید.`,
  }),
  captureUpdated: (draftId: string, version: number): Localized => ({
    en: `Draft ${draftId} updated to version ${version}. Previous approvals for older versions are now INVALID.`,
    fa: `پیش‌نویس ${draftId} به نسخهٔ ${version} به‌روزرسانی شد. تأییدهای نسخه‌های قبلی دیگر معتبر نیستند.`,
  }),
  captureAlreadyCaptured: {
    en: 'This update was already captured (duplicate delivery).',
    fa: 'این به‌روزرسانی قبلاً ثبت شده است (ارسال تکراری).',
  } satisfies Localized,
  captureMediaRejected: {
    en: 'REJECTED: this media type is not supported. Only ONE photo or ONE video (with an optional caption), or plain TEXT, is accepted — albums and every other media type are rejected; a caption alone is never a complete post.',
    fa: 'رد شد: این نوع رسانه پشتیبانی نمی‌شود. فقط یک عکس یا یک ویدئوی تکی (با کپشن اختیاری) یا متن ساده پذیرفته می‌شود — آلبوم و هر نوع رسانهٔ دیگری رد می‌شود؛ کپشن به‌تنهایی هرگز پست کامل محسوب نمی‌شود.',
  } satisfies Localized,
  captureAlbumRejected: {
    en: 'REJECTED: albums (grouped media) are not supported. Send ONE photo or ONE video as a standalone message.',
    fa: 'رد شد: آلبوم (رسانه‌های گروهی) پشتیبانی نمی‌شود. یک عکس یا یک ویدئو را به‌صورت پیام جداگانه بفرستید.',
  } satisfies Localized,
  captureMediaCaptionRejected: {
    en: 'REJECTED: the caption is beyond the 1024-character limit or its formatting metadata is malformed. Nothing was saved.',
    fa: 'رد شد: کپشن از سقف ۱۰۲۴ نویسه بیشتر است یا فرادادهٔ قالب‌بندی آن ناقص است. چیزی ذخیره نشد.',
  } satisfies Localized,
  captureMediaFileInvalid: {
    en: 'REJECTED: the media attachment has no usable file reference. Nothing was saved.',
    fa: 'رد شد: رسانهٔ پیام مرجع فایل قابل‌استفاده ندارد. چیزی ذخیره نشد.',
  } satisfies Localized,
  captureRichMalformed: {
    en: 'REJECTED: the message rich-text metadata is malformed. Content was NOT saved.',
    fa: 'رد شد: فرادادهٔ متن غنی پیام ناقص است. محتوا ذخیره نشد.',
  } satisfies Localized,
  captureInvalidContent: {
    en: 'REJECTED: the content does not satisfy the rich-text contract. Nothing was saved.',
    fa: 'رد شد: محتوا قرارداد متن غنی را برآورده نمی‌کند. چیزی ذخیره نشد.',
  } satisfies Localized,
  captureSerializedTooLarge: {
    en: 'REJECTED: the content exceeds the storage bound. Nothing was saved.',
    fa: 'رد شد: محتوا از حد مجاز ذخیره‌سازی بزرگ‌تر است. چیزی ذخیره نشد.',
  } satisfies Localized,
  captureVersionLimit: {
    en: 'REJECTED: the open draft reached its version limit. Use /post_cancel and start a new draft.',
    fa: 'رد شد: پیش‌نویس باز به سقف نسخه‌ها رسیده است. با /post_cancel آن را ببندید و پیش‌نویس جدید آغاز کنید.',
  } satisfies Localized,
  textTooLong: {
    en: 'REJECTED: message text exceeds the Telegram 4096-character limit. Nothing was saved.',
    fa: 'رد شد: متن پیام از سقف ۴۰۹۶ نویسهٔ تلگرام بیشتر است. چیزی ذخیره نشد.',
  } satisfies Localized,
  noTextContent: {
    en: 'REJECTED: the message has no postable text content. Nothing was saved.',
    fa: 'رد شد: پیام محتوای متنی قابل‌انتشار ندارد. چیزی ذخیره نشد.',
  } satisfies Localized,
  editedMessageRejected: {
    en: 'Edited messages are never captured or applied. Send a fresh message instead.',
    fa: 'پیام‌های ویرایش‌شده هرگز ثبت یا اعمال نمی‌شوند. پیام تازه بفرستید.',
  } satisfies Localized,
  noOpenDraft: {
    en: 'You have no open draft. Use /post to start a capture session, then send the post text.',
    fa: 'پیش‌نویس بازی ندارید. با /post نشست ثبت را آغاز کنید، سپس متن پست را بفرستید.',
  } satisfies Localized,
  cancelDone: {
    en: 'Open draft cancelled and the capture session CLOSED. Your next texts are ordinary messages again; use /post to start a new draft.',
    fa: 'پیش‌نویس باز لغو و نشست ثبت بسته شد. پیام‌های بعدی شما دوباره پیام عادی‌اند؛ برای پیش‌نویس جدید از /post استفاده کنید.',
  } satisfies Localized,
  cancelNone: {
    en: 'Nothing to cancel — you have no open draft (any capture session is closed too).',
    fa: 'چیزی برای لغو نیست — پیش‌نویس بازی ندارید (نشست ثبت هم بسته است).',
  } satisfies Localized,
  storedContentCorrupt: {
    en: 'The stored content failed its integrity check and was NOT used. Nothing was sent.',
    fa: 'محتوای ذخیره‌شده بررسی صحت را رد کرد و استفاده نشد. چیزی ارسال نشد.',
  } satisfies Localized,
  statusNoDraft: {
    en: 'No open draft.',
    fa: 'پیش‌نویس بازی وجود ندارد.',
  } satisfies Localized,
  statusDraftId: (draftId: string): Localized => ({
    en: `Draft id: ${draftId}`,
    fa: `شناسهٔ پیش‌نویس: ${draftId}`,
  }),
  statusDraftStatus: (status: string): Localized => ({
    en: `Draft status: ${status}`,
    fa: `وضعیت پیش‌نویس: ${status}`,
  }),
  statusInvalidUsage: {
    en: 'Invalid usage. Use /post_status (your own open draft) or /post_status <draftId>.',
    fa: 'استفادهٔ نامعتبر. از /post_status (پیش‌نویس باز خودتان) یا /post_status <شناسهٔ پیش‌نویس> استفاده کنید.',
  } satisfies Localized,
  statusPermissionDenied: {
    en: "REJECTED: your role does not hold the publication permission required to view another draft's publication state.",
    fa: 'رد شد: نقش شما مجوز انتشار لازم برای دیدن وضعیت انتشار پیش‌نویس دیگری را ندارد.',
  } satisfies Localized,
  statusVersion: (version: number): Localized => ({
    en: `Current version: ${version}`,
    fa: `نسخهٔ فعلی: ${version}`,
  }),
  statusSessionOpen: {
    en: 'Capture session: OPEN (plain texts become draft versions; /post_cancel stops it)',
    fa: 'نشست ثبت: باز (متن‌های ساده نسخهٔ پیش‌نویس می‌شوند؛ /post_cancel آن را می‌بندد)',
  } satisfies Localized,
  statusSessionClosed: {
    en: 'Capture session: closed (/post starts one)',
    fa: 'نشست ثبت: بسته (/post آن را آغاز می‌کند)',
  } satisfies Localized,
  statusApprovalActive: {
    en: 'Approval: ACTIVE',
    fa: 'تأیید: فعال',
  } satisfies Localized,
  statusApprovalNone: {
    en: 'Approval: none for the current version',
    fa: 'تأیید: برای نسخهٔ فعلی وجود ندارد',
  } satisfies Localized,
  statusPublishQueued: {
    en: 'Publication: queued',
    fa: 'انتشار: در صف',
  } satisfies Localized,
  statusPublishSent: {
    en: 'Publication: SENT to the channel',
    fa: 'انتشار: به کانال ارسال شد',
  } satisfies Localized,
  statusPublishFailed: {
    en: 'Publication: definitive failure (nothing was sent)',
    fa: 'انتشار: شکست قطعی (چیزی ارسال نشد)',
  } satisfies Localized,
  statusPublishUncertain: (stale: boolean): Localized => ({
    en: stale
      ? 'Publication: OUTCOME UNKNOWN (lease expired) — the message MAY or MAY NOT have arrived. Nothing is ever auto-resent; verify the channel manually, then use the confirm button to re-send if needed.'
      : 'Publication: OUTCOME UNKNOWN (timeout) — the message MAY or MAY NOT have arrived. Nothing is ever auto-resent; verify the channel manually, then use the confirm button to re-send if needed.',
    fa: stale
      ? 'انتشار: نتیجهٔ نامشخص (اجاره‌نامه منقضی شد) — پیام شاید رسیده باشد یا نه. هرگز خودکار ارسال مجدد نمی‌شود؛ کانال را دستی بررسی کنید و در صورت نیاز از دکمهٔ تأیید برای ارسال مجدد استفاده کنید.'
      : 'انتشار: نتیجهٔ نامشخص (تایم‌اوت) — پیام شاید رسیده باشد یا نه. هرگز خودکار ارسال مجدد نمی‌شود؛ کانال را دستی بررسی کنید و در صورت نیاز از دکمهٔ تأیید برای ارسال مجدد استفاده کنید.',
  }),
  confirmResendButton: {
    en: 'Confirm re-send (risk of duplicate)',
    fa: 'تأیید ارسال مجدد (خطر تکرار)',
  } satisfies Localized,
  approveButton: {
    en: 'Approve this version',
    fa: 'تأیید این نسخه',
  } satisfies Localized,
  publishButton: {
    en: 'Publish to channel',
    fa: 'انتشار در کانال',
  } satisfies Localized,
  previewControlHeader: (version: number): Localized => ({
    en: `Preview of version ${version} — the message above is the EXACT stored content (text/media + entities).`,
    fa: `پیش‌نمایش نسخهٔ ${version} — پیام بالا دقیقاً محتوای ذخیره‌شده است (متن/رسانه + موجودیت‌ها).`,
  }),
  approveDone: (version: number): Localized => ({
    en: `Version ${version} APPROVED (bound to the previewed content).`,
    fa: `نسخهٔ ${version} تأیید شد (متصل به محتوای پیش‌نمایش‌شده).`,
  }),
  approveAlreadyActive: {
    en: 'This version already has an active approval.',
    fa: 'این نسخه هم‌اکنون یک تأیید فعال دارد.',
  } satisfies Localized,
  staleVersion: {
    en: 'REJECTED: the draft moved to a newer version. Preview the current version again.',
    fa: 'رد شد: پیش‌نویس به نسخهٔ جدیدتری رسیده است. نسخهٔ فعلی را دوباره پیش‌نمایش بگیرید.',
  } satisfies Localized,
  fingerprintTampered: {
    en: 'REJECTED: the action does not match the previewed content (fingerprint mismatch).',
    fa: 'رد شد: این اقدام با محتوای پیش‌نمایش‌شده مطابقت ندارد (عدم تطابق اثر انگشت).',
  } satisfies Localized,
  sessionUnknownOrExpired: {
    en: 'REJECTED: this preview session is unknown or expired. Preview again.',
    fa: 'رد شد: این نشست پیش‌نمایش ناشناخته یا منقضی است. دوباره پیش‌نمایش بگیرید.',
  } satisfies Localized,
  callbackInvalidToken: {
    en: 'This action is expired, already used, or not yours.',
    fa: 'این اقدام منقضی، قبلاً استفاده‌شده یا متعلق به شما نیست.',
  } satisfies Localized,
  permissionRevoked: {
    en: 'REJECTED: your role no longer holds the required permission.',
    fa: 'رد شد: نقش شما دیگر مجوز لازم را ندارد.',
  } satisfies Localized,
  publishDisabled: {
    en: 'Publishing is DISABLED (live publish flag is off). The approval stays active; nothing was sent.',
    fa: 'انتشار غیرفعال است (پرچم انتشار زنده خاموش). تأیید فعال می‌ماند؛ چیزی ارسال نشد.',
  } satisfies Localized,
  publishNoApproval: {
    en: 'REJECTED: no ACTIVE approval for the current version. Approve first.',
    fa: 'رد شد: تأیید فعالی برای نسخهٔ فعلی وجود ندارد. ابتدا تأیید کنید.',
  } satisfies Localized,
  publishAlreadyInProgress: {
    en: 'A publication for this version is already queued or in progress.',
    fa: 'یک انتشار برای این نسخه هم‌اکنون در صف یا در جریان است.',
  } satisfies Localized,
  publishAlreadySent: {
    en: 'This version was already published.',
    fa: 'این نسخه قبلاً منتشر شده است.',
  } satisfies Localized,
  publishUseStatus: {
    en: 'A previous publication attempt exists. Use /post_status for the safe re-send path.',
    fa: 'تلاش انتشار قبلی وجود دارد. برای مسیر امن ارسال مجدد از /post_status استفاده کنید.',
  } satisfies Localized,
  publishMissingDestination: {
    en: 'Publishing failed: no destination channel is configured.',
    fa: 'انتشار ناموفق: کانال مقصد پیکربندی نشده است.',
  } satisfies Localized,
  publishDone: (version: number): Localized => ({
    en: `Version ${version} PUBLISHED to the channel.`,
    fa: `نسخهٔ ${version} در کانال منتشر شد.`,
  }),
  publishTransportUnavailable: {
    en: 'Publishing is temporarily unavailable. Nothing was sent and nothing is marked; try again shortly via /post_status.',
    fa: 'انتشار موقتاً در دسترس نیست. چیزی ارسال نشد و چیزی ثبت نشد؛ کمی بعد از طریق /post_status دوباره تلاش کنید.',
  } satisfies Localized,
  publishFailedDefinitive: {
    en: 'Publish FAILED definitively (nothing was sent). No auto-retry.',
    fa: 'انتشار به‌طور قطعی ناموفق بود (چیزی ارسال نشد). تلاش مجدد خودکار وجود ندارد.',
  } satisfies Localized,
  publishContentChanged: {
    en: 'Publish BLOCKED: the stored content no longer matches the approved content. Nothing was sent; verify the draft with a fresh preview.',
    fa: 'انتشار متوقف شد: محتوای ذخیره‌شده دیگر با محتوای تأییدشده مطابقت ندارد. چیزی ارسال نشد؛ پیش‌نویس را با یک پیش‌نمایش تازه بررسی کنید.',
  } satisfies Localized,
  publishMediaFileFailed: {
    en: 'Publish FAILED: the media file reference was rejected (invalid, expired, or unusable file). Nothing was sent.',
    fa: 'انتشار ناموفق بود: مرجع فایل رسانه رد شد (فایل نامعتبر، منقضی یا غیرقابل‌استفاده). چیزی ارسال نشد.',
  } satisfies Localized,
  publishUncertain: {
    en: 'Publish OUTCOME UNKNOWN (timeout). The message MAY have arrived. Check /post_status — nothing is auto-resent.',
    fa: 'نتیجهٔ انتشار نامشخص است (تایم‌اوت). پیام شاید رسیده باشد. /post_status را بررسی کنید — ارسال مجدد خودکار وجود ندارد.',
  } satisfies Localized,
  publishSentButStateUnknown: {
    en: 'The send may have succeeded but its confirmation could not be recorded. Check /post_status.',
    fa: 'ارسال شاید موفق بوده اما تأیید آن ثبت نشد. /post_status را بررسی کنید.',
  } satisfies Localized,
} as const;
