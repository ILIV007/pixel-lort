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
    en: 'Capture session OPEN. Send the post TEXT now — every plain text message you send becomes a new draft version until you use /post_cancel.',
    fa: 'نشست ثبت باز شد. اکنون متن پست را بفرستید — هر پیام متنی سادهٔ شما تا استفاده از /post_cancel به یک نسخهٔ جدید پیش‌نویس تبدیل می‌شود.',
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
  captureSaved: (version: number): Localized => ({
    en: `Post captured as version ${version}. Send updated text to create the next version; use /post_preview for a faithful preview.`,
    fa: `پست به‌عنوان نسخهٔ ${version} ذخیره شد. برای نسخهٔ بعدی متن جدید بفرستید؛ برای پیش‌نمایش وفادار از /post_preview استفاده کنید.`,
  }),
  captureUpdated: (version: number): Localized => ({
    en: `Draft updated to version ${version}. Previous approvals for older versions are now INVALID.`,
    fa: `پیش‌نویس به نسخهٔ ${version} به‌روزرسانی شد. تأییدهای نسخه‌های قبلی دیگر معتبر نیستند.`,
  }),
  captureAlreadyCaptured: {
    en: 'This update was already captured (duplicate delivery).',
    fa: 'این به‌روزرسانی قبلاً ثبت شده است (ارسال تکراری).',
  } satisfies Localized,
  captureMediaRejected: {
    en: 'REJECTED: media posts are not supported yet. Send TEXT only — a caption is never treated as a complete post.',
    fa: 'رد شد: پستِ رسانه‌ای هنوز پشتیبانی نمی‌شود. فقط متن بفرستید؛ کپشن به‌تنهایی هرگز پست کامل محسوب نمی‌شود.',
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
    en: `Preview of version ${version} — the message above is the EXACT stored text and entities.`,
    fa: `پیش‌نمایش نسخهٔ ${version} — پیام بالا دقیقاً متن و موجودیت‌های ذخیره‌شده است.`,
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
  publishUncertain: {
    en: 'Publish OUTCOME UNKNOWN (timeout). The message MAY have arrived. Check /post_status — nothing is auto-resent.',
    fa: 'نتیجهٔ انتشار نامشخص است (تایم‌اوت). پیام شاید رسیده باشد. /post_status را بررسی کنید — ارسال مجدد خودکار وجود ندارد.',
  } satisfies Localized,
  publishSentButStateUnknown: {
    en: 'The send may have succeeded but its confirmation could not be recorded. Check /post_status.',
    fa: 'ارسال شاید موفق بوده اما تأیید آن ثبت نشد. /post_status را بررسی کنید.',
  } satisfies Localized,
} as const;
