import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  NOW,
  OWNER_ID,
  buildPipelineReadyDraft,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createEditorialReviewStore } from '../../src/adapters/db/editorial-review-store';

/**
 * R1.18 detail tests: bounded stored detail by EXACT id — the current
 * production builder document round-trips through the REAL ingress path,
 * a missing id is a typed not_found, stored text is unaffected by later
 * source mutation (no fresh-evidence claim), and an oversized foreign row
 * hits the SQL byte guard (typed too-large, content never transferred).
 */

beforeEach(async () => {
  await freshDb();
});

describe('bounded stored detail', () => {
  it('current production builder document round-trips through the REAL ingress path', async () => {
    const draftId = await buildPipelineReadyDraft();
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7300, OWNER_ID, `/drafts ${draftId}`),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    const text = harness.sends[0]!.text;
    expect(text).toContain(draftId);
    expect(text).toContain('به‌روزرسانی بزرگ بازی نمونه');
    expect(text).toContain('NOT approved');
    expect(text).toContain('UNVERIFIED');
    expect(text).toContain('direct_text_observed');
    // ONE editorial SELECT for the detail (no fan-out over other tables).
    expect(harness.executor.stats().draftsSql).toBe(1);
    // ZERO write statements touch the drafts table on the read path (the
    // only writes are the expected telegram_updates lifecycle rows).
    const draftsWrites = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bdrafts\b/i.test(sql))
      .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
    expect(draftsWrites).toHaveLength(0);
  });

  it('missing id → typed not_found', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7301, OWNER_ID, '/drafts no-such-draft-id'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Draft not found');
    expect(harness.sends[0]!.text).toContain('no-such-draft-id');
  });

  it('stored text is UNAFFECTED by later source mutation (view of the SAVED draft)', async () => {
    const draftId = await buildPipelineReadyDraft();
    // Mutate the mutable source row AFTER the draft was saved.
    const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    await raw.run({
      sql: "UPDATE source_items SET title = 'تغییر یافته پس از ذخیره', body_excerpt = 'متن جدید' WHERE external_id = 'review-demo-ext-1'",
    });
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7302, OWNER_ID, `/drafts ${draftId}`));
    const text = harness.sends[0]!.text;
    expect(text).toContain('به‌روزرسانی بزرگ بازی نمونه');
    expect(text).not.toContain('متن جدید');
  });

  it('oversized foreign document → SQL byte guard, typed too-large, content never transferred', async () => {
    await seedStory('story-big', 'داستان بزرگ');
    const oversized = JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: 'سند بزرگ',
      summaryFa: 'خلاصهٔ سند بزرگ',
      sourceReport: {
        sourceItemId: 'i-big',
        sourceName: 'منبع',
        stance: 'mentions',
        excerptText: 'x'.repeat(2000),
        truncated: false,
      },
      modelClaims: [],
      // A huge foreign payload beyond the 128 KiB read budget.
      padding: 'P'.repeat(200 * 1024),
    });
    await seedDraft({
      id: 'draft-oversized',
      storyId: 'story-big',
      title: 'سند بزرگ',
      documentJson: oversized,
    });
    // The store itself reports the typed boundary WITHOUT the content.
    const store = createEditorialReviewStore(createDbExecutor(env.DB, { clock: fixedClock(NOW) }));
    const row = await store.findDraftDetail('draft-oversized');
    expect(row).not.toBeNull();
    expect(row!.documentJson).toBeNull();
    expect(row!.documentBytes).toBeGreaterThan(128 * 1024);

    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7303, OWNER_ID, '/drafts draft-oversized'),
    );
    expect(outcome).toBe('processed');
    const text = harness.sends[0]!.text;
    expect(text).toContain('exceeds the read budget');
    expect(text).toContain('draft-oversized');
    expect(text).not.toContain('خلاصهٔ سند بزرگ');
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(NOW).toBeGreaterThan(0);
  });
});
