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
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import {
  commitEditorialResult,
  commitEditorialReuse,
  findStoryReferenceItems,
} from '../../src/adapters/db/editorial-store';

import { claimJob } from '../../src/adapters/db/job-store';
import {
  exactContentReuseClaimId,
  mentionsEvidenceId,
  sourceReportClaimId,
  storyIdForSnapshot,
  EDITORIAL_DRAFT_VERSION,
} from '../../src/domain/editorial/identity';
import {
  buildDraftDocument,
  buildFullEvidenceText,
  buildTraceableExcerpt,
} from '../../src/domain/editorial/mapper';
import { buildEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import { buildCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';
import { emptyEntityMentionsReport } from '../../src/domain/editorial/entity-mentions';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import {
  exactContentAnchorValue,
  exactContentDigest,
} from '../../src/domain/editorial/exact-content';

/**
 * R1.15 (Phase 5C-3) acceptance suite — REAL workerd D1, REAL pipeline.
 * The ONLY artificial piece is the provider port (zero network). Every
 * exact-content reuse behavior under test is the shipped code: verified
 * reuse with preserved provenance, zero provider calls on the sequential
 * reuse path, byte-exact equality boundaries (NO fuzzy/translation/digit
 * equivalence), the SQL-level group anchor for concurrency, and the typed
 * outcomes of every failure window. Reuse is NOT a semantic merge, NOT
 * truth verification, and NOT source independence.
 */

const NOW = 1_760_000_000_000;
const SOURCE_X = 'src-reuse-x';
const SOURCE_Y = 'src-reuse-y';

/** Executor wrapper: count + fail/interleave selected statements on demand. */
function wrapExecutor(
  inner: DbExecutor,
  hooks: {
    readonly onBatch?: (statements: readonly { sql: string }[]) => void | Promise<void>;
    readonly onQuery?: (statement: { sql: string }) => void;
    readonly onRun?: (statement: { sql: string }) => void;
  },
): DbExecutor {
  return {
    query: async (statement) => {
      hooks.onQuery?.(statement);
      return inner.query(statement);
    },
    first: inner.first.bind(inner),
    run: async (statement) => {
      hooks.onRun?.(statement);
      return inner.run(statement);
    },
    batch: async (statements) => {
      await hooks.onBatch?.(statements);
      return inner.batch(statements);
    },
  };
}

interface Harness {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly rawExecutor: DbExecutor;
  readonly clock: ReturnType<typeof fixedClock>;
  readonly envelopes: unknown[];
  readonly providerCalls: number;
  readonly failBatchesMatching: (
    match: (statements: readonly { sql: string }[]) => boolean,
  ) => void;
  readonly mutateBeforeReuseCommit: (mutate: (raw: DbExecutor) => Promise<void>) => void;
}

function createHarness(options?: {
  aiEnabled?: boolean;
  onProviderCall?: (evidenceId: string) => Promise<void>;
}): Harness {
  const clock = fixedClock(NOW);
  const logger = createLogger({ level: 'error', clock });
  const rawExecutor = createDbExecutor(env.DB, { clock });

  let providerCalls = 0;
  let failBatches: (statements: readonly { sql: string }[]) => boolean = () => false;
  const reuseMutateHook: { fn?: (raw: DbExecutor) => Promise<void> } = {};

  const executor = wrapExecutor(rawExecutor, {
    onBatch: async (statements) => {
      if (failBatches(statements)) {
        throw new Error('injected_mid_commit_failure');
      }
      // The REUSE batch signature: claim+evidence inserts and the processed
      // flip WITHOUT any story insert (the normal commit always inserts the
      // story first).
      if (
        reuseMutateHook.fn !== undefined &&
        statements.some((statement) => statement.sql.includes('INSERT INTO claims')) &&
        !statements.some((statement) => statement.sql.includes('INSERT INTO stories'))
      ) {
        await reuseMutateHook.fn(rawExecutor);
      }
    },
  });

  const port: AiProviderPort = {
    provider: 'workers-ai',
    complete: async (input) => {
      providerCalls += 1;
      const userContent = input.messages.find((message) => message.role === 'user')?.content;
      const evidenceId =
        /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>/.exec(userContent ?? '')?.[1] ?? 'missing-id';
      if (options?.onProviderCall !== undefined) {
        await options.onProviderCall(evidenceId);
      }
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
      aiEnabled: options?.aiEnabled ?? true,
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
  const dlqProducer: DlqProducerPort = { send: async () => undefined };
  let idCounter = 0;
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry(handlers as never),
      idGenerator: { newId: () => `reuse-id-${(idCounter += 1)}` },
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
    get providerCalls() {
      return providerCalls;
    },
    failBatchesMatching: (match) => {
      failBatches = match;
    },
    mutateBeforeReuseCommit: (mutate) => {
      reuseMutateHook.fn = mutate;
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

/** One full engine pass: dispatch due jobs, then consume everything sent. */
async function runPipeline(harness: Harness): Promise<string[]> {
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

interface ItemStatusRow {
  readonly id: string;
  readonly processing_status: string;
}

async function itemStatuses(
  executor: DbExecutor,
  ids: readonly string[],
): Promise<readonly ItemStatusRow[]> {
  const placeholders = ids.map(() => '?').join(', ');
  const { rows } = await executor.query<ItemStatusRow>({
    sql: `SELECT id, processing_status FROM source_items WHERE id IN (${placeholders}) ORDER BY id ASC`,
    params: [...ids],
  });
  return rows;
}

/** Seed a COMPLETE historical story (story + item + claim + evidence + ready
 * draft) with optional fingerprints — the shape a pre-R1.15 commit left.
 * R1.15.1: `realisticDocument` builds the draft's document_json with the
 * PRODUCTION mappers (sourceReport + evidenceGuard + discovery + assessment
 * exactly as the real fenced commit writes them) — the shape a real
 * pipeline-committed historical draft carries, and the shape the R1.15.1
 * immutable reuse basis verifies. The default stays '{}' (a foreign/seeded
 * shape with NO verifiable basis — honestly NOT a reuse target). */
async function seedHistoricalStory(
  executor: DbExecutor,
  input: {
    readonly itemId: string;
    readonly sourceId: string;
    readonly title: string;
    readonly body?: string;
    readonly storyId: string;
    readonly draftStatus?: string;
    readonly withContentFingerprint?: boolean;
    readonly withGroupAnchor?: boolean;
    readonly realisticDocument?: boolean;
  },
): Promise<void> {
  const contentHash = await sha256Hex(
    `${input.itemId}\u001f${input.title}\u001f${input.body ?? ''}`,
  );
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
                                     author, published_at, fetched_at, content_hash, raw_json,
                                     processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسنده', ?, ?, ?, '{}', 'processed')`,
    params: [
      input.itemId,
      input.sourceId,
      `ext-${input.itemId}`,
      `https://example.com/${input.itemId}`,
      input.title,
      input.body ?? null,
      NOW,
      NOW,
      contentHash,
    ],
  });
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
                                confidence, working_headline, first_seen_at, last_evidence_at,
                                version, created_at, updated_at)
          VALUES (?, ?, 'discovered', 'unknown', 'industry', 50, 0, NULL, ?, ?, 1, ?, ?)`,
    params: [input.storyId, `seeded-${input.storyId}`, NOW, NOW, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
                               confidence, status, created_at, updated_at)
          VALUES (?, ?, 'source_report', 'منبع تاریخی', 'reported', 'متن تاریخی', 0,
                  'unverified', ?, ?)`,
    params: [`edcl_${input.storyId}`, input.storyId, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
          VALUES (?, ?, ?, 'mentions', 0, 'متن تاریخی', ?)`,
    params: [`edev_${input.storyId}`, `edcl_${input.storyId}`, input.itemId, NOW],
  });
  let documentJson = '{}';
  if (input.realisticDocument ?? false) {
    // The PRODUCTION document shape (R1.15.1): the draft's own immutable
    // record — sourceReport + evidenceGuard.snapshot — built by the same
    // pure mappers the real fenced commit uses.
    const excerpt = buildTraceableExcerpt({
      title: input.title,
      body_excerpt: input.body ?? null,
    });
    const evidenceGuard = buildEvidenceGuardReport({
      snapshot: { sourceItemId: input.itemId, contentHash },
      evidence: {
        evidenceId: input.itemId,
        excerptText: excerpt.text,
        excerptTruncated: excerpt.truncated,
      },
      draftClaims: [],
      draftHeadlineFa: 'تیتر تاریخی',
      draftSummaryFa: 'خلاصهٔ تاریخی.',
      draftSourceItemId: input.itemId,
    });
    const discovery = buildCandidateDiscoveryReport({
      snapshot: { sourceItemId: input.itemId, contentHash },
      storyId: input.storyId,
      lookups: [],
      matches: [],
    });
    const assessment = buildCandidateAssessmentReport({ discovery });
    const document = buildDraftDocument({
      sourceItemId: input.itemId,
      sourceName: 'منبع تاریخی',
      excerpt,
      semanticDraft: {
        headlineFa: 'تیتر تاریخی',
        summaryFa: 'خلاصهٔ تاریخی.',
        claims: [],
      },
      evidenceGuard,
      candidateDiscovery: discovery,
      candidateAssessment: assessment,
      // R1.16: the PRODUCTION-shape additive mentions report for a
      // pre-R1.16 historical snapshot (honest "nothing observed"; the
      // reuse contract NEVER enriches old drafts — this only keeps the
      // seeded document shape identical to what a real commit writes).
      entityMentions: emptyEntityMentionsReport({
        sourceItemId: input.itemId,
        contentHash,
      }),
    });
    documentJson = canonicalizeJson(document.document);
  }
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
                               facts_json, warnings_json, ai_run_id, version, created_by,
                               created_at, updated_at)
          VALUES (?, ?, ?, 'fa', 'news_v1', 'تیتر تاریخی', ?, '[]', '[]', NULL, 1, 'seed', ?, ?)`,
    params: [
      `eddr_${input.storyId}`,
      input.storyId,
      input.draftStatus ?? 'ready',
      documentJson,
      NOW,
      NOW,
    ],
  });
  if (input.withContentFingerprint ?? false) {
    const digest = await exactContentDigest(
      buildFullEvidenceText({
        title: input.title,
        body_excerpt: input.body ?? null,
      }),
    );
    if (input.withGroupAnchor ?? false) {
      await executor.run({
        sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
              VALUES (?, 'content_hash', ?, ?)`,
        params: [input.storyId, exactContentAnchorValue(digest), NOW],
      });
    }
    await executor.run({
      sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
            VALUES (?, 'content_hash', ?, ?)`,
      params: [input.storyId, `sc1:${digest}:${input.storyId}`, NOW],
    });
  }
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
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe('R1.15 scenario 1+2 — identical content: ONE usable draft result, BOTH provenances, sequential reuse is FREE', () => {
  it('the second source reuses the first result with zero provider calls and zero charges', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    const title = 'تیتر محتوای دقیقاً یکسان';
    const body = 'بدنهٔ کامل و دقیقاً یکسان که از دو منبع مستقل مصنوعی منتشر شده است.';
    await seedItem(harness.rawExecutor, {
      id: 'item-a',
      sourceId: SOURCE_X,
      title,
      body,
      url: 'https://x.example/one',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-b',
      sourceId: SOURCE_Y,
      title,
      body,
      url: 'https://y.example/two',
    });

    // The FIRST item takes the normal path: one real provider call.
    expect(await enqueueAndRun(harness, 'item-a')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1);
    const draftAfterA = await harness.rawExecutor.first<{
      id: string;
      story_id: string;
      document_json: string;
    }>({
      sql: 'SELECT id, story_id, document_json FROM drafts',
    });
    expect(draftAfterA).not.toBeNull();

    // The SECOND item (different id/source/URL, same full text) reuses.
    expect(await enqueueAndRun(harness, 'item-b')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1); // ZERO new provider calls
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(1); // ZERO new charges
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1); // ONE stable result
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(2); // BOTH provenances
    expect(await rowCount(harness.rawExecutor, 'evidence')).toBe(2);

    // The reused draft is byte-identical — never rewritten.
    const draftAfterB = await harness.rawExecutor.first<{
      id: string;
      story_id: string;
      document_json: string;
    }>({
      sql: 'SELECT id, story_id, document_json FROM drafts',
    });
    expect(draftAfterB!.id).toBe(draftAfterA!.id);
    expect(draftAfterB!.document_json).toBe(draftAfterA!.document_json);

    // The second provenance: B's OWN claim under A's story, its OWN
    // evidence, and its own processed flip — added, never substituted.
    const claimB = await harness.rawExecutor.first<{
      id: string;
      story_id: string;
      subject: string;
      confidence: number;
      status: string;
    }>({
      sql: `SELECT c.id, c.story_id, c.subject, c.confidence, c.status
              FROM claims c JOIN evidence e ON e.claim_id = c.id
             WHERE e.source_item_id = 'item-b'`,
    });
    expect(claimB).not.toBeNull();
    expect(claimB!.story_id).toBe(draftAfterA!.story_id);
    expect(claimB!.subject).toBe('منبع ایگرگ'); // B's OWN source, honestly
    expect(claimB!.confidence).toBe(0);
    expect(claimB!.status).toBe('unverified');
    const statuses = await itemStatuses(harness.rawExecutor, ['item-a', 'item-b']);
    expect(statuses.map((row) => row.processing_status)).toEqual(['processed', 'processed']);

    // Nothing merged, nothing trusted: zero confidence everywhere.
    const confidences = await harness.rawExecutor.query<{ confidence: number }>({
      sql: 'SELECT confidence FROM claims',
    });
    for (const row of confidences.rows) {
      expect(row.confidence).toBe(0);
    }
  });
});

describe('R1.15 scenarios 3–6 — equality boundaries: shared URL/title/excerpt alone NEVER reuses', () => {
  const title = 'تیتر مرزی برای عدمReuse';
  const body = 'بدنهٔ کامل مرزی.';

  it('same URL, different content → independent draft', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    await seedItem(harness.rawExecutor, {
      id: 'item-url-1',
      sourceId: SOURCE_X,
      title,
      body,
      url: 'https://shared.example/same',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-url-2',
      sourceId: SOURCE_Y,
      title: 'تیتر کاملاً متفاوت',
      body: 'بدنهٔ کاملاً متفاوت با همین URL.',
      url: 'https://shared.example/same',
    });
    expect(await enqueueAndRun(harness, 'item-url-1')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(harness, 'item-url-2')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(2); // NO reuse — two real provider calls
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(2);
  });

  it('same title, different body → independent draft', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, { id: 'item-title-1', sourceId: SOURCE_X, title, body });
    await seedItem(harness.rawExecutor, {
      id: 'item-title-2',
      sourceId: SOURCE_X,
      title,
      body: 'بدنهٔ کاملاً متفاوت و حتی متناقض با خبر اول.',
    });
    expect(await enqueueAndRun(harness, 'item-title-1')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(harness, 'item-title-2')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });

  it('number, negation, unit, and Persian-vs-Latin digit differences are NEVER equated', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-num-1',
      sourceId: SOURCE_X,
      title: 'قیمت ۱۰۰ دلار شد',
      body: 'روایت اول.',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-num-2',
      sourceId: SOURCE_X,
      title: 'قیمت ۱۰۰ دلار نشد',
      body: 'روایت دوم.',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-num-3',
      sourceId: SOURCE_X,
      title: 'قیمت 100 دلار شد',
      body: 'روایت سوم.',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-num-4',
      sourceId: SOURCE_X,
      title: 'قیمت ۱۰۰ تومان شد',
      body: 'روایت چهارم.',
    });
    for (const id of ['item-num-1', 'item-num-2', 'item-num-3', 'item-num-4']) {
      expect(await enqueueAndRun(harness, id)).toEqual(['ack:job_completed']);
    }
    expect(harness.providerCalls).toBe(4);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(4);
  });

  it('different full text with an apparently EQUAL excerpt (truncation point beyond) never reuses', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    const sharedTitle = 'تیتر بلند مشترک برای برابری ظاهری گزیده';
    await seedItem(harness.rawExecutor, {
      id: 'item-exc-1',
      sourceId: SOURCE_X,
      title: sharedTitle,
      body: 'X'.repeat(5000),
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-exc-2',
      sourceId: SOURCE_X,
      title: sharedTitle,
      body: `${'X'.repeat(4000)}${'Y'.repeat(1000)}`,
    });
    expect(await enqueueAndRun(harness, 'item-exc-1')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(harness, 'item-exc-2')).toEqual(['ack:job_completed']);
    // The 4000-char excerpts coincide; the FULL compositions differ → NO reuse.
    expect(harness.providerCalls).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });
});

