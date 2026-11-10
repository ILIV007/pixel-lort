/**
 * Renderer label tables for the read-only draft review surface (R1.18 —
 * ADR-0046), one per AdminUiLanguage.
 *
 * ONLY the ADMIN-SURFACE labels localize. Stored editorial content (Persian
 * headline/summary/excerpts, claim texts, source excerpts) is NEVER
 * translated or rewritten; stored technical codes (statuses, pair states,
 * verdicts) are displayed verbatim as untrusted escaped text — a code is a
 * code, never silently reworded into a stronger claim.
 */
import type { AdminUiLanguage } from '../../admin/ui-language';

export interface ReviewRenderLabels {
  readonly listTitle: string;
  readonly listEmpty: string;
  readonly listMore: string;
  readonly listHint: string;
  readonly detailTitle: string;
  readonly readyNotice: string;
  readonly labelDraft: string;
  readonly labelVersion: string;
  readonly labelStatus: string;
  readonly labelStory: string;
  readonly labelHeadline: string;
  readonly labelSummary: string;
  readonly labelSource: string;
  readonly labelExcerpt: string;
  readonly labelSourceItem: string;
  readonly labelSnapshot: string;
  readonly labelSnapshotUnavailable: string;
  readonly labelClaims: string;
  readonly labelClaimSample: string;
  readonly labelEvidenceIds: string;
  readonly claimsUnverifiedNote: string;
  readonly labelGuard: string;
  readonly guardUnassessedNote: string;
  readonly labelFactGuard: string;
  readonly factGuardRequiringReview: string;
  readonly factGuardUnwitnessed: string;
  readonly factGuardObsNote: string;
  readonly labelCandidates: string;
  readonly labelMentions: string;
  readonly candidatesNote: string;
  readonly labelRelation: string;
  readonly relationProposalNote: string;
  readonly relationTechnicalNote: string;
  readonly relationNoCandidateNote: string;
  readonly displayTruncated: string;
  readonly notFoundTitle: string;
  readonly notFoundBody: string;
  readonly documentTooLarge: string;
  readonly unsupportedVersion: string;
  readonly malformedDocument: string;
  readonly reportAbsent: string;
  readonly reportUnsupported: string;
  readonly reportMalformed: string;
  readonly valueUnavailable: string;
  readonly excerptStoredTruncated: string;
  readonly readBudgetNote: string;
}

