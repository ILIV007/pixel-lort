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
import { createEventRelationService } from '../../src/application/ai/event-relation-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import {
  readEventRelationDecision,
  EVENT_RELATION_DECISION_VERSION,
  EVENT_RELATION_LIMITATIONS,
} from '../../src/domain/editorial/event-relation-decision';
import {
  EVENT_RELATION_MAX_ENTITY_PROBES,
  EVENT_RELATION_MAX_PAIR_EVALUATIONS,
  EVENT_RELATION_MAX_ROWS_PER_PROBE,
  EVENT_RELATION_MAX_UNIQUE_CANDIDATES,
  EVENT_RELATION_POLICY_VERSION,
} from '../../src/domain/editorial/event-relation-candidates';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';

/**
 * R1.17 (Phase 5E-1) OFFLINE demo runner — bounded event-relation
 * evaluation → durable, evidence-referenced decisions, over the SAME real
 * editorial path (real engine, real budget authority, real fenced commits
 * + SQL gates; artificial provider port, ZERO network, ZERO live AI).
 *
 * ONE controlled entity ("Astra Blade") with a Persian AND an English
 * alias; FOUR artificial news items processed in order:
 *
 * - EN announcement (its own draft first, no candidates yet);
 * - FA translation/rewrite of the SAME announcement (DIFFERENT text, SAME
 *   shared entity → the candidate comes from the ENTITY LINK, not a shared
 *   URL) → fixture `same_event_proposed` with BOTH-side citations → the
 *   versioned ledger is stored INSIDE the same fenced draft INSERT and
 *   re-read from D1;
 * - a release-date announcement vs the store-discount item of the SAME
 *   game → fixture `different_event_proposed`;
 * - a too-thin follow-up → fixture `insufficient_evidence` (the explicit
 *   zero-citation contract).
 *
 * It prints the SAFE summary: candidate origins, pair/basis ids, the
 * proposed verdicts + evidence ids, the stored readback, the REAL provider
 * attempts/charges, and the LOCAL D1 cost table. It proves PLUMBING and
 * fixture/contract correctness — NEVER live-model semantic accuracy; a
 * real model evaluation needs a separate free and allowed round.
 *
 * Run standalone with: `npm run demo:event-relations`.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-demo-er-a';
const SOURCE_B = 'src-demo-er-b';
const SOURCE_C = 'src-demo-er-c';
const SOURCE_D = 'src-demo-er-d';
const ENTITY_ASTRA = 'ent-demo-astra';

/** Counting executor: the local D1 proxy metric, WITH relation counters. */
function createCountingExecutor(inner: DbExecutor): DbExecutor & {
  readonly stats: () => {
    statements: number;
    apiCalls: number;
    rowsReturned: number;
    entityProbes: number;
    relationRunInserts: number;
  };
} {
  let statements = 0;
  let apiCalls = 0;
  let rowsReturned = 0;
  let entityProbes = 0;
  let relationRunInserts = 0;
  return {
    query: async <T>(statement: Parameters<DbExecutor['query']>[0]) => {
      statements += 1;
      apiCalls += 1;
      if (
        statement.sql.includes('FROM story_entities') &&
        statement.sql.includes('entity_id = ?')
      ) {
        entityProbes += 1;
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
      relationRunInserts += input.filter(
        (statement) =>
          statement.sql.includes("task = 'event_relation'") ||
          (statement.sql.includes('INSERT INTO ai_runs') && statement.sql.includes('?')),
      ).length;
      return inner.batch(input);
    },
    stats: () => ({ statements, apiCalls, rowsReturned, entityProbes, relationRunInserts }),
  };
}

async function seedSource(executor: DbExecutor, id: string, name: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, ?, 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [id, name, NOW, NOW],
  });
}

async function seedItem(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly sourceId: string;
    readonly title: string;
    readonly body: string;
  },
): Promise<string> {
  const contentHash = await sha256Hex(`${input.id}\u001f${input.title}\u001f${input.body}`);
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسندهٔ دمو', ?, ?, ?, '{}', 'new')`,
    params: [
      input.id,
      input.sourceId,
      `ext-${input.id}`,
      `https://example.com/demo/${input.id}`,
      input.title,
      input.body,
      NOW,
      NOW,
      contentHash,
    ],
  });
  return contentHash;
}

