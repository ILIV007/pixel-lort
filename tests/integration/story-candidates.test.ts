import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
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
import {
  createEditorialPrepareDraftHandler,
  type EditorialPrepareDraftHandlerOptions,
} from '../../src/application/editorial/prepare-draft-handler';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import { commitEditorialResult } from '../../src/adapters/db/editorial-store';
import { claimJob, findJobById } from '../../src/adapters/db/job-store';
import {
  buildStoryFingerprints,
  FINGERPRINT_LOOKUP_ROW_LIMIT,
} from '../../src/domain/editorial/story-fingerprints';
import {
  buildCandidateDiscoveryReport,
  readCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
} from '../../src/domain/editorial/candidate-discovery';
import { storyIdForSnapshot, storyKeyForSnapshot } from '../../src/domain/editorial/identity';

/**
 * R1.13 (Phase 5C-1) integration suite — REAL workerd D1, REAL pipeline.
 * The ONLY artificial piece is the provider port (zero network). Every
 * candidate-discovery behavior under test is the shipped code: durable
 * multi-owner fingerprints, bounded honest lookups, the versioned report
 * riding inside document_json of the SAME fenced commit, and the typed
 * outcomes of every failure window. Candidate discovery is ONLY discovery:
 * no merge, no trust change, no truth verification.
 */

const NOW = 1_760_000_000_000;
const SOURCE_X = 'src-cand-x';
const SOURCE_Y = 'src-cand-y';

/** Executor wrapper: count + fail/throw selected statements on demand. */
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
  readonly failLookupsMatching: (match: (sql: string) => boolean) => void;
  readonly mutateBeforeEditorialCommit: (mutate: (raw: DbExecutor) => Promise<void>) => void;
}

