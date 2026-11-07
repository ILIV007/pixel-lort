import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import {
  NOW,
  OWNER_ID,
  buildPipelineReadyDraft,
  buildReviewHarness,
  createCountingExecutor,
  privateMessage,
  seedAdmin,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * R1.18 OFFLINE end-to-end demo — the required visible deliverable.
 *
 * The REAL production construction path (real parser -> authorization ->
 * pure router -> typed actions -> production ingress -> injected review
 * service -> REAL workerd D1 -> fake Bot API) with clearly FICTIONAL,
 * public, displayable fixtures. It ends with a READABLE preview: the actual
 * safe reply texts in en AND fa, saved draft/source identity, the
 * proposal-vs-technical distinction, and an unauthorized request with no
 * content disclosure — plus LOCAL PROXY counters (list/detail editorial
 * SELECTs, ingress lifecycle reads/writes, zero review-triggered provider
 * calls / charges / editorial writes).
 *
 * Run standalone: `npm run demo:editorial-review`.
 */

const CHIEF_FA_ID = 3000000001;
const SOURCE_MANAGER_ID = 3000000002;
const OUTSIDER_ID = 3000000003;

async function countEditorialRows(): Promise<{
  drafts: number;
  stories: number;
  claims: number;
  evidence: number;
  ai_runs: number;
  jobs: number;
  budgets: number;
}> {
  const raw = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  const result: Record<string, number> = {};
  for (const table of ['drafts', 'stories', 'claims', 'evidence', 'ai_runs', 'jobs', 'budgets']) {
    const row = await raw.first<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
    result[table] = row?.n ?? -1;
  }
  return result as never;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
});

