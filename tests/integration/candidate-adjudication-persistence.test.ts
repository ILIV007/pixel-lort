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
import type { AiCallOutcome } from '../../src/domain/ai/types';
import { readCandidateAdjudicationReport } from '../../src/domain/editorial/candidate-adjudication';
import { readCandidateMatchingReport } from '../../src/domain/editorial/candidate-matching';
import { readCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { normalizeForDirectTextMatch } from '../../src/domain/editorial/evidence-guard';
import { storyFingerprintValue } from '../../src/domain/editorial/story-fingerprints';
import { exactContentDigest } from '../../src/domain/editorial/exact-content';
import { buildFullEvidenceText } from '../../src/domain/editorial/mapper';

/**
 * Phase 5.3 (V4 owner authorization 2026-11-10) REAL-D1 integration suite
 * for the candidate-ADJUDICATION report: the report is produced on the
 * REAL editorial path (real engine + real AI service + real fenced commit
 * over workerd D1, artificial provider port only) ONLY when BOTH the
 * independent EDITORIAL_ADJUDICATION_ENABLED gate AND the sibling
 * EDITORIAL_MATCHING_ENABLED gate are ON, and travels INSIDE
 * `drafts.document_json` next to the matching report it derives from.
 * ZERO new SQL statements are added — this suite proves:
 *
 * - flag OFF (production defaults): the accepted path stays byte-identical
 *   and the stored document carries NO candidateAdjudication key;
 * - adjudication ON without its matching sibling: NO payload and an HONEST
 *   warn log (the flags never imply each other);
 * - the EXACT content-composite identity echoes the verified reuse locator
 *   (single candidate) WITHOUT executing any merge;
 * - the weak-title path defers to review (similarity never proves identity);
 * - TWO exact-identity candidates are a typed CONFLICT — never auto-picked;
 * - probe overflow ⇒ suppression (defer_incomplete_coverage);
 * - the atomic batch carries NO statement beyond the known editorial set;
 * - a snapshot race writes NO draft and hence NO adjudication report;
 * - replay stays free and byte-stable.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-adj-a';
const SOURCE_B = 'src-adj-b';

/** Module-level harness id counter — see createHarness (shared D1). */
let ADJ_ID_COUNTER = 0;

interface DemoItem {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

interface ProviderCall {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

async function seedSource(executor: DbExecutor, id: string, name: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, ?, 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [id, name, NOW, NOW],
  });
}

async function seedItem(executor: DbExecutor, item: DemoItem): Promise<void> {
  const contentHash = await sha256Hex(`${item.id}\u001f${item.title}\u001f${item.body}`);
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسندهٔ آزمایش', ?, ?, ?, '{}', 'new')`,
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

/**
 * Seed a candidate story whose content_hash fingerprint digest EQUALS the
 * given text's digest while the story's OWN attached item text DIFFERS
 * (the verified reuse correctly refuses — the fingerprint is only the
 * locator). The ONLY signal is the content composite: distinct URL, title
 * and body from every other seeded artifact.
 */
async function seedExactIdentityStory(
  executor: DbExecutor,
  input: {
    readonly storyId: string;
    readonly targetText: { readonly title: string; readonly body: string };
    readonly ownTitle: string;
    readonly ownBody: string;
    readonly ownUrl: string;
  },
): Promise<void> {
  const itemId = `item-${input.storyId}-ref`;
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, 'src-adj-stale', ?, ?, ?, ?, 'نویسنده', ?, ?, ?, '{}', 'processed')`,
    params: [
      itemId,
      `ext-${itemId}`,
      input.ownUrl,
      input.ownTitle,
      input.ownBody,
      NOW,
      NOW,
      'h'.repeat(64),
    ],
  });
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
          VALUES (?, ?, 'discovered', 'unknown', 'industry', 50, 0, NULL, ?, ?, 1, ?, ?)`,
    params: [input.storyId, `seeded-${input.storyId}`, NOW, NOW, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
            confidence, status, created_at, updated_at)
          VALUES (?, ?, 'source_report', 'منبع کهنه', 'reported', 'متن تاریخی', 0,
                  'unverified', ?, ?)`,
    params: [`edcl_${input.storyId}`, input.storyId, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
          VALUES (?, ?, ?, 'mentions', 0, 'متن تاریخی', ?)`,
    params: [`edev_${input.storyId}`, `edcl_${input.storyId}`, itemId, NOW],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'ready', 'fa', 'news_v1', 'تیتر تاریخی', '{}', '[]', '[]', NULL, 1, 'seed', ?, ?)`,
    params: [`eddr_${input.storyId}`, input.storyId, NOW, NOW],
  });
  const digest = await exactContentDigest(
    buildFullEvidenceText({ title: input.targetText.title, body_excerpt: input.targetText.body }),
  );
  await executor.run({
    sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
          VALUES (?, 'content_hash', ?, ?)`,
    params: [input.storyId, `sc1:${digest}:${input.storyId}`, NOW],
  });
}

