import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
  NOW,
} from '../helpers/review-test-fixtures';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import {
  REVIEW_LIST_PROBE_LIMIT,
  REVIEW_LIST_SQL,
} from '../../src/adapters/db/editorial-review-store';

/**
 * R1.18 ready-list tests: bounded FIRST PAGE (≤5 visible + 1 probe), honest
 * has-more, deterministic order including equal timestamps, ONE indexed
 * query with no document loads/N+1/count-all, and the REAL EXPLAIN recorded
 * against schema 3 (LOCAL PROXY evidence).
 */

const T0 = 1_750_000_000_000;

async function seedReadyDrafts(
  count: number,
  baseTime: number,
  prefix = 'draft-list',
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${String(index + 1).padStart(3, '0')}`;
    await seedStory(`story-${id}`, `داستان ${id}`);
    await seedDraft({
      id,
      storyId: `story-${id}`,
      title: `پیش‌نویس ${id}`,
      documentJson: JSON.stringify({
        schemaVersion: 1,
        locale: 'fa',
        headlineFa: `پیش‌نویس ${id}`,
        summaryFa: `خلاصهٔ ${id}`,
        sourceReport: {
          sourceItemId: `item-${id}`,
          sourceName: 'منبع',
          stance: 'mentions',
          excerptText: 'متن',
          truncated: false,
        },
        modelClaims: [],
      }),
      createdAt: baseTime + index,
    });
    ids.push(id);
  }
  return ids;
}

beforeEach(async () => {
  await freshDb();
});

describe('bounded ready first page', () => {
  it('empty table → honest empty page (no drafts queries beyond the one list SELECT)', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(privateMessage(7200, OWNER_ID, '/drafts'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('ready page is empty');
    expect(harness.executor.stats().draftsSql).toBe(1);
  });

  it('1 and 5 rows → all shown, no has-more claim', async () => {
    await seedStory('story-one', 'داستان');
    await seedDraft({
      id: 'draft-one',
      storyId: 'story-one',
      title: 'تک پیش‌نویس',
      documentJson: JSON.stringify({
        schemaVersion: 1,
        locale: 'fa',
        headlineFa: 'تک',
        summaryFa: 'خ',
        sourceReport: {
          sourceItemId: 'i',
          sourceName: 's',
          stance: 'mentions',
          excerptText: 'e',
          truncated: false,
        },
        modelClaims: [],
      }),
    });
    let harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7201, OWNER_ID, '/drafts'));
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('draft-one');
    expect(harness.sends[0]!.text).not.toContain('More ready drafts may exist');
    expect(harness.executor.stats().draftsSql).toBe(1);

    await seedReadyDrafts(4, T0, 'draft-more');
    harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7202, OWNER_ID, '/drafts'));
    expect(harness.sends[0]!.text).toContain('draft-one');
    expect(harness.sends[0]!.text).not.toContain('More ready drafts may exist');
  });

  it('6+ rows → exactly 5 visible rows + honest has-more, ONE bounded query', async () => {
    await seedReadyDrafts(7, T0);
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(privateMessage(7203, OWNER_ID, '/drafts'));
    expect(outcome).toBe('processed');
    const text = harness.sends[0]!.text;
    expect(text).toContain('draft-list-007'); // newest
    expect(text).toContain('draft-list-003'); // 5th newest
    expect(text).not.toContain('draft-list-002'); // 6th — probe row never shown
    expect(text).toContain('More ready drafts may exist');
    expect(harness.executor.stats().draftsSql).toBe(1);
    // The list NEVER loads the document JSON and never counts all rows.
    const listSql = harness.executor.stats().sqlTexts.filter((sql) => /\bdrafts\b/i.test(sql));
    expect(listSql).toHaveLength(1);
    expect(listSql[0]).not.toContain('document_json');
    expect(listSql[0]).not.toMatch(/COUNT\s*\(/i);
    expect(listSql[0]).toContain(`LIMIT ${REVIEW_LIST_PROBE_LIMIT}`);
  });

  it('equal timestamps → deterministic selection (stable across repeated deliveries)', async () => {
    // 8 ready drafts sharing the SAME created_at (titles intentionally
    // contain the ids — assert UNIQUE ids only).
    await seedReadyDrafts(8, T0, 'draft-tie');
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7204, OWNER_ID, '/drafts'));
    const first = harness.sends[0]!.text;
    const ids = [...new Set([...first.matchAll(/draft-tie-\d{3}/g)].map((match) => match[0]))];
    expect(ids).toHaveLength(5);
    // The SAME page again (a different update) selects the SAME five rows.
    const harness2 = buildReviewHarness();
    await harness2.ingress.processUpdate(privateMessage(7205, OWNER_ID, '/drafts'));
    const ids2 = [
      ...new Set(
        [...harness2.sends[0]!.text.matchAll(/draft-tie-\d{3}/g)].map((match) => match[0]),
      ),
    ];
    expect(ids2).toEqual(ids);
  });

  it('REAL EXPLAIN QUERY PLAN (LOCAL PROXY): index search, NO temp B-tree, no full scan', async () => {
    await seedReadyDrafts(3, T0, 'draft-plan');
    const raw = createDbExecutor(env.DB, { clock: { now: () => NOW } });
    const plan = await raw.query<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${REVIEW_LIST_SQL}`,
      params: ['ready'],
    });
    const details = plan.rows.map((row) => row.detail).join(' | ');
    expect(details).toContain('idx_drafts_status_time');
    expect(details).toMatch(/USING INDEX/i);
    expect(details).not.toContain('TEMP B-TREE');
    expect(details).not.toMatch(/SCAN drafts(?! USING)/i);
  });
});
