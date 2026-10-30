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
import type { DeadlineTimeoutScheduler } from '../../src/shared/time/deadline-wait';
import { normalizeEntityMentionText } from '../../src/domain/editorial/entity-mentions';
import {
  readEventRelationDecision,
  type EventRelationDecisionReport,
} from '../../src/domain/editorial/event-relation-decision';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { storyIdForSnapshot } from '../../src/domain/editorial/identity';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import type { WorkerEnv } from '../../src/shared/types/env';

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
 *
 * R1.17.1 (G1/A1/D1): the harness mirrors the CORRECTED production wiring
 * (the global AI gate rides BOTH the draft service and the relation
 * service configs AND the handler's relation step), and adds the bounded
 * delay/manual-deadline extensions the correction regressions need
 * (setBasisReadDelay / setEntityProbeDelay / firePendingDeadlines /
 * hangBudgetAuthorization / hangProviderCalls). ZERO real sleeps, ZERO
 * network.
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
  setBasisReadDelay: (ms: number) => void;
  setEntityProbeDelay: (ms: number) => void;
  firePendingDeadlines: () => number;
  pendingDeadlineCount: () => number;
  hangBudgetAuthorization: () => void;
  hangProviderCalls: () => void;
  hangBasisReads: () => void;
  hangEntityProbes: () => void;
  disarmHungReads: () => void;
  releaseHungReads: (error?: unknown) => void;
  throwOnRelationAttempt: () => void;
  rejectPendingProviderCalls: (error: unknown) => void;
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

function createHarness(input?: {
  readonly relationEnabled?: boolean;
  readonly aiEnabled?: boolean;
  readonly manualDeadlineScheduler?: boolean;
}): Harness {
  const relationEnabled = input?.relationEnabled ?? true;
  // R1.17.1: the harness mirrors the corrected production wiring —
  // the GLOBAL AI gate reaches the draft service, the relation service,
  // AND the handler's relation step.
  const aiEnabled = input?.aiEnabled ?? true;
  // Each harness gets its OWN Tehran budget day: the shared disposable D1
  // accumulates REAL charges across this file's tests, and the shared
  // workers-ai daily cap (40) must never deny a later test's honest
  // fixtures — a test's charge isolation comes from its own day bucket,
  // never from a raised cap and never from another test's leftovers.
  const harnessDayOffsetMs = (harnessJobIdCounter += 1) * 86_400_000;
  const clock = fixedClock(NOW + harnessDayOffsetMs);
  // R1.17.2 (A2) harness extension: the logger wrapper can inject an
  // infrastructure failure in the relation task's OWN result path (the
  // attempt-record observability call) — the same fault class as
  // failBatchesMatching, ONE-SHOT, armed by the A2 regression only.
  const baseLogger = createLogger({ level: 'error', clock });
  let throwOnRelationAttemptArmed = false;
  const logger = {
    debug: (message: string, fields?: Record<string, unknown>) => baseLogger.debug(message, fields),
    info: (message: string, fields?: Record<string, unknown>) => {
      if (throwOnRelationAttemptArmed && message === 'ai.event_relation.attempt') {
        throwOnRelationAttemptArmed = false;
        throw new Error('injected_relation_attempt_log_failure');
      }
      baseLogger.info(message, fields);
    },
    warn: (message: string, fields?: Record<string, unknown>) => baseLogger.warn(message, fields),
    error: (message: string, fields?: Record<string, unknown>) => baseLogger.error(message, fields),
    child: (fields: Record<string, unknown>) => baseLogger.child(fields),
  };
  const rawExecutor = createDbExecutor(env.DB, { clock });

  let basisReadDelay = 0;
  let entityProbeDelay = 0;
  let hangBudgetAuth = false;
  let hangProvider = false;
  let hangBasisReadsArmed = false;
  let hangEntityProbesArmed = false;
  const pendingHungReadRejects: ((error: unknown) => void)[] = [];
  const pendingProviderRejects: ((error: unknown) => void)[] = [];
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
      // R1.17.2 (D2): a PENDING entity-probe read — the query never
      // settles on its own; only the caller-side bounded race can free
      // the step. Late release is available to prove absorption.
      if (hangEntityProbesArmed && statement.sql.includes('FROM story_entities')) {
        return new Promise<never>((_resolve, reject) => {
          pendingHungReadRejects.push(reject);
        });
      }
      const result = await rawExecutor.query<T>(statement);
      if (
        statement.sql.includes('FROM entity_aliases') &&
        statement.sql.includes(' IN (') &&
        afterAliasHook.fn !== undefined
      ) {
        await afterAliasHook.fn?.();
        afterAliasHook.fn = null;
      }
      // R1.17.1 (D1): a slow ENTITY PROBE read — the clock advances when
      // the first probe result returns (the read itself is instant; the
      // FAKE clock models the elapsed step time).
      if (entityProbeDelay > 0 && statement.sql.includes('FROM story_entities')) {
        clock.advance(entityProbeDelay);
        entityProbeDelay = 0;
      }
      return result;
    },
    first: async <T>(statement: Parameters<DbExecutor['first']>[0]) => {
      // R1.17.2 (D2): a PENDING basis read — the read never settles; the
      // step deadline must free the CALLER (the bounded race), and a late
      // rejection must be absorbed — never an unhandled rejection.
      if (hangBasisReadsArmed && statement.sql.includes('FROM drafts WHERE story_id')) {
        return new Promise<never>((_resolve, reject) => {
          pendingHungReadRejects.push(reject);
        });
      }
      const result = await rawExecutor.first<T>(statement);
      // R1.17.1 (D1): a slow BASIS read — the clock advances when the
      // first real candidate-draft read returns (no DB change, no output
      // change — only elapsed step time).
      if (basisReadDelay > 0 && statement.sql.includes('FROM drafts WHERE story_id')) {
        clock.advance(basisReadDelay);
        basisReadDelay = 0;
      }
      return result;
    },
    run: async (statement: Parameters<DbExecutor['run']>[0]) => {
      // R1.17.1 (D1): a PENDING budget write through the run path (the
      // authorize batch is covered in the batch hook above) — ONE-SHOT.
      if (hangBudgetAuth && statement.sql.includes('INTO budgets')) {
        hangBudgetAuth = false;
        return new Promise<never>(() => undefined); // never settles
      }
      return rawExecutor.run(statement);
    },
    batch: async (statements) => {
      // R1.17.1 (D1): a PENDING budget authorization — ONE-SHOT (the
      // relation task's authorization is the FIRST 'ai' budget write of
      // the step; the later drafting authorization proceeds normally).
      // The durable charge never completes; the manual deadline frees the
      // caller (the bounded race — never a claimed real cancellation).
      if (
        hangBudgetAuth &&
        statements.some((statement) => statement.sql.includes('INTO budgets'))
      ) {
        hangBudgetAuth = false;
        return new Promise<never>(() => undefined); // never settles
      }
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
        // R1.17.1 (D1): a NONCOOPERATIVE provider — the call never
        // settles on its own; the manual deadline frees the caller and a
        // LATE rejection (if armed) is absorbed by the deadline primitive.
        if (hangProvider) {
          return new Promise<never>((_resolve, reject) => {
            pendingProviderRejects.push(reject);
          });
        }
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

  // R1.17.1 (D1): the injected manual deadline scheduler — deterministic
  // deadline firing (the test calls firePendingDeadlines()); NO real
  // sleeps anywhere.
  const pendingDeadlineCallbacks: (() => void)[] = [];
  const manualDeadlineScheduler: DeadlineTimeoutScheduler = (callback) => {
    pendingDeadlineCallbacks.push(callback);
    return () => {
      const index = pendingDeadlineCallbacks.indexOf(callback);
      if (index >= 0) pendingDeadlineCallbacks.splice(index, 1);
    };
  };
  const useManualScheduler = input?.manualDeadlineScheduler === true;

  const aiService = createAiDraftService({
    executor,
    ports: { 'workers-ai': port },
    clock,
    logger,
    config: {
      aiEnabled,
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
    ...(useManualScheduler ? { deadlineScheduler: manualDeadlineScheduler } : {}),
    config: {
      eventRelationEnabled: relationEnabled,
      aiEnabled,
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
          ...(useManualScheduler ? { deadlineScheduler: manualDeadlineScheduler } : {}),
          eventRelation: {
            // R1.17.1 (G1): the effective gate — global AND feature flag.
            enabled: relationEnabled && aiEnabled,
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
    setBasisReadDelay: (ms) => {
      basisReadDelay = ms;
    },
    setEntityProbeDelay: (ms) => {
      entityProbeDelay = ms;
    },
    firePendingDeadlines: () => {
      const callbacks = [...pendingDeadlineCallbacks];
      pendingDeadlineCallbacks.length = 0;
      for (const callback of callbacks) callback();
      return callbacks.length;
    },
    pendingDeadlineCount: () => pendingDeadlineCallbacks.length,
    hangBudgetAuthorization: () => {
      hangBudgetAuth = true;
    },
    hangProviderCalls: () => {
      hangProvider = true;
    },
    hangBasisReads: () => {
      hangBasisReadsArmed = true;
    },
    hangEntityProbes: () => {
      hangEntityProbesArmed = true;
    },
    disarmHungReads: () => {
      hangBasisReadsArmed = false;
      hangEntityProbesArmed = false;
    },
    releaseHungReads: (error?: unknown) => {
      const rejects = [...pendingHungReadRejects];
      pendingHungReadRejects.length = 0;
      for (const reject of rejects) reject(error ?? new Error('late_read_settlement'));
    },
    throwOnRelationAttempt: () => {
      throwOnRelationAttemptArmed = true;
    },
    rejectPendingProviderCalls: (error) => {
      const rejects = [...pendingProviderRejects];
      pendingProviderRejects.length = 0;
      for (const reject of rejects) reject(error);
    },
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

  it('R1.17.1 A1: a first-commit throw durably records EVERY real relation invocation BEFORE the retry (multi-pair, no collision, no misattribution)', async () => {
    // TWO committed candidates sharing the entity ⇒ the failing item gets
    // the FULL multi-pair bundle (erp-1 + erp-2) — one REAL row per
    // invocation, ladder included.
    const harness = createHarness();
    await seedSource(harness.executor, 'src-a1', 'Source A1');
    await seedEntity(harness.executor, { id: 'ent-a1', slug: 'a1-entity', name: 'A1 Entity' });
    await seedAlias(harness.executor, { entityId: 'ent-a1', alias: 'A1 Entity' });
    for (const index of [1, 2]) {
      await seedItem(harness.executor, {
        id: `item-a1-c${index}`,
        sourceId: 'src-a1',
        title: `A1 Entity candidate coverage ${index}`,
        body: `Candidate body ${index} about A1 Entity.`,
      });
      expect(await enqueueAndRun(harness, `item-a1-c${index}`)).toEqual(['ack:job_completed']);
    }

    // Fail ONLY the first commit batch of the NEXT item — after BOTH
    // providers ran (drafting AND the 2-pair relation adjudication).
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
    const hashFail = await seedItem(harness.executor, {
      id: 'item-a1-fail',
      sourceId: 'src-a1',
      title: 'A1 Entity racing report in Persian',
      body: 'گزارش رقیب A1 Entity با متن کاملاً متفاوت.',
    });
    const runsBeforeGen1 = await relationRunCount(harness.executor);
    const budgetsBeforeGen1 = await budgetAiRequests(harness.executor);
    const relationCallsBeforeGen1 = providerRelationCalls(harness);
    const runIdsBeforeGen1 = new Set(
      (
        await harness.executor.query<{ id: string }>({
          sql: `SELECT id FROM ai_runs WHERE task = 'event_relation'`,
          params: [],
        })
      ).rows.map((row) => row.id),
    );
    expect(await enqueueAndRun(harness, 'item-a1-fail')).toEqual(['ack:retry_scheduled']);
    expect(await processedStatus(harness.executor, 'item-a1-fail')).toBe('new');

    // BEFORE the retry: this generation's REAL invocations are compared —
    // provider attempts == charged attempts == durable rows. The atomic
    // batch left zero editorial state, but the audit no longer loses the
    // relation invocations (the pre-R1.17.1 handler lost them entirely:
    // providerCalls=1 with durable delta=0).
    const providerAttemptsGen1 = providerRelationCalls(harness) - relationCallsBeforeGen1;
    expect(providerAttemptsGen1).toBe(2);
    const budgetsAfterGen1 = await budgetAiRequests(harness.executor);
    expect((budgetsAfterGen1 ?? 0) - (budgetsBeforeGen1 ?? 0)).toBe(3); // 1 draft + 2 relation — charged, never refunded
    const runRowsGen1 = (await relationRunCount(harness.executor)) - runsBeforeGen1;
    expect(runRowsGen1).toBe(2); // one REAL row per invocation
    const gen1RunIds = (
      await harness.executor.query<{ id: string }>({
        sql: `SELECT id FROM ai_runs WHERE task = 'event_relation' ORDER BY id ASC`,
        params: [],
      })
    ).rows
      .map((row) => row.id)
      .filter((runId) => !runIdsBeforeGen1.has(runId));
    expect(gen1RunIds.length).toBe(runRowsGen1);
    for (const runId of gen1RunIds) {
      expect(runId).toMatch(/^edai_[0-9a-f]{32}$/);
      const run = await harness.executor.first<{ status: string; task: string }>({
        sql: `SELECT status, task FROM ai_runs WHERE id = ?`,
        params: [runId],
      });
      // The provider DID succeed — the run is honestly 'succeeded' and
      // referenced by NO draft (a used-by-nobody run is never presented
      // as consumed by the next generation's draft).
      expect(run?.status).toBe('succeeded');
      expect(run?.task).toBe('event_relation');
    }

    // The bounded engine retry owns the NEXT generation: its own provider
    // invocations happen again (the lost generation's runs are NOT its
    // substitute — no fabricated free lunch) and get their OWN rows.
    harness.clock.advance(10_000);
    await runPipeline(harness);
    expect(await processedStatus(harness.executor, 'item-a1-fail')).toBe('processed');
    expect(providerRelationCalls(harness)).toBe(relationCallsBeforeGen1 + providerAttemptsGen1 + 2);
    expect(await relationRunCount(harness.executor)).toBe(runsBeforeGen1 + 4);

    // The winning generation's ledger references ONLY its own durable
    // runs — no collision with generation 1's deterministic ids, no
    // misattribution of the orphaned-but-real generation-1 rows.
    const storyFail = await storyIdForSnapshot('item-a1-fail', hashFail);
    const document = await readDraftDocument(harness.executor, storyFail);
    const report = eventRelationOf(document!);
    const winningRunIds: string[] = [];
    for (const pair of report.pairs) {
      for (const runId of pair.aiRunIds) {
        winningRunIds.push(runId);
        expect(gen1RunIds).not.toContain(runId);
        const run = await harness.executor.first<{ id: string }>({
          sql: `SELECT id FROM ai_runs WHERE id = ?`,
          params: [runId],
        });
        expect(run?.id).toBe(runId);
      }
    }
    expect(winningRunIds.length).toBe(2);
    // Generation 1's rows still exist — never replaced, never deleted.
    for (const runId of gen1RunIds) {
      const run = await harness.executor.first<{ id: string }>({
        sql: `SELECT id FROM ai_runs WHERE id = ?`,
        params: [runId],
      });
      expect(run?.id).toBe(runId);
    }
  });
});

// ---------------------------------------------------------------------------
// R1.17.1 (G1) — the global AI kill switch gates the relation task.
// ---------------------------------------------------------------------------

describe('R1.17.1 G1 — the global AI kill switch gates the relation task', () => {
  beforeEach(async () => {
    // The wiring engines run on the SYSTEM clock while the harness engines
    // run on the suite's FAKE clock — stale pending/retry jobs from other
    // tests would be re-dispatched here (cross-clock contamination). The
    // wiring probes own their seeded rows; stale non-terminal jobs are
    // removed before each wiring case (never touching terminal history).
    await createDbExecutor(env.DB).run({
      sql: "DELETE FROM jobs WHERE status IN ('pending', 'queued', 'retry_wait')",
      params: [],
    });
  });

  it('global AI OFF × relation ON ⇒ ZERO relation provider calls, ZERO budget writes, ZERO runs (harness wiring)', async () => {
    // The committed base candidate (its harness had the global gate ON).
    const base = createHarness();
    await seedSource(base.executor, 'src-g1', 'Source G1');
    await seedEntity(base.executor, { id: 'ent-g1', slug: 'g1-entity', name: 'G1 Entity' });
    await seedAlias(base.executor, { entityId: 'ent-g1', alias: 'G1 Entity' });
    await seedItem(base.executor, {
      id: 'item-g1-base',
      sourceId: 'src-g1',
      title: 'G1 base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(await enqueueAndRun(base, 'item-g1-base')).toEqual(['ack:job_completed']);

    // A SECOND harness over the SAME D1 with the GLOBAL AI gate OFF while
    // the relation feature flag stays ON. The pre-R1.17.1 wiring let the
    // relation task bypass the global kill switch (provider call + budget
    // authorization + usage write); the corrected effective gate — global
    // AND feature flag, both fail-closed — must prevent ALL of it.
    const gated = createHarness({ aiEnabled: false });
    const budgetsBefore = await budgetAiRequests(gated.executor);
    const runsBefore = await relationRunCount(gated.executor);
    await seedItem(gated.executor, {
      id: 'item-g1-off',
      sourceId: 'src-g1',
      title: 'G1 second coverage in Persian',
      body: 'خبر دوم با متن متفاوت.',
    });
    // The draft service also refuses (same global gate) ⇒ the bounded
    // typed retry — no fake success, no processed flip.
    expect(await enqueueAndRun(gated, 'item-g1-off')).toEqual(['ack:retry_scheduled']);
    expect(gated.providerCalls.relation).toBe(0);
    expect(gated.providerCalls.draft).toBe(0);
    expect(await budgetAiRequests(gated.executor)).toBe(budgetsBefore);
    expect(await relationRunCount(gated.executor)).toBe(runsBefore);
    expect(await processedStatus(gated.executor, 'item-g1-off')).toBe('new');
  });

  it('global AI OFF × relation ON ⇒ the production wiring itself never reaches the provider or the budget (real engine-env resolution, native-binding stub)', async () => {
    // The base candidate through the REAL resolved wiring (global ON).
    const stubOn = createWiringStub();
    const baseResolution = resolveWiring({ ai: 'true', relation: 'true', stub: stubOn });
    expect(baseResolution.kind).toBe('ready');
    await seedSource(createDbExecutor(env.DB), 'src-g1w', 'Source G1W');
    await seedEntity(createDbExecutor(env.DB), {
      id: 'ent-g1w',
      slug: 'g1w-entity',
      name: 'G1W Entity',
    });
    await seedAlias(createDbExecutor(env.DB), { entityId: 'ent-g1w', alias: 'G1W Entity' });
    await seedItem(createDbExecutor(env.DB), {
      id: 'item-g1w-base',
      sourceId: 'src-g1w',
      title: 'G1W base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(
      await enqueueAndRunResolved(baseResolution.engine, baseResolution.envelopes, 'item-g1w-base'),
    ).toEqual(['ack:job_completed']);
    expect(stubOn.calls).toBe(1); // the base news_draft call — nothing else

    // The SAME environment resolved with the GLOBAL gate OFF while the
    // relation flag stays ON: the production wiring passes the global
    // gate into BOTH services AND the handler's relation step — the item
    // with the SAME shared entity produces ZERO provider touches and
    // ZERO budget writes.
    const stubOff = createWiringStub();
    const gatedResolution = resolveWiring({ ai: 'false', relation: 'true', stub: stubOff });
    expect(gatedResolution.kind).toBe('ready');
    const budgetsBefore = await budgetAiRequests(createDbExecutor(env.DB));
    await seedItem(createDbExecutor(env.DB), {
      id: 'item-g1w-off',
      sourceId: 'src-g1w',
      title: 'G1W second coverage in Persian',
      body: 'خبر دوم با متن متفاوت.',
    });
    expect(
      await enqueueAndRunResolved(
        gatedResolution.engine,
        gatedResolution.envelopes,
        'item-g1w-off',
      ),
    ).toEqual(['ack:retry_scheduled']);
    expect(stubOff.calls).toBe(0);
    expect(await budgetAiRequests(createDbExecutor(env.DB))).toBe(budgetsBefore);
    expect(await processedStatus(createDbExecutor(env.DB), 'item-g1w-off')).toBe('new');
  });

  it('global ON × relation OFF ⇒ the production wiring commits with the honest disabled ledger and zero relation calls', async () => {
    const stub = createWiringStub();
    const resolution = resolveWiring({ ai: 'true', relation: 'false', stub });
    expect(resolution.kind).toBe('ready');
    await seedSource(createDbExecutor(env.DB), 'src-g1x', 'Source G1X');
    await seedEntity(createDbExecutor(env.DB), {
      id: 'ent-g1x',
      slug: 'g1x-entity',
      name: 'G1X Entity',
    });
    await seedAlias(createDbExecutor(env.DB), { entityId: 'ent-g1x', alias: 'G1X Entity' });
    await seedItem(createDbExecutor(env.DB), {
      id: 'item-g1x-base',
      sourceId: 'src-g1x',
      title: 'G1X base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(
      await enqueueAndRunResolved(resolution.engine, resolution.envelopes, 'item-g1x-base'),
    ).toEqual(['ack:job_completed']);

    const relationCallsBefore = stub.relationCalls;
    await seedItem(createDbExecutor(env.DB), {
      id: 'item-g1x-second',
      sourceId: 'src-g1x',
      title: 'G1X second coverage in Persian',
      body: 'خبر دوم با متن متفاوت.',
    });
    expect(
      await enqueueAndRunResolved(resolution.engine, resolution.envelopes, 'item-g1x-second'),
    ).toEqual(['ack:job_completed']);
    expect(stub.relationCalls).toBe(relationCallsBefore);
    const hashSecond = await sha256Hex(
      'item-g1x-second\u001fG1X second coverage in Persian\u001fخبر دوم با متن متفاوت.',
    );
    const storySecond = await storyIdForSnapshot('item-g1x-second', hashSecond);
    const document = await readDraftDocument(createDbExecutor(env.DB), storySecond);
    expect(document).not.toBeNull();
    expect(eventRelationOf(document!)).toMatchObject({ observation: 'disabled' });
  });

  it('relation ON with the binding ABSENT ⇒ typed no_free_path deferral, zero calls, zero charges (production wiring)', async () => {
    const stub = createWiringStub();
    const resolution = resolveWiring({ ai: 'true', relation: 'true', stub, withBinding: false });
    expect(resolution.kind).toBe('ready');
    await seedSource(createDbExecutor(env.DB), 'src-g1y', 'Source G1Y');
    await seedEntity(createDbExecutor(env.DB), {
      id: 'ent-g1y',
      slug: 'g1y-entity',
      name: 'G1Y Entity',
    });
    await seedAlias(createDbExecutor(env.DB), { entityId: 'ent-g1y', alias: 'G1Y Entity' });
    await seedItem(createDbExecutor(env.DB), {
      id: 'item-g1y-base',
      sourceId: 'src-g1y',
      title: 'G1Y base coverage',
      body: 'The committed candidate snapshot.',
    });
    // The base cannot commit without the binding (typed retry, zero calls,
    // zero budget rows for THIS item — delta-checked, the bucket may carry
    // earlier tests' rows in the shared disposable D1).
    const budgetsBeforeNoBinding = await budgetAiRequests(createDbExecutor(env.DB));
    expect(
      await enqueueAndRunResolved(resolution.engine, resolution.envelopes, 'item-g1y-base'),
    ).toEqual(['ack:retry_scheduled']);
    expect(stub.calls).toBe(0);
    expect(await budgetAiRequests(createDbExecutor(env.DB))).toBe(budgetsBeforeNoBinding);
  });

  it('present-but-invalid flag values fail closed BEFORE the engine is built (config_invalid)', () => {
    const stub = createWiringStub();
    const invalidRelation = resolveWiringRaw({
      ai: 'true',
      relation: 'maybe',
      stub,
    });
    expect(invalidRelation.kind).toBe('config_invalid');
    expect(invalidRelation.issues.join('\n')).toContain('EVENT_RELATION_ENABLED');
    const invalidGlobal = resolveWiringRaw({ ai: 'maybe', relation: 'true', stub });
    expect(invalidGlobal.kind).toBe('config_invalid');
    expect(invalidGlobal.issues.join('\n')).toContain('AI_ENABLED');
  });
});

// ---------------------------------------------------------------------------
// R1.17.1 (D1) — the step deadline covers retrieval, basis packaging,
// budget authorization, the provider call and usage: the ABSOLUTE deadline
// is set at the FIRST relation work and can only be SHORTENED by the
// service. Expiry is a TYPED technical state — never a semantic verdict —
// and NO new provider work starts after it. Deterministic: fake-clock
// delays and an injected manual deadline scheduler — ZERO real sleeps.
// ---------------------------------------------------------------------------

describe('R1.17.1 D1 — the step deadline covers retrieval, basis, budget and provider', () => {
  beforeEach(async () => {
    await createDbExecutor(env.DB).run({
      sql: "DELETE FROM jobs WHERE status IN ('pending', 'queued', 'retry_wait')",
      params: [],
    });
  });

  it('a slow ENTITY probe consumes the step budget; no provider window opens; the unread candidate stays typed', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-d1p', 'Source D1P');
    await seedEntity(harness.executor, { id: 'ent-d1p', slug: 'd1p-entity', name: 'D1P Entity' });
    await seedAlias(harness.executor, { entityId: 'ent-d1p', alias: 'D1P Entity' });
    await seedItem(harness.executor, {
      id: 'item-d1p-base',
      sourceId: 'src-d1p',
      title: 'D1P Entity base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(await enqueueAndRun(harness, 'item-d1p-base')).toEqual(['ack:job_completed']);

    const relationCallsBefore = providerRelationCalls(harness);
    harness.setEntityProbeDelay(20_000);
    const start = harness.clock.now();
    const hashSecond = await seedItem(harness.executor, {
      id: 'item-d1p-second',
      sourceId: 'src-d1p',
      title: 'D1P Entity second coverage in Persian',
      body: 'متن متفاوت دربارهٔ D1P Entity.',
    });
    const outcomes = await enqueueAndRun(harness, 'item-d1p-second');
    // The 20 s probe delay counts against the 15 s step deadline...
    expect(harness.clock.now() - start).toBeGreaterThan(15_000);
    // ...and NO provider window opens afterwards.
    expect(providerRelationCalls(harness)).toBe(relationCallsBefore);
    // The draft path is unaffected — the item still commits.
    expect(outcomes).toEqual(['ack:job_completed']);

    const storySecond = await storyIdForSnapshot('item-d1p-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    // The candidate was OBSERVED (the probe completed) but its basis was
    // never read: the typed technical state — never a semantic verdict,
    // never a fabricated basis claim.
    expect(report.observation).toBe('no_evaluable_basis');
    expect(report.candidates[0]).toMatchObject({
      basisState: 'basis_unavailable',
      basisUnavailableReason: 'step_deadline_expired',
    });
    expect(report.counts.pairsAttempted).toBe(0);
    expect(report.counts.providerAttempts).toBe(0);
  });

  it('a slow FIRST basis read consumes the step budget; the bundled pair is typed skipped_deadline with ZERO provider calls', async () => {
    const harness = createHarness();
    await seedSource(harness.executor, 'src-d1b', 'Source D1B');
    await seedEntity(harness.executor, { id: 'ent-d1b', slug: 'd1b-entity', name: 'D1B Entity' });
    await seedAlias(harness.executor, { entityId: 'ent-d1b', alias: 'D1B Entity' });
    await seedItem(harness.executor, {
      id: 'item-d1b-base',
      sourceId: 'src-d1b',
      title: 'D1B Entity base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(await enqueueAndRun(harness, 'item-d1b-base')).toEqual(['ack:job_completed']);

    const relationCallsBefore = providerRelationCalls(harness);
    harness.setBasisReadDelay(20_000);
    const start = harness.clock.now();
    const hashSecond = await seedItem(harness.executor, {
      id: 'item-d1b-second',
      sourceId: 'src-d1b',
      title: 'D1B Entity second coverage in Persian',
      body: 'متن متفاوت دربارهٔ D1B Entity.',
    });
    const outcomes = await enqueueAndRun(harness, 'item-d1b-second');
    expect(harness.clock.now() - start).toBeGreaterThan(15_000);
    expect(providerRelationCalls(harness)).toBe(relationCallsBefore);
    expect(outcomes).toEqual(['ack:job_completed']);

    const storySecond = await storyIdForSnapshot('item-d1b-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    // R1.17.2 (D2) signature adaptation (assertion meaning unchanged): the
    // slow basis read consumed the WHOLE step budget, so the candidate's
    // REFERENCE read — new work after expiry — now correctly refuses to
    // start (the bounded race returns already-expired). The candidate is
    // the TYPED technical state and NO bundle is built from an unverified
    // reference identity; the late read can never open a fresh window.
    // (Pre-R1.17.2 this surfaced as pair-level skipped_deadline because
    // the reference read ran unbounded and the bundle was still built.)
    expect(report.observation).toBe('no_evaluable_basis');
    expect(report.candidates[0]).toMatchObject({
      basisState: 'basis_unavailable',
      basisUnavailableReason: 'step_deadline_expired',
    });
    expect(report.pairs).toEqual([]);
    expect(report.counts.providerAttempts).toBe(0);
    expect(report.counts.pairsAttempted).toBe(0);
  });

  it('a PENDING budget authorization is freed by the deadline — zero provider calls, zero fabricated charge, typed ledger', async () => {
    const harness = createHarness({ manualDeadlineScheduler: true });
    await seedSource(harness.executor, 'src-d1c', 'Source D1C');
    await seedEntity(harness.executor, { id: 'ent-d1c', slug: 'd1c-entity', name: 'D1C Entity' });
    await seedAlias(harness.executor, { entityId: 'ent-d1c', alias: 'D1C Entity' });
    await seedItem(harness.executor, {
      id: 'item-d1c-base',
      sourceId: 'src-d1c',
      title: 'D1C Entity base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(await enqueueAndRun(harness, 'item-d1c-base')).toEqual(['ack:job_completed']);

    const relationCallsBefore = providerRelationCalls(harness);
    const budgetsBefore = await budgetAiRequests(harness.executor);
    const hashSecond = await seedItem(harness.executor, {
      id: 'item-d1c-second',
      sourceId: 'src-d1c',
      title: 'D1C Entity second coverage in Persian',
      body: 'متن متفاوت دربارهٔ D1C Entity.',
    });
    harness.hangBudgetAuthorization(); // ONE-SHOT: the relation task's authorization
    const pipeline = (async () => {
      expect(
        await enqueueEditorialPrepareDraft({
          engine: harness.engine,
          executor: harness.rawExecutor,
          sourceItemId: 'item-d1c-second',
        }),
      ).toMatchObject({ kind: 'created' });
      return runPipeline(harness);
    })();
    // The pipeline reaches the hanging authorization; the manual deadline
    // frees the caller (the bounded race — no real cancellation claimed).
    for (let i = 0; i < 500 && harness.pendingDeadlineCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.pendingDeadlineCount()).toBeGreaterThan(0);
    harness.firePendingDeadlines();
    const outcomes = await pipeline;
    expect(providerRelationCalls(harness)).toBe(relationCallsBefore);
    // The hung authorization never completed — NO relation charge was
    // fabricated. The drafting authorization (its one-shot unblocked)
    // proceeds normally: the ONLY delta is the draft's own +1.
    expect(await budgetAiRequests(harness.executor)).toBe((budgetsBefore ?? 0) + 1);
    expect(outcomes).toEqual(['ack:job_completed']);

    const storySecond = await storyIdForSnapshot('item-d1c-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    expect(report.pairs[0]).toMatchObject({
      state: 'skipped_deadline',
      deferredReason: 'step_deadline',
      aiRunIds: [],
    });
  });

  it('a NONCOOPERATIVE provider times out at the step deadline; the attempt is recorded honestly and a LATE rejection is absorbed', async () => {
    const harness = createHarness({ manualDeadlineScheduler: true });
    await seedSource(harness.executor, 'src-d1d', 'Source D1D');
    await seedEntity(harness.executor, { id: 'ent-d1d', slug: 'd1d-entity', name: 'D1D Entity' });
    await seedAlias(harness.executor, { entityId: 'ent-d1d', alias: 'D1D Entity' });
    await seedItem(harness.executor, {
      id: 'item-d1d-base',
      sourceId: 'src-d1d',
      title: 'D1D Entity base coverage',
      body: 'The committed candidate snapshot.',
    });
    expect(await enqueueAndRun(harness, 'item-d1d-base')).toEqual(['ack:job_completed']);

    const relationCallsBefore = providerRelationCalls(harness);
    const runsBefore = await relationRunCount(harness.executor);
    const runIdsBefore = new Set(
      (
        await harness.executor.query<{ id: string }>({
          sql: `SELECT id FROM ai_runs WHERE task = 'event_relation'`,
          params: [],
        })
      ).rows.map((row) => row.id),
    );
    const hashSecond = await seedItem(harness.executor, {
      id: 'item-d1d-second',
      sourceId: 'src-d1d',
      title: 'D1D Entity second coverage in Persian',
      body: 'متن متفاوت دربارهٔ D1D Entity.',
    });
    harness.hangProviderCalls();
    const pipeline = (async () => {
      expect(
        await enqueueEditorialPrepareDraft({
          engine: harness.engine,
          executor: harness.rawExecutor,
          sourceItemId: 'item-d1d-second',
        }),
      ).toMatchObject({ kind: 'created' });
      return runPipeline(harness);
    })();
    for (let i = 0; i < 500 && harness.pendingDeadlineCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.pendingDeadlineCount()).toBeGreaterThan(0);
    harness.firePendingDeadlines();
    const outcomes = await pipeline;
    expect(outcomes).toEqual(['ack:job_completed']); // the draft still commits
    // The attempt HAPPENED (the provider was reached) and stays charged.
    const providerAttempts = providerRelationCalls(harness) - relationCallsBefore;
    expect(providerAttempts).toBe(1);

    const storySecond = await storyIdForSnapshot('item-d1d-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    expect(report.pairs[0]).toMatchObject({
      state: 'skipped_deadline',
      deferredReason: 'step_deadline',
    });
    // The REAL invocation is durably recorded — status failed with the
    // typed deadline code, exactly one row per invocation.
    expect(report.pairs[0]?.aiRunIds).toHaveLength(1);
    const attemptRunId = report.pairs[0]!.aiRunIds[0]!;
    expect(runIdsBefore.has(attemptRunId)).toBe(false);
    const runRow = await harness.executor.first<{ status: string; error_code: string | null }>({
      sql: `SELECT status, error_code FROM ai_runs WHERE id = ?`,
      params: [attemptRunId],
    });
    expect(runRow?.status).toBe('failed');
    expect(runRow?.error_code).toBe('deadline_exceeded');
    expect(await relationRunCount(harness.executor)).toBe(runsBefore + 1);

    // The LATE rejection (arriving after the deadline freed the caller)
    // is observed and absorbed — never unhandled, never a state change.
    harness.rejectPendingProviderCalls(new Error('late_provider_rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
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

// ---------------------------------------------------------------------------
// R1.17.1 (G1) wiring helpers — REAL engine-env resolution over a stubbed
// native binding. The stub counts calls and returns the SAME accepted
// draft fixture for news_draft prompts; a live-binding call for ANY other
// prompt (relation included) fails the test via the forbidden-network
// throw. ZERO network anywhere.
// ---------------------------------------------------------------------------

function createWiringStub(): {
  readonly calls: number;
  readonly relationCalls: number;
  binding: unknown;
} {
  const state = { calls: 0, relationCalls: 0 };
  const binding = {
    run: async (_modelId: string, inputs: { messages: { role: string; content: string }[] }) => {
      state.calls += 1;
      const userContent = inputs.messages.find((message) => message.role === 'user')?.content;
      if (userContent?.includes('شناسهٔ جفت (pairId):')) {
        state.relationCalls += 1;
        throw new Error('live relation inference is forbidden in tests');
      }
      const evidenceId =
        /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>/.exec(userContent ?? '')?.[1] ?? 'missing-id';
      return {
        // A minimal Workers-AI-shaped response (the adapter normalizes it).
        response: JSON.stringify({
          headlineFa: 'تیتر آزمایشی خبر',
          summaryFa: 'خلاصهٔ آزمایشی خبر بر اساس شواهد ارائه‌شده.',
          claims: [
            { text: 'استودیوی آزمایشی از عرضهٔ نسخهٔ جدید خبر داد.', evidenceIds: [evidenceId] },
          ],
        }),
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      };
    },
  };
  // LIVE counters (getters): the closure mutates `state`, and the tests
  // must observe the mutations, never a return-time snapshot.
  return {
    get calls() {
      return state.calls;
    },
    get relationCalls() {
      return state.relationCalls;
    },
    binding,
  };
}

interface WiringResolutionReady {
  engine: ReturnType<typeof createJobsEngine>;
  envelopes: unknown[];
}

function resolveWiringRaw(flags: {
  readonly ai: string;
  readonly relation: string;
  readonly stub: { binding: unknown };
  readonly withBinding?: boolean;
}): { kind: string; issues: readonly string[]; engine?: unknown } {
  return resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'false',
    EDITORIAL_ENABLED: 'true',
    AI_ENABLED: flags.ai,
    EVENT_RELATION_ENABLED: flags.relation,
    AI: flags.withBinding === false ? undefined : (flags.stub.binding as never),
    JOBS: { send: async () => undefined },
    DLQ: { send: async () => undefined },
  } as unknown as WorkerEnv) as { kind: string; issues: readonly string[]; engine?: unknown };
}

function resolveWiring(flags: {
  readonly ai: string;
  readonly relation: string;
  readonly stub: { binding: unknown };
  readonly withBinding?: boolean;
}): WiringResolutionReady & { kind: 'ready' } {
  const envelopes: unknown[] = [];
  const resolution = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'false',
    EDITORIAL_ENABLED: 'true',
    AI_ENABLED: flags.ai,
    EVENT_RELATION_ENABLED: flags.relation,
    AI: flags.withBinding === false ? undefined : (flags.stub.binding as never),
    JOBS: {
      send: async (envelope: unknown) => {
        envelopes.push(envelope);
      },
    },
    DLQ: { send: async () => undefined },
  } as unknown as WorkerEnv);
  if (resolution.kind !== 'ready') {
    throw new Error(`fixture wiring resolution: ${resolution.kind}`);
  }
  return { kind: 'ready', engine: resolution.engine, envelopes };
}

/** Dispatch + consume through a RESOLVED production wiring engine. */
async function enqueueAndRunResolved(
  engine: WiringResolutionReady['engine'],
  envelopes: unknown[],
  sourceItemId: string,
): Promise<string[]> {
  const rawExecutor = createDbExecutor(env.DB);
  expect(
    await enqueueEditorialPrepareDraft({ engine, executor: rawExecutor, sourceItemId }),
  ).toMatchObject({ kind: 'created' });
  await engine.dispatchDueJobs();
  const outcomes: string[] = [];
  for (const envelope of envelopes.splice(0)) {
    const action = await engine.consumeMessage(`msg-${outcomes.length}`, envelope);
    outcomes.push(`${action.action}:${action.outcome}`);
  }
  return outcomes;
}

/** The shared 'ai' budget bucket's total authorized requests (null if none). */
async function budgetAiRequests(executor: DbExecutor): Promise<number | null> {
  const row = await executor.first<{ n: number | null }>({
    sql: `SELECT SUM(requests) AS n FROM budgets WHERE scope = 'ai'`,
    params: [],
  });
  return row?.n ?? null;
}

// ---------------------------------------------------------------------------
// R1.17.2 (A2/D2) — second-generation corrections on the R1.17.1 delivery.
// A2: the durable relation audit no longer depends on the relation step's
//     post-return outcome mapping — every REAL invocation is observed at
//     RECORD TIME and survives a step that fails after the provider
//     answered (providerCalls=1 ⇒ durable delta=1, the exact A1 signature
//     must never reappear on a NEW exit).
// D2: the pending retrieval/basis/reference reads are BOUNDED by the same
//     absolute step deadline through the accepted race primitive — expiry
//     frees the CALLER (a pending D1 query is never claimed cancellable),
//     a late settlement is absorbed, and no new work starts after expiry.
// ---------------------------------------------------------------------------
describe('R1.17.2 A2/D2 — record-time audit + bounded pending reads', () => {
  beforeEach(async () => {
    await createDbExecutor(env.DB).run({
      sql: "DELETE FROM jobs WHERE status IN ('pending', 'queued', 'retry_wait')",
      params: [],
    });
  });

  async function seedBase(
    harness: Harness,
    srcId: string,
    entId: string,
    entName: string,
  ): Promise<void> {
    await seedSource(harness.executor, srcId, `${entName} Source`);
    await seedEntity(harness.executor, { id: entId, slug: entId, name: entName });
    await seedAlias(harness.executor, { entityId: entId, alias: entName });
    await seedItem(harness.executor, {
      id: `p2-base-${entId}`,
      sourceId: srcId,
      title: `${entName} release announcement`,
      body: 'The first dated event.',
    });
    expect(await enqueueAndRun(harness, `p2-base-${entId}`)).toEqual(['ack:job_completed']);
  }

  it('A2: a relation-task failure AFTER the provider ran keeps the invocation audited BEFORE the retry; the retry generation owns its own rows (no collision, no misattribution)', async () => {
    const harness = createHarness();
    await seedBase(harness, 'p2-src-a', 'p2-ent-a', 'Aurora');
    const hashSecond = await seedItem(harness.executor, {
      id: 'p2-a-second',
      sourceId: 'p2-src-a',
      title: 'Aurora translated coverage',
      body: 'خبر دوم با متن متفاوت دربارهٔ Aurora.',
    });
    const rowsBefore = await relationRunCount(harness.executor);
    const budgetsBefore = await budgetAiRequests(harness.executor);
    const callsBefore = harness.providerCalls.relation;
    // The relation task's OWN result path fails (the attempt-record
    // observability write throws) AFTER the provider answered — the same
    // infrastructure-fault class as the injected mid-commit failure.
    harness.throwOnRelationAttempt();
    expect(await enqueueAndRun(harness, 'p2-a-second')).toEqual(['ack:retry_scheduled']);
    expect(await processedStatus(harness.executor, 'p2-a-second')).toBe('new');

    // BEFORE the retry: provider attempts == charged attempts == durable
    // rows (the audit is independent of the step's outcome mapping).
    const providerAttemptsGen1 = harness.providerCalls.relation - callsBefore;
    expect(providerAttemptsGen1).toBe(1);
    const runRowsGen1 = (await relationRunCount(harness.executor)) - rowsBefore;
    expect(runRowsGen1).toBe(1);
    expect((await budgetAiRequests(harness.executor))! - budgetsBefore!).toBe(1); // charged, never refunded
    const gen1RunIds = (
      await harness.executor.query<{ id: string }>({
        sql: `SELECT id FROM ai_runs WHERE task = 'event_relation' ORDER BY id ASC`,
        params: [],
      })
    ).rows.map((row) => row.id);
    expect(gen1RunIds.length).toBe(rowsBefore + runRowsGen1);
    const gen1NewIds = gen1RunIds.slice(rowsBefore);
    for (const runId of gen1NewIds) {
      const run = await harness.executor.first<{ status: string; task: string }>({
        sql: `SELECT status, task FROM ai_runs WHERE id = ?`,
        params: [runId],
      });
      // The provider DID answer — the row honestly records 'succeeded' and
      // is referenced by NO draft (never presented as consumed).
      expect(run?.status).toBe('succeeded');
      expect(run?.task).toBe('event_relation');
    }

    // The bounded engine retry owns the NEXT generation: its own REAL
    // invocation happens again and gets its OWN row (no collision with
    // generation 1's deterministic ids, no misattribution, no free lunch).
    harness.clock.advance(10_000);
    await runPipeline(harness);
    expect(await processedStatus(harness.executor, 'p2-a-second')).toBe('processed');
    expect(harness.providerCalls.relation).toBe(callsBefore + providerAttemptsGen1 + 1);
    expect(await relationRunCount(harness.executor)).toBe(rowsBefore + runRowsGen1 + 1);

    // The winning generation's ledger references ONLY its own durable run.
    const storySecond = await storyIdForSnapshot('p2-a-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    const winningRunIds: string[] = [];
    for (const pair of report.pairs) {
      for (const runId of pair.aiRunIds) {
        winningRunIds.push(runId);
        expect(gen1NewIds).not.toContain(runId);
        const run = await harness.executor.first<{ id: string }>({
          sql: `SELECT id FROM ai_runs WHERE id = ?`,
          params: [runId],
        });
        expect(run?.id).toBe(runId);
      }
    }
    expect(winningRunIds.length).toBe(1);
    // Generation 1's audited row still exists — never replaced, never deleted.
    for (const runId of gen1NewIds) {
      const run = await harness.executor.first<{ id: string }>({
        sql: `SELECT id FROM ai_runs WHERE id = ?`,
        params: [runId],
      });
      expect(run?.id).toBe(runId);
    }
  });

  it('D2: a PENDING basis read is freed by the step deadline — typed ledger, zero provider calls, late rejection absorbed', async () => {
    const harness = createHarness({ manualDeadlineScheduler: true });
    await seedBase(harness, 'p2-src-b', 'p2-ent-b', 'Borealis');
    const hashSecond = await seedItem(harness.executor, {
      id: 'p2-b-second',
      sourceId: 'p2-src-b',
      title: 'Borealis translated coverage',
      body: 'خبر دوم با متن متفاوت دربارهٔ Borealis.',
    });
    const callsBefore = harness.providerCalls.relation;
    const rowsBefore = await relationRunCount(harness.executor);
    const budgetsBefore = await budgetAiRequests(harness.executor);
    harness.hangBasisReads();
    const pipeline = (async () => {
      expect(
        await enqueueEditorialPrepareDraft({
          engine: harness.engine,
          executor: harness.rawExecutor,
          sourceItemId: 'p2-b-second',
        }),
      ).toMatchObject({ kind: 'created' });
      return runPipeline(harness);
    })();
    // The bounded race must be scheduled BY THE READ ITSELF — expiry frees
    // the caller while the D1 read is still pending (never claimed cancelled).
    for (let i = 0; i < 500 && harness.pendingDeadlineCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.pendingDeadlineCount()).toBeGreaterThan(0);
    harness.firePendingDeadlines();
    harness.disarmHungReads();
    const outcomes = await pipeline;
    // A LATE rejection of the pending read is absorbed by the primitive —
    // never an unhandled rejection, never a resurrected step.
    harness.releaseHungReads(new Error('late_basis_read_failure'));
    expect(outcomes).toEqual(['ack:job_completed']);
    expect(harness.providerCalls.relation).toBe(callsBefore);
    expect((await relationRunCount(harness.executor)) - rowsBefore).toBe(0);
    // The ONLY charge is the draft's own — the relation step started no
    // provider work and fabricated no authorization.
    expect((await budgetAiRequests(harness.executor))! - budgetsBefore!).toBe(1);
    const storySecond = await storyIdForSnapshot('p2-b-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    // The unread candidate is the TYPED technical state — never a semantic verdict.
    expect(report.candidates[0]).toMatchObject({
      basisState: 'basis_unavailable',
      basisUnavailableReason: 'step_deadline_expired',
    });
    expect(report.counts.providerAttempts).toBe(0);
  });

  it('D2: a PENDING entity probe is freed by the step deadline — honest unprobed accounting, zero provider calls', async () => {
    const harness = createHarness({ manualDeadlineScheduler: true });
    await seedBase(harness, 'p2-src-c', 'p2-ent-c', 'Cascade');
    const hashSecond = await seedItem(harness.executor, {
      id: 'p2-c-second',
      sourceId: 'p2-src-c',
      title: 'Cascade translated coverage',
      body: 'خبر دوم با متن متفاوت دربارهٔ Cascade.',
    });
    const callsBefore = harness.providerCalls.relation;
    harness.hangEntityProbes();
    const pipeline = (async () => {
      expect(
        await enqueueEditorialPrepareDraft({
          engine: harness.engine,
          executor: harness.rawExecutor,
          sourceItemId: 'p2-c-second',
        }),
      ).toMatchObject({ kind: 'created' });
      return runPipeline(harness);
    })();
    for (let i = 0; i < 500 && harness.pendingDeadlineCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.pendingDeadlineCount()).toBeGreaterThan(0);
    harness.firePendingDeadlines();
    harness.disarmHungReads();
    const outcomes = await pipeline;
    harness.releaseHungReads(new Error('late_probe_failure'));
    expect(outcomes).toEqual(['ack:job_completed']);
    expect(harness.providerCalls.relation).toBe(callsBefore);
    const storySecond = await storyIdForSnapshot('p2-c-second', hashSecond);
    const document = await readDraftDocument(harness.executor, storySecond);
    const report = eventRelationOf(document!);
    // The deadline-stopped probe is the HONEST unprobed truth — recorded,
    // never hidden, never folded into a fake "no candidates exist" claim.
    expect(report.lookup).toMatchObject({ probedEntities: [], unprobedEntityCount: 1 });
    expect(report.observation).toBe('no_candidates_observed');
    expect(report.counts.providerAttempts).toBe(0);
  });
});
