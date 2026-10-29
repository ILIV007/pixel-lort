import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createLogger } from '../../src/observability/logger';
import { createJobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import type {
  DlqProducerPort,
  JobsQueueProducerPort,
} from '../../src/adapters/queue/jobs-producer';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';
import { enqueueEditorialPrepareDraft } from '../../src/application/editorial/enqueue-prepare-draft';
import { createEditorialPrepareDraftHandler } from '../../src/application/editorial/prepare-draft-handler';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import { readCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { readCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';
import { readEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import {
  FINGERPRINT_LOOKUP_ROW_LIMIT,
  STORY_CANDIDATES_MAX,
} from '../../src/domain/editorial/story-fingerprints';

/**
 * R1.13+R1.14 (Phase 5C-1/5C-2) OFFLINE demo runner: SEVEN artificial news
 * items from seven different sources — THREE related pairs plus one
 * unrelated item — through the SAME real editorial path (real engine, real
 * budget authority, real fenced commit; artificial provider port, zero
 * network, zero live AI):
 *
 * - one pair with IDENTICAL content (title+body; different ids/sources/URLs)
 *   → the content_hash composite digest AND the weak title signal are
 *   observed → `full_content_equality_observed` (all reasons kept) — a
 *   text observation, NOT truth confirmation, NOT source independence;
 * - one pair sharing ONLY the stored URL (different texts/titles)
 *   → `shared_url_observed`;
 * - one pair sharing ONLY the normalized title (different bodies/URLs)
 *   → the WEAK `shared_title_observed` signal;
 * - one fully unrelated item → zero candidates, and the assessment's
 *   `unrelatednessConcluded` stays FALSE — never "definitely unrelated".
 *
 * It prints the SAFE summary: storyIds, per-draft candidate observation,
 * matchedSignals, the R1.14 assessment verdicts + observed reasons + the
 * preserved discovery limits, candidate counts, the honest scope caps, and
 * the proof that NOTHING merged (7 independent stories, confidence 0
 * everywhere) — plus the LOCAL D1 cost table (statements / execution-API
 * calls / rows returned), with the R1.13 fingerprint delta (≤3 pre-provider
 * lookups + ≤3 in-batch inserts per item) called out and the R1.14 delta
 * explicitly ZERO (the assessment rides inside the existing document_json).
 * These are LOCAL PROXY metrics (ADR-0042 §8) — NOT Cloudflare billing
 * counters, and this demo does NOT resolve the NOT_READY status of Free
 * ingestion/full-poll.
 *
 * Run standalone with: `npm run demo:story-candidates`.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-demo-alpha';
const SOURCE_B = 'src-demo-beta';
const SOURCE_C = 'src-demo-gamma';
const SOURCE_D = 'src-demo-delta';
const SOURCE_E = 'src-demo-epsilon';
const SOURCE_F = 'src-demo-zeta';
const SOURCE_G = 'src-demo-eta';
const SHARED_URL = 'https://example.com/demo/shared-event';
const IDENTICAL_TITLE = 'دمو: تیتر محتوای کاملاً یکسان';
const IDENTICAL_BODY =
  'بدنهٔ کاملاً یکسان دمو برای بررسی برابری کامل محتوا بین دو منبع مستقل مصنوعی.';
const SHARED_TITLE_ONLY = 'دمو: تیتر مشترک فقط در عنوان';

/** Counting executor: the local D1 proxy metric, WITH rows returned. */
function createCountingExecutor(inner: DbExecutor): DbExecutor & {
  readonly stats: () => {
    statements: number;
    apiCalls: number;
    rowsReturned: number;
    fingerprintLookups: number;
    fingerprintInserts: number;
  };
} {
  let statements = 0;
  let apiCalls = 0;
  let rowsReturned = 0;
  let fingerprintLookups = 0;
  let fingerprintInserts = 0;
  return {
    query: async <T>(statement: Parameters<DbExecutor['query']>[0]) => {
      statements += 1;
      apiCalls += 1;
      if (statement.sql.includes('FROM story_fingerprints')) {
        fingerprintLookups += 1;
      }
      const result = await inner.query<T>(statement);
      rowsReturned += result.rows.length;
      return result;
    },
    first: async (statement) => {
      statements += 1;
      apiCalls += 1;
      return inner.first(statement);
    },
    run: async (statement) => {
      statements += 1;
      apiCalls += 1;
      return inner.run(statement);
    },
    batch: async (input) => {
      statements += input.length;
      apiCalls += 1;
      fingerprintInserts += input.filter((statement) =>
        statement.sql.includes('INSERT INTO story_fingerprints'),
      ).length;
      return inner.batch(input);
    },
    stats: () => ({ statements, apiCalls, rowsReturned, fingerprintLookups, fingerprintInserts }),
  };
}

describe('story candidates demo — offline three-source runner', () => {
  it('runs the related pair + the unrelated item and prints the safe summary with SQL cost', async () => {
    await applyMigrations(env.DB);
    const clock = fixedClock(NOW);
    const rawExecutor = createDbExecutor(env.DB, { clock });
    const executor = createCountingExecutor(rawExecutor);
    const logger = createLogger({ level: 'error', clock });

    for (const [id, name] of [
      [SOURCE_A, 'دموی منبع آلفا'],
      [SOURCE_B, 'دموی منبع بتا'],
      [SOURCE_C, 'دموی منبع گاما'],
      [SOURCE_D, 'دموی منبع دلتا'],
      [SOURCE_E, 'دموی منبع اپسیلون'],
      [SOURCE_F, 'دموی منبع زتا'],
      [SOURCE_G, 'دموی منبع اتا'],
    ] as const) {
      await rawExecutor.run({
        sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
                priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
              VALUES (?, ?, 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
        params: [id, name, NOW, NOW],
      });
    }
    const items = [
      {
        id: 'demo-cand-a1',
        sourceId: SOURCE_A,
        title: 'دمو: رویداد مشترک خبری آلفا',
        body: 'بدنهٔ دموی رویداد مشترک از منبع آلفا با جزئیات ویژهٔ آلفا.',
        url: SHARED_URL,
      },
      {
        id: 'demo-cand-a2',
        sourceId: SOURCE_B,
        title: 'دمو: گزارش متفاوت بتا از همان رویداد',
        body: 'بدنهٔ دموی کاملاً متفاوت از منبع بتا؛ تنها URL ذخیره‌شده مشترک است.',
        url: SHARED_URL,
      },
      {
        id: 'demo-cand-p1',
        sourceId: SOURCE_C,
        title: IDENTICAL_TITLE,
        body: IDENTICAL_BODY,
        url: 'https://example.com/demo/identical-c',
      },
      {
        id: 'demo-cand-p2',
        sourceId: SOURCE_D,
        title: IDENTICAL_TITLE,
        body: IDENTICAL_BODY,
        url: 'https://example.com/demo/identical-d',
      },
      {
        id: 'demo-cand-t1',
        sourceId: SOURCE_E,
        title: SHARED_TITLE_ONLY,
        body: 'بدنهٔ نخست زوج عنوانی با محتوای ویژهٔ منبع اپسیلون.',
        url: 'https://example.com/demo/title-e',
      },
      {
        id: 'demo-cand-t2',
        sourceId: SOURCE_F,
        title: SHARED_TITLE_ONLY,
        body: 'بدنهٔ دوم زوج عنوانی با محتوای کاملاً متفاوت منبع زتا.',
        url: 'https://example.com/demo/title-f',
      },
      {
        id: 'demo-cand-solo',
        sourceId: SOURCE_G,
        title: 'دمو: خبر کاملاً مستقل اتا',
        body: 'بدنهٔ دموی خبر مستقل؛ هیچ سیگنال مشترکی با بقیهٔ خبرها ندارد.',
        url: 'https://example.com/demo/solo',
      },
    ];
    for (const item of items) {
      const contentHash = await sha256Hex(`${item.id}\u001f${item.title}\u001f${item.body}`);
      await rawExecutor.run({
        sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
                author, published_at, fetched_at, content_hash, raw_json, processing_status)
              VALUES (?, ?, ?, ?, ?, ?, 'نویسندهٔ دمو', ?, ?, ?, '{}', 'new')`,
        params: [
          item.id,
          item.sourceId,
          `ext-${item.id}`,
          item.url,
          item.title,
          item.body,
          NOW,
          NOW,
          contentHash,
        ],
      });
    }

    const port: AiProviderPort = {
      provider: 'workers-ai',
      complete: async (input) => {
        const userContent = input.messages.find((message) => message.role === 'user')?.content;
        const evidenceId =
          /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>/.exec(userContent ?? '')?.[1] ?? 'missing-id';
        const outcome: AiCallOutcome = {
          kind: 'ok',
          rawText: JSON.stringify({
            headlineFa: 'تیتر دموی مصنوعی',
            summaryFa: 'خلاصهٔ دموی مصنوعی؛ خروجی مدل یک فیکسچر آفلاین است.',
            claims: [
              { text: 'استودیوی آزمایشی از عرضهٔ نسخهٔ جدید خبر داد.', evidenceIds: [evidenceId] },
            ],
          }),
          usage: { inputTokens: 42, outputTokens: 17 },
        };
        return outcome;
      },
    };
    const aiService = createAiDraftService({
      executor,
      ports: { 'workers-ai': port },
      clock,
      logger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
    const envelopes: unknown[] = [];
    let demoIdCounter = 0;
    const engine = createJobsEngine(
      {
        executor,
        handlers: createJobHandlerRegistry([
          createEditorialPrepareDraftHandler({
            executor,
            aiService,
            nowMs: () => clock.now(),
            logger,
          }),
        ] as never),
        idGenerator: { newId: () => `demo-cand-${(demoIdCounter += 1)}` },
        clock,
        random: () => 1,
        logger,
        jobsProducer: {
          send: async (envelope) => {
            envelopes.push(envelope);
          },
        } as JobsQueueProducerPort,
        dlqProducer: { send: async () => undefined } as DlqProducerPort,
        policyGates: { ingestionGateOn: true, editorialGateOn: true },
      },
      {
        leaseMs: 2 * 60 * 1000,
        dispatchBatch: 25,
        dlqReconcileBatch: 25,
        reclaimBatch: 25,
        dispatchGraceMs: 60_000,
        backoff: { baseMs: 2_000, capMs: 3_600_000 },
        retryHintMaxSeconds: 3_600,
      },
    );

    const summaryItems: Record<string, unknown>[] = [];
    for (const item of items) {
      const before = executor.stats();
      expect(
        await enqueueEditorialPrepareDraft({
          engine,
          executor,
          sourceItemId: item.id,
        }),
      ).toMatchObject({ kind: 'created' });
      await engine.dispatchDueJobs();
      const action = await engine.consumeMessage(`demo-msg-${item.id}`, envelopes.shift());
      expect(action).toMatchObject({ action: 'ack' });
      const after = executor.stats();

      const latest = await rawExecutor.first<{
        id: string;
        story_id: string;
        status: string;
        document_json: string;
      }>({
        sql: 'SELECT id, story_id, status, document_json FROM drafts ORDER BY rowid DESC LIMIT 1',
      });
      expect(latest).not.toBeNull();
      const document = JSON.parse(latest!.document_json) as Record<string, unknown>;
      const guardRead = readEvidenceGuardReport(document);
      const discoveryRead = readCandidateDiscoveryReport(document);
      const assessmentRead = readCandidateAssessmentReport(document);
      expect(discoveryRead.kind).toBe('candidate_discovery_v1');
      expect(assessmentRead.kind).toBe('candidate_assessment_v1');
      if (discoveryRead.kind !== 'candidate_discovery_v1') return;

      summaryItems.push({
        sourceItemId: item.id,
        storyId: latest!.story_id,
        draftId: latest!.id,
        draftStatus: latest!.status,
        guardKind: guardRead.kind,
        observation: discoveryRead.report.observation,
        candidates: discoveryRead.report.candidates.map((candidate) => ({
          storyId: candidate.storyId,
          matchedSignals: candidate.matchedSignals.map((signal) => signal.kind),
        })),
        counts: discoveryRead.report.counts,
        candidatesTruncated: discoveryRead.report.candidatesTruncated,
        assessment:
          assessmentRead.kind === 'candidate_assessment_v1'
            ? {
                observation: assessmentRead.report.observation,
                entries: assessmentRead.report.entries.map((entry) => ({
                  storyId: entry.storyId,
                  verdict: entry.verdict,
                  verdictReasons: entry.verdictReasons,
                })),
                unrelatednessConcluded: assessmentRead.report.unrelatednessConcluded,
                unassessed: assessmentRead.report.unassessed,
                discoveryLimits: {
                  candidatesTruncated: assessmentRead.report.discoveryLimits.candidatesTruncated,
                  overflowObserved: assessmentRead.report.discoveryLimits.overflowObserved,
                },
              }
            : { kind: assessmentRead.kind },
        sqlDelta: {
          statements: after.statements - before.statements,
          apiCalls: after.apiCalls - before.apiCalls,
          fingerprintLookups: after.fingerprintLookups - before.fingerprintLookups,
          fingerprintInserts: after.fingerprintInserts - before.fingerprintInserts,
        },
      });
    }

    const stats = executor.stats();
    const storyRows = await rawExecutor.query<{ id: string; status: string }>({
      sql: 'SELECT id, status FROM stories',
    });
    const claimRows = await rawExecutor.query<{ confidence: number }>({
      sql: 'SELECT confidence FROM claims',
    });

    const summary = {
      demo: 'R1.14 story candidates + conservative assessment — seven artificial sources, ZERO network/AI',
      scopeCaps: {
        probeRowsPerLookup: FINGERPRINT_LOOKUP_ROW_LIMIT,
        maxCandidates: STORY_CANDIDATES_MAX,
        indexNamespace: 'sc1',
        assessmentNote:
          'R1.14 adds ZERO statements: the assessment rides inside the existing document_json',
      },
      items: summaryItems,
      totals: {
        statements: stats.statements,
        apiCalls: stats.apiCalls,
        rowsReturned: stats.rowsReturned,
        fingerprintLookups: stats.fingerprintLookups,
        fingerprintInserts: stats.fingerprintInserts,
      },
      noMergeProof: {
        stories: storyRows.rows.length,
        storyStatuses: storyRows.rows.map((row) => row.status),
        claimCount: claimRows.rows.length,
        allClaimConfidencesZero: claimRows.rows.every((row) => row.confidence === 0),
      },
      note:
        'Local D1 proxy metrics only — NOT Cloudflare billing counters. ' +
        'Free ingestion/full-poll remain NOT_READY.',
    };
    // eslint-disable-next-line no-console
    console.log('\n=== R1.14 STORY-CANDIDATES + ASSESSMENT DEMO (safe summary) ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    // The demo's OWN assertions: each pair observed EXACTLY the signals it
    // shares, the solo items honestly empty, and NOTHING merged anywhere.
    const a1 = summaryItems[0]!;
    const a2 = summaryItems[1]!;
    const p1 = summaryItems[2]!;
    const p2 = summaryItems[3]!;
    const t1 = summaryItems[4]!;
    const t2 = summaryItems[5]!;
    const solo = summaryItems[6]!;
    expect(a1['observation']).toBe('no_candidates_observed');
    expect(a2['observation']).toBe('candidates_observed');
    expect(a2['candidates']).toEqual([{ storyId: a1['storyId'], matchedSignals: ['url'] }]);
    expect(a2['assessment']).toMatchObject({
      entries: [
        {
          storyId: a1['storyId'],
          verdict: 'shared_url_observed',
          verdictReasons: ['url_fingerprint_match'],
        },
      ],
      unrelatednessConcluded: false,
    });
    expect(p1['observation']).toBe('no_candidates_observed');
    expect(p2['observation']).toBe('candidates_observed');
    expect(p2['candidates']).toEqual([
      { storyId: p1['storyId'], matchedSignals: ['content_hash', 'title_key'] },
    ]);
    expect(p2['assessment']).toMatchObject({
      entries: [
        {
          storyId: p1['storyId'],
          verdict: 'full_content_equality_observed',
          verdictReasons: ['content_hash_fingerprint_match', 'title_key_fingerprint_match'],
        },
      ],
      unrelatednessConcluded: false,
      unassessed: ['same_event', 'truth', 'source_independence'],
    });
    expect(t1['observation']).toBe('no_candidates_observed');
    expect(t2['observation']).toBe('candidates_observed');
    expect(t2['candidates']).toEqual([{ storyId: t1['storyId'], matchedSignals: ['title_key'] }]);
    expect(t2['assessment']).toMatchObject({
      entries: [
        {
          storyId: t1['storyId'],
          verdict: 'shared_title_observed',
          verdictReasons: ['title_key_fingerprint_match'],
        },
      ],
      unrelatednessConcluded: false,
    });
    expect(solo['observation']).toBe('no_candidates_observed');
    expect(solo['assessment']).toMatchObject({
      observation: 'no_candidates_observed',
      entries: [],
      unrelatednessConcluded: false,
    });
    expect(summary.noMergeProof.stories).toBe(7);
    expect(summary.noMergeProof.allClaimConfidencesZero).toBe(true);
  });
});
