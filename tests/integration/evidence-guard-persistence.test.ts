import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createJobsEngine, type JobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import type {
  DlqReference,
  DlqProducerPort,
  JobsQueueProducerPort,
} from '../../src/adapters/queue/jobs-producer';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';
import { enqueueEditorialPrepareDraft } from '../../src/application/editorial/enqueue-prepare-draft';
import { createEditorialPrepareDraftHandler } from '../../src/application/editorial/prepare-draft-handler';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import { commitEditorialResult } from '../../src/adapters/db/editorial-store';
import { authorizeAiRequestAttempt, readAiBudget } from '../../src/adapters/db/ai-budget-store';
import { AI_DAILY_REQUEST_ATTEMPT_CAPS } from '../../src/domain/ai/policy';
import { claimJob, findJobById } from '../../src/adapters/db/job-store';
import {
  readEvidenceGuardReport,
  type EvidenceGuardClaimStatus,
  type EvidenceGuardReport,
} from '../../src/domain/editorial/evidence-guard';

/**
 * Evidence Guard v1 D1 integration suite (R1.12 Phase 5B): the report is
 * produced on the REAL editorial path (real engine + real AI service +
 * real fenced commit over workerd D1, artificial provider port only) and
 * is stored INSIDE the draft it describes. Zero new SQL statements were
 * added by the guard — this suite proves the protections still hold:
 *
 *   8. the report really lands in `drafts.document_json` and re-reads;
 *   9. a snapshot race / expired-lease commit writes NO draft and hence
 *      NO report for a foreign snapshot or owner;
 *   10. replay reuses the stable result: no provider call, no new charge,
 *      no duplicate draft/report, byte-identical document;
 *   4b. a pre-5B draft (no payload) honestly reads as `absent`, and a
 *       foreign-version payload never reads as a current result.
 */

const NOW = 1_760_000_000_000;
const SOURCE_ID = 'src-guard-official';
const ITEM_ID = 'item-guard-1';
const ITEM_TITLE = 'عنوان خبر آزمایشی شماره یک';
const ITEM_BODY =
  'استودیوی نمونه اعلام کرد به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه منتشر شد.';
/** A claim quoting the body VERBATIM (the direct-text observation case). */
const VERBATIM_CLAIM = 'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه منتشر شد.';
const PARAPHRASE_CLAIM = 'استودیوی نمونه نسخهٔ تازه‌ای از بازی نمونه را عرضه کرد.';
const UNRELATED_CLAIM = 'قیمت سهام استودیو در بورس دو برابر شد.';