/** Seed ONE historical story with ONLY a title_key fingerprint row. */
async function seedTitleKeyStory(
  executor: DbExecutor,
  input: {
    readonly itemId: string;
    readonly storyId: string;
    readonly title: string;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, 'src-adj-stale', ?, ?, ?, 'بدنهٔ تاریخی با محتوای متفاوت.', 'نویسنده', ?, ?, ?, '{}', 'processed')`,
    params: [
      input.itemId,
      `ext-${input.itemId}`,
      `https://example.com/${input.itemId}`,
      input.title,
      NOW,
      NOW,
      'h'.repeat(64),
    ],
  });
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
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
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'ready', 'fa', 'news_v1', 'تیتر تاریخی', '{}', '[]', '[]', NULL, 1, 'seed', ?, ?)`,
    params: [`eddr_${input.storyId}`, input.storyId, NOW, NOW],
  });
  const value = await storyFingerprintValue(
    'title_key',
    normalizeForDirectTextMatch(input.title),
    input.storyId,
  );
  await executor.run({
    sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
          VALUES (?, 'title_key', ?, ?)`,
    params: [input.storyId, value, NOW],
  });
}

function createHarness(options?: {
  readonly matchingEnabled?: boolean;
  readonly adjudicationEnabled?: boolean;
  readonly mutateBeforeEditorialCommit?: (raw: DbExecutor) => Promise<void>;
  readonly captureBatches?: DbStatement[][];
}): {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly rawExecutor: DbExecutor;
  readonly clock: MutableClock;
  readonly providerCalls: ProviderCall[];
  readonly envelopes: unknown[];
  readonly logLines: readonly string[];
} {
  const clock = fixedClock(NOW);
  const logLines: string[] = [];
  const sink: LogSink = (_level, line) => {
    logLines.push(line);
  };
  const logger = createLogger({ level: 'debug', base: { evt: 'test' }, clock, sink });

  const providerCalls: ProviderCall[] = [];
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
      options?.captureBatches?.push([...statements]);
      return rawExecutor.batch(statements);
    },
  };

  const aiService = createAiDraftService({
    executor,
    ports: {
      'workers-ai': {
        provider: 'workers-ai',
        complete: async (input): Promise<AiCallOutcome> => {
          providerCalls.push({ messages: input.messages });
          const header = /شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>/;
          const evidenceId =
            input.messages.find((message) => message.role === 'user')?.content.match(header)?.[1] ??
            'missing-evidence-id';
          return {
            kind: 'ok',
            rawText: JSON.stringify({
              headlineFa: 'تیتر آزمایشی داوری نامزدها',
              summaryFa: 'خلاصهٔ آزمایشی؛ فیکسچر آفلاین مسیر واقعی.',
              claims: [{ text: 'ادعای آزمایشی مرتبط با شاهد.', evidenceIds: [evidenceId] }],
            }),
            usage: { inputTokens: 42, outputTokens: 17 },
          };
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

  const envelopes: unknown[] = [];
  const dlq: DlqReference[] = [];
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createEditorialPrepareDraftHandler({
          executor,
          aiService,
          ...(options?.matchingEnabled === true ? { matching: { enabled: true } } : {}),
          ...(options?.adjudicationEnabled === true ? { adjudication: { enabled: true } } : {}),
          nowMs: () => clock.now(),
          logger,
        }),
      ] as never),
      idGenerator: { newId: () => `adj-id-${(ADJ_ID_COUNTER += 1)}` },
      clock,
      random: () => 1,
      logger,
      jobsProducer: {
        send: async (envelope) => {
          envelopes.push(envelope);
        },
      } as JobsQueueProducerPort,
      dlqProducer: {
        send: async (reference) => {
          dlq.push(reference);
        },
      } as DlqProducerPort,
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
  return { engine, executor, rawExecutor, clock, providerCalls, envelopes, logLines };
}

/** Enqueue + dispatch + consume ONE item; returns the LAST stored draft. */
async function runItem(
  harness: ReturnType<typeof createHarness>,
  item: DemoItem,
  index: number,
): Promise<{ readonly id: string; readonly story_id: string; readonly document_json: string }> {
  expect(
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    }),
  ).toMatchObject({ kind: 'created' });
  await harness.engine.dispatchDueJobs();
  const envelope = harness.envelopes.shift();
  const action = await harness.engine.consumeMessage(`adj-msg-${index}`, envelope);
  expect(action).toMatchObject({ action: 'ack' });
  const latest = await harness.rawExecutor.first<{
    id: string;
    story_id: string;
    document_json: string;
  }>({
    sql: 'SELECT id, story_id, document_json FROM drafts ORDER BY rowid DESC LIMIT 1',
  });
  expect(latest).not.toBeNull();
  return latest!;
}

