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
import { readEntityMentionsReport } from '../../src/domain/editorial/entity-mentions';
import {
  ENTITY_MENTION_MAX_PHRASES,
  ENTITY_MENTION_MAX_RESULT_ROWS,
  ENTITY_MENTION_MAX_SCAN_TOKENS,
  ENTITY_MENTION_POLICY_VERSION,
} from '../../src/domain/editorial/entity-mentions';

/**
 * R1.16 (Phase 5D) OFFLINE demo runner — controlled entity aliases →
 * durable story mentions, over the SAME real editorial path (real engine,
 * real budget authority, real fenced commits; artificial provider port,
 * zero network, zero live AI). ONE entity seeded with a Persian AND an
 * English alias; THREE artificial news items:
 *
 * - EN news mentioning the English alias → its own draft + ONE durable
 *   `story_entities` link (relation `mentioned`, confidence 0);
 * - FA news mentioning the Persian alias → its own INDEPENDENT draft +
 *   the SAME entity linked again (Persian and English resolve to ONE id);
 * - AMBIG news mentioning an alias deliberately shared with a second
 *   entity → its own draft, ZERO links (ambiguous — no first-row-wins).
 *
 * It prints the SAFE summary: entity ids, matched aliases per story, the
 * durable links, per-item outcome/observation, the REAL provider-call
 * count, and the LOCAL D1 cost table (statements / execution-API calls /
 * rows returned / alias lookups / mention inserts). LOCAL PROXY metrics
 * only — NOT Cloudflare billing counters.
 *
 * Run standalone with: `npm run demo:entity-mentions`.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-demo-mentions-a';
const SOURCE_B = 'src-demo-mentions-b';
const SOURCE_C = 'src-demo-mentions-c';
const ENTITY_DOOM = 'ent-demo-doom';
const ENTITY_RIVAL = 'ent-demo-rival';

/** Counting executor: the local D1 proxy metric, WITH alias counters. */
function createCountingExecutor(inner: DbExecutor): DbExecutor & {
  readonly stats: () => {
    statements: number;
    apiCalls: number;
    rowsReturned: number;
    aliasLookups: number;
    mentionInserts: number;
  };
} {
  let statements = 0;
  let apiCalls = 0;
  let rowsReturned = 0;
  let aliasLookups = 0;
  let mentionInserts = 0;
  return {
    query: async <T>(statement: Parameters<DbExecutor['query']>[0]) => {
      statements += 1;
      apiCalls += 1;
      if (statement.sql.includes('FROM entity_aliases')) {
        aliasLookups += 1;
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
      mentionInserts += input.filter((statement) =>
        statement.sql.includes('INSERT INTO story_entities'),
      ).length;
      return inner.batch(input);
    },
    stats: () => ({ statements, apiCalls, rowsReturned, aliasLookups, mentionInserts }),
  };
}

describe('entity mentions demo — offline runner (R1.16 controlled aliases)', () => {
  it('runs EN→link, FA→same entity, AMBIG→zero links and prints the safe summary with per-item SQL cost', async () => {
    await applyMigrations(env.DB);
    const clock = fixedClock(NOW);
    const rawExecutor = createDbExecutor(env.DB, { clock });
    const executor = createCountingExecutor(rawExecutor);
    const logger = createLogger({ level: 'error', clock });

    for (const [id, name] of [
      [SOURCE_A, 'دموی منبع الفبا'],
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

    // The CONTROLLED catalog (fixture seeding — news text can NEVER add
    // entities or aliases). ONE entity, TWO registered names; the rival
    // entity deliberately shares the ambiguous alias.
    await rawExecutor.run({
      sql: `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
            VALUES (?, 'game', 'Doom', 'doom', '{}', ?, ?)`,
      params: [ENTITY_DOOM, NOW, NOW],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
            VALUES (?, 'Doom', 'Doom', 'en')`,
      params: [ENTITY_DOOM],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
            VALUES (?, 'دوم', 'دوم', 'fa')`,
      params: [ENTITY_DOOM],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
            VALUES (?, 'game', 'Rival Quest', 'rival-quest', '{}', ?, ?)`,
      params: [ENTITY_RIVAL, NOW, NOW],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
            VALUES (?, 'Quest', 'Quest', 'en')`,
      params: [ENTITY_RIVAL],
    });
    await rawExecutor.run({
      sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
            VALUES (?, 'Quest', 'Quest', 'en')`,
      params: [ENTITY_DOOM],
    });

    const items = [
      {
        id: 'demo-mentions-en',
        sourceId: SOURCE_A,
        title: 'Doom reveals the next chapter',
        body: 'The studio shared a short teaser today.',
      },
      {
        id: 'demo-mentions-fa',
        sourceId: SOURCE_B,
        title: 'دوم فصل تازه را روایت می‌کند',
        body: 'استودیو امروز یک تیزر کوتاه منتشر کرد.',
      },
      {
        id: 'demo-mentions-ambig',
        sourceId: SOURCE_C,
        title: 'Quest receives a new update',
        body: 'The ambiguous alias belongs to two entities at once.',
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
          `https://example.com/demo/${item.id}`,
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
        idGenerator: { newId: () => `demo-mentions-${(demoIdCounter += 1)}` },
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
    let providerBefore = 0;
    for (const item of items) {
      const before = executor.stats();
      providerBefore = providerCalls;
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
      const document = JSON.parse(
        (await rawExecutor.first<{ document_json: string }>({
          sql: 'SELECT document_json FROM drafts WHERE story_id = ? AND version = 1',
          params: [storyId],
        }))!.document_json,
      ) as unknown;
      const report = readEntityMentionsReport(document);
      const links = (
        await rawExecutor.query<{ entity_id: string }>({
          sql: 'SELECT entity_id FROM story_entities WHERE story_id = ? ORDER BY entity_id ASC',
          params: [storyId],
        })
      ).rows;
      summaryItems.push({
        sourceItemId: item.id,
        storyId,
        outcome: report.kind === 'entity_mentions_v1' ? report.report.observation : report.kind,
        matchedAliases:
          report.kind === 'entity_mentions_v1'
            ? report.report.matched.map((match) => match.normalizedAlias)
            : [],
        resolvedEntities:
          report.kind === 'entity_mentions_v1'
            ? [...new Set(report.report.matched.map((match) => match.entityId))]
            : [],
        ambiguousAliases:
          report.kind === 'entity_mentions_v1'
            ? report.report.ambiguous.map((entry) => ({
                normalizedAlias: entry.normalizedAlias,
                ownerCount: entry.ownerCount,
              }))
            : [],
        durableLinks: links.map((row) => row.entity_id),
        itemProcessingStatus: (await rawExecutor.first<{ processing_status: string }>({
          sql: 'SELECT processing_status FROM source_items WHERE id = ?',
          params: [item.id],
        }))!.processing_status,
        providerCallsDelta: providerCalls - providerBefore,
        sqlDelta: {
          statements: after.statements - before.statements,
          apiCalls: after.apiCalls - before.apiCalls,
          aliasLookups: after.aliasLookups - before.aliasLookups,
          mentionInsertStatements: after.mentionInserts - before.mentionInserts,
        },
      });
    }

    const stats = executor.stats();
    const links = (
      await rawExecutor.query<StoryEntityLinkRow>({
        sql: 'SELECT story_id, entity_id, relation, confidence FROM story_entities ORDER BY story_id ASC, entity_id ASC',
      })
    ).rows;
    const summary = {
      demo: 'R1.16 controlled entity aliases → durable story mentions — three artificial sources, ZERO network/live AI',
      policy: {
        version: ENTITY_MENTION_POLICY_VERSION,
        caps: {
          maxPhrases: ENTITY_MENTION_MAX_PHRASES,
          maxScanTokens: ENTITY_MENTION_MAX_SCAN_TOKENS,
          maxResultRows: ENTITY_MENTION_MAX_RESULT_ROWS,
        },
        note: 'controlled_aliases_only; mention_not_verification; confidence_zero; NO fuzzy/translation/semantic merge',
      },
      items: summaryItems,
      durableStoryEntities: links,
      totals: {
        providerCalls,
        statements: stats.statements,
        apiCalls: stats.apiCalls,
        rowsReturned: stats.rowsReturned,
        aliasLookups: stats.aliasLookups,
        mentionInsertStatements: stats.mentionInserts,
      },
      note:
        'Local D1 proxy metrics only — NOT Cloudflare billing counters. ' +
        'Exact-content reuse drafts (R1.15.2 contract) are NOT enriched by this catalog.',
    };
    // eslint-disable-next-line no-console
    console.log('\n=== R1.16 ENTITY MENTIONS DEMO (safe summary) ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    // The demo's OWN assertions.
    const [en, fa, ambig] = summaryItems;
    // EN news: English alias → the entity, durable link.
    expect(en!.outcome).toBe('mentions_observed');
    expect(en!.matchedAliases).toEqual(['Doom']);
    expect(en!.resolvedEntities).toEqual([ENTITY_DOOM]);
    expect(en!.durableLinks).toEqual([ENTITY_DOOM]);
    expect(en!.itemProcessingStatus).toBe('processed');
    // FA news: Persian alias → the SAME entity, independent story+draft.
    expect(fa!.outcome).toBe('mentions_observed');
    expect(fa!.matchedAliases).toEqual(['دوم']);
    expect(fa!.resolvedEntities).toEqual([ENTITY_DOOM]);
    expect(fa!.durableLinks).toEqual([ENTITY_DOOM]);
    expect(fa!.storyId).not.toBe(en!.storyId);
    // AMBIG news: shared alias → ZERO links, honest ambiguity record.
    expect(ambig!.outcome).toBe('ambiguous_only_observed');
    expect(ambig!.matchedAliases).toEqual([]);
    expect(ambig!.durableLinks).toEqual([]);
    expect(ambig!.ambiguousAliases).toEqual([{ normalizedAlias: 'Quest', ownerCount: 2 }]);

    // 3 items → 3 stories (NO merge), exactly 2 durable links, 3 REAL
    // provider calls, all confidences zero.
    expect(
      (await rawExecutor.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM stories' }))!.n,
    ).toBe(3);
    expect(links.length).toBe(2);
    expect(links.every((row) => row.relation === 'mentioned' && row.confidence === 0)).toBe(true);
    expect(summary.totals.providerCalls).toBe(3);
    expect(
      (await rawExecutor.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM ai_runs' }))!.n,
    ).toBe(3);
  });
});

interface StoryEntityLinkRow {
  readonly story_id: string;
  readonly entity_id: string;
  readonly relation: string;
  readonly confidence: number;
}