interface ProviderCall {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

/** Scriptable artificial provider port — SAME contract, ZERO network. */
function createHarness(options?: {
  readonly script?:
    | ((callIndex: number, input: Parameters<AiProviderPort['complete']>[0]) => AiCallOutcome)
    | 'traced-four-claims';
  readonly mutateBeforeEditorialCommit?: (raw: DbExecutor) => Promise<void>;
}): {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly rawExecutor: DbExecutor;
  readonly clock: MutableClock;
  readonly providerCalls: ProviderCall[];
  readonly envelopes: unknown[];
  /** Captured structured log lines (debug aid for assertion failures). */
  readonly logLines: string[];
} {
  const clock = fixedClock(NOW);
  const lines: string[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(line);
  };
  const logger = createLogger({ level: 'debug', base: { evt: 'test' }, clock, sink });

  const providerCalls: ProviderCall[] = [];
  const defaultScript = (_callIndex: number, input: Parameters<AiProviderPort['complete']>[0]) => {
    // The evidence id is extracted from the REAL user prompt header — the
    // fixture is traceable to the actual request, never fabricated.
    const header = /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>>/;
    const evidenceId =
      input.messages.find((message) => message.role === 'user')?.content.match(header)?.[1] ??
      'missing-evidence-id';
    return {
      kind: 'ok',
      rawText: JSON.stringify({
        headlineFa: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد',
        summaryFa: 'خلاصهٔ آزمایشی خبر بر اساس شواهد ارائه‌شده.',
        claims: [
          { text: VERBATIM_CLAIM, evidenceIds: [evidenceId] },
          { text: PARAPHRASE_CLAIM, evidenceIds: [evidenceId] },
          { text: UNRELATED_CLAIM, evidenceIds: [evidenceId] },
        ],
      }),
      usage: { inputTokens: 42, outputTokens: 17 },
    } satisfies AiCallOutcome;
  };
  const script =
    options?.script === undefined || options.script === 'traced-four-claims'
      ? defaultScript
      : options.script;

  const rawExecutor = createDbExecutor(env.DB, { clock });
  const executor: DbExecutor = {
    query: rawExecutor.query.bind(rawExecutor),
    first: rawExecutor.first.bind(rawExecutor),
    run: rawExecutor.run.bind(rawExecutor),
    batch: async (statements: readonly DbStatement[]) => {
      if (
        options?.mutateBeforeEditorialCommit !== undefined &&
        statements.some((statement) => statement.sql.includes('INSERT INTO stories'))
      ) {
        await options.mutateBeforeEditorialCommit(rawExecutor);
      }
      return rawExecutor.batch(statements);
    },
  };

  const aiService = createAiDraftService({
    executor,
    ports: {
      'workers-ai': {
        provider: 'workers-ai',
        complete: async (input) => {
          providerCalls.push({ messages: input.messages });
          return script(providerCalls.length - 1, input);
        },
      },
    },
    clock,
    logger,
    config: {
      aiEnabled: true,
      geminiEnabled: false,
      workersAiBindingPresent: true,
      geminiApiKeyPresent: false,
    },
  });

  const handlers = [
    createEditorialPrepareDraftHandler({
      executor,
      aiService,
      nowMs: () => clock.now(),
      logger,
    }),
  ];
  const envelopes: unknown[] = [];
  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      envelopes.push(envelope);
    },
  };
  const dlq: DlqReference[] = [];
  const dlqProducer: DlqProducerPort = {
    send: async (reference) => {
      dlq.push(reference);
    },
  };
  let idCounter = 0;
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry(handlers as never),
      idGenerator: { newId: () => `guard-id-${(idCounter += 1)}` },
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
  return { engine, executor, rawExecutor, clock, providerCalls, envelopes, logLines: lines };
}