function createHarness(options?: {
  aiEnabled?: boolean;
  editorialGateOn?: boolean;
  mutateBeforeEditorialCommit?: (raw: DbExecutor) => Promise<void>;
  failBatchesMatching?: (statements: readonly { sql: string }[]) => boolean;
  /** R1.13.1: capture the REAL fingerprint lookup statements the shipped
   * handler sends, so tests can EXPLAIN the exact SQL with the exact binds. */
  captureLookupStatements?: DbStatement[];
  /** R1.13.1: work INSIDE the provider-call window — after the caller's
   * lookup and BEFORE the caller's commit (the honest interleaving point
   * of the pipeline). */
  onProviderCall?: (evidenceId: string) => Promise<void>;
}): Harness {
  const clock = fixedClock(NOW);
  const logger = createLogger({ level: 'error', clock });
  const rawExecutor = createDbExecutor(env.DB, { clock });

  let providerCalls = 0;
  let failBatches: (statements: readonly { sql: string }[]) => boolean = () => false;
  let failLookups: (sql: string) => boolean = () => false;
  const mutateHook = { fn: options?.mutateBeforeEditorialCommit };

  const executor = wrapExecutor(rawExecutor, {
    onQuery: (statement) => {
      if (
        options?.captureLookupStatements !== undefined &&
        statement.sql.includes('FROM story_fingerprints')
      ) {
        options.captureLookupStatements.push(statement);
      }
      if (failLookups(statement.sql)) {
        throw new Error('injected_candidate_lookup_failure');
      }
    },
    onBatch: async (statements) => {
      if (failBatches(statements)) {
        throw new Error('injected_mid_commit_failure');
      }
      if (
        mutateHook.fn !== undefined &&
        statements.some((statement) => statement.sql.includes('INSERT INTO stories'))
      ) {
        await mutateHook.fn(rawExecutor);
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

  const editorialGateOn = options?.editorialGateOn ?? true;
  const handlers = editorialGateOn
    ? [
        createEditorialPrepareDraftHandler({
          executor,
          aiService,
          nowMs: () => clock.now(),
          logger,
        }),
      ]
    : [];

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
      idGenerator: { newId: () => `cand-id-${(idCounter += 1)}` },
      clock,
      random: () => 1,
      logger,
      jobsProducer,
      dlqProducer,
      policyGates: { ingestionGateOn: true, editorialGateOn },
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
    failLookupsMatching: (match) => {
      failLookups = match;
    },
    mutateBeforeEditorialCommit: (mutate) => {
      mutateHook.fn = mutate;
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

interface DraftRead {
  readonly id: string;
  readonly story_id: string;
  readonly document_json: string;
}

async function readLatestDraft(executor: DbExecutor): Promise<DraftRead> {
  const row = await executor.first<DraftRead>({
    // rowid = insertion order (the fixed clock makes created_at ties real).
    sql: 'SELECT id, story_id, document_json FROM drafts ORDER BY rowid DESC LIMIT 1',
  });
  expect(row).not.toBeNull();
  return row as DraftRead;
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

describe('R1.13 — candidate discovery on the real path (two sources, related pair)', () => {
  it('the SECOND draft observes the first story via the shared URL; both stories stay independent', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    // The related pair: SAME canonical_url, DIFFERENT text and title.
    await seedItem(harness.rawExecutor, {
      id: 'item-a1',
      sourceId: SOURCE_X,
      title: 'تیتر منبع اول',
      body: 'متن کامل خبر از منبع اول با جزئیات متفاوت.',
      url: 'https://example.com/shared-news',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-a2',
      sourceId: SOURCE_Y,
      title: 'تیتر کاملاً متفاوت منبع دوم',
      body: 'بدنهٔ خبر دوم با محتوای دیگر و بدون شباهت متنی.',
      url: 'https://example.com/shared-news',
    });

    // First run: an EMPTY index — the honest observation is "nothing seen".
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-a1',
      }),
    ).toMatchObject({ kind: 'created' });
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    const first = await readLatestDraft(harness.rawExecutor);
    const firstRead = readCandidateDiscoveryReport(JSON.parse(first.document_json));
    expect(firstRead.kind).toBe('candidate_discovery_v1');
    if (firstRead.kind !== 'candidate_discovery_v1') return;
    expect(firstRead.report.observation).toBe('no_candidates_observed');
    expect(firstRead.report.limitations).toContain('candidate_only_not_merge');

    // Second run: the SAME url fingerprint finds the first story — url only.
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-a2',
      }),
    ).toMatchObject({ kind: 'created' });
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    const second = await readLatestDraft(harness.rawExecutor);
    const secondRead = readCandidateDiscoveryReport(JSON.parse(second.document_json));
    expect(secondRead.kind).toBe('candidate_discovery_v1');
    if (secondRead.kind !== 'candidate_discovery_v1') return;
    expect(secondRead.report.observation).toBe('candidates_observed');
    expect(secondRead.report.candidates).toHaveLength(1);
    expect(secondRead.report.candidates[0]!.storyId).toBe(first.story_id);
    expect(secondRead.report.candidates[0]!.matchedSignals).toEqual([
      { kind: 'url', reasonCode: 'url_fingerprint_match' },
    ]);

    // NO merge happened: two independent stories, zero trust/confidence lift.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(2);
    const claimRows = await harness.rawExecutor.query<{ confidence: number }>({
      sql: 'SELECT confidence FROM claims',
    });
    for (const row of claimRows.rows) {
      expect(row.confidence).toBe(0);
    }
    const storyRows = await harness.rawExecutor.query<{ status: string; trust_status: string }>({
      sql: 'SELECT status, trust_status FROM stories',
    });
    for (const row of storyRows.rows) {
      expect(row.status).toBe('discovered');
      expect(row.trust_status).toBe('unknown');
    }
  });
});