export const REVIEW_RENDER_LABELS: Readonly<Record<AdminUiLanguage, ReviewRenderLabels>> = {
  en: {
    listTitle: 'Ready drafts (read-only, first page)',
    listEmpty:
      'The ready page is empty right now. This shows only the current ready page — it is NOT a statement that the system has finished processing everything.',
    listMore: 'More ready drafts may exist beyond this bounded first page.',
    listHint: 'Send /drafts <draftId> for the read-only detail view.',
    detailTitle: 'Stored draft (read-only view)',
    readyNotice: 'ready = stored draft only — NOT approved, NOT published.',
    labelDraft: 'Draft',
    labelVersion: 'version',
    labelStatus: 'status',
    labelStory: 'Story',
    labelHeadline: 'Headline (fa)',
    labelSummary: 'Summary (fa)',
    labelSource: 'Source',
    labelExcerpt: 'Stored source excerpt (immutable)',
    labelSourceItem: 'Source item',
    labelSnapshot: 'Snapshot identity',
    labelSnapshotUnavailable: 'unavailable in this stored document',
    labelClaims: 'Model claims — UNVERIFIED samples',
    labelClaimSample: 'Claim',
    labelEvidenceIds: 'evidence',
    claimsUnverifiedNote:
      'Model claims are unverified model output — presence in text is not truth.',
    labelGuard: 'Evidence guard (v1 summary)',
    guardUnassessedNote: 'Headline and summary are explicitly UNASSESSED.',
    labelFactGuard: 'Fact guard (v1 lexical observations)',
    factGuardRequiringReview: 'requiring review',
    factGuardUnwitnessed: 'unwitnessed',
    factGuardObsNote:
      'Lexical observations only — never truth verdicts; headline and summary are explicitly UNASSESSED.',
    labelCandidates: 'Candidates (discovery/assessment — historical observations)',
    labelMentions: 'Entity mentions (historical observation)',
    candidatesNote:
      'Candidates are observations only — never same-event proof, source independence, or confidence upgrades.',
    labelRelation: 'Event relation (≤2 pairs, proposals)',
    relationProposalNote: '*_proposed = model proposal only — never an approved merge or truth.',
    relationTechnicalNote: 'Technical states are technical — never semantic verdicts.',
    relationNoCandidateNote: 'Missing candidate / non-match is NOT "unrelated".',
    displayTruncated: '… display truncated (bounded view)',
    notFoundTitle: 'Draft not found',
    notFoundBody: 'No stored draft has this exact ID.',
    documentTooLarge:
      'The stored document exceeds the read budget — metadata shown, content not transferred.',
    unsupportedVersion:
      'This stored document uses a version this view does not read — safe metadata only.',
    malformedDocument:
      'The stored document is malformed for this view — safe metadata only, no content shown.',
    reportAbsent: 'not present in this stored document (older/legacy draft)',
    reportUnsupported: 'stored report has a version this view does not read',
    reportMalformed: 'stored report is malformed — shown as unavailable, never guessed',
    valueUnavailable: '(unavailable)',
    excerptStoredTruncated: 'stored excerpt was truncated at capture time',
    readBudgetNote: 'Read budget:',
  },
  fa: {
    listTitle: 'پیش‌نویس‌های آماده (فقط خواندنی، صفحهٔ اول)',
    listEmpty:
      'صفحهٔ آماده در حال حاضر خالی است. این فقط صفحهٔ آمادهٔ فعلی است — نه بیان این‌که سیستم پردازش همه‌چیز را به پایان رسانده است.',
    listMore: 'ممکن است پیش‌نویس‌های آمادهٔ بیشتری فراتر از این صفحهٔ محدود وجود داشته باشد.',
    listHint: 'برای نمای جزئیات فقط‌خواندنی، /drafts <draftId> را بفرستید.',
    detailTitle: 'پیش‌نویس ذخیره‌شده (نمای فقط‌خواندنی)',
    readyNotice: 'ready یعنی پیش‌نویس ذخیره‌شده — تأیید یا انتشار نشده است.',
    labelDraft: 'پیش‌نویس',
    labelVersion: 'نسخه',
    labelStatus: 'وضعیت',
    labelStory: 'روایت',
    labelHeadline: 'تیتر (فارسی)',
    labelSummary: 'خلاصه (فارسی)',
    labelSource: 'منبع',
    labelExcerpt: 'گزارهٔ ذخیره‌شدهٔ منبع (غیرقابل تغییر)',
    labelSourceItem: 'قلم منبع',
    labelSnapshot: 'شناسهٔ اسنپ‌شات',
    labelSnapshotUnavailable: 'در این سند ذخیره‌شده موجود نیست',
    labelClaims: 'ادعاهای مدل — نمونه‌های تأییدنشده',
    labelClaimSample: 'ادعا',
    labelEvidenceIds: 'شواهد',
    claimsUnverifiedNote:
      'ادعاهای مدل خروجی تأییدنشدهٔ مدل هستند — حضور در متن به معنای حقیقت نیست.',
    labelGuard: 'نگهبان شواهد (خلاصهٔ نسخهٔ ۱)',
    guardUnassessedNote: 'تیتر و خلاصه صراحتاً ارزیابی نشده‌اند.',
    labelFactGuard: 'نگهبان واقعیت (مشاهدات واژگانی نسخهٔ ۱)',
    factGuardRequiringReview: 'نیازمند بازبینی',
    factGuardUnwitnessed: 'بدون شاهد',
    factGuardObsNote:
      'فقط مشاهدات واژگانی — هرگز حکم حقیقت نیستند؛ تیتر و خلاصه صراحتاً ارزیابی نشده‌اند.',
    labelCandidates: 'کاندیدها (کشف/ارزیابی — مشاهدات تاریخی)',
    labelMentions: 'اشاره‌های موجودیت (مشاهدهٔ تاریخی)',
    candidatesNote:
      'کاندیدها فقط مشاهدات‌اند — هرگز اثبات رویداد یکسان، استقلال منبع یا ارتقای اطمینان نیستند.',
    labelRelation: 'ارتباط رویداد (حداکثر ۲ جفت، پیشنهادها)',
    relationProposalNote: '*_proposed فقط پیشنهاد مدل است — هرگز ادغام تأییدشده یا حقیقت نیست.',
    relationTechnicalNote: 'وضعیت‌های فنی، فنی‌اند — هرگز حکم معنایی نیستند.',
    relationNoCandidateNote: 'نبود کاندید / عدم تطابق به معنای «بی‌ربط» نیست.',
    displayTruncated: '… نمایش محدود شد (نمای bounded)',
    notFoundTitle: 'پیش‌نویس یافت نشد',
    notFoundBody: 'هیچ پیش‌نویس ذخیره‌شده‌ای با این شناسهٔ دقیق وجود ندارد.',
    documentTooLarge:
      'سند ذخیره‌شده از بودجهٔ خواندن بزرگ‌تر است — فراداده نمایش داده می‌شود و محتوا منتقل نمی‌شود.',
    unsupportedVersion: 'این سند ذخیره‌شده نسخه‌ای دارد که این نما نمی‌خواند — فقط فرادادهٔ امن.',
    malformedDocument:
      'سند ذخیره‌شده برای این نما ناقص/نامعتبر است — فقط فرادادهٔ امن، بدون نمایش محتوا.',
    reportAbsent: 'در این سند ذخیره‌شده موجود نیست (پیش‌نویس قدیمی‌تر)',
    reportUnsupported: 'نسخهٔ گزارش ذخیره‌شده را این نما نمی‌خواند',
    reportMalformed:
      'گزارش ذخیره‌شده ناقص است — به‌عنوان موجود‌نهاین نمایش داده می‌شود، هرگز حدس زده نمی‌شود',
    valueUnavailable: '(موجود نیست)',
    excerptStoredTruncated: 'گزارهٔ ذخیره‌شده در زمان ثبت کوتاه شده بود',
    readBudgetNote: 'بودجهٔ خواندن:',
  },
};
