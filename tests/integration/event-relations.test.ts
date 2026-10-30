import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createLogger } from '../../src/observability/logger';
import { createJobsEngine, type JobsEngine } from '../../src/application/jobs/engine';
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
import { normalizeEntityMentionText } from '../../src/domain/editorial/entity-mentions';
import {
  readEventRelationDecision,
  type EventRelationDecisionReport,
} from '../../src/domain/editorial/event-relation-decision';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { storyIdForSnapshot } from '../../src/domain/editorial/identity';

/**
 * R1.17 (Phase 5E-1) acceptance suite — REAL workerd D1, REAL pipeline,
 * REAL handler/store/SQL gates. The ONLY artificial piece is the provider
 * port (zero network, scripted fixtures). Under test: shared-entity
 * candidate retrieval through idx_story_entities_entity, the bidirectional
 * evidence bundle, the SEPARATE event_relation task with its real
 * budget-authority attempts, the versioned `eventRelation` ledger stored
 * by the SAME fenced draft INSERT and re-read from D1, the SQL
 * candidate-basis gate (typed eventRelationBasisChanged), the preserved
 * R1.16.1 catalog gate (C1), zero-extra-cost replays, and the no-merge
 * boundary (two stories stay independent; no duplicate marker; no
 * status/trust raise). Fixture verdicts prove PLUMBING/contract
 * correctness — never live-model semantic accuracy.
 */

const NOW = 1_760_000_000_000;

let harnessJobIdCounter = 0;

interface RelationScriptInput {
  readonly pairId: string;
  readonly sideAEvidenceId: string;
  readonly sideBEvidenceId: string;
}

function proposedBothSides(
  verdict: 'same_event_proposed' | 'different_event_proposed',
  input: RelationScriptInput,
): string {
  return JSON.stringify({
    pairId: input.pairId,
    verdict,
    reasons: ['پاسخ فیکسچر آزمون — قرارداد، نه کیفیت مدل'],
    references: [
      { side: 'A', evidenceId: input.sideAEvidenceId },
      { side: 'B', evidenceId: input.sideBEvidenceId },
    ],
    conflicts: [],
  });
}

function insufficient(input: RelationScriptInput): string {
  return JSON.stringify({
    pairId: input.pairId,
    verdict: 'insufficient_evidence',
    reasons: ['شواهد فیکسچر ناکافی است'],
    references: [],
    conflicts: [],
  });
}

interface Harness {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly rawExecutor: DbExecutor;
  readonly clock: ReturnType<typeof fixedClock>;
  readonly envelopes: unknown[];
  readonly providerCalls: { draft: number; relation: number };
  runAfterAliasLookup: (fn: (() => Promise<void>) | null) => void;
  failBatchesMatching: (match: (statements: readonly { sql: string }[]) => boolean) => void;
  onBatchMutation: (fn: (() => Promise<void>) | null) => void;
  setRelationScript: (script: (input: RelationScriptInput) => string) => void;
}

