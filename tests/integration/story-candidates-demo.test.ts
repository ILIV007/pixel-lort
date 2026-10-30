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
 * R1.15 (Phase 5C-3) OFFLINE demo runner — exact-content draft reuse with
 * preserved provenance, over the SAME real editorial path (real engine,
 * real budget authority, real fenced commits; artificial provider port,
 * zero network, zero live AI). FIVE artificial news items from five
 * different sources demonstrate the three required paths:
 *
 * - A: the FIRST item → the normal path → one stable Persian draft;
 * - B: a DIFFERENT source with the EXACT same full title+body → VERIFIED
 *   reuse of A's result: ZERO provider calls, ZERO new charges, B's OWN
 *   provenance (source_report claim + mentions evidence) durably added
 *   under A's story, B's item processed, and A's draft/report documents
 *   byte-untouched — NOT a semantic merge, NOT truth, NOT independence;
 * - C: ONLY the shared stored URL (different texts) → independent draft;
 * - D: ONLY the shared title (different body/URL) → independent draft;
 * - E: a fully independent item → its own draft.
 *
 * It prints the SAFE summary: per-item outcome type (normal_draft /
 * exact_content_reuse), result + draft ids, preserved provenances, the
 * REAL provider-call count per path, the discovery/assessment observations
 * of every draft, the no-merge proof (4 stories for 5 items, confidence 0
 * everywhere), and the LOCAL D1 cost table (statements / execution-API
 * calls / rows returned) measured PER PATH. These are LOCAL PROXY metrics
 * (ADR-0042 §8) — NOT Cloudflare billing counters.
 *
 * Run standalone with: `npm run demo:story-candidates`.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-demo-alpha';
const SOURCE_B = 'src-demo-beta';
const SOURCE_C = 'src-demo-gamma';
const SOURCE_D = 'src-demo-delta';
const SOURCE_E = 'src-demo-epsilon';
const SHARED_URL = 'https://example.com/demo/shared-event';
const IDENTICAL_TITLE = 'دمو: تیتر محتوای کاملاً یکسان';
const IDENTICAL_BODY =
  'بدنهٔ کاملاً یکسان دمو برای بررسی برابری کامل محتوا بین دو منبع مستقل مصنوعی.';

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

