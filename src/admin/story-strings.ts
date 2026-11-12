/**
 * Admin STORY UI strings (Phase 9B — the read-only `/story` surface) —
 * presentation strings for the story-identity observation screen, one table
 * per AdminUiLanguage. The SAME strict separation as `queue-strings.ts`: the
 * labels localize; the durable DATA (ids, status names, trust names, content
 * types, stable error codes) is never translated or re-cased — every stored
 * value is rendered exactly as the machine holds it.
 */
import type { AdminUiLanguage } from './ui-language';

/** The allowlisted story command word (the Phase 9B screen). */
export const STORY_COMMAND = 'story' as const;

/** Maximum UTF-8 byte length of an opaque story-id command argument. */
export const STORY_ID_MAX_BYTES = 128;

/** The fixed per-language labels of the identity section (fixed skeleton). */
export interface StoryUiLabels {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly trust: string;
  readonly type: string;
  readonly priority: string;
  readonly confidence: string;
  readonly version: string;
  readonly headline: string;
  readonly firstSeen: string;
  readonly lastEvidence: string;
  readonly lastPublished: string;
  readonly mergedInto: string;
}

export interface StoryUiStrings {
  /** /help line advertising the read-only story surface (gated). */
  readonly helpStoryLine: string;
  /** Denial text for an AUTHORIZED actor WITHOUT `story.view`. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text (authorized actors only). */
  readonly invalidUsage: string;
  readonly emptyTitle: string;
  readonly notFoundTitle: string;
  readonly notFoundBody: string;
  readonly identityTitle: string;
  readonly labels: StoryUiLabels;
  readonly noHeadline: string;
  readonly publicationsTitle: string;
  readonly emptyPublications: string;
  readonly morePublications: string;
  /** Honest observation note: the send gate state is surfaced, never hidden. */
  readonly gateOn: string;
  readonly gateOff: string;
}

export const ADMIN_STORY_STRINGS: Readonly<Record<AdminUiLanguage, StoryUiStrings>> = {
  en: {
    helpStoryLine: '/story — Story identity and publication history (read-only)',
    permissionDenied: 'Access denied: your role does not include story viewing permission.',
    invalidUsage:
      'Invalid argument. Usage: /story <storyId> — the bounded story identity and publication history view (read-only). The ID must be a single token of at most 128 bytes without spaces or control characters.',
    emptyTitle: 'Story (read-only)',
    notFoundTitle: 'No story found',
    notFoundBody: 'No story is recorded under this id.',
    identityTitle: 'Story identity:',
    labels: {
      id: 'id:',
      key: 'key:',
      status: 'status:',
      trust: 'trust:',
      type: 'type:',
      priority: 'priority:',
      confidence: 'confidence:',
      version: 'version:',
      headline: 'headline:',
      firstSeen: 'first seen:',
      lastEvidence: 'last evidence:',
      lastPublished: 'last published:',
      mergedInto: 'merged into:',
    },
    noHeadline: '—',
    publicationsTitle: 'Publications (newest first, max 8):',
    emptyPublications: 'no publications recorded for this story yet',
    morePublications: 'older publications exist (bounded view).',
    gateOn: 'Send gate: ON (the scheduler may send due publications).',
    gateOff: 'Send gate: OFF — decision-only observation, nothing sends.',
  },
  fa: {
    helpStoryLine: '/story — هویت داستان و تاریخ انتشار (فقط خواندنی)',
    permissionDenied: 'دسترسی رد شد: نقش شما شامل اجازهٔ مشاهدهٔ داستان نیست.',
    invalidUsage:
      'پارامتر نامعتبر است. کاربرد: /story <storyId> — نمای محدود هویت داستان و تاریخ انتشار آن (فقط خواندنی). شناسه باید یک توکن واحد با حداکثر ۱۲۸ بایت و بدون فاصله یا نویسهٔ کنترلی باشد.',
    emptyTitle: 'داستان (فقط خواندنی)',
    notFoundTitle: 'داستانی یافت نشد',
    notFoundBody: 'هیچ داستانی با این شناسه ثبت نشده است.',
    identityTitle: 'هویت داستان:',
    labels: {
      id: 'شناسه:',
      key: 'کلید:',
      status: 'وضعیت:',
      trust: 'اعتماد:',
      type: 'نوع:',
      priority: 'اولویت:',
      confidence: 'اطمینان:',
      version: 'نسخه:',
      headline: 'تیتر:',
      firstSeen: 'نخستین مشاهده:',
      lastEvidence: 'آخرین شواهد:',
      lastPublished: 'آخرین انتشار:',
      mergedInto: 'ادغام‌شده در:',
    },
    noHeadline: '—',
    publicationsTitle: 'انتشارات (تازه‌ترین اول، حداکثر ۸):',
    emptyPublications: 'هنوز انتشاری برای این داستان ثبت نشده است.',
    morePublications: 'انتشارات قدیمی‌تر موجود است (نمای محدود).',
    gateOn: 'گیت ارسال: روشن — زمان‌بند می‌تواند نشریات سررسید‌شده را بفرستد.',
    gateOff: 'گیت ارسال: خاموش — فقط مشاهده؛ چیزی ارسال نمی‌شود.',
  },
};