function createHarness(input?: { readonly relationEnabled?: boolean }): Harness {
  const relationEnabled = input?.relationEnabled ?? true;
  const clock = fixedClock(NOW);
  const logger = createLogger({ level: 'error', clock });
  const rawExecutor = createDbExecutor(env.DB, { clock });

  const providerCalls = { draft: 0, relation: 0 };
  const failBatchesHook: {
    fn: ((statements: readonly { sql: string }[]) => Promise<void>) | null;
  } = { fn: null };
  const afterAliasHook: { fn: (() => Promise<void>) | null } = { fn: null };
  const batchMutationHook: { fn: (() => Promise<void>) | null } = { fn: null };
  let relationScript: (input: RelationScriptInput) => string = (script) =>
    proposedBothSides('same_event_proposed', script);

  const executor: DbExecutor = {
    query: async <T>(statement: Parameters<DbExecutor['query']>[0]) => {
      const result = await rawExecutor.query<T>(statement);
      if (
        statement.sql.includes('FROM entity_aliases') &&
        statement.sql.includes(' IN (') &&
        afterAliasHook.fn !== undefined
      ) {
        await afterAliasHook.fn?.();
        afterAliasHook.fn = null;
      }
      return result;
    },
    first: rawExecutor.first.bind(rawExecutor),
    run: rawExecutor.run.bind(rawExecutor),
    batch: async (statements) => {
      await failBatchesHook.fn?.(statements);
      await batchMutationHook.fn?.();
      batchMutationHook.fn = null;
      return rawExecutor.batch(statements);
    },
  };

  const port: AiProviderPort = {
    provider: 'workers-ai',
    complete: async (input) => {
      const userContent = input.messages.find((message) => message.role === 'user')?.content;
      if (userContent?.includes('شناسهٔ جفت (pairId):')) {
        // The event_relation task prompt — scripted fixture output.
        providerCalls.relation += 1;
        const pairId = /شناسهٔ جفت \(pairId\): (erp-\d+)/.exec(userContent)?.[1] ?? 'erp-unknown';
        const sideAEvidenceId =
          /طرف A — شناسهٔ شواهد: ([^\n]+)/.exec(userContent)?.[1] ?? 'unknown-a';
        const sideBEvidenceId =
          /طرف B — شناسهٔ شواهد: ([^\n]+)/.exec(userContent)?.[1] ?? 'unknown-b';
        const rawText = relationScript({ pairId, sideAEvidenceId, sideBEvidenceId });
        return { kind: 'ok', rawText, usage: { inputTokens: 21, outputTokens: 9 } };
      }
      // The news_draft task prompt — the SAME accepted draft fixture.
      providerCalls.draft += 1;
      const evidenceId =
        /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>/.exec(userContent ?? '')?.[1] ?? 'missing-id';
      const outcome: AiCallOutcome = {
        kind: 'ok',
        rawText: JSON.stringify({
          headlineFa: 'تیتر آزمایشی خبر',
          summaryFa: 'خلاصهٔ آزمایشی خبر بر اساس شواهد ارائه‌شده.',
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
  const eventRelationService = createEventRelationService({
    executor,
    ports: { 'workers-ai': port },
    clock,
    logger,
    config: {
      eventRelationEnabled: relationEnabled,
      workersAiBindingPresent: true,
      geminiApiKeyPresent: false,
    },
  });

  const envelopes: unknown[] = [];
  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      envelopes.push(envelope);
    },
  };
  const dlqProducer: DlqProducerPort = { send: async () => undefined };
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createEditorialPrepareDraftHandler({
          executor,
          aiService,
          eventRelation: {
            enabled: relationEnabled,
            service: eventRelationService,
          },
          nowMs: () => clock.now(),
          logger,
        }),
      ] as never),
      idGenerator: { newId: () => `er-id-${(harnessJobIdCounter += 1)}` },
      clock,
      random: () => 1,
      logger,
      jobsProducer,
      dlqProducer,
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
  return {
    engine,
    executor,
    rawExecutor,
    clock,
    envelopes,
    providerCalls,
    runAfterAliasLookup: (fn) => {
      afterAliasHook.fn = fn;
    },
    failBatchesMatching: (match) => {
      failBatchesHook.fn = async (statements) => {
        if (match(statements)) {
          throw new Error('injected_mid_commit_failure');
        }
      };
    },
    onBatchMutation: (fn) => {
      batchMutationHook.fn = fn;
    },
    setRelationScript: (script) => {
      relationScript = script;
    },
  };
}

async function seedSource(executor: DbExecutor, id: string, name: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
                                priority, daily_request_budget, approval_policy, config_json,
                                created_at, updated_at)
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
    readonly body?: string;
    readonly url?: string | null;
  },
): Promise<string> {
  const contentHash = await sha256Hex(`${input.id}\u001f${input.title}\u001f${input.body ?? ''}`);
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
                                     author, published_at, fetched_at, content_hash, raw_json,
                                     processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسنده', ?, ?, ?, '{}', 'new')`,
    params: [
      input.id,
      input.sourceId,
      `ext-${input.id}`,
      input.url === undefined ? `https://example.com/${input.id}` : input.url,
      input.title,
      input.body ?? null,
      NOW,
      NOW,
      contentHash,
    ],
  });
  return contentHash;
}

async function seedEntity(
  executor: DbExecutor,
  input: { readonly id: string; readonly slug: string; readonly name: string },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
          VALUES (?, 'game', ?, ?, '{}', ?, ?)`,
    params: [input.id, input.name, input.slug, NOW, NOW],
  });
}

async function seedAlias(
  executor: DbExecutor,
  input: { readonly entityId: string; readonly alias: string; readonly language?: string },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
          VALUES (?, ?, ?, ?)`,
    params: [
      input.entityId,
      input.alias,
      normalizeEntityMentionText(input.alias),
      input.language ?? null,
    ],
  });
}