describe('event relations demo — offline runner (R1.17 Phase 5E-1)', () => {
  it('runs translation→same, different-events→different, thin→insufficient and prints the safe summary', async () => {
    await applyMigrations(env.DB);
    const clock = fixedClock(NOW);
    const rawExecutor = createDbExecutor(env.DB, { clock });
    const executor = createCountingExecutor(rawExecutor);
    const logger = createLogger({ level: 'error', clock });

    for (const [id, name] of [
      [SOURCE_A, 'دموی رویداد الفبا'],
      [SOURCE_B, 'دموی رویداد بتا'],
      [SOURCE_C, 'دموی رویداد گاما'],
      [SOURCE_D, 'دموی رویداد دلتا'],
    ] as const) {
      await seedSource(rawExecutor, id, name);
    }

    // The CONTROLLED catalog (fixture seeding — news text can NEVER add
    // entities or aliases). ONE entity, TWO registered names (fa + en).
    await rawExecutor.run({
      sql: `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
            VALUES (?, 'game', 'Astra Blade', 'astra-blade', '{}', ?, ?)`,
      params: [ENTITY_ASTRA, NOW, NOW],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
            VALUES (?, 'Astra Blade', 'Astra Blade', 'en')`,
      params: [ENTITY_ASTRA],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
            VALUES (?, 'تیغهٔ آسترا', 'تیغهٔ آسترا', 'fa')`,
      params: [ENTITY_ASTRA],
    });

    // FOUR artificial items, processed IN ORDER (each later item sees the
    // earlier committed stories as candidates through the entity links).
    const items = [
      {
        id: 'demo-er-en-announce',
        sourceId: SOURCE_A,
        title: 'Astra Blade gets a free weekend next month',
        body: 'The publisher announced a free access weekend for the game.',
      },
      {
        id: 'demo-er-fa-translate',
        sourceId: SOURCE_B,
        title: 'تیغهٔ آسترا ماه آینده یک آخر هفته رایگان می‌شود',
        body: 'ناشر بازی از برگزاری آخر هفتهٔ دسترسی رایگان خبر داد.',
      },
      {
        id: 'demo-er-discount',
        sourceId: SOURCE_C,
        title: 'Astra Blade store discount drops 40 percent',
        body: 'The publisher store lists the game at 40 percent off this weekend.',
      },
      {
        id: 'demo-er-thin',
        sourceId: SOURCE_D,
        title: 'تیغهٔ آسترا باز هم خبرساز شد',
        body: 'یک خبر کوتاه بدون جزئیات.',
      },
    ];
    const hashes = new Map<string, string>();
    for (const item of items) {
      hashes.set(item.id, await seedItem(rawExecutor, item));
    }

    // The fixture port answers BOTH tasks from the SAME scripted surface.
    let draftCalls = 0;
    let relationCalls = 0;
    const port: AiProviderPort = {
      provider: 'workers-ai',
      complete: async (input) => {
        const userContent = input.messages.find((message) => message.role === 'user')?.content;
        if (userContent?.includes('شناسهٔ جفت (pairId):')) {
          relationCalls += 1;
          const pairId = /شناسهٔ جفت \(pairId\): (erp-\d+)/.exec(userContent)?.[1] ?? 'erp-unknown';
          const sideAEvidenceId =
            /طرف A — شناسهٔ شواهد: ([^\n]+)/.exec(userContent)?.[1] ?? 'unknown-a';
          const sideBEvidenceId =
            /طرف B — شناسهٔ شواهد: ([^\n]+)/.exec(userContent)?.[1] ?? 'unknown-b';
          // Fixture semantics (CONTRACT demo — NOT model quality):
          const verdict =
            sideBEvidenceId === 'demo-er-fa-translate' || sideAEvidenceId === 'demo-er-fa-translate'
              ? 'same_event_proposed'
              : sideBEvidenceId === 'demo-er-thin' || sideAEvidenceId === 'demo-er-thin'
                ? 'insufficient_evidence'
                : 'different_event_proposed';
          const outcome: AiCallOutcome = {
            kind: 'ok',
            rawText: JSON.stringify({
              pairId,
              verdict,
              reasons: ['پاسخ فیکسچر دمو — قرارداد لوله‌کشی، نه کیفیت مدل زنده'],
              references:
                verdict === 'insufficient_evidence'
                  ? []
                  : [
                      { side: 'A', evidenceId: sideAEvidenceId },
                      { side: 'B', evidenceId: sideBEvidenceId },
                    ],
              conflicts: [],
            }),
            usage: { inputTokens: 21, outputTokens: 9 },
          };
          return outcome;
        }
        draftCalls += 1;
        const evidenceId =
          /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>/.exec(userContent ?? '')?.[1] ?? 'missing-id';
        const outcome: AiCallOutcome = {
          kind: 'ok',
          rawText: JSON.stringify({
            headlineFa: 'تیتر دموی مصنوعی',
            summaryFa: 'خلاصهٔ دموی مصنوعی؛ خروجی مدل یک فیکسچر آفلاین است.',
            claims: [
              { text: 'استودیوی آزمایشی از رویداد تازه خبر داد.', evidenceIds: [evidenceId] },
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
    const eventRelationService = createEventRelationService({
      executor,
      ports: { 'workers-ai': port },
      clock,
      logger,
      config: {
        eventRelationEnabled: true,
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
            eventRelation: {
              enabled: true,
              service: eventRelationService,
            },
            nowMs: () => clock.now(),
            logger,
          }),
        ] as never),
        idGenerator: { newId: () => `demo-er-${(demoIdCounter += 1)}` },
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

    interface PairSummary {
      pairId: string;
      state: string;
      verdict: string | null;
      candidateStoryId: string;
      candidateOrigins: readonly string[];
      canonicalInputHash: string | null;
      evidenceIds: readonly string[];
      aiRunIds: readonly string[];
    }
    const summaryItems: Record<string, unknown>[] = [];
    const storyIds: string[] = [];

    for (const item of items) {
      const before = executor.stats();
      const draftCallsBefore = draftCalls;
      const relationCallsBefore = relationCalls;
      const relationRunsBefore = await rawExecutor.first<{ n: number }>({
        sql: `SELECT COUNT(*) AS n FROM ai_runs WHERE task = 'event_relation'`,
      });
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

      const storyId = (await rawExecutor.first<{ story_id: string }>({
        sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
                 WHERE e.source_item_id = ?`,
        params: [item.id],
      }))!.story_id;
      storyIds.push(storyId);
      const documentJson = (await rawExecutor.first<{ document_json: string }>({
        sql: 'SELECT document_json FROM drafts WHERE story_id = ? AND version = 1',
        params: [storyId],
      }))!.document_json;
      const read = readEventRelationDecision(documentJson);
      expect(read.kind).toBe('event_relation_v1');
      const report = read.kind === 'event_relation_v1' ? read.report : null;
      const pairs: PairSummary[] =
        report?.pairs.map((pair) => ({
          pairId: pair.pairId,
          state: pair.state,
          verdict: pair.verdict ?? null,
          candidateStoryId: pair.sideB.storyId,
          candidateOrigins:
            report?.candidates.find((entry) => entry.storyId === pair.sideB.storyId)?.origins ?? [],
          canonicalInputHash: pair.canonicalInputHash ?? null,
          evidenceIds: (pair.references ?? []).map(
            (reference) => `${reference.side}:${reference.evidenceId}`,
          ),
          aiRunIds: pair.aiRunIds,
        })) ?? [];
      const relationRunsAfter = await rawExecutor.first<{ n: number }>({
        sql: `SELECT COUNT(*) AS n FROM ai_runs WHERE task = 'event_relation'`,
      });
      summaryItems.push({
        sourceItemId: item.id,
        storyId,
        observation: report?.observation ?? read.kind,
        candidatesObserved: report?.lookup.candidatesReported ?? 0,
        pairs: pairs,
        itemProcessingStatus: (await rawExecutor.first<{ processing_status: string }>({
          sql: 'SELECT processing_status FROM source_items WHERE id = ?',
          params: [item.id],
        }))!.processing_status,
        providerCallsDelta: {
          draft: draftCalls - draftCallsBefore,
          relation: relationCalls - relationCallsBefore,
        },
        relationRunRowsDelta: (relationRunsAfter?.n ?? 0) - (relationRunsBefore?.n ?? 0),
        sqlDelta: {
          statements: after.statements - before.statements,
          apiCalls: after.apiCalls - before.apiCalls,
          entityProbeReads: after.entityProbes - before.entityProbes,
        },
      });
    }

    const stats = executor.stats();
    const relationRuns = (
      await rawExecutor.query<{ id: string; task: string; status: string; prompt_version: string }>(
        {
          sql: `SELECT id, task, status, prompt_version FROM ai_runs
               WHERE task = 'event_relation' ORDER BY id ASC`,
        },
      )
    ).rows;
    const summary = {
      demo: 'R1.17 bounded event-relation evaluation → durable evidence-referenced decisions — synthetic sources/catalog + fixture provider, ZERO network/live AI',
      policy: {
        decisionVersion: EVENT_RELATION_DECISION_VERSION,
        retrievalPolicy: EVENT_RELATION_POLICY_VERSION,
        caps: {
          maxEntityProbes: EVENT_RELATION_MAX_ENTITY_PROBES,
          maxRowsPerProbe: EVENT_RELATION_MAX_ROWS_PER_PROBE,
          maxUniqueCandidates: EVENT_RELATION_MAX_UNIQUE_CANDIDATES,
          maxPairEvaluations: EVENT_RELATION_MAX_PAIR_EVALUATIONS,
        },
        limitations: EVENT_RELATION_LIMITATIONS,
        note: 'candidate_only_not_merge; model_proposal_not_truth; no_candidate_not_unrelated; technical_failure_not_insufficient_evidence',
      },
      items: summaryItems,
      durableRelationRuns: relationRuns,
      totals: {
        draftProviderCalls: draftCalls,
        relationProviderCalls: relationCalls,
        statements: stats.statements,
        apiCalls: stats.apiCalls,
        rowsReturned: stats.rowsReturned,
        entityProbeReads: stats.entityProbes,
      },
      noMergeProof: {
        stories: (await rawExecutor.first<{ n: number }>({
          sql: 'SELECT COUNT(*) AS n FROM stories',
        }))!.n,
        statuses: (
          await rawExecutor.query<{ status: string }>({
            sql: 'SELECT status FROM stories ORDER BY id ASC',
          })
        ).rows,
        trustStatuses: (
          await rawExecutor.query<{ trust_status: string }>({
            sql: 'SELECT trust_status FROM stories ORDER BY id ASC',
          })
        ).rows,
        note: 'two stories stay independent; status discovered; trust unknown; NO merged_into/duplicate marker; confidence 0 everywhere',
      },
      note:
        'Local D1 proxy metrics only — NOT Cloudflare billing counters. ' +
        'The fixture verdicts prove plumbing/contract correctness, NOT live-model semantic accuracy; ' +
        'a real model evaluation needs a separate free and allowed round.',
    };
    // eslint-disable-next-line no-console
    console.log('\n=== R1.17 EVENT RELATIONS DEMO (safe summary) ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    // ---- The demo's OWN assertions.
    const [, faTranslate, discount, thin] = summaryItems;

    // The Persian rewrite's candidate came through the SHARED-ENTITY link
    // (the texts and URLs are entirely different) — not a shared URL.
    const faPairs = faTranslate!.pairs as PairSummary[];
    expect(faTranslate!.observation).toBe('pairs_evaluated');
    expect(faPairs).toHaveLength(1);
    expect(faPairs[0]!.verdict).toBe('same_event_proposed');
    expect(faPairs[0]!.candidateOrigins).toContain(`entity:${ENTITY_ASTRA}`);
    expect(faPairs[0]!.evidenceIds).toEqual(['A:demo-er-fa-translate', 'B:demo-er-en-announce']);
    expect(faPairs[0]!.canonicalInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(faPairs[0]!.aiRunIds).toHaveLength(1);

    // The discount item: a DIFFERENT event of the same game.
    const discountPairs = discount!.pairs as PairSummary[];
    expect(discountPairs.length).toBeGreaterThanOrEqual(1);
    expect(discountPairs.some((pair) => pair.verdict === 'different_event_proposed')).toBe(true);

    // The thin follow-up: the explicit insufficient contract (no citations).
    const thinPairs = thin!.pairs as PairSummary[];
    expect(thinPairs.length).toBeGreaterThanOrEqual(1);
    expect(thinPairs.some((pair) => pair.verdict === 'insufficient_evidence')).toBe(true);
    const thinEvaluated = thinPairs.find((pair) => pair.verdict === 'insufficient_evidence')!;
    expect(thinEvaluated.evidenceIds).toEqual([]);

    // Stored readback: every ledger references REAL durable runs.
    for (const run of relationRuns) {
      expect(run.task).toBe('event_relation');
      expect(run.status).toBe('succeeded');
      expect(run.prompt_version).toBe('pixel-event-relation-v1');
    }

    // NO merge: four independent stories, all discovered/unknown.
    const noMerge = summary.noMergeProof as unknown as {
      stories: number;
      statuses: { status: string }[];
      trustStatuses: { trust_status: string }[];
    };
    expect(noMerge.stories).toBe(4);
    for (const status of noMerge.statuses) {
      expect(status.status).toBe('discovered');
    }
    for (const trust of noMerge.trustStatuses) {
      expect(trust.trust_status).toBe('unknown');
    }
    // Four distinct story ids.
    expect(new Set(storyIds).size).toBe(4);

    // Every committed item processed; the first item honestly observed no
    // candidates (nothing was committed before it), the later items carry
    // evaluated pairs. All ledger readbacks are v1.
    const [firstItem, ...laterItems] = summaryItems;
    expect(firstItem!.itemProcessingStatus).toBe('processed');
    expect(firstItem!.observation).toBe('no_candidates_observed');
    for (const entry of laterItems) {
      expect(entry.itemProcessingStatus).toBe('processed');
      expect(entry.observation).toBe('pairs_evaluated');
    }
    expect(canonicalizeJson(summary)).toBeDefined();
  });
});
