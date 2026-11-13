import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedAdmin,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';

/**
 * R1.18 language tests: the persisted per-admin UI language via the REAL
 * ingress (/language fa), English default, Persian draft content NEVER
 * translated — and no unauthorized/no-permission actor gains a content
 * preview through language or help.
 */

const CHIEF_FA_ID = 2000000100;
const SOURCE_MANAGER_ID = 2000000101;

const HEADLINE = 'تیتر فارسی برای آزمون زبان';

async function seedOneReadyDraft(): Promise<void> {
  await seedStory('story-lang', 'داستان زبان');
  await seedDraft({
    id: 'draft-lang-1',
    storyId: 'story-lang',
    title: HEADLINE,
    documentJson: JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: HEADLINE,
      summaryFa: 'خلاصهٔ فارسی آزمون',
      sourceReport: {
        sourceItemId: 'item-lang',
        sourceName: 'منبع فارسی',
        stance: 'mentions',
        excerptText: 'گزارهٔ فارسی',
        truncated: false,
      },
      modelClaims: [],
    }),
  });
}

beforeEach(async () => {
  await freshDb();
  await seedAdmin(CHIEF_FA_ID, 'chief_editor');
  await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');
  await seedOneReadyDraft();
});

describe('per-admin UI language on the review surface', () => {
  it('English default: /drafts replies with English labels and the Persian draft content', async () => {
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7700, OWNER_ID, '/drafts'));
    expect(harness.sends).toHaveLength(1);
    const text = harness.sends[0]!.text;
    expect(text).toContain('Ready drafts (read-only, first page)');
    // The list row shows the stored TITLE (Persian content unchanged).
    expect(text).toContain(HEADLINE);
    // The detail view adds the stored Persian source identity.
    await harness.ingress.processUpdate(privateMessage(7710, OWNER_ID, '/drafts draft-lang-1'));
    expect(harness.sends[1]!.text).toContain('منبع فارسی');
  });

  it('persisted fa preference via the REAL /language flow: labels localize, content stays Persian', async () => {
    const harness = buildReviewHarness();
    const changed = await harness.ingress.processUpdate(
      privateMessage(7701, CHIEF_FA_ID, '/language fa'),
    );
    expect(changed).toBe('processed');
    expect(harness.sends[0]!.text).toContain('زبان رابط مدیریت به فارسی تغییر کرد');
    await harness.ingress.processUpdate(privateMessage(7702, CHIEF_FA_ID, '/drafts'));
    expect(harness.sends).toHaveLength(2);
    const listText = harness.sends[1]!.text;
    expect(listText).toContain('پیش‌نویس‌های آماده (فقط خواندنی، صفحهٔ اول)');
    expect(listText).toContain(HEADLINE);
    await harness.ingress.processUpdate(privateMessage(7703, CHIEF_FA_ID, '/drafts draft-lang-1'));
    const detailText = harness.sends[2]!.text;
    expect(detailText).toContain('پیش‌نویس ذخیره‌شده (نمای فقط‌خواندنی)');
    expect(detailText).toContain(HEADLINE);
    expect(detailText).toContain('گزارهٔ فارسی');
  });

  it('fa help for source_manager never advertises drafts and never shows content', async () => {
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7704, SOURCE_MANAGER_ID, '/language fa'));
    await harness.ingress.processUpdate(privateMessage(7705, SOURCE_MANAGER_ID, '/help'));
    expect(harness.sends).toHaveLength(2);
    expect(harness.sends[1]!.text).not.toContain('/drafts');
    await harness.ingress.processUpdate(privateMessage(7706, SOURCE_MANAGER_ID, '/drafts'));
    expect(harness.sends[2]!.text).toContain('دسترسی رد شد');
    expect(harness.sends[2]!.text).not.toContain(HEADLINE);
  });

  it('unauthorized actor never gains a preview via language/help', async () => {
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7707, 9990000001, '/language fa'));
    await harness.ingress.processUpdate(privateMessage(7708, 9990000001, '/help'));
    await harness.ingress.processUpdate(privateMessage(7709, 9990000001, '/drafts'));
    expect(harness.sends).toHaveLength(3);
    expect(harness.sends[2]!.text).toBe('Access denied.');
    expect(harness.executor.stats().draftsSql).toBe(0);
  });
});