async function enqueueAndRun(harness: Harness, sourceItemId: string): Promise<readonly string[]> {
  expect(
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId,
    }),
  ).toMatchObject({ kind: 'created' });
  return runPipeline(harness);
}

async function runPipeline(harness: Harness): Promise<string[]> {
  await harness.engine.dispatchDueJobs();
  const outcomes: string[] = [];
  for (const envelope of harness.envelopes.splice(0)) {
    const action = await harness.engine.consumeMessage(`msg-${outcomes.length}`, envelope);
    outcomes.push(`${action.action}:${action.outcome}`);
  }
  return outcomes;
}

async function readDraftDocument(
  executor: DbExecutor,
  storyId: string,
): Promise<Record<string, unknown> | null> {
  const row = await executor.first<{ document_json: string }>({
    sql: `SELECT document_json FROM drafts WHERE story_id = ? AND version = 1`,
    params: [storyId],
  });
  if (row === null) {
    return null;
  }
  return JSON.parse(row.document_json) as Record<string, unknown>;
}

async function relationRunCount(executor: DbExecutor, task = 'event_relation'): Promise<number> {
  const row = await executor.first<{ total: number }>({
    sql: `SELECT COUNT(*) AS total FROM ai_runs WHERE task = ?`,
    params: [task],
  });
  return row?.total ?? 0;
}

async function processedStatus(executor: DbExecutor, itemId: string): Promise<string | null> {
  const row = await executor.first<{ processing_status: string }>({
    sql: `SELECT processing_status FROM source_items WHERE id = ?`,
    params: [itemId],
  });
  return row?.processing_status ?? null;
}

function eventRelationOf(document: Record<string, unknown>): EventRelationDecisionReport {
  const read = readEventRelationDecision(canonicalizeJson(document));
  expect(read.kind).toBe('event_relation_v1');
  return (read as { kind: 'event_relation_v1'; report: EventRelationDecisionReport }).report;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
});