async function rowCount(executor: DbExecutor, table: string): Promise<number> {
  const row = await executor.first<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
  return row?.n ?? 0;
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

describe('candidate adjudication — flag OFF keeps the accepted path byte-identical', () => {
  it('default options store NO candidateAdjudication key; the typed reader reads absent', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-adj-off1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر داوری خاموش',
      body: 'بدنهٔ دمو برای داوری خاموش.',
      url: 'https://example.com/adj-off1',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(Object.hasOwn(document, 'candidateAdjudication')).toBe(false);
    expect(readCandidateAdjudicationReport(document)).toEqual({ kind: 'absent' });
    // The sibling the report would derive from stays absent too (its own
    // gate is OFF) while the discovery sibling stays present and valid:
    expect(readCandidateMatchingReport(document).kind).toBe('absent');
    expect(readCandidateDiscoveryReport(document).kind).toBe('candidate_discovery_v1');
  });

  it('adjudication ON without the matching gate stores NO payload and logs an HONEST warn (flags never imply each other)', async () => {
    const harness = createHarness({ adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-adj-lonely',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر داوری بی‌همتا',
      body: 'بدنهٔ دمو برای داوری بی‌همتا.',
      url: 'https://example.com/adj-lonely',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(Object.hasOwn(document, 'candidateAdjudication')).toBe(false);
    expect(readCandidateAdjudicationReport(document)).toEqual({ kind: 'absent' });
    expect(
      harness.logLines.some((line) => line.includes('adjudication_requires_matching_gate')),
    ).toBe(true);
  });
});

describe('candidate adjudication — the dispositions on the REAL path (both gates ON)', () => {
  const arrivingText = {
    title: 'تیتر داوری هویت دقیق',
    body: 'بدنهٔ داوری هویت دقیق.',
  };

  it('one exact-identity candidate echoes the verified reuse LOCATOR — and merges NOTHING', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, 'src-adj-stale', 'منبع کهنه');
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adj_exact1',
      targetText: arrivingText,
      ownTitle: 'متن واقعی کاملاً متفاوت یک',
      ownBody: 'این متن واقعی ذخیره‌شدهٔ اول است.',
      ownUrl: 'https://example.com/adj-exact1',
    });
    const item = {
      id: 'item-adj-exact1',
      sourceId: SOURCE_A,
      title: arrivingText.title,
      body: arrivingText.body,
      url: 'https://example.com/adj-exact1-arriving',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);

    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    // The sibling chain stays coherent:
    expect(readCandidateMatchingReport(document).kind).toBe('candidate_matching_v1');
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1') return;
    expect(read.report.observation).toBe('candidates_observed');
    expect(read.report.entries).toHaveLength(1);
    expect(read.report.entries[0]).toMatchObject({
      storyId: 'edst_adj_exact1',
      verdict: 'full_content_equality_observed',
      stance: 'exact_content_identity_observed',
      disposition: 'reuse_locator_supported',
    });
    expect(read.report.mergeDisposition).toBe('reuse_locator_single_exact_identity');
    expect(read.report.reviewRequired).toBe(false);
    expect(read.report.unrelatednessConcluded).toBe(false);
    // The locator never merged anything: the arriving item got its OWN story.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });

  it('same weak title, different body/URL: similarity-only DEFER with review required — never same-news', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    await seedSource(harness.rawExecutor, 'src-adj-stale', 'منبع کهنه');
    const sharedTitle = 'دمو: تیتر مشترک داوری فقط عنوانی';
    await seedTitleKeyStory(harness.rawExecutor, {
      itemId: 'item-adj-titlehist',
      storyId: 'edst_adj_titlehist',
      title: sharedTitle,
    });
    const item = {
      id: 'item-adj-titlearr',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ تازهٔ کاملاً متفاوت داوری.',
      url: 'https://example.com/adj-titlearr',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);

    const read = readCandidateAdjudicationReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1') return;
    expect(read.report.entries[0]).toMatchObject({
      storyId: 'edst_adj_titlehist',
      verdict: 'shared_title_observed',
      stance: 'identity_not_established_title_only',
      disposition: 'defer_to_review',
    });
    expect(read.report.mergeDisposition).toBe('defer_similarity_only');
    expect(read.report.reviewRequired).toBe(true);
  });

  it('TWO exact-identity candidates are a typed CONFLICT — never auto-picked, review required', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, 'src-adj-stale', 'منبع کهنه');
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adj_conf1',
      targetText: arrivingText,
      ownTitle: 'متن واقعی کاملاً متفاوت دو',
      ownBody: 'این متن واقعی ذخیره‌شدهٔ دوم است.',
      ownUrl: 'https://example.com/adj-conf1',
    });
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adj_conf2',
      targetText: arrivingText,
      ownTitle: 'متن واقعی کاملاً متفاوت سه',
      ownBody: 'این متن واقعی ذخیره‌شدهٔ سوم است.',
      ownUrl: 'https://example.com/adj-conf2',
    });
    const item = {
      id: 'item-adj-conflict',
      sourceId: SOURCE_A,
      title: arrivingText.title,
      body: arrivingText.body,
      url: 'https://example.com/adj-conflict-arriving',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);

    const read = readCandidateAdjudicationReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1') return;
    expect(read.report.entries).toHaveLength(2);
    expect(
      read.report.entries.every((entry) => entry.stance === 'exact_content_identity_observed'),
    ).toBe(true);
    expect(read.report.mergeDisposition).toBe('defer_conflict_multiple_identity_candidates');
    expect(read.report.reviewRequired).toBe(true);
    expect(read.report.mergeDispositionReasons).toContain('conflict_never_auto_resolved');
  });

  it('probe overflow beyond the 9-row page suppresses the proposal (defer_incomplete_coverage)', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, 'src-adj-stale', 'منبع کهنه');
    const sharedTitle = 'دمو: تیتر سرریز صفحهٔ داوری';
    for (let index = 0; index < 9; index += 1) {
      await seedTitleKeyStory(harness.rawExecutor, {
        itemId: `item-adj-overflow-${index}`,
        storyId: `edst_adj_overflow_${index}`,
        title: sharedTitle,
      });
    }
    const item = {
      id: 'item-adj-overflow-arriving',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ تازهٔ سرریز داوری.',
      url: 'https://example.com/adj-overflow-arriving',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);

    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const matching = readCandidateMatchingReport(document);
    expect(matching.kind).toBe('candidate_matching_v1');
    if (matching.kind !== 'candidate_matching_v1') return;
    expect(matching.report.discoveryLimits.overflowObserved).toBe(true);
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1') return;
    expect(read.report.mergeDisposition).toBe('defer_incomplete_coverage');
    expect(read.report.reviewRequired).toBe(true);
    // The observed stances stay listed even though the proposal is suppressed:
    expect(read.report.entries.length).toBeGreaterThan(0);
    expect(read.report.entries.every((entry) => entry.disposition === 'defer_to_review')).toBe(
      true,
    );
  });
});

