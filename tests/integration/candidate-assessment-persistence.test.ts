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
import { commitEditorialResult } from '../../src/adapters/db/editorial-store';
import { claimJob } from '../../src/adapters/db/job-store';
import { readCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';
import { readCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { buildFullEvidenceText } from '../../src/domain/editorial/mapper';
import { exactContentDigest } from '../../src/domain/editorial/exact-content';

/**
 * R1.14 candidate-ASSESSMENT D1 integration suite (Phase 5C-2): the
 * assessment is produced on the REAL editorial path (real engine + real AI
 * service + real fenced commit over workerd D1, artificial provider port
 * only) and is stored INSIDE `drafts.document_json` next to the discovery
 * it derives from. ZERO new SQL statements were added by the assessment —
 * this suite proves the protections still hold:
 *
 * - identical content (different ids/sources) → content equality OBSERVED,
 *   never truth/source-independence; same URL → only URL sharing;
 *   same title → the weak title signal; Persian/Latin digit differences
 *   are NOT equated (no new equivalence anywhere);
 * - the assessment adds NO statement to the atomic batch;
 * - a snapshot race / expired lease writes NO draft and hence NO assessment;
 * - replay reuses the stable result: no provider call, byte-identical
 *   document, valid stored assessment;
 * - a pre-5C-2 draft (no payload) reads honestly as `absent`, and a
 *   foreign-version payload never reads as a current result.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-cassess-a';
const SOURCE_B = 'src-cassess-b';

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

function createHarness(options?: {
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
              headlineFa: 'تیتر آزمایشی ارزیابی نامزدها',
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
  let idCounter = 0;
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
      idGenerator: { newId: () => `cassess-id-${(idCounter += 1)}` },
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
  const action = await harness.engine.consumeMessage(`cassess-msg-${index}`, envelope);
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

/** Seed a COMPLETE historical story (R1.13-era shape: ready draft + item +
 * claim + evidence, optional fingerprints) — pre-R1.15 state, no anchor. */
async function seedHistoricalStory(
  executor: DbExecutor,
  input: {
    readonly itemId: string;
    readonly sourceId: string;
    readonly title: string;
    readonly body?: string;
    readonly storyId: string;
    readonly withContentFingerprint?: boolean;
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
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
                               facts_json, warnings_json, ai_run_id, version, created_by,
                               created_at, updated_at)
          VALUES (?, ?, 'ready', 'fa', 'news_v1', 'تیتر تاریخی', '{}', '[]', '[]', NULL, 1, 'seed', ?, ?)`,
    params: [`eddr_${input.storyId}`, input.storyId, NOW, NOW],
  });
  if (input.withContentFingerprint ?? false) {
    const digest = await exactContentDigest(
      buildFullEvidenceText({ title: input.title, body_excerpt: input.body ?? null }),
    );
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
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe('candidate assessment — the three observed relations on the REAL path', () => {
  it('identical content, different ids/sources/URLs → the second item REUSES the first result (R1.15): provenance added, the first draft never rewritten, assessment reports stay with their OWN drafts', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    const title = 'دمو: تیتر محتوای کاملاً یکسان';
    const body = 'بدنهٔ کاملاً یکسان دمو برای بررسی برابری کامل محتوا بین دو منبع مستقل.';
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-c1',
      sourceId: SOURCE_A,
      title,
      body,
      url: 'https://example.com/c1-a',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-c2',
      sourceId: SOURCE_B,
      title,
      body,
      url: 'https://example.com/c1-b',
    });
    const first = await runItem(
      harness,
      { id: 'item-cassess-c1', sourceId: SOURCE_A, title, body, url: 'https://example.com/c1-a' },
      0,
    );
    const firstDocument = JSON.parse(first.document_json) as Record<string, unknown>;
    const firstRead = readCandidateAssessmentReport(firstDocument);
    expect(firstRead.kind).toBe('candidate_assessment_v1');
    if (firstRead.kind === 'candidate_assessment_v1') {
      expect(firstRead.report.observation).toBe('no_candidates_observed');
      expect(firstRead.report.entries).toEqual([]);
      expect(firstRead.report.unrelatednessConcluded).toBe(false);
    }

    // R1.15: the identical-content second item REUSES the first result —
    // zero provider calls, zero charges, NO second draft, NO rewritten
    // report documents. The assessment/discovery/guard reports of the
    // first draft describe THEIR OWN lookup moment and stay untouched.
    const second = await runItem(
      harness,
      { id: 'item-cassess-c2', sourceId: SOURCE_B, title, body, url: 'https://example.com/c1-b' },
      1,
    );
    expect(second.document_json).toBe(first.document_json); // byte-identical
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(1);

    // The second provenance: B's OWN claim under the ONE story.
    const claims = await harness.rawExecutor.query<{ subject: string; confidence: number }>({
      sql: 'SELECT subject, confidence FROM claims ORDER BY created_at ASC, id ASC',
    });
    expect(claims.rows).toHaveLength(2);
    expect(claims.rows[1]!.subject).toBe('منبع ب');
    expect(claims.rows.every((row) => row.confidence === 0)).toBe(true);
    const processed = await harness.rawExecutor.query<{ processing_status: string }>({
      sql: "SELECT processing_status FROM source_items WHERE id LIKE 'item-cassess-c%' ORDER BY id ASC",
    });
    expect(processed.rows.map((row) => row.processing_status)).toEqual(['processed', 'processed']);
  });

  it('a fingerprint that MATCHES but whose real text differs: the draft honestly reports the full-content-equality SIGNAL while the verified reuse correctly refuses (stale-locator honesty)', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    // A historical-shaped story whose content_hash fingerprint digest
    // equals the arriving text's digest, but whose REAL attached item text
    // differs (seeded stale locator).
    await seedHistoricalStory(harness.rawExecutor, {
      itemId: 'item-stale-ref',
      sourceId: SOURCE_A,
      title: 'متن واقعی کاملاً متفاوت',
      body: 'این متن واقعی ذخیره‌شده است.',
      storyId: 'edst_stale_ref',
      withContentFingerprint: false,
    });
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
      url: 'https://example.com/stale',
    };
    await seedItem(harness.rawExecutor, itemInput);
    const draft = await runItem(harness, itemInput, 0);
    // The reuse correctly REFUSED (the real text differs) — the item got
    // its own draft, and THAT draft's discovery/assessment pair honestly
    // reports the fingerprint SIGNAL it observed at its lookup moment.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    const read = readCandidateAssessmentReport(
      JSON.parse(draft.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_assessment_v1');
    if (read.kind !== 'candidate_assessment_v1') return;
    expect(read.report.observation).toBe('candidates_observed');
    expect(read.report.entries).toHaveLength(1);
    expect(read.report.entries[0]!.verdict).toBe('full_content_equality_observed');
    expect(read.report.entries[0]!.verdictReasons).toContain('content_hash_fingerprint_match');
    expect(read.report.unrelatednessConcluded).toBe(false);
  });

  it('same URL, different title/body → ONLY the shared-URL observation', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-u1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر نخست آلفا',
      body: 'بدنهٔ نخست آلفا با جزئیات ویژهٔ آلفا.',
      url: 'https://example.com/shared-url',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-u2',
      sourceId: SOURCE_B,
      title: 'دمو: تیتر کاملاً متفاوت بتا',
      body: 'بدنهٔ کاملاً متفاوت بتا؛ تنها URL ذخیره‌شده مشترک است.',
      url: 'https://example.com/shared-url',
    });
    await runItem(
      harness,
      {
        id: 'item-cassess-u1',
        sourceId: SOURCE_A,
        title: 'دمو: تیتر نخست آلفا',
        body: 'بدنهٔ نخست آلفا با جزئیات ویژهٔ آلفا.',
        url: 'https://example.com/shared-url',
      },
      0,
    );
    const second = await runItem(
      harness,
      {
        id: 'item-cassess-u2',
        sourceId: SOURCE_B,
        title: 'دمو: تیتر کاملاً متفاوت بتا',
        body: 'بدنهٔ کاملاً متفاوت بتا؛ تنها URL ذخیره‌شده مشترک است.',
        url: 'https://example.com/shared-url',
      },
      1,
    );
    const read = readCandidateAssessmentReport(
      JSON.parse(second.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_assessment_v1');
    if (read.kind !== 'candidate_assessment_v1') return;
    expect(read.report.entries).toEqual([
      {
        storyId: read.report.entries[0]!.storyId,
        verdict: 'shared_url_observed',
        verdictReasons: ['url_fingerprint_match'],
      },
    ]);
    expect(read.report.entries[0]!.verdict).toBe('shared_url_observed');
  });

  it('same title, different body/URL → only the WEAK title signal', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-t1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر مشترک فقط عنوانی',
      body: 'بدنهٔ نخست با محتوای ویژهٔ نخست.',
      url: 'https://example.com/t1',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-t2',
      sourceId: SOURCE_B,
      title: 'دمو: تیتر مشترک فقط عنوانی',
      body: 'بدنهٔ دوم با محتوای کاملاً متفاوت دوم.',
      url: 'https://example.com/t2',
    });
    await runItem(
      harness,
      {
        id: 'item-cassess-t1',
        sourceId: SOURCE_A,
        title: 'دمو: تیتر مشترک فقط عنوانی',
        body: 'بدنهٔ نخست با محتوای ویژهٔ نخست.',
        url: 'https://example.com/t1',
      },
      0,
    );
    const second = await runItem(
      harness,
      {
        id: 'item-cassess-t2',
        sourceId: SOURCE_B,
        title: 'دمو: تیتر مشترک فقط عنوانی',
        body: 'بدنهٔ دوم با محتوای کاملاً متفاوت دوم.',
        url: 'https://example.com/t2',
      },
      1,
    );
    const read = readCandidateAssessmentReport(
      JSON.parse(second.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_assessment_v1');
    if (read.kind !== 'candidate_assessment_v1') return;
    expect(read.report.entries).toEqual([
      {
        storyId: read.report.entries[0]!.storyId,
        verdict: 'shared_title_observed',
        verdictReasons: ['title_key_fingerprint_match'],
      },
    ]);
    expect(read.report.limitations).toContain('title_signal_is_weak');
  });

  it('Persian vs Latin digits are NOT equated: no shared signal → zero entries, unrelatednessConcluded false (never "definitely unrelated")', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-d1',
      sourceId: SOURCE_A,
      title: 'دمو: نسخهٔ شماره ۱۲۳ منتشر شد',
      body: 'بدنهٔ دمو با عدد یکصد و بیست و سه.',
      url: 'https://example.com/d1',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-d2',
      sourceId: SOURCE_B,
      title: 'دمو: نسخهٔ شماره 123 منتشر شد',
      body: 'بدنهٔ دمو با عدد یکصد و بیست و سه.',
      url: 'https://example.com/d2',
    });
    await runItem(
      harness,
      {
        id: 'item-cassess-d1',
        sourceId: SOURCE_A,
        title: 'دمو: نسخهٔ شماره ۱۲۳ منتشر شد',
        body: 'بدنهٔ دمو با عدد یکصد و بیست و سه.',
        url: 'https://example.com/d1',
      },
      0,
    );
    const second = await runItem(
      harness,
      {
        id: 'item-cassess-d2',
        sourceId: SOURCE_B,
        title: 'دمو: نسخهٔ شماره 123 منتشر شد',
        body: 'بدنهٔ دمو با عدد یکصد و بیست و سه.',
        url: 'https://example.com/d2',
      },
      1,
    );
    const read = readCandidateAssessmentReport(
      JSON.parse(second.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_assessment_v1');
    if (read.kind !== 'candidate_assessment_v1') return;
    // NO signal matched (digit equivalence is forbidden) — the honest
    // result is an empty assessment, NEVER "definitely unrelated".
    expect(read.report.observation).toBe('no_candidates_observed');
    expect(read.report.entries).toEqual([]);
    expect(read.report.counts).toEqual({ assessed: 0 });
    expect(read.report.unrelatednessConcluded).toBe(false);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });
});

describe('candidate assessment — zero new SQL on the real commit path', () => {
  it('the assessment rides INSIDE document_json; the atomic batch carries NO statement beyond the known editorial set (including the R1.15 anchor, still story_fingerprints)', async () => {
    const batches: DbStatement[][] = [];
    const harness = createHarness({ captureBatches: batches });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, SOURCE_B, 'منبع ب');
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-s1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر کاملاً یکسان برای SQL',
      body: 'بدنهٔ کاملاً یکسان دمو برای بررسی شکل دستورها.',
      url: 'https://example.com/s1',
    });
    // DISTINCT content (R1.15 would otherwise reuse the first result and
    // skip the second commit entirely — the shape proof needs BOTH drafts).
    await seedItem(harness.rawExecutor, {
      id: 'item-cassess-s2',
      sourceId: SOURCE_B,
      title: 'دمو: تیتر کاملاً یکسان برای SQL نسخهٔ دوم',
      body: 'بدنهٔ کاملاً یکسان دمو برای بررسی شکل دستورها.',
      url: 'https://example.com/s2',
    });
    await runItem(
      harness,
      {
        id: 'item-cassess-s1',
        sourceId: SOURCE_A,
        title: 'دمو: تیتر کاملاً یکسان برای SQL',
        body: 'بدنهٔ کاملاً یکسان دمو برای بررسی شکل دستورها.',
        url: 'https://example.com/s1',
      },
      0,
    );
    const second = await runItem(
      harness,
      {
        id: 'item-cassess-s2',
        sourceId: SOURCE_B,
        title: 'دمو: تیتر کاملاً یکسان برای SQL',
        body: 'بدنهٔ کاملاً یکسان دمو برای بررسی شکل دستورها.',
        url: 'https://example.com/s2',
      },
      1,
    );
    // The assessment is IN the stored document and reader-valid.
    const read = readCandidateAssessmentReport(
      JSON.parse(second.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_assessment_v1');
    // The editorial commit batches mention ONLY the known statements — the
    // assessment traveled inside the draft INSERT's bound document_json.
    const commitBatches = batches.filter((batch) =>
      batch.some((statement) => statement.sql.includes('INSERT INTO drafts')),
    );
    expect(commitBatches.length).toBeGreaterThanOrEqual(1);
    for (const batch of commitBatches) {
      for (const statement of batch) {
        expect(statement.sql).toMatch(
          /^(INSERT INTO (stories|claims|evidence|ai_runs|drafts|story_fingerprints)|UPDATE source_items)/,
        );
        expect(statement.sql).not.toContain('candidateAssessment');
        expect(statement.sql).not.toContain('candidate_assessment');
      }
    }
    // No extra table exists: the whole write surface is unchanged. The R1.15
    // delta is exactly ONE story_fingerprints row per commit (the group
    // anchor): 3 story-scoped signals × 2 items + 2 anchors = 8.
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(8); // 3×2 scoped + 2 anchors
  });
});

describe('candidate assessment — no report for a foreign snapshot or owner', () => {
  it('a snapshot race at commit time writes ZERO drafts and ZERO assessments', async () => {
    const harness = createHarness({
      mutateBeforeEditorialCommit: async (raw) => {
        await raw.run({
          sql: `UPDATE source_items SET title = ?, content_hash = ? WHERE id = ?`,
          params: ['عنوان تغییر یافته', 'c'.repeat(64), 'item-cassess-r1'],
        });
      },
    });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-cassess-r1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر مسابقهٔ اسنپ‌شات',
      body: 'بدنهٔ دمو برای مسابقهٔ اسنپ‌شات.',
      url: 'https://example.com/r1',
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
    const action = await harness.engine.consumeMessage('cassess-msg-race', envelope);
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_dead_lettered' });
    expect(harness.providerCalls).toHaveLength(1);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
  });

  it('an expired-lease (stale generation) commit writes nothing — no assessment for another owner', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-cassess-stale',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر نسل قدیمی',
      body: 'بدنهٔ دمو برای نسل قدیمی.',
      url: 'https://example.com/stale',
    };
    await seedItem(harness.rawExecutor, item);
    const contentHash = await sha256Hex(`${item.id}\u001f${item.title}\u001f${item.body}`);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(enqueued.kind).toBe('created');
    const jobId = enqueued.kind === 'created' ? enqueued.jobId : '';
    const claim = await claimJob(harness.rawExecutor, jobId, NOW, 2 * 60 * 1000);
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    harness.clock.advance(3 * 60 * 1000); // lease expired

    const stale = await commitEditorialResult(harness.rawExecutor, {
      jobId,
      generation: claim.generation,
      fenceNowMs: harness.clock.now(),
      snapshot: { sourceItemId: item.id, sourceId: item.sourceId, contentHash },
      entityMentions: [],
      story: {
        id: 'edst-cassess-stale',
        storyKey: 'editorial.story:cassess-stale',
        workingHeadline: null,
        createdAt: harness.clock.now(),
      },
      claim: {
        id: 'edcl-cassess-stale',
        storyId: 'edst-cassess-stale',
        claimType: 'source_report',
        subject: 's',
        predicate: 'reported',
        objectText: 'o',
        confidence: 0,
        status: 'unverified',
        createdAt: harness.clock.now(),
      },
      evidence: {
        id: 'edev-cassess-stale',
        claimId: 'edcl-cassess-stale',
        sourceItemId: item.id,
        stance: 'mentions',
        confidence: 0,
        excerpt: 'e',
        createdAt: harness.clock.now(),
      },
      aiRun: {
        id: 'edai-cassess-stale',
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
        id: 'eddr-cassess-stale',
        storyId: 'edst-cassess-stale',
        status: 'ready',
        language: 'fa',
        layout: 'news_v1',
        title: 't',
        documentJson: JSON.stringify({
          candidateAssessment: { assessmentVersion: 1 },
        }),
        factsJson: '[]',
        warningsJson: '[]',
        aiRunId: 'edai-cassess-stale',
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
  });
});

describe('candidate assessment — replay is free and byte-stable', () => {
  it('a replayed job calls NO provider, charges NOTHING, and rewrites NOTHING', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-cassess-replay',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر پخش دوباره',
      body: 'بدنهٔ دمو برای پخش دوباره.',
      url: 'https://example.com/replay',
    };
    await seedItem(harness.rawExecutor, item);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(enqueued.kind).toBe('created');
    await harness.engine.dispatchDueJobs();
    await harness.engine.consumeMessage('cassess-msg-replay-1', harness.envelopes.shift());
    expect(harness.providerCalls).toHaveLength(1);
    const firstDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    expect(firstDraft).not.toBeNull();
    const firstDocumentJson = firstDraft!.document_json;

    // Handler-level replay: the pre-AI stable-result path returns success
    // WITHOUT any provider call or write — the stored assessment (and the
    // whole document) is never rewritten.
    const jobId = enqueued.kind === 'created' ? enqueued.jobId : '';
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
      jobId,
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
    const read = readCandidateAssessmentReport(
      JSON.parse(secondDraft!.document_json) as Record<string, unknown>,
    );
    expect(read.kind).toBe('candidate_assessment_v1');
  });
});

describe('candidate assessment — historical drafts read honestly', () => {
  it('a pre-5C-2 draft (discovery only) reads absent; foreign/corrupt payloads never read current', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-cassess-hist',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر تاریخچه',
      body: 'بدنهٔ دمو برای تاریخچه.',
      url: 'https://example.com/hist',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 0);
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(readCandidateAssessmentReport(document).kind).toBe('candidate_assessment_v1');
    expect(readCandidateDiscoveryReport(document).kind).toBe('candidate_discovery_v1');

    // An R1.13-era draft stored discovery WITHOUT any assessment payload:
    // deleting the key is exactly that historical shape → absent, with no
    // backfill anywhere.
    const withoutAssessment = { ...document };
    delete withoutAssessment['candidateAssessment'];
    expect(readCandidateAssessmentReport(withoutAssessment)).toEqual({ kind: 'absent' });

    // A foreign version and a corrupt payload never read as a current result.
    const future = { ...document, candidateAssessment: { assessmentVersion: 2 } };
    expect(readCandidateAssessmentReport(future)).toEqual({
      kind: 'unsupported_version',
      assessmentVersion: 2,
    });
    const corrupt = { ...document, candidateAssessment: 'garbage' };
    expect(readCandidateAssessmentReport(corrupt).kind).toBe('malformed');
  });
});