describe('R1.17 — shared-entity candidate → evaluation → durable decision (REAL D1)', () => {
  it('finds the candidate through a fa/en alias pair, stores the proposal, keeps two stories', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-a', 'Source A');
    await seedEntity(harness.executor, { id: 'ent-hl3', slug: 'half-life-3', name: 'Half-Life 3' });
    await seedAlias(harness.executor, {
      entityId: 'ent-hl3',
      alias: 'Half-Life 3',
      language: 'en',
    });
    await seedAlias(harness.executor, { entityId: 'ent-hl3', alias: 'هف لایف ۳', language: 'fa' });

    // The FIRST item (English coverage) becomes the committed candidate.
    const hashEn = await seedItem(harness.executor, {
      id: 'item-en',
      sourceId: 'src-er-a',
      title: 'Half-Life 3 announcement expected at the showcase',
      body: 'Several outlets expect the long-rumored sequel to appear.',
      url: 'https://example.com/en-announcement',
    });
    await enqueueAndRun(harness, 'item-en');
    const storyAId = await storyIdForSnapshot('item-en', hashEn);
    // The committed story carries its durable entity link.
    const linked = await harness.executor.first<{ story_id: string }>({
      sql: `SELECT story_id FROM story_entities WHERE entity_id = ? AND story_id = ?`,
      params: ['ent-hl3', storyAId],
    });
    expect(linked?.story_id).toBe(storyAId);
    expect(providerRelationCalls(harness)).toBe(0);

    // The SECOND item (Persian text, SAME entity, DIFFERENT words/URL).
    const hashFa = await seedItem(harness.executor, {
      id: 'item-fa',
      sourceId: 'src-er-a',
      title: 'هف لایف ۳ در رویداد پیش رو معرفی می‌شود',
      body: 'شایعات از حضور نسخهٔ جدید در نمایشگاه حکایت دارند.',
      url: 'https://example.com/fa-khabar',
    });
    const outcomes = await enqueueAndRun(harness, 'item-fa');
    expect(outcomes.length).toBe(1);

    const storyBId = await storyIdForSnapshot('item-fa', hashFa);
    const document = await readDraftDocument(harness.executor, storyBId);
    expect(document).not.toBeNull();
    const report = eventRelationOf(document!);
    expect(report.observation).toBe('pairs_evaluated');
    expect(report.lookup.candidatesReported).toBe(1);
    // The candidate came through the SHARED-ENTITY link (not shared URL).
    expect(report.candidates.some((entry) => entry.origins.includes(`entity:ent-hl3`))).toBe(true);
    expect(report.counts.pairsEvaluated).toBe(1);
    expect(report.pairs[0]?.verdict).toBe('same_event_proposed');
    expect(report.pairs[0]?.citationsReported).toBe('both_sides');
    expect(report.pairs[0]?.aiRunIds.length).toBe(1);

    // The REAL relation run exists in D1 with the SAME id as the ledger.
    const ledgerRunId = report.pairs[0]?.aiRunIds[0];
    expect(ledgerRunId).toBeTruthy();
    const runRow = await harness.executor.first<{ id: string; status: string; task: string }>({
      sql: `SELECT id, status, task FROM ai_runs WHERE id = ?`,
      params: [ledgerRunId!],
    });
    expect(runRow?.status).toBe('succeeded');
    expect(runRow?.task).toBe('event_relation');
    expect(report.pairs[0]?.aiRunIds).toContain(runRow?.id);

    // The draft's OWN ai_run reference stays the news_draft run.
    const draftRun = await harness.executor.first<{ task: string }>({
      sql: `SELECT r.task FROM drafts d JOIN ai_runs r ON r.id = d.ai_run_id
             WHERE d.story_id = ? AND d.version = 1`,
      params: [storyBId],
    });
    expect(draftRun?.task).toBe('news_draft');

    // NO merge: two independent stories, both still discovered/unknown.
    const stories = await harness.executor.query<{
      id: string;
      status: string;
      trust_status: string;
    }>({
      sql: `SELECT id, status, trust_status FROM stories ORDER BY id ASC`,
      params: [],
    });
    expect(stories.rows.length).toBe(2);
    for (const story of stories.rows) {
      expect(story.status).toBe('discovered');
      expect(story.trust_status).toBe('unknown');
    }
  });

  it('proposes different_event_proposed and insufficient_evidence per the fixture', async () => {
    const harness = createHarness();
    harness.setRelationScript((script) =>
      script.sideBEvidenceId === 'item-discount'
        ? proposedBothSides('different_event_proposed', script)
        : insufficient(script),
    );
    await seedSource(harness.executor, 'src-er-b', 'Source B');
    await seedEntity(harness.executor, { id: 'ent-er2', slug: 'er-two', name: 'ER Two' });
    await seedAlias(harness.executor, { entityId: 'ent-er2', alias: 'ER Two' });

    await seedItem(harness.executor, {
      id: 'item-discount',
      sourceId: 'src-er-b',
      title: 'ER Two store discount goes live this weekend',
      body: 'The publisher store lists the game 40 percent off.',
    });
    await enqueueAndRun(harness, 'item-discount');

    const hashDate = await seedItem(harness.executor, {
      id: 'item-date',
      sourceId: 'src-er-b',
      title: 'ER Two announces its release date at the showcase',
      body: 'The studio confirmed the launch window today.',
    });
    await enqueueAndRun(harness, 'item-date');

    const storyDateId = await storyIdForSnapshot('item-date', hashDate);
    const document = await readDraftDocument(harness.executor, storyDateId);
    const report = eventRelationOf(document!);
    // The single pair evaluated against the discount-story candidate
    // resolves the fixture deterministically.
    expect(report.counts.pairsEvaluated).toBe(1);
    expect(report.pairs[0]?.verdict).toBe('different_event_proposed');
    expect(report.pairs[0]?.state).toBe('evaluated');
  });

  it('keeps no-candidate news fully independent with ZERO relation calls', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-c', 'Source C');
    // No entity aliases exist at all — the honest no-candidate path.
    const hashPlain = await seedItem(harness.executor, {
      id: 'item-plain',
      sourceId: 'src-er-c',
      title: 'An unrelated story about a different game',
      body: 'Nothing in the catalog mentions this.',
      url: 'https://example.com/unique-plain',
    });
    const runsBefore = await relationRunCount(harness.executor);
    const callsBefore = providerRelationCalls(harness);
    const outcomes = await enqueueAndRun(harness, 'item-plain');
    expect(outcomes.length).toBe(1);
    expect(await relationRunCount(harness.executor)).toBe(runsBefore);
    expect(providerRelationCalls(harness)).toBe(callsBefore);

    // The isolated item's OWN story has ZERO mention links.
    const storyPlainId = await storyIdForSnapshot('item-plain', hashPlain);
    const linked = await harness.executor.first<{ story_id: string }>({
      sql: `SELECT story_id FROM story_entities WHERE story_id = ?`,
      params: [storyPlainId],
    });
    expect(linked).toBeNull();
    const stories = await harness.executor.query<{ status: string }>({
      sql: `SELECT status FROM stories WHERE id = ?`,
      params: [storyPlainId],
    });
    expect(stories.rows.length).toBe(1); // the normal independent draft
  });

  it('types a stale candidate basis as basis_unavailable — never a different-event verdict', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-d', 'Source D');
    await seedEntity(harness.executor, { id: 'ent-er3', slug: 'er-three', name: 'ER Three' });
    await seedAlias(harness.executor, { entityId: 'ent-er3', alias: 'ER Three' });

    await seedItem(harness.executor, {
      id: 'item-first',
      sourceId: 'src-er-d',
      title: 'ER Three first coverage',
      body: 'Original snapshot of the story.',
    });
    await enqueueAndRun(harness, 'item-first');

    // Corrupt the candidate's identity bridge: its ORIGINAL item's stored
    // hash no longer matches the draft's recorded snapshot identity.
    await harness.executor.run({
      sql: `UPDATE source_items SET content_hash = ? WHERE id = 'item-first'`,
      params: ['f'.repeat(64)],
    });

    const hashSecond = await seedItem(harness.executor, {
      id: 'item-second',
      sourceId: 'src-er-d',
      title: 'ER Three follow-up coverage in Persian',
      body: 'متن متفاوت دربارهٔ همان بازی.',
    });
    const callsBeforeStale = providerRelationCalls(harness);
    const runsBeforeStale = await relationRunCount(harness.executor);
    const outcomes = await enqueueAndRun(harness, 'item-second');
    expect(outcomes.length).toBe(1);
    // NO relation provider call happened (the pair never became a bundle).
    expect(providerRelationCalls(harness)).toBe(callsBeforeStale);
    expect(await relationRunCount(harness.executor)).toBe(runsBeforeStale);

    const secondStoryId = await storyIdForSnapshot('item-second', hashSecond);
    const document = await readDraftDocument(harness.executor, secondStoryId);
    const report = eventRelationOf(document!);
    expect(report.observation).toBe('no_evaluable_basis');
    expect(
      report.candidates.some(
        (entry) =>
          entry.basisState === 'basis_unavailable' &&
          entry.basisUnavailableReason === 'stale_reference',
      ),
    ).toBe(true);
    expect(report.counts.pairsAttempted).toBe(0);
  });

  it('enforces the ≤2 pair cap and deterministic ordered selection', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-e', 'Source E');
    await seedEntity(harness.executor, { id: 'ent-er4', slug: 'er-four', name: 'ER Four' });
    await seedAlias(harness.executor, { entityId: 'ent-er4', alias: 'ER Four' });

    // THREE committed candidates sharing the entity.
    for (const index of [1, 2, 3]) {
      await seedItem(harness.executor, {
        id: `item-c${index}`,
        sourceId: 'src-er-e',
        title: `ER Four coverage number ${index}`,
        body: `Variant ${index} of the coverage.`,
      });
      await enqueueAndRun(harness, `item-c${index}`);
    }
    void 0;
    const relationCallsBeforeNew = providerRelationCalls(harness);

    const hashNew2 = await seedItem(harness.executor, {
      id: 'item-new',
      sourceId: 'src-er-e',
      title: 'ER Four fresh report in Persian',
      body: 'گزارش تازه با همان موجودیت.',
    });
    await enqueueAndRun(harness, 'item-new');

    const linked = await harness.executor.query<{ story_id: string }>({
      sql: `SELECT story_id FROM story_entities WHERE entity_id = ? ORDER BY story_id ASC`,
      params: ['ent-er4'],
    });
    // 4 committed stories carry the entity link (3 candidates + this one).
    expect(linked.rows.length).toBe(4);
    const newStoryId = await storyIdForSnapshot('item-new', hashNew2);
    const document = await readDraftDocument(harness.executor, newStoryId);
    const report = eventRelationOf(document!);
    expect(report.lookup.candidatesReported).toBe(3);
    expect(report.candidates.length).toBe(3); // all three observed
    expect(report.counts.pairsAttempted).toBe(2); // the cost cap held
    expect(report.pairs.map((pair) => pair.pairId)).toEqual(['erp-1', 'erp-2']);
    // Deterministic ascending-story selection: the two evaluated pairs'
    // candidate stories are the FIRST two of the observed candidate list.
    const evaluableStories = report.candidates
      .filter((entry) => entry.basisState === 'ok')
      .map((entry) => entry.storyId);
    expect(evaluableStories).toEqual([...evaluableStories].sort());
    expect(report.pairs.map((pair) => pair.sideB.storyId)).toEqual(evaluableStories.slice(0, 2));
    // ≤3 relation provider attempts for the WHOLE step (2 pairs here).
    expect(providerRelationCalls(harness) - relationCallsBeforeNew).toBe(2);
  });

  it('zeroes the WHOLE commit with typed eventRelationBasisChanged on a just-in-time basis mutation', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-f', 'Source F');
    await seedEntity(harness.executor, { id: 'ent-er5', slug: 'er-five', name: 'ER Five' });
    await seedAlias(harness.executor, { entityId: 'ent-er5', alias: 'ER Five' });

    const hashBase = await seedItem(harness.executor, {
      id: 'item-base',
      sourceId: 'src-er-f',
      title: 'ER Five base coverage',
      body: 'The committed candidate snapshot.',
    });
    await enqueueAndRun(harness, 'item-base');

    const hashRace = await seedItem(harness.executor, {
      id: 'item-race',
      sourceId: 'src-er-f',
      title: 'ER Five racing report',
      body: 'گزارش رقیب با همان موجودیت.',
    });
    // Mutate the candidate's ORIGINAL reference row content hash RIGHT
    // BEFORE the batch executes — the SQL basis gate must zero everything.
    harness.onBatchMutation(async () => {
      await rawUpdate(
        harness.executor,
        `UPDATE source_items SET content_hash = ? WHERE id = 'item-base'`,
        ['e'.repeat(64)],
      );
    });
    const outcomes = await enqueueAndRun(harness, 'item-race');
    // The SQL basis gate zeroed the WHOLE first generation (the mutation
    // landed between the basis reads and the commit): typed
    // eventRelationBasisChanged → the bounded engine retry. ZERO editorial
    // effects, zero stale decision, zero orphan runs.
    expect(outcomes).toEqual(['ack:retry_scheduled']);
    expect(await processedStatus(harness.executor, 'item-race')).toBe('new');

    // The bounded engine retry: advance past the backoff; the fresh
    // generation re-decides against the CURRENT (broken) basis.
    harness.clock.advance(10_000);
    await runPipeline(harness);
    expect(await processedStatus(harness.executor, 'item-race')).toBe('processed');

    const raceStoryId = await storyIdForSnapshot('item-race', hashRace);
    void hashBase;
    const document = await readDraftDocument(harness.executor, raceStoryId);
    const report = eventRelationOf(document!);
    // The fresh generation re-decided honestly: the mutated bridge reads
    // as a TYPED basis_unavailable — never a verdict, never different-event.
    expect(report.observation).toBe('no_evaluable_basis');
    expect(
      report.candidates.some(
        (entry) =>
          entry.basisState === 'basis_unavailable' &&
          entry.basisUnavailableReason === 'stale_reference',
      ),
    ).toBe(true);
    expect(report.counts.providerAttempts).toBe(0);
    // The mutated base item's row carries the hook's hash.
    const mutated = await harness.executor.first<{ content_hash: string }>({
      sql: `SELECT content_hash FROM source_items WHERE id = 'item-base'`,
      params: [],
    });
    expect(mutated?.content_hash).toBe('e'.repeat(64));
  });

  it('preserves the C1 catalog gate AND the relation additions on a catalog-only retry', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-g', 'Source G');
    await seedEntity(harness.executor, { id: 'ent-er6', slug: 'er-six', name: 'ER Six' });
    await seedAlias(harness.executor, { entityId: 'ent-er6', alias: 'ER Six' });

    await seedItem(harness.executor, {
      id: 'item-g1',
      sourceId: 'src-er-g',
      title: 'ER Six first coverage',
      body: 'Committed candidate.',
    });
    await enqueueAndRun(harness, 'item-g1');

    const hashG2 = await seedItem(harness.executor, {
      id: 'item-g2',
      sourceId: 'src-er-g',
      title: 'ER Six second coverage with mention',
      body: 'گزارش دوم با همان موجودیت.',
    });
    // Remap the alias to a SECOND entity inside the lookup→commit window:
    // the R1.16.1 whole-result catalog gate must zero the batch and the
    // bounded re-resolve must re-commit the SAME provider draft.
    await harness.runAfterAliasLookup(async () => {
      await rawUpdate(
        harness.executor,
        `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
         VALUES ('ent-er6-b', 'game', 'ER Six B', 'er-six-b', '{}', ?, ?)`,
        [NOW, NOW],
      );
      await rawUpdate(
        harness.executor,
        `UPDATE entity_aliases SET entity_id = 'ent-er6-b' WHERE normalized_alias = ?`,
        [normalizeEntityMentionText('ER Six')],
      );
    });
    const outcomes = await enqueueAndRun(harness, 'item-g2');
    expect(outcomes.length).toBe(1);

    // The relation evaluations from the FIRST generation stay exactly the
    // honest, deterministic run rows — the re-commit inserts no duplicates.
    const runsBefore = await relationRunCount(harness.executor);
    const storyG2 = await storyIdForSnapshot('item-g2', hashG2);
    const document = await readDraftDocument(harness.executor, storyG2!);
    const report = eventRelationOf(document!);
    // The ledger's run ids all exist in ai_runs (report ≡ durable runs).
    for (const pair of report.pairs) {
      for (const runId of pair.aiRunIds) {
        const run = await harness.executor.first<{ id: string }>({
          sql: `SELECT id FROM ai_runs WHERE id = ?`,
          params: [runId],
        });
        expect(run?.id).toBe(runId);
      }
    }
    const runsAfter = await relationRunCount(harness.executor);
    expect(runsAfter).toBe(runsBefore);
    // Report↔link coherence (C1): the committed mentions report counts
    // exactly the durable story_entities rows of the story.
    const mentionReport = (document as { entityMentions?: { counts: { entitiesLinked: number } } })
      .entityMentions;
    const linkRows = await harness.executor.first<{ total: number }>({
      sql: `SELECT COUNT(*) AS total FROM story_entities WHERE story_id = ?`,
      params: [storyG2!],
    });
    expect(mentionReport?.counts.entitiesLinked).toBe(linkRows?.total);
  });

  it('replays a committed snapshot with ZERO extra provider calls and byte-identical documents', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-h', 'Source H');
    await seedEntity(harness.executor, { id: 'ent-er7', slug: 'er-seven', name: 'ER Seven' });
    await seedAlias(harness.executor, { entityId: 'ent-er7', alias: 'ER Seven' });

    const hashH1 = await seedItem(harness.executor, {
      id: 'item-h1',
      sourceId: 'src-er-h',
      title: 'ER Seven coverage for replay',
      body: 'The replayed snapshot.',
    });
    await enqueueAndRun(harness, 'item-h1');
    const draftCallsAfterFirst = harness.providerCalls.draft;
    const relationCallsAfterFirst = providerRelationCalls(harness);
    expect(draftCallsAfterFirst).toBe(1);

    const storyH1 = await storyIdForSnapshot('item-h1', hashH1);
    const before = await readDraftDocument(harness.executor, storyH1);

    // The at-least-once replay: the SAME durable job re-dispatches (its
    // terminal bookkeeping is lost), the handler re-executes, and the
    // stable-result fast-path answers with ZERO provider involvement and
    // ZERO writes.
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-h1',
      }),
    ).toMatchObject({ kind: 'existing' });
    await harness.executor.run({
      sql: "UPDATE jobs SET status = 'pending', run_after = ?, lease_until = NULL\n               WHERE aggregate_id = ? AND status = 'succeeded'",
      params: [harness.clock.now(), 'item-h1'],
    });
    harness.clock.advance(1);
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    expect(harness.providerCalls.draft).toBe(draftCallsAfterFirst);
    expect(providerRelationCalls(harness)).toBe(relationCallsAfterFirst);
    const after = await readDraftDocument(harness.executor, storyH1);
    expect(canonicalizeJson(after)).toEqual(canonicalizeJson(before));
  });

  it('keeps the flag OFF byte-honest: zero relation SQL, zero calls, disabled ledger', async () => {
    const harness = createHarness({ relationEnabled: false });
    await seedSource(harness.executor, 'src-er-i', 'Source I');
    await seedEntity(harness.executor, { id: 'ent-er8', slug: 'er-eight', name: 'ER Eight' });
    await seedAlias(harness.executor, { entityId: 'ent-er8', alias: 'ER Eight' });

    const hashI1 = await seedItem(harness.executor, {
      id: 'item-i1',
      sourceId: 'src-er-i',
      title: 'ER Eight coverage with the feature off',
      body: 'The accepted normal path stays intact.',
    });
    const runsBefore = await relationRunCount(harness.executor);
    const callsBefore = providerRelationCalls(harness);
    const outcomes = await enqueueAndRun(harness, 'item-i1');
    expect(outcomes.length).toBe(1);
    expect(await relationRunCount(harness.executor)).toBe(runsBefore);
    expect(providerRelationCalls(harness)).toBe(callsBefore);

    const storyI1 = await storyIdForSnapshot('item-i1', hashI1);
    const linked = await harness.executor.first<{ story_id: string }>({
      sql: `SELECT story_id FROM story_entities WHERE entity_id = ? AND story_id = ?`,
      params: ['ent-er8', storyI1],
    });
    expect(linked?.story_id).toBe(storyI1);
    const document = await readDraftDocument(harness.executor, storyI1);
    const report = eventRelationOf(document!);
    expect(report.observation).toBe('disabled');
    expect(report.counts).toEqual({
      candidatesEvaluable: 0,
      pairsAttempted: 0,
      pairsEvaluated: 0,
      providerAttempts: 0,
    });
  });

  it('keeps runs honest and the ledger coherent across a mid-commit failure', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-er-j', 'Source J');
    await seedEntity(harness.executor, { id: 'ent-er9', slug: 'er-nine', name: 'ER Nine' });
    await seedAlias(harness.executor, { entityId: 'ent-er9', alias: 'ER Nine' });

    const hashJ1 = await seedItem(harness.executor, {
      id: 'item-j1',
      sourceId: 'src-er-j',
      title: 'ER Nine base coverage',
      body: 'Committed candidate.',
    });
    await enqueueAndRun(harness, 'item-j1');

    // Fail ONLY the first commit batch (after the provider ran for both
    // tasks) — the documented at-least-once honesty: the atomic batch left
    // ZERO state; the bounded engine retry owns the next generation.
    let failedOnce = false;
    harness.failBatchesMatching((statements) => {
      if (
        !failedOnce &&
        statements.some((statement) => statement.sql.includes('INSERT INTO story_fingerprints'))
      ) {
        failedOnce = true;
        return true;
      }
      return false;
    });
    const hashJ2 = await seedItem(harness.executor, {
      id: 'item-j2',
      sourceId: 'src-er-j',
      title: 'ER Nine racing report with the same entity',
      body: 'گزارش دوم.',
    });
    expect(await enqueueAndRun(harness, 'item-j2')).toEqual(['ack:retry_scheduled']);
    expect(providerRelationCalls(harness)).toBeGreaterThanOrEqual(1);
    expect(await processedStatus(harness.executor, 'item-j2')).toBe('new');

    harness.clock.advance(10_000);
    await runPipeline(harness);
    expect(await processedStatus(harness.executor, 'item-j2')).toBe('processed');

    // The successful generation's ledger references REAL durable runs only.
    void hashJ1;
    const storyJ2 = await storyIdForSnapshot('item-j2', hashJ2);
    const document = await readDraftDocument(harness.executor, storyJ2);
    const report = eventRelationOf(document!);
    for (const pair of report.pairs) {
      for (const runId of pair.aiRunIds) {
        const run = await harness.executor.first<{ id: string }>({
          sql: `SELECT id FROM ai_runs WHERE id = ?`,
          params: [runId],
        });
        expect(run?.id).toBe(runId);
      }
    }
  });
});

/** Relation provider calls observed through the harness port. */
function providerRelationCalls(harness: Harness): number {
  return harness.providerCalls.relation;
}

async function rawUpdate(
  executor: DbExecutor,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  await executor.run({ sql, params });
}