describe('R1.15 scenario 7 — a fingerprint inconsistent with the real text NEVER causes a wrong reuse', () => {
  it('the locator matches but the byte-comparison refuses; the item proceeds independently', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    // A historical-shaped story whose content_hash fingerprint LIES: the
    // indexed digest equals the arriving text's digest, but the story's
    // REAL attached item text is different (seeded corruption).
    const realTitle = 'متن واقعی کاملاً متفاوت';
    const realBody = 'این متن واقعیِ ذخیره‌شده است و با اثر انگشت همخوان نیست.';
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-corrupt-ref',
      sourceId: SOURCE_X,
      title: realTitle,
      body: realBody,
      storyId: 'edst_corrupt_ref',
      withContentFingerprint: false,
    });
    const lyingDigest = await exactContentDigest('تیتر خبر تکراری\n\nبدنهٔ خبر تکراری.');
    await harness.rawExecutor.run({
      sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
            VALUES ('edst_corrupt_ref', 'content_hash', ?, ?)`,
      params: [`sc1:${lyingDigest}:edst_corrupt_ref`, NOW],
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-corrupt-arriving',
      sourceId: SOURCE_X,
      title: 'تیتر خبر تکراری',
      body: 'بدنهٔ خبر تکراری.',
    });
    expect(await enqueueAndRun(harness, 'item-corrupt-arriving')).toEqual(['ack:job_completed']);
    // NO reuse: the arriving item got its OWN story + draft (one provider call).
    expect(harness.providerCalls).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(2);
    const arrivingClaim = await harness.rawExecutor.first<{ story_id: string }>({
      sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
             WHERE e.source_item_id = 'item-corrupt-arriving'`,
    });
    expect(arrivingClaim!.story_id).not.toBe('edst_corrupt_ref');
  });
});

