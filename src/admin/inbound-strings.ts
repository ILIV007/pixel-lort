import type { AdminUiLanguage } from './ui-language';

/**
 * Slice 4 — owner-facing strings for the inbound AI-admin pipeline.
 * English-first; Persian is the owner's language. Same `Localized` shape
 * as `admin-post-strings.ts` (a plain EN/FA record; function-valued
 * entries take their arguments first and return the record). Category
 * names stay the stable English token in both languages (they are also
 * the stored category value).
 */
export type Localized = Readonly<Record<AdminUiLanguage, string>>;

export const INBOUND_STRINGS = {
  inboundPublished: (category: string): Localized => ({
    en: `Published to the channel — ${category}.`,
    fa: `در کانال منتشر شد — ${category}.`,
  }),
  inboundEdited: {
    en: 'Channel post updated in place.',
    fa: 'پست کانال در جای خود به‌روزرسانی شد.',
  } satisfies Localized,
  inboundEditFailed: {
    en: 'The channel post could not be fully updated — please check the channel.',
    fa: 'پست کانال کامل به‌روزرسانی نشد — لطفاً کانال را بررسی کنید.',
  } satisfies Localized,
  inboundApprovalPreviewHeader: (
    category: string,
    partCount: number,
    hours: number,
  ): Localized => ({
    en: `Approval preview — ${category}${partCount > 1 ? ` · ${partCount} parts` : ''}. This preview expires in ${hours} hours.`,
    fa: `پیش‌نمایش تایید — ${category}${partCount > 1 ? ` · ${partCount} بخش` : ''}. این پیش‌نمایش تا ${hours} ساعت دیگر منقضی می‌شود.`,
  }),
  inboundApproveButton: {
    en: '✅ Publish',
    fa: '✅ انتشار',
  } satisfies Localized,
  inboundRejectButton: {
    en: '❌ Reject',
    fa: '❌ رد',
  } satisfies Localized,
  inboundRejected: {
    en: 'Rejected — nothing was published.',
    fa: 'رد شد — چیزی منتشر نشد.',
  } satisfies Localized,
  inboundApprovalExpired: {
    en: 'This preview expired (24 hours). Send the post again to publish it.',
    fa: 'این پیش‌نمایش منقضی شده است (۲۴ ساعت). برای انتشار، پست را دوباره بفرستید.',
  } satisfies Localized,
  inboundUnsafeLink: {
    en: 'This post contains a link that can never be published (magnet link). Nothing was sent.',
    fa: 'این پست لینکی دارد که هرگز قابل انتشار نیست (لینک magnet). چیزی ارسال نشد.',
  } satisfies Localized,
  inboundAlreadyPending: {
    en: 'This post already has a pending approval preview.',
    fa: 'این پست از قبل یک پیش‌نمایش تایید در انتظار دارد.',
  } satisfies Localized,
} as const;

export type InboundStrings = typeof INBOUND_STRINGS;