describe('R1.13 — signal honesty on the real path', () => {
  it('same text from a different source REUSES the first result (R1.15): provenance kept; same title alone is title-only; different everything matches nothing', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    const title = 'عنوان مشترک دو خبر';
    const body = 'متن یکسان کامل که از دو منبع منتشر شده است.';
    await seedItem(harness.rawExecutor, {
      id: 'item-t1',
      sourceId: SOURCE_X,
      title,
      body,
      url: 'https://x.example/one',
    });
    // Same title+body, different source+url → R1.15: the second item REUSES
    // the first result (zero provider calls); its provenance is ADDED as
    // its own source_report claim under the first story.
    await seedItem(harness.rawExecutor, {
      id: 'item-t2',
      sourceId: SOURCE_Y,
      title,
      body,
      url: 'https://y.example/two',
    });
    // Same title, CONFLICTING body, different url → title_key ONLY.
    await seedItem(harness.rawExecutor, {
      id: 'item-t3',
      sourceId: SOURCE_Y,
      title,
      body: 'روایت کاملاً متفاوت و حتی متناقض با خبر اول.',
      url: 'https://y.example/three',
    });
    // A Persian-digit difference (۱→۲) is NEVER equated; url param differs.
    await seedItem(harness.rawExecutor, {
      id: 'item-t4',
      sourceId: SOURCE_Y,
      title: `${title} نسخهٔ ۲`,
      body: body.replace('یکسان', 'دوگانه'),
      url: 'https://x.example/one?utm=other',
    });
    for (const id of ['item-t1', 'item-t2', 'item-t3', 'item-t4']) {
      expect(
        await enqueueEditorialPrepareDraft({
          engine: harness.engine,
          executor: harness.rawExecutor,
          sourceItemId: id,
        }),
      ).toMatchObject({ kind: 'created' });
      expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    }
    // R1.15: t2 reused t1's result — 3 drafts from 4 items, 3 provider
    // calls, 3 ai_runs rows (a provider that never ran is never fabricated).
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(3);
    expect(harness.providerCalls).toBe(3);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(3);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(3);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(4);
    const drafts = await harness.rawExecutor.query<{ id: string; document_json: string }>({
      // rowid = insertion order (the fixed clock makes created_at ties real).
      sql: 'SELECT id, document_json FROM drafts ORDER BY rowid ASC',
    });
    const reports = drafts.rows.map((row) => {
      const read = readCandidateDiscoveryReport(JSON.parse(row.document_json));
      expect(read.kind).toBe('candidate_discovery_v1');
      return read.kind === 'candidate_discovery_v1' ? read.report : null;
    });

    // item-t1 ran against an empty index.
    expect(reports[0]!.observation).toBe('no_candidates_observed');
    // item-t2 has NO draft (it reused t1's result — R1.15); its provenance
    // lives under t1's story as its OWN source_report claim.
    const t2Claim = await harness.rawExecutor.first<{ story_id: string; subject: string }>({
      sql: `SELECT c.story_id, c.subject FROM claims c
             JOIN evidence e ON e.claim_id = c.id
            WHERE e.source_item_id = 'item-t2'`,
    });
    expect(t2Claim).not.toBeNull();
    const t1Story = await harness.rawExecutor.first<{ story_id: string }>({
      sql: `SELECT c.story_id FROM claims c
             JOIN evidence e ON e.claim_id = c.id
            WHERE e.source_item_id = 'item-t1'`,
    });
    expect(t2Claim!.story_id).toBe(t1Story!.story_id);
    expect(t2Claim!.subject).toBe('منبع ایگرگ');
    // item-t3 sees t1's story via title_key ONLY (t2 created no story of
    // its own — the reused provenance never hijacks the index).
    expect(reports[1]!.candidates).toHaveLength(1);
    expect(reports[1]!.candidates[0]!.matchedSignals.map((signal) => signal.kind)).toEqual([
      'title_key',
    ]);
    // item-t4: number/body/url differences preserved — NOTHING observed.
    expect(reports[2]!.observation).toBe('no_candidates_observed');
    expect(reports[2]!.candidates).toEqual([]);
  });

  it('every story keeps ALL its own fingerprint rows; multi-owner rows are never overwritten', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    const title = 'عنوان مشترک چند مالک';
    await seedItem(harness.rawExecutor, { id: 'item-m1', sourceId: SOURCE_X, title });
    // DIFFERENT body (same weak title): the multi-owner fingerprint
    // contract is about stories with distinct content — identical content
    // is the R1.15 reuse path and never creates a second story.
    await seedItem(harness.rawExecutor, {
      id: 'item-m2',
      sourceId: SOURCE_Y,
      title,
      body: 'بدنهٔ متفاوت برای مالک دومِ همین عنوان.',
    });
    for (const id of ['item-m1', 'item-m2']) {
      expect(
        await enqueueEditorialPrepareDraft({
          engine: harness.engine,
          executor: harness.rawExecutor,
          sourceItemId: id,
        }),
      ).toMatchObject({ kind: 'created' });
      expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    }
    const digest = await (async () => {
      const plans = await buildStoryFingerprints({
        storyId: 'irrelevant',
        canonicalUrl: null,
        fullEvidenceText: title,
        title,
      });
      return plans.find((plan) => plan.kind === 'title_key')!.digest;
    })();
    const owners = await harness.rawExecutor.query<{ story_id: string; value: string }>({
      sql: 'SELECT story_id, value FROM story_fingerprints WHERE kind = ? AND value >= ? AND value < ?',
      params: ['title_key', `sc1:${digest}:`, `sc1:${digest}:\u{10ffff}`],
    });
    // TWO independent owners hold the SAME digest — the sc1 namespace made
    // the index multi-owner; neither write replaced the other.
    expect(owners.rows).toHaveLength(2);
    expect(new Set(owners.rows.map((row) => row.story_id))).toHaveLength(2);
    for (const row of owners.rows) {
      expect(row.value.endsWith(`:${row.story_id}`)).toBe(true);
    }
  });
});