describe('candidate adjudication — zero new SQL on the real commit path', () => {
  it('the adjudication report rides INSIDE document_json; the atomic batch carries NO statement beyond the known editorial set', async () => {
    const onBatches: DbStatement[][] = [];
    const offBatches: DbStatement[][] = [];
    const onHarness = createHarness({
      matchingEnabled: true,
      adjudicationEnabled: true,
      captureBatches: onBatches,
    });
    await seedSource(onHarness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-adj-sql',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر شکل دستورهای داوری',
      body: 'بدنهٔ دمو برای شکل دستورهای داوری.',
      url: 'https://example.com/adj-sql',
    };
    await seedItem(onHarness.rawExecutor, item);
    const draft = await runItem(onHarness, item, 0);
    const read = readCandidateAdjudicationReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_adjudication_v1');

    // The SAME scenario with the adjudication flag OFF must produce the
    // IDENTICAL statement sequence (same SQL text, same count) — the
    // report adds zero statements to the fenced atomic batch. A DIFFERENT
    // source/item id AND a DISTINCT text (same reason as the 5C-4 suite:
    // an identical composed text would correctly take the verified 5C-3
    // reuse path, which inserts NO draft).
    const offHarness = createHarness({
      matchingEnabled: true,
      captureBatches: offBatches,
    });
    await seedSource(offHarness.rawExecutor, 'src-adj-c', 'منبع ج');
    const offItem = {
      id: 'item-adj-sql-off',
      sourceId: 'src-adj-c',
      title: 'دمو: تیتر مستقل برای شکل دستورهای داوری',
      body: 'بدنهٔ مستقل دمو برای شکل دستورهای داوری.',
      url: 'https://example.com/adj-sql-off',
    };
    await seedItem(offHarness.rawExecutor, offItem);
    await runItem(offHarness, offItem, 1);

    const editorial = (batches: DbStatement[][]): DbStatement[][] =>
      batches.filter((batch) =>
        batch.some((statement) => statement.sql.includes('INSERT INTO drafts')),
      );
    const onCommit = editorial(onBatches);
    const offCommit = editorial(offBatches);
    expect(onCommit.length).toBe(offCommit.length);
    for (let index = 0; index < onCommit.length; index += 1) {
      const onStatements = onCommit[index]!;
      const offStatements = offCommit[index]!;
      expect(onStatements.length, `batch ${index} statement count`).toBe(offStatements.length);
      for (let s = 0; s < onStatements.length; s += 1) {
        const sql = onStatements[s]!.sql;
        expect(sql, `batch ${index} statement ${s}`).toBe(offStatements[s]!.sql);
        expect(sql).toMatch(
          /^(INSERT INTO (stories|claims|evidence|ai_runs|drafts|story_fingerprints)|UPDATE source_items)/,
        );
        expect(sql).not.toContain('candidateAdjudication');
        expect(sql).not.toContain('candidate_adjudication');
      }
    }
  });
});

