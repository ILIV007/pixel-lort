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
import {
  readCandidateMatchingReport,
  CANDIDATE_MATCHING_SIGNAL_WEIGHTS,
} from '../../src/domain/editorial/candidate-matching';
import { readCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { normalizeForDirectTextMatch } from '../../src/domain/editorial/evidence-guard';
import { storyFingerprintValue } from '../../src/domain/editorial/story-fingerprints';
import { exactContentDigest } from '../../src/domain/editorial/exact-content';
import { buildFullEvidenceText } from '../../src/domain/editorial/mapper';

/**
 * Phase 5C-4 (V4 Phase 5.2) REAL-D1 integration suite for the
 * candidate-MATCHING report: the report is produced on the REAL editorial
 * path (real engine + real AI service + real fenced commit over workerd
 * D1, artificial provider port only) ONLY when the independent
 * EDITORIAL_MATCHING_ENABLED gate is ON, and travels INSIDE
 * `drafts.document_json` next to the discovery + assessment it derives
 * from. ZERO new SQL statements are added — this suite proves:
 *
 * - flag OFF (production default): the accepted path stays byte-identical
 *   and the stored document carries NO candidateMatching key (typed
 *   reader: absent);
 * - flag ON: the identical-content relation is reported ONLY where the
 *   content-composite fingerprint really matched (the reuse locator);
 *   the weak title path stays similar_signals_only — never same-news;
 *   ties are honest AMBIGUOUS ties; probe overflow / report truncation
 *   make the resolution honestly INCOMPLETE;
 * - the atomic batch carries NO statement beyond the known editorial set;
 * - a snapshot race writes NO draft and hence NO matching report;
 * - replay stays free and byte-stable (the stored report is never
 *   rewritten).
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-match-a';
const SOURCE_B = 'src-match-b';

/** Module-level harness id counter — see createHarness (shared D1). */
let MATCH_ID_COUNTER = 0;

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

/** Seed a historical story + item + ready draft and ONE title_key index row. */
async function seedTitleKeyStory(
  executor: DbExecutor,
  input: {
    readonly itemId: string;
    readonly sourceId: string;
    readonly storyId: string;
    readonly title: string;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسنده', ?, ?, ?, '{}', 'processed')`,
    params: [
      input.itemId,
      input.sourceId,
      `ext-${input.itemId}`,
      `https://example.com/${input.itemId}`,
      input.title,
      'بدنهٔ تاریخی با محتوای متفاوت.',
      NOW,
      NOW,
      'h'.repeat(64),
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
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
                               facts_json, warnings_json, ai_run_id, version, created_by,
                               created_at, updated_at)
          VALUES (?, ?, 'ready', 'fa', 'news_v1', 'تیتر تاریخی', '{}', '[]', '[]', NULL, 1, 'seed', ?, ?)`,
    params: [`eddr_${input.storyId}`, input.storyId, NOW, NOW],
  });
  // The ONLY signal: the weak title_key fingerprint (same limited
  // normalization the real path uses — no other equivalence anywhere).
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
  readonly mutateBeforeEditorialCommit?: (raw: DbExecutor) => Promise<void>;
  readonly captureBatches?: DbStatement[][];
}): {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly rawExecutor: DbExecutor;
  readonly clock: MutableClock;
  readonly providerCalls: ProviderCall[];
  readonly envelopes: unknown[];
} {
  const clock = fixedClock(NOW);
  const lines: string[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(line);
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
              headlineFa: 'تیتر آزمایشی تطبیق نامزدها',
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
  // A MODULE-LEVEL counter: multiple harnesses may share one D1 database
  // within a single test (e.g. the flag-ON vs flag-OFF batch-shape pair),
  // and job/story ids must never collide across them.
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createEditorialPrepareDraftHandler({
          executor,
          aiService,
          ...(options?.matchingEnabled === true ? { matching: { enabled: true } } : {}),
          nowMs: () => clock.now(),
          logger,
        }),
      ] as never),
      idGenerator: { newId: () => `match-id-${(MATCH_ID_COUNTER += 1)}` },
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
  return { engine, executor, rawExecutor, clock, providerCalls, envelopes };
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
  const action = await harness.engine.consumeMessage(`match-msg-${index}`, envelope);
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

describe('candidate matching — flag OFF keeps the accepted path byte-identical', () => {
  it('default options store NO candidateMatching key; the typed reader reads absent', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    await seedItem(harness.rawExecutor, {
      id: 'item-match-off1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر دروازهٔ خاموش',
      body: 'بدنهٔ دمو برای دروازهٔ خاموش.',
      url: 'https://example.com/off1',
    });
    const draft = await runItem(
      harness,
      {
        id: 'item-match-off1',
        sourceId: SOURCE_A,
        title: 'دمو: تیتر دروازهٔ خاموش',
        body: 'بدنهٔ دمو برای دروازهٔ خاموش.',
        url: 'https://example.com/off1',
      },
      0,
    );
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(Object.hasOwn(document, 'candidateMatching')).toBe(false);
    expect(readCandidateMatchingReport(document)).toEqual({ kind: 'absent' });
    // The siblings the report would derive from stay present and valid.
    expect(readCandidateDiscoveryReport(document).kind).toBe('candidate_discovery_v1');
  });
});

describe('candidate matching — the observed relations on the REAL path (flag ON)', () => {
  it('a stale identical-content locator: the reuse refuses, the draft reports the identical-content relation as a LOCATOR only', async () => {
    const harness = createHarness({ matchingEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    // A historical story whose content_hash fingerprint digest equals the
    // arriving text's digest, but whose REAL attached item text differs
    // (the verified reuse correctly refuses — the fingerprint is only the
    // locator).
    await seedSource(harness.rawExecutor, 'src-stale', 'منبع کهنه');
    await harness.rawExecutor.run({
      sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
              author, published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES ('item-stale-ref', 'src-stale', 'ext-stale-ref', 'https://example.com/stale-ref',
                    'متن واقعی کاملاً متفاوت', 'این متن واقعی ذخیره‌شده است.', 'نویسنده', ?, ?, ?, '{}', 'processed')`,
      params: [NOW, NOW, 'h'.repeat(64)],
    });
    await harness.rawExecutor.run({
      sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
              confidence, working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
            VALUES ('edst_stale_ref', 'seeded-stale', 'discovered', 'unknown', 'industry', 50, 0,
                    NULL, ?, ?, 1, ?, ?)`,
      params: [NOW, NOW, NOW, NOW],
    });
    await harness.rawExecutor.run({
      sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
              confidence, status, created_at, updated_at)
            VALUES ('edcl_stale_ref', 'edst_stale_ref', 'source_report', 'منبع کهنه', 'reported',
                    'متن تاریخی', 0, 'unverified', ?, ?)`,
      params: [NOW, NOW],
    });
    await harness.rawExecutor.run({
      sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
            VALUES ('edev_stale_ref', 'edcl_stale_ref', 'item-stale-ref', 'mentions', 0, 'متن تاریخی', ?)`,
      params: [NOW],
    });
    await harness.rawExecutor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
            VALUES ('eddr_stale_ref', 'edst_stale_ref', 'ready', 'fa', 'news_v1', 'تیتر تاریخی',
                    '{}', '[]', '[]', NULL, 1, 'seed', ?, ?)`,
      params: [NOW, NOW],
    });
    // The REAL content_hash fingerprint payload: the FULL title+body
    // composition (the same composition the real path digests).
    const staleDigest = await exactContentDigest(
      buildFullEvidenceText({ title: 'تیتر سیگنال خراب', body_excerpt: 'بدنهٔ سیگنال خراب.' }),
    );
    await harness.rawExecutor.run({
      sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
            VALUES ('edst_stale_ref', 'content_hash', ?, ?)`,
      params: [`sc1:${staleDigest}:edst_stale_ref`, NOW],
    });

    const itemInput = {
      id: 'item-stale-arriving',
      sourceId: SOURCE_A,
      title: 'تیتر سیگنال خراب',
      body: 'بدنهٔ سیگنال خراب.',
      url: 'https://example.com/stale-arriving',
    };
    await seedItem(harness.rawExecutor, itemInput);
    const draft = await runItem(harness, itemInput, 0);

    const read = readCandidateMatchingReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_matching_v1');
    if (read.kind !== 'candidate_matching_v1') return;
    expect(read.report.observation).toBe('candidates_observed');
    expect(read.report.entries).toHaveLength(1);
    expect(read.report.entries[0]).toMatchObject({
      verdict: 'full_content_equality_observed',
      score: CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash,
    });
    expect(read.report.outcome).toBe('identical_content_relation_observed');
    expect(read.report.resolution).toBe('single_top_candidate_observed');
    expect(read.report.topScoreObserved).toBe(CANDIDATE_MATCHING_SIGNAL_WEIGHTS.content_hash);
    expect(read.report.unrelatednessConcluded).toBe(false);
    // The locator never merged anything: the arriving item got its OWN story.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });

  it('same weak title, different body/URL: similar_signals_only — NEVER same-news, score = title weight only', async () => {
    const harness = createHarness({ matchingEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    const sharedTitle = 'دمو: تیتر مشترک فقط عنوانی';
    await seedItem(harness.rawExecutor, {
      id: 'item-match-t1',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ نخست با محتوای ویژهٔ نخست.',
      url: 'https://example.com/mt1',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-match-t2',
      sourceId: SOURCE_B,
      title: sharedTitle,
      body: 'بدنهٔ دوم با محتوای کاملاً متفاوت دوم.',
      url: 'https://example.com/mt2',
    });
    await runItem(
      harness,
      {
        id: 'item-match-t1',
        sourceId: SOURCE_A,
        title: sharedTitle,
        body: 'بدنهٔ نخست با محتوای ویژهٔ نخست.',
        url: 'https://example.com/mt1',
      },
      0,
    );
    const second = await runItem(
      harness,
      {
        id: 'item-match-t2',
        sourceId: SOURCE_B,
        title: sharedTitle,
        body: 'بدنهٔ دوم با محتوای کاملاً متفاوت دوم.',
        url: 'https://example.com/mt2',
      },
      1,
    );
    const read = readCandidateMatchingReport(
      JSON.parse(second.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_matching_v1');
    if (read.kind !== 'candidate_matching_v1') return;
    expect(read.report.outcome).toBe('similar_signals_only_observed');
    expect(read.report.entries).toHaveLength(1);
    expect(read.report.entries[0]).toMatchObject({
      verdict: 'shared_title_observed',
      score: CANDIDATE_MATCHING_SIGNAL_WEIGHTS.title_key,
    });
    expect(read.report.resolution).toBe('single_top_candidate_observed');
    expect(read.report.limitations).toContain('similar_signals_never_same_news');
    // Nothing merged: the second item owns its OWN story.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });

  it('two candidates tied on the SAME observed signal set are an honest ambiguous tie', async () => {
    const harness = createHarness({ matchingEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const sharedTitle = 'دمو: تیتر مشترک برای تساوی';
    await seedTitleKeyStory(harness.rawExecutor, {
      itemId: 'item-tie-hist-1',
      sourceId: SOURCE_A,
      storyId: 'edst_tie_a',
      title: sharedTitle,
    });
    await seedTitleKeyStory(harness.rawExecutor, {
      itemId: 'item-tie-hist-2',
      sourceId: SOURCE_A,
      storyId: 'edst_tie_b',
      title: sharedTitle,
    });
    const itemInput = {
      id: 'item-tie-arriving',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ تازهٔ کاملاً متفاوت برای تساوی.',
      url: 'https://example.com/tie-arriving',
    };
    await seedItem(harness.rawExecutor, itemInput);
    const draft = await runItem(harness, itemInput, 0);
    const read = readCandidateMatchingReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_matching_v1');
    if (read.kind !== 'candidate_matching_v1') return;
    expect(read.report.entries).toHaveLength(2);
    expect(read.report.entries.every((entry) => entry.score === 1)).toBe(true);
    expect(read.report.resolution).toBe('ambiguous_tie_observed');
    expect(read.report.outcome).toBe('similar_signals_only_observed');
    expect(read.report.topScoreObserved).toBe(1);
  });

  it('probe overflow beyond the 9-row page makes the resolution honestly INCOMPLETE', async () => {
    const harness = createHarness({ matchingEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const sharedTitle = 'دمو: تیتر مشترک برای سرریز';
    for (let index = 0; index < 10; index += 1) {
      await seedTitleKeyStory(harness.rawExecutor, {
        itemId: `item-overflow-hist-${index}`,
        sourceId: SOURCE_A,
        storyId: `edst_overflow_${index}`,
        title: sharedTitle,
      });
    }
    const itemInput = {
      id: 'item-overflow-arriving',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ تازهٔ برای سرریز.',
      url: 'https://example.com/overflow-arriving',
    };
    await seedItem(harness.rawExecutor, itemInput);
    const draft = await runItem(harness, itemInput, 0);
    const read = readCandidateMatchingReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_matching_v1');
    if (read.kind !== 'candidate_matching_v1') return;
    // The discovery probe saw its FULL 9-row page: overflow recorded, the
    // report capped at 8 candidates and truncated, so the matching report
    // refuses any best-candidate claim.
    expect(read.report.discoveryLimits.overflowObserved).toBe(true);
    expect(read.report.discoveryLimits.candidatesTruncated).toBe(true);
    expect(read.report.entries).toHaveLength(8);
    expect(read.report.resolution).toBe('unresolvable_incomplete_coverage');
  });
});

describe('candidate matching — zero new SQL on the real commit path', () => {
  it('the matching report rides INSIDE document_json; the atomic batch carries NO statement beyond the known editorial set', async () => {
    const onBatches: DbStatement[][] = [];
    const offBatches: DbStatement[][] = [];
    const onHarness = createHarness({ matchingEnabled: true, captureBatches: onBatches });
    await seedSource(onHarness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-match-sql',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر شکل دستورها',
      body: 'بدنهٔ دمو برای شکل دستورها.',
      url: 'https://example.com/match-sql',
    };
    await seedItem(onHarness.rawExecutor, item);
    const draft = await runItem(onHarness, item, 0);
    const read = readCandidateMatchingReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_matching_v1');

    // The SAME scenario with the flag OFF must produce the IDENTICAL
    // statement sequence (same SQL text, same count) — the report adds
    // zero statements to the fenced atomic batch. A DIFFERENT source/item
    // id AND a DISTINCT text: both harnesses share one D1 database within
    // this test, and an identical composed text would (correctly) take the
    // verified 5C-3 reuse path — which inserts NO draft — invalidating the
    // batch-shape comparison this test exists for.
    const offHarness = createHarness({ captureBatches: offBatches });
    await seedSource(offHarness.rawExecutor, 'src-match-c', 'منبع ج');
    const offItem = {
      id: 'item-match-sql-off',
      sourceId: 'src-match-c',
      title: 'دمو: تیتر مستقل برای شکل دستورها',
      body: 'بدنهٔ مستقل دمو برای شکل دستورها.',
      url: 'https://example.com/match-sql-off',
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
        expect(sql).not.toContain('candidateMatching');
        expect(sql).not.toContain('candidate_matching');
      }
    }
  });
});

describe('candidate matching — races and replay stay honest', () => {
  it('a snapshot race at commit time writes ZERO drafts and ZERO matching reports', async () => {
    const harness = createHarness({
      matchingEnabled: true,
      mutateBeforeEditorialCommit: async (raw) => {
        await raw.run({
          sql: `UPDATE source_items SET title = ?, content_hash = ? WHERE id = ?`,
          params: ['عنوان تغییر یافته', 'c'.repeat(64), 'item-match-race'],
        });
      },
    });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-match-race',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر مسابقهٔ اسنپ‌شات',
      body: 'بدنهٔ دمو برای مسابقهٔ اسنپ‌شات.',
      url: 'https://example.com/match-race',
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
    const action = await harness.engine.consumeMessage('match-msg-race', envelope);
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_dead_lettered' });
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
  });

  it('replay stays free and byte-stable: the stored matching report is NEVER rewritten', async () => {
    const harness = createHarness({ matchingEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-match-replay',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر پخش دوبارهٔ تطبیق',
      body: 'بدنهٔ دمو برای پخش دوبارهٔ تطبیق.',
      url: 'https://example.com/match-replay',
    };
    await seedItem(harness.rawExecutor, item);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(enqueued.kind).toBe('created');
    await harness.engine.dispatchDueJobs();
    await harness.engine.consumeMessage('match-msg-replay-1', harness.envelopes.shift());
    expect(harness.providerCalls).toHaveLength(1);
    const firstDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    expect(firstDraft).not.toBeNull();
    const firstDocumentJson = firstDraft!.document_json;
    const firstRead = readCandidateMatchingReport(
      JSON.parse(firstDocumentJson) as Record<string, unknown>,
    );
    expect(firstRead.kind).toBe('candidate_matching_v1');

    // Handler-level replay: the pre-AI stable-result path returns success
    // WITHOUT any provider call or write — the stored matching report (and
    // the whole document) is never rewritten.
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
