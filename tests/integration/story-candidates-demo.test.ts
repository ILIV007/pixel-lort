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
import { readEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import {
  FINGERPRINT_LOOKUP_ROW_LIMIT,
  STORY_CANDIDATES_MAX,
} from '../../src/domain/editorial/story-fingerprints';

/**
 * R1.13 (Phase 5C-1) OFFLINE demo runner: THREE artificial news items from
 * three different sources — one RELATED pair (the same stored canonical_url,
 * different texts/titles) and one UNRELATED item — through the SAME real
 * editorial path (real engine, real budget authority, real fenced commit;
 * artificial provider port, zero network, zero live AI).
 *
 * It prints the SAFE summary: storyIds, per-draft candidate observation,
 * matchedSignals, candidate counts, the honest scope caps, and the proof
 * that NOTHING merged (3 independent stories, confidence 0 everywhere) —
 * plus the LOCAL D1 cost table (statements / execution-API calls / rows
 * returned), with the R1.13 fingerprint delta (≤3 pre-provider lookups +
 * ≤3 in-batch inserts per item) called out. These are LOCAL PROXY metrics
 * (ADR-0042 §8) — NOT Cloudflare billing counters, and this demo does NOT
 * resolve the NOT_READY status of Free ingestion/full-poll.
 *
 * Run standalone with: `npm run demo:story-candidates`.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-demo-alpha';
const SOURCE_B = 'src-demo-beta';
const SOURCE_C = 'src-demo-gamma';
const SHARED_URL = 'https://example.com/demo/shared-event';

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
        id: 'demo-cand-solo',
        sourceId: SOURCE_C,
        title: 'دمو: خبر کاملاً مستقل گاما',
        body: 'بدنهٔ دموی خبر مستقل؛ هیچ سیگنال مشترکی با دو خبر دیگر ندارد.',
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
      expect(discoveryRead.kind).toBe('candidate_discovery_v1');
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
      demo: 'R1.13 story candidates — three artificial sources, ZERO network/AI',
      scopeCaps: {
        probeRowsPerLookup: FINGERPRINT_LOOKUP_ROW_LIMIT,
        maxCandidates: STORY_CANDIDATES_MAX,
        indexNamespace: 'sc1',
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
    console.log('\n=== R1.13 STORY-CANDIDATES DEMO (safe summary) ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    // The demo's OWN assertions: the related pair discovered, the solo item
    // honestly empty, and NOTHING merged anywhere.
    const a1 = summaryItems[0]!;
    const a2 = summaryItems[1]!;
    const solo = summaryItems[2]!;
    expect(a1['observation']).toBe('no_candidates_observed');
    expect(a2['observation']).toBe('candidates_observed');
    expect(a2['candidates']).toEqual([{ storyId: a1['storyId'], matchedSignals: ['url'] }]);
    expect(solo['observation']).toBe('no_candidates_observed');
    expect(summary.noMergeProof.stories).toBe(3);
    expect(summary.noMergeProof.allClaimConfidencesZero).toBe(true);
  });
});