describe('R1.13 — bounded, honest candidate lookup at scale', () => {
  it('12 pre-indexed title owners: the 13th reports overflow, truncation, and honest counts', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    const sharedTitle = 'عنوان پرتکرار برای سنجش سرریز';
    // Seed 12 stories + their title_key fingerprints DIRECTLY (sc1 format).
    for (let index = 0; index < 12; index++) {
      const storyId = `edst_pre_${String(index).padStart(2, '0')}`;
      await harness.rawExecutor.run({
        sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
                confidence, working_headline, first_seen_at, last_evidence_at, version,
                created_at, updated_at)
              VALUES (?, ?, 'discovered', 'unknown', 'industry', 50, 0, NULL, ?, ?, 1, ?, ?)`,
        params: [storyId, `pre-key-${index}`, NOW, NOW, NOW, NOW],
      });
      const plans = await buildStoryFingerprints({
        storyId,
        canonicalUrl: null,
        fullEvidenceText: sharedTitle,
        title: sharedTitle,
      });
      const plan = plans.find((entry) => entry.kind === 'title_key')!;
      await harness.rawExecutor.run({
        sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
              VALUES (?, ?, ?, ?)`,
        params: [storyId, plan.kind, plan.value, NOW],
      });
    }
    // The 13th story goes through the REAL pipeline.
    await seedItem(harness.rawExecutor, {
      id: 'item-overflow',
      sourceId: SOURCE_X,
      title: sharedTitle,
      url: null,
    });
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-overflow',
      }),
    ).toMatchObject({ kind: 'created' });
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);

    const draft = await readLatestDraft(harness.rawExecutor);
    const read = readCandidateDiscoveryReport(JSON.parse(draft.document_json));
    expect(read.kind).toBe('candidate_discovery_v1');
    if (read.kind !== 'candidate_discovery_v1') return;
    // url is absent → exactly TWO lookups (content_hash + title_key), and
    // the probe hit its 9-row limit: overflow is RECORDED, never hidden —
    // the report claims neither "all candidates" nor a unique story.
    expect(read.report.lookup.overflowObserved).toBe(true);
    expect(read.report.counts.lookupsPerformed).toBe(2);
    expect(read.report.counts.uniqueCandidatesObserved).toBe(FINGERPRINT_LOOKUP_ROW_LIMIT);
    expect(read.report.counts.candidatesReported).toBe(8);
    expect(read.report.candidatesTruncated).toBe(true);
    expect(read.report.candidates).toHaveLength(8);
  });
});