describe('story candidates demo — offline runner (R1.15 exact-content reuse)', () => {
  it('runs A→draft, B→verified reuse (zero provider), C/D→independent, E→solo and prints the safe summary with per-path SQL cost', async () => {
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
        id: 'demo-reuse-a',
        sourceId: SOURCE_A,
        title: IDENTICAL_TITLE,
        body: IDENTICAL_BODY,
        url: SHARED_URL,
      },
      {
        id: 'demo-reuse-b',
        sourceId: SOURCE_B,
        title: IDENTICAL_TITLE,
        body: IDENTICAL_BODY,
        url: 'https://example.com/demo/identical-b',
      },
      {
        id: 'demo-reuse-c',
        sourceId: SOURCE_C,
        title: 'دمو: گزارش متفاوت گاما از همان رویداد',
        body: 'بدنهٔ دموی کاملاً متفاوت از منبع گاما؛ تنها URL ذخیره‌شده مشترک است.',
        url: SHARED_URL,
      },
      {
        id: 'demo-reuse-d',
        sourceId: SOURCE_D,
        title: IDENTICAL_TITLE,
        body: 'بدنهٔ دموی منبع دلتا؛ فقط عنوان با خبر آلفا مشترک است.',
        url: 'https://example.com/demo/title-d',
      },
      {
        id: 'demo-reuse-e',
        sourceId: SOURCE_E,
        title: 'دمو: خبر کاملاً مستقل اپسیلون',
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

    let providerCalls = 0;
    const port: AiProviderPort = {
      provider: 'workers-ai',
      complete: async (input) => {
        providerCalls += 1;
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
        idGenerator: { newId: () => `demo-reuse-${(demoIdCounter += 1)}` },
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
      const draftsBefore = (await rawExecutor.first<{ n: number }>({
        sql: 'SELECT COUNT(*) AS n FROM drafts',
      }))!.n;
      const providerBefore = providerCalls;
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
      const draftsAfter = (await rawExecutor.first<{ n: number }>({
        sql: 'SELECT COUNT(*) AS n FROM drafts',
      }))!.n;

      const outcomeType = draftsAfter > draftsBefore ? 'normal_draft' : 'exact_content_reuse';
      const claims = await rawExecutor.query<{
        claim_id: string;
        story_id: string;
        subject: string;
      }>({
        sql: `SELECT c.id AS claim_id, c.story_id, c.subject
                FROM claims c JOIN evidence e ON e.claim_id = c.id
               WHERE e.source_item_id = ?`,
        params: [item.id],
      });
      const ownClaim = claims.rows[0]!;
      let draftInfo: {
        draftId: string | null;
        draftStatus: string | null;
        guardKind: string;
        observation: string | null;
        candidates: unknown;
        assessment: unknown;
      } = {
        draftId: null,
        draftStatus: null,
        guardKind: 'not_created_on_reuse',
        observation: null,
        candidates: [],
        assessment: { kind: 'not_created_on_reuse' },
      };
      if (outcomeType === 'normal_draft') {
        const latest = await rawExecutor.first<{
          id: string;
          story_id: string;
          status: string;
          document_json: string;
        }>({
          sql: 'SELECT id, story_id, status, document_json FROM drafts ORDER BY rowid DESC LIMIT 1',
        });
        const document = JSON.parse(latest!.document_json) as Record<string, unknown>;
        const guardRead = readEvidenceGuardReport(document);
        const discoveryRead = readCandidateDiscoveryReport(document);
        const assessmentRead = readCandidateAssessmentReport(document);
        expect(discoveryRead.kind).toBe('candidate_discovery_v1');
        expect(assessmentRead.kind).toBe('candidate_assessment_v1');
        draftInfo = {
          draftId: latest!.id,
          draftStatus: latest!.status,
          guardKind: guardRead.kind,
          observation:
            discoveryRead.kind === 'candidate_discovery_v1'
              ? discoveryRead.report.observation
              : null,
          candidates:
            discoveryRead.kind === 'candidate_discovery_v1'
              ? discoveryRead.report.candidates.map((candidate) => ({
                  storyId: candidate.storyId,
                  matchedSignals: candidate.matchedSignals.map((signal) => signal.kind),
                }))
              : [],
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
                }
              : { kind: assessmentRead.kind },
        };
      } else {
        // Reuse outcome: report the TARGET draft this item now shares.
        const reused = await rawExecutor.first<{ id: string; status: string }>({
          sql: 'SELECT id, status FROM drafts WHERE story_id = ? AND version = 1',
          params: [ownClaim.story_id],
        });
        draftInfo = {
          ...draftInfo,
          draftId: reused!.id,
          draftStatus: reused!.status,
          guardKind: 'reused_target_draft_untouched',
        };
      }
      summaryItems.push({
        sourceItemId: item.id,
        outcomeType,
        resultStoryId: ownClaim.story_id,
        ownProvenance: {
          claimId: ownClaim.claim_id,
          claimSubject: ownClaim.subject,
        },
        reusedOrCreatedDraft: draftInfo.draftId,
        draftStatus: draftInfo.draftStatus,
        guardKind: draftInfo.guardKind,
        discoveryObservation: draftInfo.observation,
        discoveryCandidates: draftInfo.candidates,
        assessment: draftInfo.assessment,
        itemProcessingStatus: (await rawExecutor.first<{ processing_status: string }>({
          sql: 'SELECT processing_status FROM source_items WHERE id = ?',
          params: [item.id],
        }))!.processing_status,
        providerCallsDelta: providerCalls - providerBefore,
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
    const draftRows = await rawExecutor.query<{ id: string; document_json: string }>({
      sql: 'SELECT id, document_json FROM drafts',
    });

    const summary = {
      demo: 'R1.15 exact-content draft reuse with preserved provenance — five artificial sources, ZERO network/live AI',
      scopeCaps: {
        probeRowsPerLookup: FINGERPRINT_LOOKUP_ROW_LIMIT,
        maxCandidates: STORY_CANDIDATES_MAX,
        indexNamespace: 'sc1',
        reuseNote:
          'R1.15 reuse is VERIFIED (byte-exact full composed text + usable ready draft); the group anchor enforces ONE stable result per exact content in SQL; reuse is NOT a merge, NOT truth, NOT independence',
      },
      items: summaryItems,
      totals: {
        providerCalls,
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
        distinctDraftDocuments: new Set(draftRows.rows.map((row) => row.document_json)).size,
      },
      note:
        'Local D1 proxy metrics only — NOT Cloudflare billing counters. ' +
        'Free ingestion/full-poll remain NOT_READY.',
    };
    // eslint-disable-next-line no-console
    console.log('\n=== R1.15 EXACT-CONTENT REUSE DEMO (safe summary) ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    // The demo's OWN assertions.
    const [a, b, c, d, e] = summaryItems;
    // A: the normal path — one real provider call, its own draft.
    expect(a!.outcomeType).toBe('normal_draft');
    expect(a!.providerCallsDelta).toBe(1);
    expect(a!.discoveryObservation).toBe('no_candidates_observed');
    // B: VERIFIED reuse — zero provider calls, own provenance under A's story.
    expect(b!.outcomeType).toBe('exact_content_reuse');
    expect(b!.providerCallsDelta).toBe(0);
    expect(b!.resultStoryId).toBe(a!.resultStoryId);
    expect(b!.ownProvenance).toMatchObject({ claimSubject: 'دموی منبع بتا' });
    expect(b!.reusedOrCreatedDraft).toBe(a!.reusedOrCreatedDraft);
    expect(b!.itemProcessingStatus).toBe('processed');
    // C: shared URL only → independent draft; the URL signal observed.
    expect(c!.outcomeType).toBe('normal_draft');
    expect(c!.providerCallsDelta).toBe(1);
    expect(c!.discoveryCandidates).toEqual([
      { storyId: a!.resultStoryId, matchedSignals: ['url'] },
    ]);
    expect(c!.assessment).toMatchObject({
      entries: [
        {
          storyId: a!.resultStoryId,
          verdict: 'shared_url_observed',
          verdictReasons: ['url_fingerprint_match'],
        },
      ],
      unrelatednessConcluded: false,
    });
    // D: shared title only → independent draft; the WEAK title signal observed.
    expect(d!.outcomeType).toBe('normal_draft');
    expect(d!.providerCallsDelta).toBe(1);
    expect(d!.discoveryCandidates).toEqual([
      { storyId: a!.resultStoryId, matchedSignals: ['title_key'] },
    ]);
    expect(d!.assessment).toMatchObject({
      entries: [
        {
          storyId: a!.resultStoryId,
          verdict: 'shared_title_observed',
          verdictReasons: ['title_key_fingerprint_match'],
        },
      ],
      unrelatednessConcluded: false,
    });
    // E: fully independent.
    expect(e!.outcomeType).toBe('normal_draft');
    expect(e!.discoveryObservation).toBe('no_candidates_observed');
    expect(e!.assessment).toMatchObject({
      observation: 'no_candidates_observed',
      entries: [],
      unrelatednessConcluded: false,
    });

    // 5 items → 4 stories, 4 drafts, 5 claims, exactly 4 REAL provider
    // calls, 4 ai_runs rows — B paid NOTHING and fabricated NOTHING.
    expect(summary.noMergeProof.stories).toBe(4);
    expect(summary.noMergeProof.claimCount).toBe(5);
    expect(summary.noMergeProof.allClaimConfidencesZero).toBe(true);
    expect(summary.totals.providerCalls).toBe(4);
    expect(
      await rawExecutor.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM ai_runs' }),
    ).toMatchObject({ n: 4 });
  });
});