describe('R1.15 scenario 8 — a reference without a usable draft: defined outcome, no fake success', () => {
  it('a fingerprint-matching story with NO usable draft is never a reuse target', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    // Historical story WITH the content fingerprint but a FAILED draft.
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-dead-ref',
      sourceId: SOURCE_X,
      title: 'تیتر مرجع بی‌پیش‌نویس',
      body: 'بدنهٔ مرجع بی‌پیش‌نویس.',
      storyId: 'edst_dead_ref',
      draftStatus: 'failed',
      withContentFingerprint: true,
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-dead-arriving',
      sourceId: SOURCE_X,
      title: 'تیتر مرجع بی‌پیش‌نویس',
      body: 'بدنهٔ مرجع بی‌پیش‌نویس.',
    });
    expect(await enqueueAndRun(harness, 'item-dead-arriving')).toEqual(['ack:job_completed']);
    // The item honestly produced its OWN independent result.
    expect(harness.providerCalls).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(2);
    const arrivingClaim = await harness.rawExecutor.first<{ story_id: string }>({
      sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
             WHERE e.source_item_id = 'item-dead-arriving'`,
    });
    expect(arrivingClaim!.story_id).not.toBe('edst_dead_ref');
  });
});

describe('R1.15 scenario 13 — REAL interleaving: exactly ONE stable result, both provenances kept', () => {
  it('the loser of the anchor race records its REAL run and retries into verified reuse', async () => {
    let insideNestedRun = false;
    const harness = createHarness({
      onProviderCall: async (evidenceId) => {
        if (evidenceId !== 'item-race-1' || insideNestedRun) {
          return;
        }
        insideNestedRun = true;
        try {
          // INSIDE the first item's provider-call window (after its lookup,
          // before its commit): the SECOND item runs its WHOLE real path
          // and COMMITS first — the honest interleaving point.
          expect(await enqueueAndRun(harness, 'item-race-2')).toEqual(['ack:job_completed']);
        } finally {
          insideNestedRun = false;
        }
      },
    });
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    const title = 'تیتر رقابت همزمان';
    const body = 'بدنهٔ یکسان برای هر دو خبرِ همزمان.';
    await seedItem(harness.rawExecutor, {
      id: 'item-race-1',
      sourceId: SOURCE_X,
      title,
      body,
      url: null,
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-race-2',
      sourceId: SOURCE_X,
      title,
      body,
      url: null,
    });

    expect(await enqueueAndRun(harness, 'item-race-1')).toEqual(['ack:retry_scheduled']);
    // The anchor collision consumed ONE real provider call and scheduled
    // the bounded retry. Advance past the backoff and let generation 2 run.
    harness.clock.advance(2_001);
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);

    // Exactly ONE stable result — the anchor made a second one impossible.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    // BOTH items processed; BOTH provenances durably attached.
    const statuses = await itemStatuses(harness.rawExecutor, ['item-race-1', 'item-race-2']);
    expect(statuses.map((row) => row.processing_status)).toEqual(['processed', 'processed']);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'evidence')).toBe(2);
    const attachedStoryIds = await harness.rawExecutor.query<{ story_id: string }>({
      sql: `SELECT DISTINCT c.story_id FROM claims c
             JOIN evidence e ON e.claim_id = c.id
            WHERE e.source_item_id IN ('item-race-1', 'item-race-2')`,
    });
    expect(attachedStoryIds.rows).toHaveLength(1);

    // The loser's REAL provider run is durably recorded (charged, honest)
    // but referenced by NO draft — never presented as used.
    expect(harness.providerCalls).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(2);
    const orphanedRuns = await harness.rawExecutor.query<{ id: string }>({
      sql: 'SELECT id FROM ai_runs WHERE id NOT IN (SELECT ai_run_id FROM drafts)',
    });
    expect(orphanedRuns.rows).toHaveLength(1);
  });
});

describe('R1.15 — failure windows of the reuse commit (fence, snapshot, atomicity)', () => {
  it('an expired lease makes the reuse commit write NOTHING (store-level fence proof)', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-fence-ref',
      sourceId: SOURCE_X,
      title: 'تیتر نردهٔ reuse',
      body: 'بدنهٔ نردهٔ reuse.',
      storyId: 'edst_reuse_fence_ref',
      withContentFingerprint: true,
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-fence-arriving',
      sourceId: SOURCE_X,
      title: 'تیتر نردهٔ reuse',
      body: 'بدنهٔ نردهٔ reuse.',
    });
    const enqueue = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: 'item-fence-arriving',
    });
    expect(enqueue).toMatchObject({ kind: 'created' });
    const jobId = enqueue.kind === 'created' ? enqueue.jobId : '';
    const claimed = await claimJob(harness.rawExecutor, jobId, NOW, 2 * 60 * 1000);
    if (claimed.kind !== 'claimed') {
      throw new Error('expected claim');
    }
    const itemHash = await sha256Hex(
      'item-fence-arriving\u001fتیتر نردهٔ reuse\u001fبدنهٔ نردهٔ reuse.',
    );
    const referenceHash = await sha256Hex(
      'item-fence-ref\u001fتیتر نردهٔ reuse\u001fبدنهٔ نردهٔ reuse.',
    );
    const claimId = await sourceReportClaimId('edst_reuse_fence_ref', 'item-fence-arriving');
    const stale = await commitEditorialReuse(harness.rawExecutor, {
      jobId,
      generation: claimed.generation,
      fenceNowMs: NOW + 10 * 60 * 1000, // lease expired → fence fails
      snapshot: {
        sourceItemId: 'item-fence-arriving',
        sourceId: SOURCE_X,
        contentHash: itemHash,
      },
      // R1.15.1: the comparison basis carried INTO the SQL predicate — the
      // seeded draft's document bytes and the story's ORIGINAL reference
      // row identity (item-fence-ref, as seeded).
      target: {
        storyId: 'edst_reuse_fence_ref',
        draftVersion: EDITORIAL_DRAFT_VERSION,
        documentJson: '{}',
        referenceItemId: 'item-fence-ref',
        referenceContentHash: referenceHash,
      },
      claim: {
        id: claimId,
        storyId: 'edst_reuse_fence_ref',
        claimType: 'source_report',
        subject: 's',
        predicate: 'reported',
        objectText: 'o',
        confidence: 0,
        status: 'unverified',
        createdAt: NOW,
      },
      evidence: {
        id: await mentionsEvidenceId(claimId, 'item-fence-arriving'),
        claimId,
        sourceItemId: 'item-fence-arriving',
        stance: 'mentions',
        confidence: 0,
        excerpt: 'e',
        createdAt: NOW,
      },
    });
    expect(stale).toMatchObject({
      attached: false,
      sourceItemProcessed: false,
      alreadyAttached: false,
      fenceLost: true,
      snapshotChanged: false,
      targetInvalid: false,
    });
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(1); // only the seeded one
    const arriving = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-fence-arriving'],
    });
    expect(arriving!.processing_status).toBe('new');
  });

  it('a snapshot mutation before the reuse commit writes NOTHING and dead-letters distinctly', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-snap-ref',
      sourceId: SOURCE_X,
      title: 'تیتر مسابقهٔ اسنپ‌شات reuse',
      body: 'بدنهٔ مسابقهٔ اسنپ‌شات reuse.',
      storyId: 'edst_reuse_snap_ref',
      withContentFingerprint: true,
      realisticDocument: true, // R1.15.1: a verifiable pipeline-shaped document
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-snap-arriving',
      sourceId: SOURCE_X,
      title: 'تیتر مسابقهٔ اسنپ‌شات reuse',
      body: 'بدنهٔ مسابقهٔ اسنپ‌شات reuse.',
    });
    harness.mutateBeforeReuseCommit(async (raw) => {
      await raw.run({
        sql: "UPDATE source_items SET content_hash = ? WHERE id = 'item-snap-arriving'",
        params: [await sha256Hex('a-brand-new-reuse-snapshot')],
      });
    });
    expect(await enqueueAndRun(harness, 'item-snap-arriving')).toEqual(['ack:job_dead_lettered']);
    // ZERO effects: no second claim, no processed flip.
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(1);
    const arriving = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-snap-arriving'],
    });
    expect(arriving!.processing_status).toBe('new');
  });

  it('a mid-batch reuse failure leaves NO orphan relation and NO fake processed, then succeeds on retry', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-atomic-ref',
      sourceId: SOURCE_X,
      title: 'تیتر اتمی بودن reuse',
      body: 'بدنهٔ اتمی بودن reuse.',
      storyId: 'edst_reuse_atomic_ref',
      withContentFingerprint: true,
      realisticDocument: true, // R1.15.1: a verifiable pipeline-shaped document
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-atomic-arriving',
      sourceId: SOURCE_X,
      title: 'تیتر اتمی بودن reuse',
      body: 'بدنهٔ اتمی بودن reuse.',
    });
    // Fail ONLY the reuse batch (claim+evidence+flip, no story insert),
    // ONCE — the retry must then land cleanly.
    let failedOnce = false;
    harness.failBatchesMatching((statements) => {
      const isReuseBatch =
        statements.some((statement) => statement.sql.includes('INSERT INTO claims')) &&
        !statements.some((statement) => statement.sql.includes('INSERT INTO stories'));
      if (isReuseBatch && !failedOnce) {
        failedOnce = true;
        return true;
      }
      return false;
    });
    expect(await enqueueAndRun(harness, 'item-atomic-arriving')).toEqual(['ack:retry_scheduled']);
    harness.clock.advance(2_001);
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(0); // NEVER a provider call in reuse
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'evidence')).toBe(2);
    const arriving = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-atomic-arriving'],
    });
    expect(arriving!.processing_status).toBe('processed');
  });
});

describe('R1.15 scenario 12 — replay of the first AND the reused item is free', () => {
  it('re-execution finds the stable result / the durable attachment with zero new effects', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    const title = 'تیتر بازپخش رایگان';
    const body = 'بدنهٔ بازپخش رایگان.';
    await seedItem(harness.rawExecutor, { id: 'item-rep-a', sourceId: SOURCE_X, title, body });
    await seedItem(harness.rawExecutor, { id: 'item-rep-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(harness, 'item-rep-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(harness, 'item-rep-b')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1);
    const before = {
      stories: await rowCount(harness.rawExecutor, 'stories'),
      drafts: await rowCount(harness.rawExecutor, 'drafts'),
      claims: await rowCount(harness.rawExecutor, 'claims'),
      aiRuns: await rowCount(harness.rawExecutor, 'ai_runs'),
    };

    // Replay item-a: enqueue resolves to the SAME job ('existing') and a
    // direct handler re-execution finds the stable result — free.
    const enqueueA = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: 'item-rep-a',
    });
    expect(enqueueA).toMatchObject({ kind: 'existing' });
    // Replay item-b: the durable attachment answers before any work.
    const enqueueB = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: 'item-rep-b',
    });
    expect(enqueueB).toMatchObject({ kind: 'existing' });

    // No new durable state appeared; the reusing item's job stays succeeded.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(before.stories);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(before.drafts);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(before.claims);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(before.aiRuns);
    expect(harness.providerCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R1.15.1 — the real REPLAY HANDLER executions and the reference-mutation
// regression (Posidon R1.15.1 test contract items 1+2). enqueue=existing
// alone never exercises the fast-path HANDLER: here the engine RE-CLAIMS
// the durable job (the documented at-least-once window — the terminal write
// was lost) and the handler re-runs in a REAL new generation.
// ---------------------------------------------------------------------------
describe('R1.15.1 — real replay handler re-execution is free, proven, and side-effect-free', () => {
  it('re-running the handler for a NORMAL and a REUSED item answers with ZERO new effects and ZERO provider calls', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    const title = 'تیتر بازپخش واقعی';
    const body = 'بدنهٔ بازپخش واقعی.';
    await seedItem(harness.rawExecutor, { id: 'item-realrep-a', sourceId: SOURCE_X, title, body });
    await seedItem(harness.rawExecutor, { id: 'item-realrep-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(harness, 'item-realrep-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(harness, 'item-realrep-b')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1);
    const before = {
      stories: await rowCount(harness.rawExecutor, 'stories'),
      drafts: await rowCount(harness.rawExecutor, 'drafts'),
      claims: await rowCount(harness.rawExecutor, 'claims'),
      evidence: await rowCount(harness.rawExecutor, 'evidence'),
      aiRuns: await rowCount(harness.rawExecutor, 'ai_runs'),
      fingerprints: await rowCount(harness.rawExecutor, 'story_fingerprints'),
      jobsSucceeded: await harness.rawExecutor.first<{ n: number }>({
        sql: "SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded'",
      }),
    };
    expect(before.jobsSucceeded?.n).toBe(2);

    // The at-least-once window: the terminal bookkeeping was lost, so BOTH
    // durable jobs become dispatchable again. The engine re-claims each and
    // the handler RE-EXECUTES for real (a NEW generation).
    for (const itemId of ['item-realrep-a', 'item-realrep-b']) {
      await harness.rawExecutor.run({
        sql: "UPDATE jobs SET status = 'pending', run_after = ?, lease_until = NULL\n               WHERE aggregate_id = ? AND status = 'succeeded'",
        params: [NOW, itemId],
      });
    }
    harness.clock.advance(1);
    const outcomes = await runPipeline(harness);
    expect(outcomes.sort()).toEqual(['ack:job_completed', 'ack:job_completed']);
    // The replay fast-paths are REAL: the stable result (item A) and the
    // PROVEN durable attachment (item B — verified against the draft's
    // immutable document basis) answered with ZERO new durable effects and
    // ZERO provider involvement.
    expect(harness.providerCalls).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(before.stories);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(before.drafts);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(before.claims);
    expect(await rowCount(harness.rawExecutor, 'evidence')).toBe(before.evidence);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(before.aiRuns);
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(before.fingerprints);
    const statuses = await itemStatuses(harness.rawExecutor, ['item-realrep-a', 'item-realrep-b']);
    expect(statuses.map((row) => row.processing_status)).toEqual(['processed', 'processed']);
  });

  it('P2 regression — a reference mutated BEFORE verification never attributes the mutated text to the old draft', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    // A shared URL makes the mutated reference story DISCOVERABLE — the
    // strongest form of this regression: the candidate IS probed, and the
    // decision must still refuse.
    await seedItem(harness.rawExecutor, {
      id: 'item-premut-a',
      sourceId: SOURCE_X,
      title: 'Original title',
      body: 'Original body',
      url: 'https://shared.example/premut',
    });
    expect(await enqueueAndRun(harness, 'item-premut-a')).toEqual(['ack:job_completed']);
    const storyAfterA = await harness.rawExecutor.first<{ story_id: string }>({
      sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
             WHERE e.source_item_id = 'item-premut-a'`,
    });
    // The reference is mutated BEFORE the arriving item is even enqueued:
    // the row now carries NEW text under a NEW snapshot identity.
    await harness.rawExecutor.run({
      sql: "UPDATE source_items SET title = ?, body_excerpt = ?, content_hash = ? WHERE id = 'item-premut-a'",
      params: [
        'Changed reference',
        'Different reference',
        await sha256Hex('reference-changed-pre-verification'),
      ],
    });
    // The arriving item's text equals the MUTATED text — the ONLY way it
    // could wrongly attach to the old draft is by comparing against the
    // mutated mutable row. The immutable document basis refuses.
    await seedItem(harness.rawExecutor, {
      id: 'item-premut-b',
      sourceId: SOURCE_Y,
      title: 'Changed reference',
      body: 'Different reference',
      url: 'https://shared.example/premut',
    });
    expect(await enqueueAndRun(harness, 'item-premut-b')).toEqual(['ack:job_completed']);
    // The mutated text took its OWN independent path: a real provider call,
    // its own story and draft — NEVER the old draft.
    expect(harness.providerCalls).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(2);
    const arrivingClaim = await harness.rawExecutor.first<{ story_id: string }>({
      sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
             WHERE e.source_item_id = 'item-premut-b'`,
    });
    expect(arrivingClaim!.story_id).not.toBe(storyAfterA!.story_id);
    // The old draft's own document was never rewritten to fake a new basis.
    const oldDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: `SELECT d.document_json FROM drafts d WHERE d.story_id = ?`,
      params: [storyAfterA!.story_id],
    });
    expect(oldDraft!.document_json).toContain('Original title');
  });
});

describe('R1.15 scenario 14 — historical results behave consistently within the honest limits', () => {
  it('a pre-fingerprint historical story is NEVER consulted (no backfill); an R1.13-era fingerprinted story IS reusable', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    // (a) pre-R1.13 story: ready draft, NO fingerprints at all.
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-hist-nofp',
      sourceId: SOURCE_X,
      title: 'تیتر تاریخی بدون اثر انگشت',
      body: 'بدنهٔ تاریخی بدون اثر انگشت.',
      storyId: 'edst_hist_nofp',
      withContentFingerprint: false,
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-hist-arriving',
      sourceId: SOURCE_X,
      title: 'تیتر تاریخی بدون اثر انگشت',
      body: 'بدنهٔ تاریخی بدون اثر انگشت.',
    });
    expect(await enqueueAndRun(harness, 'item-hist-arriving')).toEqual(['ack:job_completed']);
    // The limitation: no sc1 content fingerprint → NOT found → independent.
    expect(harness.providerCalls).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);

    // (b) R1.13-era story: story-scoped content fingerprint, NO anchor —
    //     the verified reuse DOES cover it. R1.15.1 assertion basis (documented):
    //     the reuse decision verifies the draft's IMMUTABLE document record,
    //     so the seeded historical draft carries the PRODUCTION document shape
    //     (built with the real mappers) — exactly what a real R1.13-era
    //     pipeline commit wrote. '{}' foreign shapes are honestly NOT reusable.
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-hist-fp',
      sourceId: SOURCE_X,
      title: 'تیتر تاریخی دارای اثر انگشت',
      body: 'بدنهٔ تاریخی دارای اثر انگشت.',
      storyId: 'edst_hist_fp',
      withContentFingerprint: true,
      realisticDocument: true,
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-hist-arriving-2',
      sourceId: SOURCE_X,
      title: 'تیتر تاریخی دارای اثر انگشت',
      body: 'بدنهٔ تاریخی دارای اثر انگشت.',
    });
    expect(await enqueueAndRun(harness, 'item-hist-arriving-2')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1); // reused — no new call
    // Stories: hist-nofp (seeded) + its arriving item's own + hist-fp
    // (seeded) = 3 — the reuse added NO story. Drafts likewise 3.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(3);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(3);
    const attached = await harness.rawExecutor.first<{ story_id: string }>({
      sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
             WHERE e.source_item_id = 'item-hist-arriving-2'`,
    });
    expect(attached!.story_id).toBe('edst_hist_fp');
  });
});