describe('R1.13.1 — deterministic bounded selection under overflow (Posidon finding)', () => {
  const SHARED_TITLE_R131 = 'عنوان مشترک برای قطعیت انتخاب در سرریز';
  // Ascending story ids — the value suffix makes index-value order equal
  // to this order, so the FIRST 9 values and the LAST 9 are different sets.
  const ASCENDING = Array.from(
    { length: 12 },
    (_, index) => `edst_r131_${String(index).padStart(2, '0')}`,
  );

  /** Seed N stories owning ONE shared title_key digest, in the given order. */
  async function seedTitleOwners(executor: DbExecutor, storyIds: readonly string[]): Promise<void> {
    const plans = await buildStoryFingerprints({
      storyId: 'digest-probe',
      canonicalUrl: null,
      fullEvidenceText: SHARED_TITLE_R131,
      title: SHARED_TITLE_R131,
    });
    const digest = plans.find((plan) => plan.kind === 'title_key')!.digest;
    for (const storyId of storyIds) {
      await executor.run({
        sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
                confidence, working_headline, first_seen_at, last_evidence_at, version,
                created_at, updated_at)
              VALUES (?, ?, 'discovered', 'unknown', 'industry', 50, 0, NULL, ?, ?, 1, ?, ?)`,
        params: [storyId, `pre-${storyId}`, NOW, NOW, NOW, NOW],
      });
      await executor.run({
        sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
              VALUES (?, 'title_key', ?, ?)`,
        params: [storyId, `sc1:${digest}:${storyId}`, NOW],
      });
    }
  }

  /** Run a 13th same-title item through the REAL pipeline, read its report. */
  async function runThirteenthStory(
    harness: Harness,
    itemId: string,
  ): Promise<CandidateDiscoveryReport> {
    await seedItem(harness.rawExecutor, {
      id: itemId,
      sourceId: SOURCE_X,
      title: SHARED_TITLE_R131,
      url: null,
    });
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: itemId,
      }),
    ).toMatchObject({ kind: 'created' });
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    const draft = await readLatestDraft(harness.rawExecutor);
    const read = readCandidateDiscoveryReport(JSON.parse(draft.document_json));
    expect(read.kind).toBe('candidate_discovery_v1');
    if (read.kind !== 'candidate_discovery_v1') {
      throw new Error('unreachable: report must be candidate_discovery_v1');
    }
    return read.report;
  }

  it('12 owners of ONE digest: normal lookup vs reverse_unordered_selects + permuted seed order produce the SAME final candidate set', async () => {
    // ---- Run A: seeds inserted ascending, D1's default unordered-select
    // behavior. The honest overflow is still recorded (9-row probe, cap 8).
    const harnessA = createHarness();
    await seedSource(harnessA.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedTitleOwners(harnessA.rawExecutor, ASCENDING);
    const reportA = await runThirteenthStory(harnessA, 'item-r131-a');
    expect(reportA.lookup.overflowObserved).toBe(true);
    expect(reportA.candidates).toHaveLength(8);

    // Clean slate between the runs — run B carries the SAME data.
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

    // ---- Run B: the SAME 12 owners inserted in a PERMUTED (descending)
    // order, with the D1 connection asked to REVERSE every unordered
    // SELECT — the honesty probe for "LIMIT without ORDER BY". Restored
    // in `finally` so no other test ever runs under the flipped pragma.
    const harnessB = createHarness();
    await seedSource(harnessB.rawExecutor, SOURCE_X, 'منبع ایکس');
    await env.DB.exec('PRAGMA reverse_unordered_selects = ON');
    let reportB: CandidateDiscoveryReport;
    try {
      await seedTitleOwners(harnessB.rawExecutor, [...ASCENDING].reverse());
      reportB = await runThirteenthStory(harnessB, 'item-r131-b');
    } finally {
      await env.DB.exec('PRAGMA reverse_unordered_selects = OFF');
    }
    expect(reportB.lookup.overflowObserved).toBe(true);
    expect(reportB.candidates).toHaveLength(8);

    // THE CONTRACT: identical stored data → identical final candidate
    // selection, regardless of scan direction or physical insertion order.
    // The builder's ascending sort cannot rescue a DIFFERENT pre-LIMIT page.
    expect(reportB.candidates.map((candidate) => candidate.storyId)).toEqual(
      reportA.candidates.map((candidate) => candidate.storyId),
    );
  });

  it('the shipped lookup keeps an explicit PK-compatible order: the REAL plan is a range SEARCH — no full scan, no temporary sort', async () => {
    const captured: DbStatement[] = [];
    const harness = createHarness({ captureLookupStatements: captured });
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    // Two pre-existing owners make the probed range non-trivial.
    await seedTitleOwners(harness.rawExecutor, ASCENDING.slice(0, 2));
    const report = await runThirteenthStory(harness, 'item-r131-explain');
    expect(report.observation).toBe('candidates_observed');

    // Both present-signal lookups (content_hash + title_key) were captured.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const statement of captured) {
      // The deterministic order lives IN the shipped query, BEFORE LIMIT.
      const orderByAt = statement.sql.indexOf('ORDER BY value ASC');
      const limitAt = statement.sql.indexOf('LIMIT');
      expect(orderByAt).toBeGreaterThan(-1);
      expect(limitAt).toBeGreaterThan(orderByAt);

      // EXPLAIN QUERY PLAN of the REAL statement with the REAL binds:
      // a bounded PK range SEARCH — never a table scan, never a temp
      // b-tree sort before LIMIT. Local workerd plan, correct label only:
      // NO Cloudflare cost guarantee is claimed.
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .bind(...(statement.params ?? []))
        .all();
      const details = plan.results.map((row) => String(row['detail'])).join(' | ');
      expect(details).toMatch(/SEARCH /);
      expect(details).not.toMatch(/SCAN /);
      expect(details).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('the concurrency window under R1.15: the lookup-moment blindness still holds, and the group anchor resolves the race into ONE stable result with BOTH provenances (the loser\u2019s REAL run stays recorded)', async () => {
    let insideNestedRun = false;
    const harness = createHarness({
      // The provider-call window sits AFTER the caller's lookup and BEFORE
      // the caller's commit: when the FIRST item reaches its provider call,
      // the SECOND item runs its WHOLE real path (lookup → provider →
      // commit) inside that window. Both lookups precede both commits —
      // neither report can see the other (lookup-moment honesty), and the
      // R1.15 group anchor then resolves the race in SQL.
      onProviderCall: async (evidenceId) => {
        if (evidenceId !== 'item-r131-c1' || insideNestedRun) {
          return;
        }
        insideNestedRun = true;
        try {
          expect(
            await enqueueEditorialPrepareDraft({
              engine: harness.engine,
              executor: harness.rawExecutor,
              sourceItemId: 'item-r131-c2',
            }),
          ).toMatchObject({ kind: 'created' });
          await harness.engine.dispatchDueJobs();
          const envelope = harness.envelopes.shift();
          expect(envelope).toBeDefined();
          const action = await harness.engine.consumeMessage('msg-r131-c2', envelope);
          expect(action).toMatchObject({ action: 'ack' });
        } finally {
          insideNestedRun = false;
        }
      },
    });
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    const sharedTitle = 'عنوان مشترک دو خبر همزمان';
    const sharedBody = 'بدنهٔ یکسان برای هر دو خبرِ همزمان.';
    await seedItem(harness.rawExecutor, {
      id: 'item-r131-c1',
      sourceId: SOURCE_X,
      title: sharedTitle,
      body: sharedBody,
      url: null,
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-r131-c2',
      sourceId: SOURCE_X,
      title: sharedTitle,
      body: sharedBody,
      url: null,
    });

    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-r131-c1',
      }),
    ).toMatchObject({ kind: 'created' });
    await harness.engine.dispatchDueJobs();
    const action = await harness.engine.consumeMessage('msg-r131-c1', harness.envelopes.shift());
    // c1's commit hit the R1.15 group anchor (c2 owns the exact content):
    // the WHOLE batch rolled back and a bounded retry was scheduled.
    expect(action).toMatchObject({ action: 'ack', outcome: 'retry_scheduled' });

    // Generation 2 (after the backoff): c1's lookup now SEES c2's story,
    // the byte-verification passes, and c1 REUSES the result — zero new
    // provider calls.
    harness.clock.advance(2_001);
    await harness.engine.dispatchDueJobs();
    const retryEnvelope = harness.envelopes.shift();
    expect(retryEnvelope).toBeDefined();
    const retryAction = await harness.engine.consumeMessage('msg-r131-c1-retry', retryEnvelope);
    expect(retryAction).toMatchObject({ action: 'ack', outcome: 'job_completed' });

    // Exactly ONE stable result — the anchor made a second one impossible.
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    // BOTH items processed; BOTH provenances durably attached to THE story.
    const processedItems = await harness.rawExecutor.query<{ processing_status: string }>({
      sql: "SELECT processing_status FROM source_items WHERE id LIKE 'item-r131-c%' ORDER BY id ASC",
    });
    expect(processedItems.rows).toHaveLength(2);
    for (const row of processedItems.rows) {
      expect(row.processing_status).toBe('processed');
    }
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'evidence')).toBe(2);
    const attachedStories = await harness.rawExecutor.query<{ story_id: string }>({
      sql: `SELECT DISTINCT c.story_id FROM claims c
             JOIN evidence e ON e.claim_id = c.id
            WHERE e.source_item_id IN ('item-r131-c1', 'item-r131-c2')`,
    });
    expect(attachedStories.rows).toHaveLength(1);

    // Fingerprints: c2's story-scoped content_hash + title_key rows PLUS
    // the R1.15 group anchor (content_hash, no story suffix) = 3 rows —
    // no write ever replaced another owner, and the title_key digest has
    // exactly ONE owner (c1 never became a story).
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(3);
    const digestPlans = await buildStoryFingerprints({
      storyId: 'digest-probe',
      canonicalUrl: null,
      fullEvidenceText: sharedTitle,
      title: sharedTitle,
    });
    const digest = digestPlans.find((plan) => plan.kind === 'title_key')!.digest;
    const titleOwners = await harness.rawExecutor.query<{ story_id: string; value: string }>({
      sql: 'SELECT story_id, value FROM story_fingerprints WHERE kind = ? AND value >= ? AND value < ?',
      params: ['title_key', `sc1:${digest}:`, `sc1:${digest}:\u{10ffff}`],
    });
    expect(titleOwners.rows).toHaveLength(1);
    expect(titleOwners.rows[0]!.value.endsWith(`:${titleOwners.rows[0]!.story_id}`)).toBe(true);

    // The loser's REAL provider run is durably recorded (charged, honest)
    // but referenced by NO draft — never presented as used in any output.
    expect(harness.providerCalls).toBe(2);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(2);
    const orphanedRuns = await harness.rawExecutor.query<{ id: string }>({
      sql: 'SELECT id FROM ai_runs WHERE id NOT IN (SELECT ai_run_id FROM drafts WHERE ai_run_id IS NOT NULL)',
    });
    expect(orphanedRuns.rows).toHaveLength(1);

    // The ONE draft's report stays lookup-moment honest: its OWN lookup ran
    // before c1's commit, so it observed nothing and says so verbatim.
    const draftRow = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    const read = readCandidateDiscoveryReport(JSON.parse(draftRow!.document_json));
    expect(read.kind).toBe('candidate_discovery_v1');
    if (read.kind !== 'candidate_discovery_v1') {
      throw new Error('unreachable: report must be candidate_discovery_v1');
    }
    expect(read.report.candidates).toEqual([]);
    expect(read.report.observation).toBe('no_candidates_observed');
    expect(read.report.limitations).toContain('lookup_moment_visibility');

    // And NOTHING merged: one story, zero confidence everywhere.
    const claimRows = await harness.rawExecutor.query<{ confidence: number }>({
      sql: 'SELECT confidence FROM claims',
    });
    for (const row of claimRows.rows) {
      expect(row.confidence).toBe(0);
    }
  });
});