describe('candidate adjudication — races and replay stay honest', () => {
  it('a snapshot race at commit time writes ZERO drafts and ZERO adjudication reports', async () => {
    const harness = createHarness({
      matchingEnabled: true,
      adjudicationEnabled: true,
      mutateBeforeEditorialCommit: async (raw) => {
        await raw.run({
          sql: `UPDATE source_items SET title = ?, content_hash = ? WHERE id = ?`,
          params: ['عنوان تغییر یافتهٔ داوری', 'c'.repeat(64), 'item-adj-race'],
        });
      },
    });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-adj-race',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر مسابقهٔ اسنپ‌شات داوری',
      body: 'بدنهٔ دمو برای مسابقهٔ اسنپ‌شات داوری.',
      url: 'https://example.com/adj-race',
    };
    await seedItem(harness.rawExecutor, item);
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: item.id,
      }),
    ).toMatchObject({ kind: 'created' });
    await harness.engine.dispatchDueJobs();
    const envelope = harness.envelopes.shift();
    const action = await harness.engine.consumeMessage('adj-msg-race', envelope);
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_dead_lettered' });
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
  });

  it('replay stays free and byte-stable: the stored adjudication report is NEVER rewritten', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-adj-replay',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر پخش دوبارهٔ داوری',
      body: 'بدنهٔ دمو برای پخش دوبارهٔ داوری.',
      url: 'https://example.com/adj-replay',
    };
    await seedItem(harness.rawExecutor, item);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(enqueued.kind).toBe('created');
    await harness.engine.dispatchDueJobs();
    await harness.engine.consumeMessage('adj-msg-replay-1', harness.envelopes.shift());
    expect(harness.providerCalls).toHaveLength(1);
    const firstDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    expect(firstDraft).not.toBeNull();
    const firstDocumentJson = firstDraft!.document_json;
    const firstRead = readCandidateAdjudicationReport(
      JSON.parse(firstDocumentJson) as Record<string, unknown>,
    );
    expect(firstRead.kind).toBe('candidate_adjudication_v1');

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
      matching: { enabled: true },
      adjudication: { enabled: true },
      nowMs: () => harness.clock.now(),
    });
    const replayOutcome = await replayHandler.execute({
      jobId: enqueued.kind === 'created' ? enqueued.jobId : '',
      generation: 1,
      payload: {
        sourceItemId: item.id,
        snapshotHash: await sha256Hex(`${item.id}\u001f${item.title}\u001f${item.body}`),
      },
    });
    expect(replayOutcome).toEqual({ kind: 'success' });
    expect(harness.providerCalls).toHaveLength(1); // NO new provider call
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1); // no duplicate draft
    const secondDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    expect(secondDraft!.document_json).toBe(firstDocumentJson); // byte-identical
  });
});