describe('R1.15 — the group anchor at the SQL layer (concurrency primitive)', () => {
  /** A REAL claimed durable job for one item — the fence needs it. */
  async function claimedJobFor(
    harness: Harness,
    itemId: string,
  ): Promise<{ jobId: string; generation: number }> {
    const enqueue = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: itemId,
    });
    expect(enqueue).toMatchObject({ kind: 'created' });
    const jobId = enqueue.kind === 'created' ? enqueue.jobId : '';
    const claim = await claimJob(harness.rawExecutor, jobId, NOW, 2 * 60 * 1000);
    if (claim.kind !== 'claimed') {
      throw new Error('expected claim');
    }
    return { jobId, generation: claim.generation };
  }

  function commitInputFor(input: {
    readonly jobId: string;
    readonly generation: number;
    readonly itemId: string;
    readonly title: string;
    readonly body: string;
    readonly storyId: string;
    readonly storyKey: string;
  }): Omit<Parameters<typeof commitEditorialResult>[1], 'exactContentAnchor'> {
    return {
      jobId: input.jobId,
      generation: input.generation,
      fenceNowMs: NOW,
      entityMentions: [],
      snapshot: {
        sourceItemId: input.itemId,
        sourceId: SOURCE_X,
        contentHash: sha256HexSync(`${input.itemId}\u001f${input.title}\u001f${input.body}`),
      },
      story: {
        id: input.storyId,
        storyKey: input.storyKey,
        workingHeadline: null,
        createdAt: NOW,
      },
      claim: {
        id: `edcl_${input.storyId}`,
        storyId: input.storyId,
        claimType: 'source_report',
        subject: 's',
        predicate: 'reported',
        objectText: 'o',
        confidence: 0,
        status: 'unverified',
        createdAt: NOW,
      },
      evidence: {
        id: `edev_${input.storyId}`,
        claimId: `edcl_${input.storyId}`,
        sourceItemId: input.itemId,
        stance: 'mentions',
        confidence: 0,
        excerpt: 'e',
        createdAt: NOW,
      },
      aiRun: {
        id: `edai_${input.storyId}`,
        task: 'news_draft',
        provider: 'p',
        model: 'm',
        promptVersion: 'v',
        inputHash: 'h',
        status: 'succeeded',
        latencyMs: 1,
        inputTokens: null,
        outputTokens: null,
        errorCode: null,
        errorMessage: null,
        createdAt: NOW,
        completedAt: NOW,
      },
      draft: {
        id: `eddr_${input.storyId}`,
        storyId: input.storyId,
        status: 'ready',
        language: 'fa',
        layout: 'news_v1',
        title: 't',
        documentJson: '{}',
        factsJson: '[]',
        warningsJson: '[]',
        aiRunId: `edai_${input.storyId}`,
        version: 1,
        createdBy: 'test',
        createdAt: NOW,
      },
      fingerprints: [],
    };
  }

  // sha256Hex is async; a tiny sync-shaped bridge for the input builder.
  let shaCache = new Map<string, string>();
  function sha256HexSync(input: string): string {
    const cached = shaCache.get(input);
    if (cached !== undefined) {
      return cached;
    }
    throw new Error(`sha not precomputed: ${input}`);
  }

  it('a second commit of the SAME exact content collides on the anchor: ZERO effects, typed contentTaken', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    const title = 'تیتر لنگر گروه';
    const body = 'بدنهٔ لنگر گروه.';
    await seedItem(harness.rawExecutor, { id: 'item-anchor-1', sourceId: SOURCE_X, title, body });
    await seedItem(harness.rawExecutor, { id: 'item-anchor-2', sourceId: SOURCE_X, title, body });
    shaCache = new Map([
      [
        `item-anchor-1\u001f${title}\u001f${body}`,
        await sha256Hex(`item-anchor-1\u001f${title}\u001f${body}`),
      ],
      [
        `item-anchor-2\u001f${title}\u001f${body}`,
        await sha256Hex(`item-anchor-2\u001f${title}\u001f${body}`),
      ],
    ]);

    // The FIRST commit succeeds and plants the group anchor.
    const digest = await exactContentDigest(buildFullEvidenceText({ title, body_excerpt: body }));
    const anchor = { kind: 'content_hash' as const, value: exactContentAnchorValue(digest) };
    const job1 = await claimedJobFor(harness, 'item-anchor-1');
    const first = await commitEditorialResult(harness.rawExecutor, {
      ...commitInputFor({
        jobId: job1.jobId,
        generation: job1.generation,
        itemId: 'item-anchor-1',
        title,
        body,
        storyId: 'edst_anchor_1',
        storyKey: 'seeded-anchor-1',
      }),
      exactContentAnchor: anchor,
    });
    expect(first).toMatchObject({
      draftInserted: true,
      storyInserted: true,
      sourceItemProcessed: true,
      contentTaken: false,
    });
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(1); // the anchor

    // A DIFFERENT item, the SAME exact content, a DIFFERENT story id — the
    // anchor's PRIMARY KEY collides and the WHOLE batch writes NOTHING.
    const job2 = await claimedJobFor(harness, 'item-anchor-2');
    const second = await commitEditorialResult(harness.rawExecutor, {
      ...commitInputFor({
        jobId: job2.jobId,
        generation: job2.generation,
        itemId: 'item-anchor-2',
        title,
        body,
        storyId: 'edst_anchor_2',
        storyKey: 'seeded-anchor-2',
      }),
      exactContentAnchor: anchor,
    });
    expect(second).toMatchObject({
      draftInserted: false,
      storyInserted: false,
      sourceItemProcessed: false,
      fingerprintsInserted: 0,
      contentTaken: true,
      fenceLost: false,
      snapshotChanged: false,
    });
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(1);
    const secondItem = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-anchor-2'],
    });
    expect(secondItem!.processing_status).toBe('new');

    // A DIFFERENT content commits fine under its OWN fence (its own anchor).
    const otherTitle = 'تیتر دیگر برای لنگر سوم';
    const otherBody = 'بدنهٔ دیگر برای لنگر سوم.';
    await seedItem(harness.rawExecutor, {
      id: 'item-anchor-3',
      sourceId: SOURCE_X,
      title: otherTitle,
      body: otherBody,
    });
    shaCache.set(
      `item-anchor-3\u001f${otherTitle}\u001f${otherBody}`,
      await sha256Hex(`item-anchor-3\u001f${otherTitle}\u001f${otherBody}`),
    );
    const otherDigest = await exactContentDigest(
      buildFullEvidenceText({ title: otherTitle, body_excerpt: otherBody }),
    );
    const job3 = await claimedJobFor(harness, 'item-anchor-3');
    const third = await commitEditorialResult(harness.rawExecutor, {
      ...commitInputFor({
        jobId: job3.jobId,
        generation: job3.generation,
        itemId: 'item-anchor-3',
        title: otherTitle,
        body: otherBody,
        storyId: 'edst_anchor_3',
        storyKey: 'seeded-anchor-3',
      }),
      exactContentAnchor: {
        kind: 'content_hash' as const,
        value: exactContentAnchorValue(otherDigest),
      },
    });
    expect(third).toMatchObject({ draftInserted: true, contentTaken: false });
  });

  it('reference items of a story are readable through its source_report claims (verification basis)', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-refcheck',
      sourceId: SOURCE_X,
      title: 'تیتر وارسی مراجع',
      body: 'بدنهٔ وارسی مراجع.',
      storyId: 'edst_refcheck',
      withContentFingerprint: true,
    });
    const references = await findStoryReferenceItems(harness.rawExecutor, 'edst_refcheck', 8);
    expect(references).toHaveLength(1);
    expect(references[0]!.id).toBe('item-refcheck');
    expect(buildFullEvidenceText(references[0]!)).toBe(
      buildFullEvidenceText({ title: 'تیتر وارسی مراجع', body_excerpt: 'بدنهٔ وارسی مراجع.' }),
    );
  });
});