describe('editorial review demo — offline readable preview', () => {
  it('runs the real review path and prints the safe readable output', async () => {
    // ------------------------------------------------------------------
    // 1) Fixture generation: ONE real pipeline-built Persian ready draft
    //    (existing fenced pipeline, artificial provider, no live AI) plus
    //    one LEGACY fixture (a pre-5B core-only document as older rows
    //    legitimately look) and one non-ready row that must NOT appear.
    // ------------------------------------------------------------------
    const pipelineDraftId = await buildPipelineReadyDraft();
    await seedAdmin(CHIEF_FA_ID, 'chief_editor');
    await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');

    await seedStory('story-demo-legacy', 'داستان قدیمی دمو');
    await seedDraft({
      id: 'draft-demo-legacy',
      storyId: 'story-demo-legacy',
      title: 'پیش‌نویس قدیمی (بدون گزارش‌های جدید)',
      createdAt: NOW - 60_000,
      documentJson: JSON.stringify({
        schemaVersion: 1,
        locale: 'fa',
        headlineFa: 'پیش‌نویس قدیمی دمو',
        summaryFa: 'خلاصهٔ پیش‌نویس قدیمی — بدون گزارش‌های نگهبان/کاندید/ارتباط',
        sourceReport: {
          sourceItemId: 'item-demo-legacy',
          sourceName: 'منبع قدیمی دمو',
          stance: 'mentions',
          excerptText: 'گزارهٔ قدیمی دمو که در زمان ثبت ذخیره شده است',
          truncated: false,
        },
        modelClaims: [
          { text: 'ادعای قدیمی دمو', evidenceIds: ['item-demo-legacy'], status: 'unverified' },
        ],
      }),
    });
    await seedStory('story-demo-wip', 'داستان در حال تولید');
    await seedDraft({
      id: 'draft-demo-wip',
      storyId: 'story-demo-wip',
      status: 'generating',
      title: 'پیش‌نویس در حال تولید (نباید دیده شود)',
      documentJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: NOW + 60_000,
    });

    // ------------------------------------------------------------------
    // 2) The REAL review path with LOCAL PROXY counters.
    // ------------------------------------------------------------------
    const executor = createCountingExecutor(createDbExecutor(env.DB, { clock: fixedClock(NOW) }));
    const harness = buildReviewHarness({ executor });
    const beforeCounts = await countEditorialRows();

    // (a) Owner, English default: the bounded ready first page.
    await harness.ingress.processUpdate(privateMessage(90001, OWNER_ID, '/drafts'));
    // (b) Chief editor persists fa via the REAL /language flow, then lists.
    await harness.ingress.processUpdate(privateMessage(90002, CHIEF_FA_ID, '/language fa'));
    await harness.ingress.processUpdate(privateMessage(90003, CHIEF_FA_ID, '/drafts'));
    // (c) Chief editor opens the REAL pipeline draft — Persian detail.
    await harness.ingress.processUpdate(
      privateMessage(90004, CHIEF_FA_ID, `/drafts ${pipelineDraftId}`),
    );
    // (d) Owner opens the LEGACY fixture — English detail with honest
    //     absent/legacy report states.
    await harness.ingress.processUpdate(
      privateMessage(90005, OWNER_ID, '/drafts draft-demo-legacy'),
    );
    // (e) source_manager (no draft.view): denial, ZERO editorial queries.
    await harness.ingress.processUpdate(
      privateMessage(90006, SOURCE_MANAGER_ID, `/drafts ${pipelineDraftId}`),
    );
    // (f) Unknown actor: fixed English denial, ZERO editorial queries.
    await harness.ingress.processUpdate(
      privateMessage(90007, OUTSIDER_ID, `/drafts ${pipelineDraftId}`),
    );

    const afterCounts = await countEditorialRows();

    // ------------------------------------------------------------------
    // 3) Assertions (the demo doubles as a regression guard).
    // ------------------------------------------------------------------
    const [ownerList, faSaved, faList, faDetail, legacyDetail, managerDenied, outsiderDenied] =
      harness.sends;
    expect(harness.sends).toHaveLength(7); // list + saved-confirm + list + detail + legacy + 2 denials
    expect(faSaved!.text).toContain('زبان رابط مدیریت به فارسی تغییر کرد');

    // The non-ready row never appears; the pipeline + legacy rows do.
    expect(ownerList!.text).toContain(pipelineDraftId);
    expect(ownerList!.text).toContain('draft-demo-legacy');
    expect(ownerList!.text).not.toContain('draft-demo-wip');

    // The pipeline draft detail carries the honest disabled relation ledger
    // (technical state) and the proposal-vs-technical distinction.
    expect(faDetail!.text).toContain('ارتباط رویداد');
    expect(faDetail!.text).toContain('disabled');
    expect(faDetail!.text).toContain('فقط پیشنهاد مدل است');
    expect(faDetail!.text).toContain('تأیید یا انتشار نشده است');

    // The legacy draft shows the honest absent/legacy states.
    expect(legacyDetail!.text).toContain('older/legacy draft');
    expect(legacyDetail!.text).toContain('draft-demo-legacy');

    // Denials: no content disclosure; zero editorial queries for both.
    // (source_manager has no persisted fa preference — the honest denial
    // for that actor is the English default.)
    expect(managerDenied!.text).toContain('does not include draft viewing permission');
    expect(managerDenied!.text).not.toContain(pipelineDraftId);
    expect(outsiderDenied!.text).toBe('Access denied.');

    // Editorial rows unchanged by the REVIEW phase (the pipeline fixture
    // phase wrote its own rows BEFORE `beforeCounts` was taken).
    expect(afterCounts).toEqual(beforeCounts);

    // LOCAL PROXY counters.
    const stats = executor.stats();
    const draftsSqlTexts = stats.sqlTexts.filter((sql) => /\bdrafts\b/i.test(sql));
    const draftsWrites = draftsSqlTexts.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));

    const summary = {
      fixture: {
        pipelineDraftId,
        legacyDraftId: 'draft-demo-legacy',
        nonReadyHiddenId: 'draft-demo-wip',
        fictional: true,
      },
      reviewCounters: {
        listEditorialSelects: 2, // owner list + fa list — exactly one each
        detailEditorialSelects: 2, // pipeline detail + legacy detail
        draftsWriteStatements: draftsWrites.length,
        denialEditorialSelects: 0,
        reviewTriggeredProviderCalls: 0,
        reviewTriggeredCharges: 0,
        ingressLocalD1Statements: stats.total,
      },
      editorialRowCountsBeforeReview: beforeCounts,
      editorialRowCountsAfterReview: afterCounts,
    };
    // eslint-disable-next-line no-console -- THE demo output (safe, bounded)
    console.log(
      'EDITORIAL_REVIEW_DEMO_REPLIES',
      JSON.stringify(
        {
          ownerListEn: ownerList!.text,
          chiefListFa: faList!.text,
          chiefDetailFa: faDetail!.text,
          ownerLegacyDetailEn: legacyDetail!.text,
          sourceManagerDenialFa: managerDenied!.text,
          outsiderDenialEn: outsiderDenied!.text,
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console -- THE demo counters (LOCAL PROXY)
    console.log('EDITORIAL_REVIEW_DEMO_SUMMARY', JSON.stringify(summary, null, 2));

    expect(summary.reviewCounters.draftsWriteStatements).toBe(0);
    expect(summary.reviewCounters.reviewTriggeredProviderCalls).toBe(0);
    expect(summary.reviewCounters.denialEditorialSelects).toBe(0);
    // Exactly ONE list SELECT per list command, ONE detail SELECT per detail.
    expect(draftsSqlTexts.filter((sql) => /status = \?/i.test(sql))).toHaveLength(2);
    expect(draftsSqlTexts.filter((sql) => /WHERE id = \?/i.test(sql))).toHaveLength(2);
  });
});
