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
  readCandidateAdjudicationReport,
  CANDIDATE_ADJUDICATION_LIMITATIONS,
  CANDIDATE_ADJUDICATION_UNASSESSED,
} from '../../src/domain/editorial/candidate-adjudication';
import { readCandidateMatchingReport } from '../../src/domain/editorial/candidate-matching';
import { readCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { readEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import { normalizeForDirectTextMatch } from '../../src/domain/editorial/evidence-guard';
import { storyFingerprintValue } from '../../src/domain/editorial/story-fingerprints';
import {
  exactContentAnchorValue,
  exactContentDigest,
} from '../../src/domain/editorial/exact-content';
import { buildFullEvidenceText } from '../../src/domain/editorial/mapper';

/**
 * Phase 5.4 (V4 roadmap: tests & self-review) — the ADVERSARIAL cross-cutting
 * suite over the REAL item→draft editorial path on REAL workerd D1. The ONLY
 * artificial piece stays the provider PORT (no network); every gate, fence,
 * fingerprint lookup and atomic commit is the shipped code.
 *
 * The roadmap dimensions proven HERE (each is a REAL gap the existing suites
 * do not cover — see docs/reviews/PHASE_5_4_SELF_REVIEW.md for the matrix):
 *
 * - CRASH mid-editorial-commit WITH both 5.2/5.3 gates ON: the atomic batch
 *   rolls back completely, the honest at-least-once retry recomputes FRESH
 *   sibling reports (no stale flag-gated payload ever survives a crash);
 * - DUPLICATE ENQUEUE resolves the SAME durable job row (the idempotency
 *   boundary, distinct from the racing-delivery coverage of Phase 5A);
 * - MIXED url+title_key candidate (same page + same headline, UPDATED
 *   content) → identity_not_established_signals_only → similarity-only defer;
 * - SAME-NAME games: two DIFFERENT stories sharing one normalized title tie
 *   at the same weak score → ambiguous_tie + similarity-only defer (NOT a
 *   conflict — a conflict requires exact identity);
 * - VERSION UPDATE at the SAME url (new content version) → url-only defer,
 *   never identity, never a locator;
 * - DUPLICATE CONTENT FROM TWO INDEPENDENT SOURCES → typed conflict plus the
 *   P1 false-merge proof: every candidate-owned row byte-untouched, NO
 *   executed merge anywhere, source independence stays unassessed verbatim,
 *   raw_json preserved (OD-009);
 * - the P1 PROVENANCE WITNESS WALK: the item→draft chain (story →
 *   source_report claim → mentions evidence → stored item → fingerprints →
 *   document snapshot identity → ai_run) is preserved AND recomputable.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-54-a';
const STALE_A = 'src-54-stale-a';
const STALE_B = 'src-54-stale-b';

/** Module-level harness id counter — see createHarness (shared D1). */
let ADV_ID_COUNTER = 0;

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

async function seedItem(executor: DbExecutor, item: DemoItem): Promise<string> {
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
  return contentHash;
}

interface CandidateStorySeed {
  readonly storyId: string;
  readonly sourceId: string;
  /** The candidate's OWN stored text — deliberately DIFFERENT from the
   *  arriving snapshot's text in every adversarial scenario below. */
  readonly ownTitle: string;
  readonly ownBody: string;
  readonly ownUrl: string;
  /** The pre-computed fingerprint rows this story owns (kind + full value). */
  readonly fingerprints: readonly { readonly kind: string; readonly value: string }[];
}

/** Seed one HISTORICAL candidate story with its full witness scaffold. */
async function seedCandidateStory(executor: DbExecutor, seed: CandidateStorySeed): Promise<void> {
  const itemId = `item-${seed.storyId}-ref`;
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسندهٔ تاریخی', ?, ?, ?, '{}', 'processed')`,
    params: [
      itemId,
      seed.sourceId,
      `ext-${itemId}`,
      seed.ownUrl,
      seed.ownTitle,
      seed.ownBody,
      NOW,
      NOW,
      'h'.repeat(64),
    ],
  });
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
          VALUES (?, ?, 'discovered', 'unknown', 'industry', 50, 0, NULL, ?, ?, 1, ?, ?)`,
    params: [seed.storyId, `seeded-${seed.storyId}`, NOW, NOW, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
            confidence, status, created_at, updated_at)
          VALUES (?, ?, 'source_report', 'منبع تاریخی', 'reported', 'متن تاریخی', 0,
                  'unverified', ?, ?)`,
    params: [`edcl_${seed.storyId}`, seed.storyId, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
          VALUES (?, ?, ?, 'mentions', 0, 'متن تاریخی', ?)`,
    params: [`edev_${seed.storyId}`, `edcl_${seed.storyId}`, itemId, NOW],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'ready', 'fa', 'news_v1', 'تیتر تاریخی', '{}', '[]', '[]', NULL, 1, 'seed', ?, ?)`,
    params: [`eddr_${seed.storyId}`, seed.storyId, NOW, NOW],
  });
  for (const fingerprint of seed.fingerprints) {
    await executor.run({
      sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
            VALUES (?, ?, ?, ?)`,
      params: [seed.storyId, fingerprint.kind, fingerprint.value, NOW],
    });
  }
}

/** A story whose content_hash fingerprint digest EQUALS the given text's
 *  digest while its OWN attached text DIFFERS (the fingerprint is only the
 *  locator; the verified reuse correctly refuses). */
async function seedExactIdentityStory(
  executor: DbExecutor,
  input: {
    readonly storyId: string;
    readonly sourceId: string;
    readonly targetText: { readonly title: string; readonly body: string };
    readonly ownTitle: string;
    readonly ownBody: string;
    readonly ownUrl: string;
  },
): Promise<void> {
  const digest = await exactContentDigest(
    buildFullEvidenceText({ title: input.targetText.title, body_excerpt: input.targetText.body }),
  );
  await seedCandidateStory(executor, {
    storyId: input.storyId,
    sourceId: input.sourceId,
    ownTitle: input.ownTitle,
    ownBody: input.ownBody,
    ownUrl: input.ownUrl,
    fingerprints: [{ kind: 'content_hash', value: `sc1:${digest}:${input.storyId}` }],
  });
}

/** A story whose ONLY signal is the weak normalized-title key. */
async function seedTitleKeyStory(
  executor: DbExecutor,
  input: {
    readonly storyId: string;
    readonly sourceId: string;
    readonly title: string;
    readonly ownBody: string;
    readonly ownUrl: string;
  },
): Promise<void> {
  const value = await storyFingerprintValue(
    'title_key',
    normalizeForDirectTextMatch(input.title),
    input.storyId,
  );
  await seedCandidateStory(executor, {
    storyId: input.storyId,
    sourceId: input.sourceId,
    ownTitle: input.title,
    ownBody: input.ownBody,
    ownUrl: input.ownUrl,
    fingerprints: [{ kind: 'title_key', value }],
  });
}

/** A story whose ONLY signal is the VERBATIM stored url. */
async function seedUrlStory(
  executor: DbExecutor,
  input: {
    readonly storyId: string;
    readonly sourceId: string;
    readonly url: string;
    readonly ownTitle: string;
    readonly ownBody: string;
  },
): Promise<void> {
  const value = await storyFingerprintValue('url', input.url, input.storyId);
  await seedCandidateStory(executor, {
    storyId: input.storyId,
    sourceId: input.sourceId,
    ownTitle: input.ownTitle,
    ownBody: input.ownBody,
    ownUrl: input.url,
    fingerprints: [{ kind: 'url', value }],
  });
}

/** A story matching on url AND title_key but NOT content (the "updated
 *  article at the same page + same headline" shape → mixed signals). */
async function seedUrlTitleStory(
  executor: DbExecutor,
  input: {
    readonly storyId: string;
    readonly sourceId: string;
    readonly url: string;
    readonly title: string;
    readonly ownBody: string;
  },
): Promise<void> {
  const urlValue = await storyFingerprintValue('url', input.url, input.storyId);
  const titleValue = await storyFingerprintValue(
    'title_key',
    normalizeForDirectTextMatch(input.title),
    input.storyId,
  );
  await seedCandidateStory(executor, {
    storyId: input.storyId,
    sourceId: input.sourceId,
    ownTitle: input.title,
    ownBody: input.ownBody,
    ownUrl: input.url,
    fingerprints: [
      { kind: 'url', value: urlValue },
      { kind: 'title_key', value: titleValue },
    ],
  });
}

function createHarness(options?: {
  readonly matchingEnabled?: boolean;
  readonly adjudicationEnabled?: boolean;
  /** Fail ONLY the editorial commit batch (identified by its first
   *  statement) — never the AI budget-authorization batch. */
  readonly failBatchesMatching?: (statements: readonly { sql: string }[]) => boolean;
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
      if (options?.failBatchesMatching?.(statements)) {
        // A REAL store-outage model: the batch fails at the D1 LAYER — a
        // constraint violation on ONE statement appended AFTER the real
        // batch rolls the WHOLE atomic transaction back. The injected
        // statement targets `stories` (never `story_fingerprints`) so the
        // raw error can never be mistaken for the exact-content anchor
        // collision signature.
        return rawExecutor.batch([
          ...statements,
          { sql: 'INSERT INTO stories (id) VALUES (NULL)' },
        ]);
      }
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
              headlineFa: 'تیتر آزمایشی adversarial',
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
      idGenerator: { newId: () => `adv-id-${(ADV_ID_COUNTER += 1)}` },
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

/** One full engine pass: dispatch due jobs, then consume everything sent. */
async function runPipeline(harness: ReturnType<typeof createHarness>): Promise<string[]> {
  await harness.engine.dispatchDueJobs();
  const outcomes: string[] = [];
  for (const envelope of harness.envelopes.splice(0)) {
    const action = await harness.engine.consumeMessage(`adv-msg-${outcomes.length}`, envelope);
    outcomes.push(`${action.action}:${action.outcome}`);
  }
  return outcomes;
}

async function rowCount(executor: DbExecutor, table: string): Promise<number> {
  const row = await executor.first<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
  return row?.n ?? 0;
}

interface DraftRow {
  readonly id: string;
  readonly story_id: string;
  readonly document_json: string;
  readonly facts_json: string;
  readonly ai_run_id: string | null;
}

async function latestDraft(executor: DbExecutor): Promise<DraftRow> {
  const row = await executor.first<DraftRow>({
    sql: `SELECT id, story_id, document_json, facts_json, ai_run_id FROM drafts
          ORDER BY rowid DESC LIMIT 1`,
  });
  expect(row).not.toBeNull();
  return row!;
}

/** Deterministic ordered row snapshot of one table filtered by a predicate. */
async function snapshotRows(
  executor: DbExecutor,
  sql: string,
  params: readonly string[],
): Promise<string> {
  const rows = await executor.query<Record<string, unknown>>({ sql, params: [...params] });
  return JSON.stringify(rows.rows ?? rows);
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

describe('Phase 5.4 adversarial — crash mid-commit with BOTH gates ON', () => {
  it('the atomic batch rolls back completely; the honest retry recomputes FRESH coherent sibling reports', async () => {
    let failEditorialCommit = true;
    const harness = createHarness({
      matchingEnabled: true,
      adjudicationEnabled: true,
      // Fail ONLY the editorial commit batch (identified by its first
      // statement) — never the AI budget-authorization batch.
      failBatchesMatching: (statements) =>
        failEditorialCommit &&
        statements.some((statement) => statement.sql.includes('INSERT INTO stories')),
    });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, STALE_A, 'منبع کهنه');
    const arrivingText = {
      title: 'تیتر crash-retry داوری',
      body: 'بدنهٔ crash-retry داوری.',
    };
    // The candidate exists BEFORE both attempts: the retry must RE-discover it.
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adv_crash',
      sourceId: STALE_A,
      targetText: arrivingText,
      ownTitle: 'متن واقعی ذخیره‌شدهٔ crash',
      ownBody: 'این متن واقعی ذخیره‌شده با متن رسیده فرق دارد.',
      ownUrl: 'https://example.com/adv-crash-cand',
    });
    const item = {
      id: 'item-adv-crash',
      sourceId: SOURCE_A,
      title: arrivingText.title,
      body: arrivingText.body,
      url: 'https://example.com/adv-crash-arriving',
    };
    await seedItem(harness.rawExecutor, item);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });

    // Attempt 1: the commit batch throws mid-flight.
    const first = await runPipeline(harness);
    expect(first).toEqual(['ack:retry_scheduled']);
    // ZERO editorial state — the batch is atomic, nothing partial survived.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1); // the seeded candidate only
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1); // the seeded candidate draft only
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(1);
    // R1.17.1 (A1): the ONE real drafting invocation of this generation is
    // durably recorded (fenced standalone insert) and stays charged.
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(1);
    expect(harness.providerCalls).toHaveLength(1);
    const itemStatus = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: [item.id],
    });
    expect(itemStatus?.processing_status).toBe('new');

    // Attempt 2: the retry recomputes EVERYTHING from the durable state.
    failEditorialCommit = false;
    harness.clock.advance(60_000);
    const second = await runPipeline(harness);
    expect(second).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toHaveLength(2); // honest at-least-once
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(2);

    const draft = await latestDraft(harness.rawExecutor);
    expect(draft.story_id).not.toBe('edst_adv_crash');
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const discovery = readCandidateDiscoveryReport(document);
    expect(discovery.kind).toBe('candidate_discovery_v1');
    const matching = readCandidateMatchingReport(document);
    expect(matching.kind).toBe('candidate_matching_v1');
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1' || matching.kind !== 'candidate_matching_v1') {
      return;
    }
    // The recomputed reports are FRESH and coherent: the candidate was
    // re-discovered on the retry generation, not inherited from attempt 1.
    expect(read.report.entries).toHaveLength(1);
    expect(read.report.entries[0]?.storyId).toBe('edst_adv_crash');
    expect(read.report.entries[0]).toMatchObject({
      stance: 'exact_content_identity_observed',
      disposition: 'reuse_locator_supported',
    });
    expect(read.report.mergeDisposition).toBe('reuse_locator_single_exact_identity');
    expect(read.report.reviewRequired).toBe(false);
    expect(matching.report.entries[0]?.score).toBe(8); // content_hash only
    // The new story's own fingerprints ride in the committed batch: the ≤3
    // signal rows PLUS the exact-content GROUP anchor (`sc1:<digest>`, no
    // story suffix — R1.15) owned by this story.
    const fingerprintCount = await harness.rawExecutor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM story_fingerprints WHERE story_id = ?',
      params: [draft.story_id],
    });
    expect(fingerprintCount?.n).toBe(4);
    const anchorRow = await harness.rawExecutor.first<{ value: string }>({
      sql: `SELECT value FROM story_fingerprints WHERE story_id = ? AND kind = 'content_hash'
            AND value NOT LIKE '%:%:%'`,
      params: [draft.story_id],
    });
    expect(anchorRow?.value).toBe(
      exactContentAnchorValue(
        await exactContentDigest(
          buildFullEvidenceText({ title: arrivingText.title, body_excerpt: arrivingText.body }),
        ),
      ),
    );
  });
});

describe('Phase 5.4 adversarial — the enqueue idempotency boundary', () => {
  it('a duplicate enqueue resolves the SAME durable job row and produces exactly one draft', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-adv-dup-enqueue',
      sourceId: SOURCE_A,
      title: 'تیتر enqueue دوگانهٔ داوری',
      body: 'بدنهٔ enqueue دوگانهٔ داوری.',
      url: 'https://example.com/adv-dup-enqueue',
    };
    await seedItem(harness.rawExecutor, item);

    const first = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(first.kind).toBe('created');
    const second = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(second.kind).toBe('existing');
    if (first.kind !== 'created' || second.kind !== 'existing') return;
    expect(second.jobId).toBe(first.jobId); // the SAME durable row, never a twin job

    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toHaveLength(1);
    expect(await rowCount(harness.rawExecutor, 'jobs')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
  });
});

describe('Phase 5.4 adversarial — mixed signals and same-name games on the real path', () => {
  it('url+title_key match with UPDATED content → identity_not_established_signals_only → similarity-only defer', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, STALE_A, 'منبع کهنه');
    const sharedUrl = 'https://example.com/adv-mixed-page';
    const sharedTitle = 'تیتر مشترک صفحهٔ mixed داوری';
    await seedUrlTitleStory(harness.rawExecutor, {
      storyId: 'edst_adv_mixed',
      sourceId: STALE_A,
      url: sharedUrl,
      title: sharedTitle,
      ownBody: 'متن قدیمی صفحه برای نسخهٔ پیشین مقاله.',
    });
    const item = {
      id: 'item-adv-mixed',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ کاملاً به‌روزرسانی‌شدهٔ مقاله برای mixed.',
      url: sharedUrl, // the SAME page reposts the UPDATED article
    };
    await seedItem(harness.rawExecutor, item);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    const draft = await latestDraft(harness.rawExecutor);
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const matching = readCandidateMatchingReport(document);
    expect(matching.kind).toBe('candidate_matching_v1');
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1' || matching.kind !== 'candidate_matching_v1') {
      return;
    }
    // The mixed candidate: url (4) + title_key (1) = 5 — content never matched.
    expect(matching.report.entries).toHaveLength(1);
    expect(matching.report.entries[0]).toMatchObject({
      storyId: 'edst_adv_mixed',
      verdict: 'multiple_signals_observed',
      score: 5,
    });
    expect(matching.report.outcome).toBe('similar_signals_only_observed');
    expect(matching.report.resolution).toBe('single_top_candidate_observed');
    expect(matching.report.topScoreObserved).toBe(5);
    expect(read.report.entries[0]).toMatchObject({
      storyId: 'edst_adv_mixed',
      verdict: 'multiple_signals_observed',
      stance: 'identity_not_established_signals_only',
      disposition: 'defer_to_review',
      reasons: [
        'similarity_never_proves_identity',
        'correlated_signals_not_independent_confirmations',
      ],
    });
    expect(read.report.mergeDisposition).toBe('defer_similarity_only');
    expect(read.report.reviewRequired).toBe(true);
    // Correlated signals are NEVER independent confirmations — and never a merge.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });

  it('two DIFFERENT stories sharing one normalized title tie at the weak score → ambiguous_tie + similarity-only defer (NOT a conflict)', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, STALE_A, 'منبع کهنه');
    await seedSource(harness.rawExecutor, STALE_B, 'منبع کهنهٔ دوم');
    const sharedTitle = 'دمو: بازی‌های هم‌نام با تیتر یکسان داوری';
    // Two DIFFERENT games/stories that happen to share the same headline.
    await seedTitleKeyStory(harness.rawExecutor, {
      storyId: 'edst_adv_game1',
      sourceId: STALE_A,
      title: sharedTitle,
      ownBody: 'بدنهٔ بازی اول با محتوای مستقل.',
      ownUrl: 'https://example.com/adv-game1',
    });
    await seedTitleKeyStory(harness.rawExecutor, {
      storyId: 'edst_adv_game2',
      sourceId: STALE_B,
      title: sharedTitle,
      ownBody: 'بدنهٔ بازی دوم با محتوای مستقل دیگر.',
      ownUrl: 'https://example.com/adv-game2',
    });
    const item = {
      id: 'item-adv-game3',
      sourceId: SOURCE_A,
      title: sharedTitle,
      body: 'بدنهٔ تازهٔ بازی سوم کاملاً مستقل.',
      url: 'https://example.com/adv-game3',
    };
    await seedItem(harness.rawExecutor, item);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    const draft = await latestDraft(harness.rawExecutor);
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const matching = readCandidateMatchingReport(document);
    expect(matching.kind).toBe('candidate_matching_v1');
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1' || matching.kind !== 'candidate_matching_v1') {
      return;
    }
    // Two equal weak scores = an honest AMBIGUOUS tie at the matching level.
    expect(matching.report.entries).toHaveLength(2);
    expect(matching.report.entries.every((entry) => entry.score === 1)).toBe(true);
    expect(matching.report.resolution).toBe('ambiguous_tie_observed');
    expect(matching.report.outcome).toBe('similar_signals_only_observed');
    // The ADJUDICATION is similarity-only defer — a CONFLICT requires exact
    // identity, and two weak titles are never one.
    expect(
      read.report.entries.every((entry) => entry.stance === 'identity_not_established_title_only'),
    ).toBe(true);
    expect(read.report.mergeDisposition).toBe('defer_similarity_only');
    expect(read.report.mergeDisposition).not.toBe('defer_conflict_multiple_identity_candidates');
    expect(read.report.reviewRequired).toBe(true);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(3);
  });

  it('a VERSION UPDATE at the same url (new content) → url-only defer — never identity, never a locator', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, STALE_A, 'منبع کهنه');
    const pageUrl = 'https://example.com/adv-version-page';
    await seedUrlStory(harness.rawExecutor, {
      storyId: 'edst_adv_version',
      sourceId: STALE_A,
      url: pageUrl,
      ownTitle: 'تیتر نسخهٔ پیشین صفحه',
      ownBody: 'متن کامل نسخهٔ پیشین صفحه که با نسخهٔ تازه فرق دارد.',
    });
    const item = {
      id: 'item-adv-version',
      sourceId: SOURCE_A,
      title: 'تیتر نسخهٔ تازهٔ صفحه',
      body: 'متن کامل نسخهٔ تازهٔ صفحه — محتوای به‌روزرسانی‌شده.',
      url: pageUrl, // the SAME page now carries the NEW version
    };
    await seedItem(harness.rawExecutor, item);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    const draft = await latestDraft(harness.rawExecutor);
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const matching = readCandidateMatchingReport(document);
    expect(matching.kind).toBe('candidate_matching_v1');
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1' || matching.kind !== 'candidate_matching_v1') {
      return;
    }
    // ONLY the verbatim url matched; the new version's content never did.
    expect(matching.report.entries[0]).toMatchObject({
      storyId: 'edst_adv_version',
      verdict: 'shared_url_observed',
      score: 4,
    });
    expect(read.report.entries[0]).toMatchObject({
      stance: 'identity_not_established_url_only',
      disposition: 'defer_to_review',
      reasons: ['similarity_never_proves_identity', 'url_is_not_content_identity'],
    });
    expect(read.report.mergeDisposition).toBe('defer_similarity_only');
    expect(read.report.reviewRequired).toBe(true);
    // A url match NEVER becomes the verified reuse locator.
    expect(read.report.mergeDisposition).not.toBe('reuse_locator_single_exact_identity');
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
  });
});

describe('Phase 5.4 adversarial — duplicate content from TWO INDEPENDENT sources (P1 false-merge proof)', () => {
  it('two exact-identity candidates anchored by two INDEPENDENT sources → typed conflict; every candidate-owned row byte-untouched; independence stays unassessed; no executed merge', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع رسیده');
    await seedSource(harness.rawExecutor, STALE_A, 'منبع مستقل اول');
    await seedSource(harness.rawExecutor, STALE_B, 'منبع مستقل دوم');
    const arrivingText = {
      title: 'تیتر محتوای تکراری از منابع مستقل',
      body: 'بدنهٔ محتوای تکراری از منابع مستقل.',
    };
    // The SAME text fingerprinted by TWO stories from TWO INDEPENDENT sources.
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adv_indep1',
      sourceId: STALE_A,
      targetText: arrivingText,
      ownTitle: 'متن واقعی متفاوت مستقل اول',
      ownBody: 'این متن واقعی ذخیره‌شدهٔ منبع مستقل اول است.',
      ownUrl: 'https://example.com/adv-indep1',
    });
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adv_indep2',
      sourceId: STALE_B,
      targetText: arrivingText,
      ownTitle: 'متن واقعی متفاوت مستقل دوم',
      ownBody: 'این متن واقعی ذخیره‌شدهٔ منبع مستقل دوم است.',
      ownUrl: 'https://example.com/adv-indep2',
    });

    // P1 evidence: snapshot EVERY candidate-owned row BEFORE the run.
    const candidateIds = ['edst_adv_indep1', 'edst_adv_indep2'];
    const refItemIds = ['item-edst_adv_indep1-ref', 'item-edst_adv_indep2-ref'];
    const beforeStories = await snapshotRows(
      harness.rawExecutor,
      'SELECT * FROM stories WHERE id IN (?, ?) ORDER BY id',
      candidateIds,
    );
    const beforeClaims = await snapshotRows(
      harness.rawExecutor,
      'SELECT * FROM claims WHERE story_id IN (?, ?) ORDER BY id',
      candidateIds,
    );
    const beforeEvidence = await snapshotRows(
      harness.rawExecutor,
      `SELECT * FROM evidence WHERE claim_id IN
         (SELECT id FROM claims WHERE story_id IN (?, ?)) ORDER BY id`,
      candidateIds,
    );
    const beforeFingerprints = await snapshotRows(
      harness.rawExecutor,
      'SELECT * FROM story_fingerprints WHERE story_id IN (?, ?) ORDER BY kind, value',
      candidateIds,
    );
    const beforeDrafts = await snapshotRows(
      harness.rawExecutor,
      'SELECT * FROM drafts WHERE story_id IN (?, ?) ORDER BY id',
      candidateIds,
    );
    const beforeRefItems = await snapshotRows(
      harness.rawExecutor,
      'SELECT * FROM source_items WHERE id IN (?, ?) ORDER BY id',
      refItemIds,
    );

    const item = {
      id: 'item-adv-indep',
      sourceId: SOURCE_A,
      title: arrivingText.title,
      body: arrivingText.body,
      url: 'https://example.com/adv-indep-arriving',
    };
    await seedItem(harness.rawExecutor, item);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    const draft = await latestDraft(harness.rawExecutor);
    const documentJson = draft.document_json;
    const document = JSON.parse(documentJson) as Record<string, unknown>;
    const read = readCandidateAdjudicationReport(document);
    expect(read.kind).toBe('candidate_adjudication_v1');
    if (read.kind !== 'candidate_adjudication_v1') return;
    // The typed conflict: BOTH stances are identity-grade, NEITHER is picked.
    expect(read.report.entries).toHaveLength(2);
    expect(
      read.report.entries.every((entry) => entry.stance === 'exact_content_identity_observed'),
    ).toBe(true);
    expect(read.report.mergeDisposition).toBe('defer_conflict_multiple_identity_candidates');
    expect(read.report.mergeDispositionReasons).toEqual([
      'conflict_never_auto_resolved',
      'exact_identity_candidates_conflict',
    ]);
    expect(read.report.reviewRequired).toBe(true);
    // Source independence is UNASSESSED — verbatim, whatever the sources are.
    expect(read.report.unassessed).toEqual(CANDIDATE_ADJUDICATION_UNASSESSED);
    expect(read.report.limitations).toEqual(CANDIDATE_ADJUDICATION_LIMITATIONS);
    expect(CANDIDATE_ADJUDICATION_LIMITATIONS).toContain('conflict_never_auto_resolved');
    // NO executed merge anywhere in the stored document (P1).
    expect(documentJson).not.toContain('"executed"');
    // P1 proof: EVERY candidate-owned row is byte-identical after the run.
    expect(
      await snapshotRows(
        harness.rawExecutor,
        'SELECT * FROM stories WHERE id IN (?, ?) ORDER BY id',
        candidateIds,
      ),
    ).toBe(beforeStories);
    expect(
      await snapshotRows(
        harness.rawExecutor,
        'SELECT * FROM claims WHERE story_id IN (?, ?) ORDER BY id',
        candidateIds,
      ),
    ).toBe(beforeClaims);
    expect(
      await snapshotRows(
        harness.rawExecutor,
        `SELECT * FROM evidence WHERE claim_id IN
           (SELECT id FROM claims WHERE story_id IN (?, ?)) ORDER BY id`,
        candidateIds,
      ),
    ).toBe(beforeEvidence);
    expect(
      await snapshotRows(
        harness.rawExecutor,
        'SELECT * FROM story_fingerprints WHERE story_id IN (?, ?) ORDER BY kind, value',
        candidateIds,
      ),
    ).toBe(beforeFingerprints);
    expect(
      await snapshotRows(
        harness.rawExecutor,
        'SELECT * FROM drafts WHERE story_id IN (?, ?) ORDER BY id',
        candidateIds,
      ),
    ).toBe(beforeDrafts);
    // The reference items' raw_json (OD-009) is preserved byte-identically.
    expect(
      await snapshotRows(
        harness.rawExecutor,
        'SELECT * FROM source_items WHERE id IN (?, ?) ORDER BY id',
        refItemIds,
      ),
    ).toBe(beforeRefItems);
    // The arriving item got its OWN story — no merge, no rewrite of theirs.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(3);
    expect(draft.story_id).not.toBe('edst_adv_indep1');
    expect(draft.story_id).not.toBe('edst_adv_indep2');
  });
});

describe('Phase 5.4 adversarial — the P1 provenance witness walk (item → draft)', () => {
  it('every witness of the item→draft path is preserved AND recomputable from the stored state', async () => {
    const harness = createHarness({ matchingEnabled: true, adjudicationEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    await seedSource(harness.rawExecutor, STALE_A, 'منبع کهنه');
    const arrivingText = {
      title: 'تیتر مسیر شاهدهای حفظ‌شده',
      body: 'بدنهٔ مسیر شاهدهای حفظ‌شده.',
    };
    await seedExactIdentityStory(harness.rawExecutor, {
      storyId: 'edst_adv_witness',
      sourceId: STALE_A,
      targetText: arrivingText,
      ownTitle: 'متن واقعی متفاوت شاهد',
      ownBody: 'این متن واقعی ذخیره‌شدهٔ شاهد است.',
      ownUrl: 'https://example.com/adv-witness-cand',
    });
    const item = {
      id: 'item-adv-witness',
      sourceId: SOURCE_A,
      title: arrivingText.title,
      body: arrivingText.body,
      url: 'https://example.com/adv-witness-arriving',
    };
    const itemHash = await seedItem(harness.rawExecutor, item);
    await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_completed']);

    const draft = await latestDraft(harness.rawExecutor);
    const storyId = draft.story_id;
    // (1) the draft's story exists and owns the draft.
    const story = await harness.rawExecutor.first<{ id: string; status: string }>({
      sql: 'SELECT id, status FROM stories WHERE id = ?',
      params: [storyId],
    });
    expect(story).not.toBeNull();
    expect(story?.id).toBe(storyId);
    // (2) the story's source_report claim.
    const claims = await harness.rawExecutor.query<{
      id: string;
      claim_type: string;
      status: string;
    }>({ sql: 'SELECT id, claim_type, status FROM claims WHERE story_id = ?', params: [storyId] });
    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0]).toMatchObject({ claim_type: 'source_report', status: 'unverified' });
    const claimId = claims.rows[0]!.id;
    // (3) the claim's mentions evidence points BACK at the arriving item.
    const evidence = await harness.rawExecutor.query<{
      id: string;
      source_item_id: string;
      stance: string;
    }>({
      sql: 'SELECT id, source_item_id, stance FROM evidence WHERE claim_id = ?',
      params: [claimId],
    });
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({ source_item_id: item.id, stance: 'mentions' });
    // (4) the stored item: the snapshot identity witness is INTACT and the
    //     raw_json (OD-009) untouched; the honest processed flip happened.
    const storedItem = await harness.rawExecutor.first<{
      content_hash: string;
      raw_json: string;
      processing_status: string;
    }>({
      sql: 'SELECT content_hash, raw_json, processing_status FROM source_items WHERE id = ?',
      params: [item.id],
    });
    expect(storedItem?.content_hash).toBe(itemHash);
    expect(storedItem?.content_hash).toBe(
      await sha256Hex(`${item.id}\u001f${item.title}\u001f${item.body}`),
    );
    expect(storedItem?.raw_json).toBe('{}');
    expect(storedItem?.processing_status).toBe('processed');
    // (5) the new story's ≤3 fingerprints are recomputable FROM THE STORED
    //     item — the index never holds an unexplainable row.
    const fingerprints = await harness.rawExecutor.query<{ kind: string; value: string }>({
      sql: 'SELECT kind, value FROM story_fingerprints WHERE story_id = ? ORDER BY kind',
      params: [storyId],
    });
    const fullText = buildFullEvidenceText({ title: item.title, body_excerpt: item.body });
    const contentDigest = await exactContentDigest(fullText);
    const expectedValues = new Set([
      await storyFingerprintValue('url', item.url, storyId),
      await storyFingerprintValue('content_hash', fullText, storyId),
      await storyFingerprintValue('title_key', normalizeForDirectTextMatch(item.title), storyId),
      // The exact-content GROUP anchor (R1.15): `sc1:<digest>` with NO story
      // suffix — the SQL-level locator of the stable result for one content
      // group, owned by THIS story on the real path.
      exactContentAnchorValue(contentDigest),
    ]);
    expect(fingerprints.rows).toHaveLength(4);
    for (const row of fingerprints.rows) {
      expect(expectedValues.has(row.value), `fingerprint ${row.kind} recomputable`).toBe(true);
    }
    // The anchor is EXACTLY the group anchor of the stored text — recomputable.
    expect(expectedValues.has(exactContentAnchorValue(contentDigest))).toBe(true);
    // (6) the document's snapshot identity names the SAME stored item.
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const discovery = readCandidateDiscoveryReport(document);
    expect(discovery.kind).toBe('candidate_discovery_v1');
    if (discovery.kind !== 'candidate_discovery_v1') return;
    expect(discovery.report.snapshot.sourceItemId).toBe(item.id);
    expect(discovery.report.snapshot.contentHash).toBe(itemHash);
    expect(discovery.report.storyId).toBe(storyId);
    // (7) the evidence guard judged the claims against THIS snapshot.
    const guard = readEvidenceGuardReport(document);
    expect(guard.kind).toBe('guard_v1');
    if (guard.kind !== 'guard_v1') return;
    expect(guard.report.snapshot.sourceItemId).toBe(item.id);
    expect(guard.report.snapshot.contentHash).toBe(itemHash);
    expect(guard.report.evaluationStatus).toBe('evaluated');
    // (8) NO dangling witness: every model claim references an id from the
    //     REAL request evidence set — whose stable public identity IS the
    //     ingestion-side source_item id (AiEvidenceSnippet contract).
    const modelClaims = (
      document as {
        modelClaims?: readonly { readonly evidenceIds: readonly string[] }[];
      }
    ).modelClaims;
    expect(Array.isArray(modelClaims)).toBe(true);
    for (const claim of modelClaims ?? []) {
      expect(claim.evidenceIds.length).toBeGreaterThan(0);
      for (const referencedId of claim.evidenceIds) {
        expect(referencedId).toBe(item.id);
      }
    }
    // (9) the draft's AI run is a REAL recorded invocation of this attempt.
    expect(draft.ai_run_id).not.toBeNull();
    const aiRun = await harness.rawExecutor.first<{ task: string; status: string }>({
      sql: 'SELECT task, status FROM ai_runs WHERE id = ?',
      params: [draft.ai_run_id ?? ''],
    });
    expect(aiRun).toMatchObject({ task: 'news_draft', status: 'succeeded' });
  });
});