// ---------------------------------------------------------------------------
// R1.15.1 — Posidon's THREE independent counterexamples (recorded RED on the
// R1.15 baseline, required GREEN after the exact-content reuse correctness
// fix). Appended to THIS suite with the SAME helpers; the assertions are the
// reviewer's own and are not weakened.
// ---------------------------------------------------------------------------
describe('Posidon R115 independent counterexamples', () => {
  it('P1 a NEW snapshot of an already attached item must not be acknowledged by the OLD attachment', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    await seedItem(h.rawExecutor, {
      id: 'proof-a',
      sourceId: SOURCE_X,
      title: 'Original title',
      body: 'Original body',
    });
    await seedItem(h.rawExecutor, {
      id: 'proof-b',
      sourceId: SOURCE_Y,
      title: 'Original title',
      body: 'Original body',
    });
    expect(await enqueueAndRun(h, 'proof-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(h, 'proof-b')).toEqual(['ack:job_completed']);
    const newHash = await sha256Hex('genuinely-new-snapshot');
    await h.rawExecutor.run({
      sql: "UPDATE source_items SET title=?, body_excerpt=?, content_hash=?, processing_status='new' WHERE id=?",
      params: ['Completely changed title', 'Completely changed body', newHash, 'proof-b'],
    });
    const outcomes = await enqueueAndRun(h, 'proof-b');
    // eslint-disable-next-line no-console
    console.log(
      'P1 observed',
      JSON.stringify({
        outcomes,
        providerCalls: h.providerCalls,
        statuses: await itemStatuses(h.rawExecutor, ['proof-b']),
        drafts: await rowCount(h.rawExecutor, 'drafts'),
      }),
    );
    expect(h.providerCalls).toBe(2);
    expect(await rowCount(h.rawExecutor, 'drafts')).toBe(2);
  });

  it('P2 reference snapshot mutation between comparison and reuse commit must prevent attachment', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    await seedItem(h.rawExecutor, {
      id: 'proof-r-a',
      sourceId: SOURCE_X,
      title: 'Shared title',
      body: 'Shared body',
    });
    await seedItem(h.rawExecutor, {
      id: 'proof-r-b',
      sourceId: SOURCE_Y,
      title: 'Shared title',
      body: 'Shared body',
    });
    expect(await enqueueAndRun(h, 'proof-r-a')).toEqual(['ack:job_completed']);
    h.mutateBeforeReuseCommit(async (raw) => {
      await raw.run({
        sql: 'UPDATE source_items SET title=?, body_excerpt=?, content_hash=? WHERE id=?',
        params: [
          'Changed reference',
          'Different reference',
          await sha256Hex('reference-changed'),
          'proof-r-a',
        ],
      });
    });
    const outcomes = await enqueueAndRun(h, 'proof-r-b');
    const claims = await rowCount(h.rawExecutor, 'claims');
    // eslint-disable-next-line no-console
    console.log(
      'P2 observed',
      JSON.stringify({
        outcomes,
        claims,
        statuses: await itemStatuses(h.rawExecutor, ['proof-r-b']),
      }),
    );
    expect(claims).toBe(1);
  });

  it('P3 a valid anchor owner outside the 9-row candidate page must still be reusable without a new charge', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    const title = 'Actual original title';
    const body = 'Actual original body';
    await seedItem(h.rawExecutor, { id: 'proof-page-a', sourceId: SOURCE_X, title, body });
    expect(await enqueueAndRun(h, 'proof-page-a')).toEqual(['ack:job_completed']);
    const digest = await exactContentDigest(buildFullEvidenceText({ title, body_excerpt: body }));
    for (let i = 0; i < 9; i++) {
      const sid = `edst_00000_${i}`;
      await seedHistoricalStory(h.rawExecutor, {
        itemId: `proof-lying-${i}`,
        sourceId: SOURCE_X,
        title: `Different ${i}`,
        body: 'Unrelated body',
        storyId: sid,
      });
      await h.rawExecutor.run({
        sql: "INSERT INTO story_fingerprints (story_id,kind,value,created_at) VALUES (?, 'content_hash', ?, ?)",
        params: [sid, `sc1:${digest}:${sid}`, NOW],
      });
    }
    await seedItem(h.rawExecutor, { id: 'proof-page-b', sourceId: SOURCE_Y, title, body });
    const outcomes = await enqueueAndRun(h, 'proof-page-b');
    // eslint-disable-next-line no-console
    console.log(
      'P3 observed',
      JSON.stringify({
        outcomes,
        providerCalls: h.providerCalls,
        statuses: await itemStatuses(h.rawExecutor, ['proof-page-b']),
      }),
    );
    expect(outcomes).toEqual(['ack:job_completed']);
    expect(h.providerCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R1.15.2 — Posidon snapshot-identity regression (Q1): a NEW raw snapshot of
// the reusing item (edge-space title change → NEW content_hash) with the
// SAME composed text (the pre-existing trim contract of
// `buildFullEvidenceText`) must NOT be silently acknowledged by the OLD
// snapshot's relation: its OWN versioned relation + processed flip must land
// durably through the fenced atomic path — with ZERO new provider calls.
// ---------------------------------------------------------------------------
describe('Posidon R1151 snapshot regression', () => {
  it('Q1 a new raw snapshot with equal composed text must be processed, not silently acknowledged as the old attachment', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    const title = 'Same composed title';
    const body = 'Same composed body';
    await seedItem(h.rawExecutor, { id: 'q1-a', sourceId: SOURCE_X, title, body });
    await seedItem(h.rawExecutor, { id: 'q1-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(h, 'q1-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(h, 'q1-b')).toEqual(['ack:job_completed']);
    const newTitle = `${title} `;
    // The NEW content_hash uses the existing fixture's actual hash convention
    // (seedItem: `${id}\u001f${title}\u001f${body}`) — a genuinely new
    // snapshot identity for the edge-space title change.
    const newHash = await sha256Hex(`q1-b\u001f${newTitle}\u001f${body}`);
    expect(buildFullEvidenceText({ title: newTitle, body_excerpt: body })).toBe(
      buildFullEvidenceText({ title, body_excerpt: body }),
    );
    await h.rawExecutor.run({
      sql: "UPDATE source_items SET title=?,content_hash=?,processing_status='new' WHERE id=?",
      params: [newTitle, newHash, 'q1-b'],
    });
    const result = await enqueueAndRun(h, 'q1-b');
    const statuses = await itemStatuses(h.rawExecutor, ['q1-b']);
    // eslint-disable-next-line no-console
    console.log(
      'Q1 observed',
      JSON.stringify({ result, statuses, providerCalls: h.providerCalls }),
    );
    expect(result).toEqual(['ack:job_completed']);
    expect(h.providerCalls).toBe(1);
    expect(statuses[0]!.processing_status).toBe('processed');
  });
});

// ---------------------------------------------------------------------------
// R1.15.2 — the snapshot-identity boundary of the reuse relation: the
// durable versioned identity, the independent path of a CHANGED text, the
// write-free same-snapshot replay, and the mutation window between
// new-snapshot verification and commit.
// ---------------------------------------------------------------------------
describe('R1.15.2 — snapshot identity of the reuse relation', () => {
  it('the new snapshot lands its OWN versioned relation while the old relation stays intact (durable distinction, not just status)', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    const title = 'Durable distinction title';
    const body = 'Durable distinction body';
    await seedItem(h.rawExecutor, { id: 'q1d-a', sourceId: SOURCE_X, title, body });
    await seedItem(h.rawExecutor, { id: 'q1d-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(h, 'q1d-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(h, 'q1d-b')).toEqual(['ack:job_completed']);
    const oldHashB = await sha256Hex(`q1d-b\u001f${title}\u001f${body}`);
    const storyAId = await storyIdForSnapshot(
      'q1d-a',
      await sha256Hex(`q1d-a\u001f${title}\u001f${body}`),
    );
    const oldReuseClaimId = await exactContentReuseClaimId(storyAId, 'q1d-b', oldHashB);
    // The FIRST reuse already carried the versioned identity (old snapshot).
    const oldClaim = await h.rawExecutor.first<{
      id: string;
      story_id: string;
      claim_type: string;
    }>({
      sql: 'SELECT id, story_id, claim_type FROM claims WHERE id = ?',
      params: [oldReuseClaimId],
    });
    expect(oldClaim).toMatchObject({
      id: oldReuseClaimId,
      story_id: storyAId,
      claim_type: 'source_report',
    });

    // A NEW raw snapshot: edge-space title, NEW hash, SAME composed text.
    const newTitle = `${title} `;
    const newHashB = await sha256Hex(`q1d-b\u001f${newTitle}\u001f${body}`);
    await h.rawExecutor.run({
      sql: "UPDATE source_items SET title=?,content_hash=?,processing_status='new' WHERE id='q1d-b'",
      params: [newTitle, newHashB],
    });
    expect(await enqueueAndRun(h, 'q1d-b')).toEqual(['ack:job_completed']);
    expect(h.providerCalls).toBe(1);

    // DURABLE distinction: the NEW snapshot's versioned relation exists —
    // the old relation is never rewritten, never replaced, never deleted.
    const newReuseClaimId = await exactContentReuseClaimId(storyAId, 'q1d-b', newHashB);
    const newClaim = await h.rawExecutor.first<{
      id: string;
      story_id: string;
      claim_type: string;
    }>({
      sql: 'SELECT id, story_id, claim_type FROM claims WHERE id = ?',
      params: [newReuseClaimId],
    });
    expect(newClaim).toMatchObject({
      id: newReuseClaimId,
      story_id: storyAId,
      claim_type: 'source_report',
    });
    expect(newReuseClaimId).not.toBe(oldReuseClaimId);
    // BOTH relations are durably retrievable WITH their evidence rows.
    expect(
      await h.rawExecutor.first({
        sql: 'SELECT id FROM evidence WHERE id = ?',
        params: [await mentionsEvidenceId(oldReuseClaimId, 'q1d-b')],
      }),
    ).not.toBeNull();
    expect(
      await h.rawExecutor.first({
        sql: 'SELECT id FROM evidence WHERE id = ?',
        params: [await mentionsEvidenceId(newReuseClaimId, 'q1d-b')],
      }),
    ).not.toBeNull();
    // Exactly THREE claims: the normal story's claim + the TWO versioned
    // reuse relations (one per snapshot — never merged, never duplicated).
    expect(await rowCount(h.rawExecutor, 'claims')).toBe(3);
    expect(await rowCount(h.rawExecutor, 'evidence')).toBe(3);
  });

  it('a changed hash with CHANGED composed text takes the honest independent path (no reuse, own story, old artifacts intact)', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    const title = 'Independent path title';
    const body = 'Independent path body';
    await seedItem(h.rawExecutor, { id: 'q1i-a', sourceId: SOURCE_X, title, body });
    await seedItem(h.rawExecutor, { id: 'q1i-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(h, 'q1i-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(h, 'q1i-b')).toEqual(['ack:job_completed']);
    expect(h.providerCalls).toBe(1);
    const storyAId = await storyIdForSnapshot(
      'q1i-a',
      await sha256Hex(`q1i-a\u001f${title}\u001f${body}`),
    );
    const oldDraft = await h.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts WHERE story_id = ?',
      params: [storyAId],
    });
    expect(oldDraft).not.toBeNull();

    // A genuinely DIFFERENT text under a NEW snapshot identity: the old
    // relation can neither acknowledge it nor be reused for it.
    const changedTitle = 'A genuinely different headline';
    const changedBody = 'A genuinely different body';
    const changedHash = await sha256Hex(`q1i-b\u001f${changedTitle}\u001f${changedBody}`);
    await h.rawExecutor.run({
      sql: "UPDATE source_items SET title=?,body_excerpt=?,content_hash=?,processing_status='new' WHERE id='q1i-b'",
      params: [changedTitle, changedBody, changedHash],
    });
    expect(await enqueueAndRun(h, 'q1i-b')).toEqual(['ack:job_completed']);
    // The independent path PAID its own way: one NEW provider call.
    expect(h.providerCalls).toBe(2);
    // The item has its OWN story (its snapshot story key), processed.
    const ownStoryId = await storyIdForSnapshot('q1i-b', changedHash);
    const ownClaim = await h.rawExecutor.first<{ id: string; story_id: string }>({
      sql: 'SELECT id, story_id FROM claims WHERE id = ?',
      params: [await sourceReportClaimId(ownStoryId, 'q1i-b')],
    });
    expect(ownClaim).toMatchObject({ story_id: ownStoryId });
    expect(await rowCount(h.rawExecutor, 'stories')).toBe(2);
    const statuses = await itemStatuses(h.rawExecutor, ['q1i-b']);
    expect(statuses[0]!.processing_status).toBe('processed');
    // The OLD artifacts are untouched: the reused draft's document was never
    // rewritten, and the old versioned reuse relation still names the OLD
    // snapshot only.
    expect(
      (await h.rawExecutor.first<{ document_json: string }>({
        sql: 'SELECT document_json FROM drafts WHERE story_id = ?',
        params: [storyAId],
      }))!.document_json,
    ).toBe(oldDraft!.document_json);
    const oldRelation = await h.rawExecutor.first<{ id: string }>({
      sql: 'SELECT id FROM claims WHERE id = ?',
      params: [
        await exactContentReuseClaimId(
          storyAId,
          'q1i-b',
          await sha256Hex(`q1i-b\u001f${title}\u001f${body}`),
        ),
      ],
    });
    expect(oldRelation).not.toBeNull();
  });

  it('the SAME-snapshot replay of a reused item stays write-free and charge-free through the versioned identity', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    const title = 'Replay identity title';
    const body = 'Replay identity body';
    await seedItem(h.rawExecutor, { id: 'q1r-a', sourceId: SOURCE_X, title, body });
    await seedItem(h.rawExecutor, { id: 'q1r-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(h, 'q1r-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(h, 'q1r-b')).toEqual(['ack:job_completed']);
    expect(h.providerCalls).toBe(1);
    const before = {
      stories: await rowCount(h.rawExecutor, 'stories'),
      drafts: await rowCount(h.rawExecutor, 'drafts'),
      claims: await rowCount(h.rawExecutor, 'claims'),
      evidence: await rowCount(h.rawExecutor, 'evidence'),
      aiRuns: await rowCount(h.rawExecutor, 'ai_runs'),
      fingerprints: await rowCount(h.rawExecutor, 'story_fingerprints'),
    };

    // The at-least-once window: the terminal bookkeeping was lost, so BOTH
    // durable jobs become dispatchable again and the handler RE-EXECUTES
    // for real (a NEW generation each).
    for (const itemId of ['q1r-a', 'q1r-b']) {
      await h.rawExecutor.run({
        sql: "UPDATE jobs SET status = 'pending', run_after = ?, lease_until = NULL WHERE aggregate_id = ? AND status = 'succeeded'",
        params: [NOW, itemId],
      });
    }
    h.clock.advance(1);
    const outcomes = await runPipeline(h);
    expect(outcomes.sort()).toEqual(['ack:job_completed', 'ack:job_completed']);
    // The reused item's replay is proven by the VERSIONED relation (claim id
    // = exact reuse identity of the CURRENT snapshot hash): ZERO new writes,
    // ZERO provider involvement.
    expect(h.providerCalls).toBe(1);
    expect(await rowCount(h.rawExecutor, 'stories')).toBe(before.stories);
    expect(await rowCount(h.rawExecutor, 'drafts')).toBe(before.drafts);
    expect(await rowCount(h.rawExecutor, 'claims')).toBe(before.claims);
    expect(await rowCount(h.rawExecutor, 'evidence')).toBe(before.evidence);
    expect(await rowCount(h.rawExecutor, 'ai_runs')).toBe(before.aiRuns);
    expect(await rowCount(h.rawExecutor, 'story_fingerprints')).toBe(before.fingerprints);
    const statuses = await itemStatuses(h.rawExecutor, ['q1r-b']);
    expect(statuses[0]!.processing_status).toBe('processed');
  });

  it('a mutation between new-snapshot verification and commit never fakes the processed flip (fenced, typed, recoverable)', async () => {
    const h = createHarness();
    await seedSource(h.rawExecutor, SOURCE_X, 'X');
    await seedSource(h.rawExecutor, SOURCE_Y, 'Y');
    const title = 'Mutation window title';
    const body = 'Mutation window body';
    await seedItem(h.rawExecutor, { id: 'q1m-a', sourceId: SOURCE_X, title, body });
    await seedItem(h.rawExecutor, { id: 'q1m-b', sourceId: SOURCE_Y, title, body });
    expect(await enqueueAndRun(h, 'q1m-a')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(h, 'q1m-b')).toEqual(['ack:job_completed']);
    const storyAId = await storyIdForSnapshot(
      'q1m-a',
      await sha256Hex(`q1m-a\u001f${title}\u001f${body}`),
    );
    const oldHashB = await sha256Hex(`q1m-b\u001f${title}\u001f${body}`);

    // A NEW raw snapshot with the SAME composed text — the old relation can
    // NOT prove it; the handler falls through to a verified new-snapshot
    // reuse whose fenced commit will be mutated mid-flight.
    const newTitle = `${title} `;
    const newHashB = await sha256Hex(`q1m-b\u001f${newTitle}\u001f${body}`);
    await h.rawExecutor.run({
      sql: "UPDATE source_items SET title=?,content_hash=?,processing_status='new' WHERE id='q1m-b'",
      params: [newTitle, newHashB],
    });
    h.mutateBeforeReuseCommit(async (raw) => {
      // Mutate the item's snapshot identity BETWEEN the verification read
      // and the atomic reuse commit — the SQL snapshot predicate must
      // no-op EVERY statement of the batch.
      await raw.run({
        sql: "UPDATE source_items SET content_hash = ? WHERE id = 'q1m-b'",
        params: [await sha256Hex('mutated-between-verification-and-commit')],
      });
    });
    expect(await enqueueAndRun(h, 'q1m-b')).toEqual(['ack:job_dead_lettered']);
    // ZERO provider involvement (the reuse path never reaches the AI) and
    // ZERO false effects: no processed flip, NO versioned relation for the
    // new snapshot, the old relation intact.
    expect(h.providerCalls).toBe(1);
    expect(await rowCount(h.rawExecutor, 'claims')).toBe(2);
    expect(
      await h.rawExecutor.first({
        sql: 'SELECT id FROM claims WHERE id = ?',
        params: [await exactContentReuseClaimId(storyAId, 'q1m-b', newHashB)],
      }),
    ).toBeNull();
    expect(
      await h.rawExecutor.first({
        sql: 'SELECT id FROM claims WHERE id = ?',
        params: [await exactContentReuseClaimId(storyAId, 'q1m-b', oldHashB)],
      }),
    ).not.toBeNull();
    const statuses = await itemStatuses(h.rawExecutor, ['q1m-b']);
    expect(statuses[0]!.processing_status).toBe('new');
  });
});