describe('R1.13 — report storage and reader boundaries', () => {
  it('a pre-5C draft (no discovery field) reads as absent — never backfilled', async () => {
    const read = readCandidateDiscoveryReport({ schemaVersion: 1, modelClaims: [] });
    expect(read.kind).toBe('absent');
    const legacy = readCandidateDiscoveryReport({
      schemaVersion: 1,
      evidenceGuard: { guardVersion: 1 },
    });
    expect(legacy.kind).toBe('absent');
  });
});

describe('R1.13 — fences, atomicity, and failure windows', () => {
  it('a stale generation (expired lease) writes NO draft and NO fingerprint; the index is untouched', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-fence-a',
      sourceId: SOURCE_X,
      title: 'خبر الف برای نرده',
    });
    // A first, SUCCESSFUL story owns the index already.
    await seedItem(harness.rawExecutor, {
      id: 'item-fence-b',
      sourceId: SOURCE_X,
      title: 'خبر ب برای نرده',
    });
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-fence-a',
      }),
    ).toMatchObject({ kind: 'created' });
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    const fingerprintsBefore = await rowCount(harness.rawExecutor, 'story_fingerprints');
    expect(fingerprintsBefore).toBeGreaterThan(0);

    // A SECOND job is claimed directly (no dispatch): its generation will
    // be stale by the time the commit runs (lease expired).
    const enqueueB = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: 'item-fence-b',
    });
    expect(enqueueB).toMatchObject({ kind: 'created' });
    const jobId = enqueueB.kind === 'created' ? enqueueB.jobId : '';
    const claimed = await claimJob(harness.rawExecutor, jobId, NOW, 2 * 60 * 1000);
    if (claimed.kind !== 'claimed') {
      throw new Error('expected claim');
    }
    const itemHash = await sha256Hex('item-fence-b\u001fخبر ب برای نرده\u001f');
    const storyId = await storyIdForSnapshot('item-fence-b', itemHash);
    const storyKey = await storyKeyForSnapshot('item-fence-b', itemHash);
    const fingerprints = await buildStoryFingerprints({
      storyId,
      canonicalUrl: 'https://example.com/item-fence-b',
      fullEvidenceText: 'خبر ب برای نرده',
      title: 'خبر ب برای نرده',
    });
    const staleResult = await commitEditorialResult(harness.rawExecutor, {
      jobId,
      generation: claimed.generation,
      fenceNowMs: NOW + 10 * 60 * 1000, // lease expired → fence fails
      entityMentions: [],
      snapshot: {
        sourceItemId: 'item-fence-b',
        sourceId: SOURCE_X,
        contentHash: itemHash,
      },
      story: { id: storyId, storyKey, workingHeadline: null, createdAt: NOW },
      claim: {
        id: 'edcl_fence',
        storyId,
        claimType: 'source_report',
        subject: 's',
        predicate: 'reported',
        objectText: 'o',
        confidence: 0,
        status: 'unverified',
        createdAt: NOW,
      },
      evidence: {
        id: 'edev_fence',
        claimId: 'edcl_fence',
        sourceItemId: 'item-fence-b',
        stance: 'mentions',
        confidence: 0,
        excerpt: 'e',
        createdAt: NOW,
      },
      aiRun: {
        id: 'edai_fence',
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
        createdAt: NOW,
        completedAt: NOW,
      },
      draft: {
        id: 'eddr_fence',
        storyId,
        status: 'ready',
        language: 'fa',
        layout: 'news_v1',
        title: 't',
        documentJson: '{}',
        factsJson: '[]',
        warningsJson: '[]',
        aiRunId: 'edai_fence',
        version: 1,
        createdBy: 'stale',
        createdAt: NOW,
      },
      fingerprints: fingerprints.map((plan) => ({ kind: plan.kind, value: plan.value })),
      // R1.15: the exact-content group anchor (store-level test uses a
      // fixed well-formed anchor; the REAL path derives it from the item's
      // own composed text). The stale fence no-ops it anyway.
      exactContentAnchor: {
        kind: 'content_hash' as const,
        value: 'sc1:' + 'b'.repeat(64),
      },
    });
    expect(staleResult.fenceLost).toBe(true);
    expect(staleResult.draftInserted).toBe(false);
    expect(staleResult.fingerprintsInserted).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(fingerprintsBefore);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
  });

  it('a mid-commit failure leaves NO orphan fingerprint and NO half report', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-atomic',
      sourceId: SOURCE_X,
      title: 'خبر شکست اتمی',
    });
    harness.failBatchesMatching((statements) =>
      statements.some((statement) => statement.sql.includes('INSERT INTO story_fingerprints')),
    );
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-atomic',
      }),
    ).toMatchObject({ kind: 'created' });
    const outcomes = await runPipeline(harness);
    // The batch failed mid-commit → the engine classifies it as transient.
    expect(outcomes).not.toContain('ack:job_completed');
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
    // The item is NOT processed — nothing fake happened.
    const item = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-atomic'],
    });
    expect(item!.processing_status).toBe('new');
  });

  it('a candidate-lookup DB error maps to a bounded retry BEFORE the AI: zero provider calls', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-lookup-err',
      sourceId: SOURCE_X,
      title: 'خبر خطای جست‌وجو',
    });
    harness.failLookupsMatching((sql) => sql.includes('story_fingerprints'));
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-lookup-err',
      }),
    ).toMatchObject({ kind: 'created' });
    const outcomes = await runPipeline(harness);
    // The engine acknowledged the message and scheduled the bounded retry.
    expect(outcomes).toEqual(['ack:retry_scheduled']);
    expect(harness.providerCalls).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(0);
  });

  it('a snapshot mutation before the batch writes NO draft and NO fingerprint', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-race',
      sourceId: SOURCE_X,
      title: 'خبر مسابقهٔ اسنپ‌شات',
    });
    harness.mutateBeforeEditorialCommit(async (raw) => {
      await raw.run({
        sql: "UPDATE source_items SET content_hash = ? WHERE id = 'item-race'",
        params: [await sha256Hex('a-brand-new-snapshot')],
      });
    });
    expect(
      await enqueueEditorialPrepareDraft({
        engine: harness.engine,
        executor: harness.rawExecutor,
        sourceItemId: 'item-race',
      }),
    ).toMatchObject({ kind: 'created' });
    const outcomes = await runPipeline(harness);
    expect(outcomes).toEqual(['ack:job_dead_lettered']);
    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
  });

  it('replay after a successful commit is free: no new report, no new fingerprints, no provider call', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-replay',
      sourceId: SOURCE_X,
      title: 'خبر تکرار‌پذیر',
    });
    const enqueue = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: 'item-replay',
    });
    expect(enqueue.kind).toBe('created');
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    const before = {
      fingerprints: await rowCount(harness.rawExecutor, 'story_fingerprints'),
      drafts: await rowCount(harness.rawExecutor, 'drafts'),
      stories: await rowCount(harness.rawExecutor, 'stories'),
    };
    const draftBefore = await readLatestDraft(harness.rawExecutor);

    // Handler-level replay (same jobId, same generation): free success.
    const job = await findJobById(
      harness.rawExecutor,
      enqueue.kind === 'created' ? enqueue.jobId : '',
    );
    const replayHandler = createEditorialPrepareDraftHandler({
      executor: harness.executor,
      aiService: createAiDraftService({
        executor: harness.executor,
        ports: {},
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
    } satisfies EditorialPrepareDraftHandlerOptions);
    const outcome = await replayHandler.execute({
      jobId: job!.id,
      generation: 1,
      payload: {
        sourceItemId: 'item-replay',
        snapshotHash: await sha256Hex('item-replay\u001fخبر تکرار‌پذیر\u001f'),
      },
    });
    expect(outcome).toEqual({ kind: 'success' });
    expect(harness.providerCalls).toBe(1); // exactly the ORIGINAL call

    expect(await rowCount(harness.rawExecutor, 'story_fingerprints')).toBe(before.fingerprints);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(before.drafts);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(before.stories);
    const draftAfter = await readLatestDraft(harness.rawExecutor);
    expect(draftAfter.document_json).toBe(draftBefore.document_json);
  });

  it('the pure builder stays honest for a report the store never saw (defensive round-trip)', () => {
    const report = buildCandidateDiscoveryReport({
      snapshot: { sourceItemId: 'i', contentHash: 'h' },
      storyId: 's',
      lookups: [{ kind: 'content_hash', overflow: false }],
      matches: [{ kind: 'content_hash', storyId: 'other' }],
    });
    expect(readCandidateDiscoveryReport({ candidateDiscovery: report })).toMatchObject({
      kind: 'candidate_discovery_v1',
    });
  });
});