async function seedSourceAndItem(executor: DbExecutor): Promise<string> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'منبع گارد آزمایشی', 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
  const contentHash = await sha256Hex(`${ITEM_ID}\u001f${ITEM_TITLE}\u001f${ITEM_BODY}`);
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, 'ext-guard-1', 'https://example.com/guard', ?, ?, 'نویسندهٔ گارد', ?, ?, ?, '{}', 'new')`,
    params: [ITEM_ID, SOURCE_ID, ITEM_TITLE, ITEM_BODY, NOW, NOW, contentHash],
  });
  return contentHash;
}

async function runPipeline(harness: ReturnType<typeof createHarness>): Promise<string[]> {
  await harness.engine.dispatchDueJobs();
  const outcomes: string[] = [];
  for (const envelope of harness.envelopes.splice(0)) {
    const action = await harness.engine.consumeMessage(`msg-${outcomes.length}`, envelope);
    outcomes.push(`${action.action}:${action.outcome}`);
  }
  return outcomes;
}

async function rowCount(executor: DbExecutor, table: string): Promise<number> {
  const row = await executor.first<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
  return row?.n ?? 0;
}

interface StoredDraft {
  readonly id: string;
  readonly status: string;
  readonly document_json: string;
}

async function readSingleDraft(executor: DbExecutor): Promise<StoredDraft | null> {
  return executor.first<StoredDraft>({
    sql: 'SELECT id, status, document_json FROM drafts',
  });
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of [
    'drafts',
    'ai_runs',
    'evidence',
    'claims',
    'story_fingerprints',
    'stories',
    'source_items',
    'sources',
    'jobs',
    'budgets',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe('evidence guard — acceptance 8: the report is stored with the draft and re-read', () => {
  it('one real path commits a draft whose document_json carries the v1 report', async () => {
    const harness = createHarness();
    await seedSourceAndItem(harness.rawExecutor);

    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    expect(enqueued.kind).toBe('created');
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    // The draft is READY — the guard NEVER upgrades the status.
    const draft = await readSingleDraft(harness.rawExecutor);
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('ready');
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);

    const document = JSON.parse(draft!.document_json) as {
      schemaVersion: number;
      evidenceGuard: EvidenceGuardReport;
      modelClaims: { text: string; evidenceIds: string[]; status: string }[];
    };
    // Additive contract: schemaVersion stays 1; the report rides inside.
    expect(document.schemaVersion).toBe(1);
    const guard = document.evidenceGuard;
    expect(guard.guardVersion).toBe(1);
    expect(guard.evaluationStatus).toBe('evaluated');
    expect(guard.snapshot).toEqual({
      sourceItemId: ITEM_ID,
      contentHash: await sha256Hex(`${ITEM_ID}\u001f${ITEM_TITLE}\u001f${ITEM_BODY}`),
    });
    expect(guard.evidence.evidenceId).toBe(ITEM_ID);
    expect(guard.evidence.excerptTruncated).toBe(false);
    expect(guard.unassessedFields).toEqual(['headlineFa', 'summaryFa']);
    expect(guard.limitations).toEqual([
      'excerpt_scope_only',
      'direct_text_is_not_truth',
      'no_semantic_analysis',
      'headline_summary_unassessed',
    ]);

    // Per-claim honesty: verbatim → observed; paraphrase/unrelated →
    // unresolved (NOT false, NOT verified). (A claim referencing an
    // UNKNOWN evidence id can never reach the commit path: the AI
    // service's own evidence cross-check rejects the whole output first —
    // the invalid-reference outcome is pinned at the unit level.)
    const statuses = guard.claims.map((claim) => claim.status as EvidenceGuardClaimStatus);
    expect(statuses).toEqual([
      'direct_text_observed',
      'unresolved_requires_further_verification',
      'unresolved_requires_further_verification',
    ]);
    expect(guard.claims.map((claim) => claim.claimIndex)).toEqual([0, 1, 2]);
    // The report indexes the SAME claims the document stores.
    expect(document.modelClaims).toHaveLength(guard.counts.total);
    expect(guard.counts).toEqual({
      total: 3,
      directTextObserved: 1,
      unresolvedRequiresFurtherVerification: 2,
      invalidReferenceOrSnapshot: 0,
      notEvaluatedIdentityInvalid: 0,
    });

    // The typed reader reads the stored draft back as guard_v1.
    expect(readEvidenceGuardReport(document)).toEqual({ kind: 'guard_v1', report: guard });
  });

  it('the guard adds NO new SQL to the path: one atomic editorial batch, same statement shape', async () => {
    const harness = createHarness();
    await seedSourceAndItem(harness.rawExecutor);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);
    // The draft carries the report; NOTHING else was written per draft:
    // exactly one draft row, one story, one durable claim, one evidence.
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'evidence')).toBe(1);
  });
});

describe('evidence guard — acceptance 10: replay is free and byte-stable', () => {
  it('a replayed job calls NO provider, charges NOTHING, and rewrites NOTHING', async () => {
    const harness = createHarness();
    await seedSourceAndItem(harness.rawExecutor);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    expect(enqueued.kind).toBe('created');
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toHaveLength(1);
    const firstDraft = await readSingleDraft(harness.rawExecutor);
    expect(firstDraft).not.toBeNull();
    const firstDocumentJson = firstDraft!.document_json;
    const budgetAfterFirst = await readAiBudget(harness.rawExecutor, {
      provider: 'workers-ai',
      nowMs: NOW,
    });
    expect(budgetAfterFirst).toBe(1);

    // Replay the SAME enqueue input: the durable idempotency key resolves
    // the SAME job row ('existing', never a second pipeline run).
    const replay = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    expect(replay.kind).toBe('existing');
    const replayJobId = replay.kind === 'existing' || replay.kind === 'created' ? replay.jobId : '';
    expect(replayJobId).toBe(enqueued.kind === 'created' ? enqueued.jobId : '');

    // Handler-level replay (same job, same generation): the pre-AI
    // stable-result path returns success WITHOUT any provider call, any
    // budget charge, or any write — the stored report is never rewritten.
    const job = await findJobById(harness.rawExecutor, replayJobId);
    expect(job).not.toBeNull();
    const replayHandler = createEditorialPrepareDraftHandler({
      executor: harness.executor,
      aiService: createAiDraftService({
        executor: harness.executor,
        ports: {}, // no provider at all: a replay must never need one
        clock: harness.clock,
        logger: createLogger({ level: 'error' }),
        config: {
          aiEnabled: true,
          geminiEnabled: false,
          workersAiBindingPresent: true,
          geminiApiKeyPresent: false,
        },
      }),
      nowMs: () => harness.clock.now(),
    });
    const replayOutcome = await replayHandler.execute({
      jobId: job!.id,
      generation: 1,
      payload: {
        sourceItemId: ITEM_ID,
        snapshotHash: await sha256Hex(`${ITEM_ID}\u001f${ITEM_TITLE}\u001f${ITEM_BODY}`),
      },
    });
    expect(replayOutcome).toEqual({ kind: 'success' });
    expect(harness.providerCalls).toHaveLength(1); // NO new provider call
    expect(await readAiBudget(harness.rawExecutor, { provider: 'workers-ai', nowMs: NOW })).toBe(1); // NO new charge
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1); // no duplicate draft
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(1);
    // Engine-level duplicate delivery: acknowledged rows are never
    // re-dispatched (no envelope, no second execution).
    await harness.engine.dispatchDueJobs();
    expect(harness.envelopes).toHaveLength(0);
    const secondDraft = await readSingleDraft(harness.rawExecutor);
    expect(secondDraft!.document_json).toBe(firstDocumentJson); // byte-identical
    const document = JSON.parse(secondDraft!.document_json) as {
      evidenceGuard: EvidenceGuardReport;
    };
    expect(document.evidenceGuard.guardVersion).toBe(1);
    expect(document.evidenceGuard.claims).toHaveLength(3);
  });
});

describe('evidence guard — acceptance 9: no report for a foreign snapshot or owner', () => {
  it('a snapshot race at commit time writes ZERO drafts and ZERO reports', async () => {
    const harness = createHarness({
      mutateBeforeEditorialCommit: async (raw) => {
        // The demonstrated R1.11.1 race: the item changes AFTER the handler
        // read it and verified its hash, BEFORE the atomic batch.
        await raw.run({
          sql: `UPDATE source_items SET title = ?, content_hash = ? WHERE id = ?`,
          params: ['عنوان تغییر یافته', 'c'.repeat(64), ITEM_ID],
        });
      },
    });
    await seedSourceAndItem(harness.rawExecutor);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    expect(enqueued.kind).toBe('created');
    // The provider DID run (charged), but the whole fenced batch no-oped.
    // A PERMANENT failure is dead-lettered by the engine (no retry storm).
    expect(await runPipeline(harness)).toEqual(['ack:job_dead_lettered']);
    expect(harness.providerCalls).toHaveLength(1);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
    // No draft → no guard report can exist anywhere for this run.
    const anyDraft = await readSingleDraft(harness.rawExecutor);
    expect(anyDraft).toBeNull();
  });

  it('an expired-lease (stale generation) commit writes nothing — no report for another owner', async () => {
    const harness = createHarness();
    const contentHash = await seedSourceAndItem(harness.rawExecutor);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    expect(enqueued.kind).toBe('created');
    const jobId = enqueued.kind === 'created' ? enqueued.jobId : '';
    const claim = await claimJob(harness.rawExecutor, jobId, NOW, 2 * 60 * 1000);
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    harness.clock.advance(3 * 60 * 1000); // lease expired

    // A full stale commit attempt (the guard report rides inside
    // document_json — it MUST NOT land either).
    const stale = await commitEditorialResult(harness.rawExecutor, {
      jobId,
      generation: claim.generation,
      fenceNowMs: harness.clock.now(),
      snapshot: { sourceItemId: ITEM_ID, sourceId: SOURCE_ID, contentHash },
      entityMentions: [],
      story: {
        id: 'edst-guard-stale',
        storyKey: 'editorial.story:guard-stale',
        workingHeadline: null,
        createdAt: harness.clock.now(),
      },
      claim: {
        id: 'edcl-guard-stale',
        storyId: 'edst-guard-stale',
        claimType: 'source_report',
        subject: 's',
        predicate: 'reported',
        objectText: 'o',
        confidence: 0,
        status: 'unverified',
        createdAt: harness.clock.now(),
      },
      evidence: {
        id: 'edev-guard-stale',
        claimId: 'edcl-guard-stale',
        sourceItemId: ITEM_ID,
        stance: 'mentions',
        confidence: 0,
        excerpt: 'e',
        createdAt: harness.clock.now(),
      },
      aiRun: {
        id: 'edai-guard-stale',
        task: 'news_draft',
        provider: 'workers-ai',
        model: 'm',
        promptVersion: 'p',
        inputHash: 'h',
        status: 'succeeded',
        latencyMs: 1,
        inputTokens: null,
        outputTokens: null,
        errorCode: null,
        errorMessage: null,
        createdAt: harness.clock.now(),
        completedAt: harness.clock.now(),
      },
      draft: {
        id: 'eddr-guard-stale',
        storyId: 'edst-guard-stale',
        status: 'ready',
        language: 'fa',
        layout: 'news_v1',
        title: 't',
        documentJson: JSON.stringify({
          evidenceGuard: { guardVersion: 1, evaluationStatus: 'evaluated' },
        }),
        factsJson: '[]',
        warningsJson: '[]',
        aiRunId: 'edai-guard-stale',
        version: 1,
        createdBy: 'stale',
        createdAt: harness.clock.now(),
      },
      fingerprints: [],
      // R1.15: the exact-content group anchor (store-level tests use a fixed
      // well-formed anchor; the REAL path derives it from the item's own text).
      exactContentAnchor: {
        kind: 'content_hash' as const,
        value: 'sc1:' + 'a'.repeat(64),
      },
    });
    expect(stale.fenceLost).toBe(true);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
    // The item stays unprocessed; the REAL pipeline (lease recovery) still
    // completes on a fresh generation.
    harness.clock.advance(60_000);
    await harness.engine.dispatchDueJobs(); // recovery: claimed → queued
    harness.clock.advance(120_000); // stranded-queue grace window
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    const draft = await readSingleDraft(harness.rawExecutor);
    expect(draft).not.toBeNull();
    const document = JSON.parse(draft!.document_json) as { evidenceGuard?: EvidenceGuardReport };
    // Only the NEW generation's report exists — computed for THIS snapshot.
    expect(document.evidenceGuard?.evaluationStatus).toBe('evaluated');
    expect(document.evidenceGuard?.snapshot.sourceItemId).toBe(ITEM_ID);
  });
});

describe('evidence guard — acceptance 4b: historical drafts read honestly', () => {
  it('a pre-5B draft reads as absent; a foreign-version payload never reads as a current result', async () => {
    const harness = createHarness();
    await seedSourceAndItem(harness.rawExecutor);
    // Minimal historical rows: a story + two drafts written the OLD way.
    await harness.rawExecutor.run({
      sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
              confidence, working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
            VALUES ('edst-legacy', 'editorial.story:legacy', 'discovered', 'unknown', 'industry',
                    50, 0, NULL, 1, 1, 1, 1, 1)`,
    });
    await harness.rawExecutor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
            VALUES ('eddr-legacy', 'edst-legacy', 'ready', 'fa', 'news_v1', 'قدیمی',
                    '${'{"schemaVersion":1,"headlineFa":"قدیمی"}'}' , '[]', '[]', NULL, 1, 'legacy', 1, 1)`,
    });
    await harness.rawExecutor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
            VALUES ('eddr-future', 'edst-legacy', 'ready', 'fa', 'news_v1', 'آینده',
                    '{"schemaVersion":1,"evidenceGuard":{"guardVersion":99}}', '[]', '[]', NULL, 2, 'future', 1, 1)`,
    });

    const legacyRow = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts WHERE id = ?',
      params: ['eddr-legacy'],
    });
    expect(readEvidenceGuardReport(JSON.parse(legacyRow!.document_json))).toEqual({
      kind: 'absent',
    });

    const futureRow = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts WHERE id = ?',
      params: ['eddr-future'],
    });
    expect(readEvidenceGuardReport(JSON.parse(futureRow!.document_json))).toEqual({
      kind: 'unsupported_version',
      guardVersion: 99,
    });
  });

  it('the budget authority path is untouched: one authorization per attempt (5A contract holds)', async () => {
    const harness = createHarness();
    await seedSourceAndItem(harness.rawExecutor);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: ITEM_ID,
    });
    // The durable budget charge happens BEFORE the provider call (5A); the
    // guard never touches the budget store. One manual authorization first
    // (the versioned per-provider cap from the policy).
    const charged = await authorizeAiRequestAttempt(harness.rawExecutor, {
      provider: 'workers-ai',
      cap: AI_DAILY_REQUEST_ATTEMPT_CAPS['workers-ai'],
      nowMs: NOW,
    });
    expect(charged.kind).toBe('authorized');
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    // 1 (manual pre-call authorization above) + 1 (the handler's own) = 2.
    expect(await readAiBudget(harness.rawExecutor, { provider: 'workers-ai', nowMs: NOW })).toBe(2);
    expect(harness.providerCalls).toHaveLength(1);
  });
});
