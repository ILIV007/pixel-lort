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
  type EditorialCommitInput,
} from '../../src/adapters/db/editorial-store';
import {
  normalizeEntityMentionText,
  readEntityMentionsReport,
  ENTITY_MENTION_MAX_PHRASES,
} from '../../src/domain/editorial/entity-mentions';

/**
 * R1.16 (Phase 5D) acceptance suite — REAL workerd D1, REAL pipeline. The
 * ONLY artificial piece is the provider port (zero network). Every
 * controlled-alias mention behavior under test is the shipped code:
 * durable `story_entities` links with relation `mentioned` and confidence 0
 * from the SAME fenced atomic batch as the draft, word-boundary phrase
 * matching under policy `em1` (no substring matches, no case folding, no
 * digit equivalence, ZWNJ word-internal), deterministic ambiguity (shared
 * alias → ZERO auto links, row order never matters), honest caps and
 * overflow, the lookup→commit alias-mutation window enforced IN SQL, and
 * write-free replays. A mention is NOT verification, NOT a merge, and
 * NEVER a trust/confidence raise.
 */

const NOW = 1_760_000_000_000;
const SOURCE_X = 'src-mentions-x';
const SOURCE_Y = 'src-mentions-y';

/** Module-global job id counter — multiple harnesses may live inside ONE
 * test (the durable jobs table outlives each harness). */
let harnessJobIdCounter = 0;

/** Executor wrapper: runs a mutation hook right AFTER the alias IN-lookup
 * (the lookup→commit window) and can fail selected batches on demand. */
function wrapExecutor(
  inner: DbExecutor,
  hooks: {
    readonly afterAliasLookup?: () => Promise<void>;
    readonly onBatch?: (statements: readonly { sql: string }[]) => void | Promise<void>;
  },
): DbExecutor {
  return {
    query: async <T>(statement: Parameters<DbExecutor['query']>[0]) => {
      const result = await inner.query<T>(statement);
      if (
        statement.sql.includes('FROM entity_aliases') &&
        statement.sql.includes(' IN (') &&
        hooks.afterAliasLookup !== undefined
      ) {
        await hooks.afterAliasLookup();
      }
      return result;
    },
    first: inner.first.bind(inner),
    run: inner.run.bind(inner),
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
  readonly runAfterAliasLookup: (fn: (() => Promise<void>) | null) => void;
  readonly failBatchesMatching: (
    match: (statements: readonly { sql: string }[]) => boolean,
  ) => void;
}

function createHarness(): Harness {
  const clock = fixedClock(NOW);
  const logger = createLogger({ level: 'error', clock });
  const rawExecutor = createDbExecutor(env.DB, { clock });

  let providerCalls = 0;
  let failBatches: (statements: readonly { sql: string }[]) => boolean = () => false;
  const afterAliasHook: { fn: (() => Promise<void>) | null } = { fn: null };

  const executor = wrapExecutor(rawExecutor, {
    afterAliasLookup: async () => {
      await afterAliasHook.fn?.();
      // Fire ONCE per generation — later statements in the same run must
      // not re-trigger the mutation.
      afterAliasHook.fn = null;
    },
    onBatch: async (statements) => {
      if (failBatches(statements)) {
        throw new Error('injected_mid_commit_failure');
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
          nowMs: () => clock.now(),
          logger,
        }),
      ] as never),
      idGenerator: { newId: () => `mentions-id-${(harnessJobIdCounter += 1)}` },
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
    runAfterAliasLookup: (fn) => {
      afterAliasHook.fn = fn;
    },
    failBatchesMatching: (match) => {
      failBatches = match;
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

/** Fixture helper: seed a CONTROLLED catalog entity (tests/demo only —
 * news text can never add entities or aliases; no cloud seeding here). */
async function seedEntity(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly type?: string;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    params: [input.id, input.type ?? 'game', input.name, input.slug, NOW, NOW],
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

interface StoryEntityRow {
  readonly story_id: string;
  readonly entity_id: string;
  readonly relation: string;
  readonly confidence: number;
}

async function storyEntityRows(
  executor: DbExecutor,
  storyId?: string,
): Promise<readonly StoryEntityRow[]> {
  const { rows } = await executor.query<StoryEntityRow>({
    sql: `SELECT story_id, entity_id, relation, confidence FROM story_entities
           ${storyId !== undefined ? 'WHERE story_id = ?' : ''}
          ORDER BY story_id ASC, entity_id ASC`,
    params: storyId !== undefined ? [storyId] : [],
  });
  return rows;
}

async function storyIdForItem(executor: DbExecutor, itemId: string): Promise<string> {
  const row = await executor.first<{ story_id: string }>({
    sql: `SELECT c.story_id FROM claims c JOIN evidence e ON e.claim_id = c.id
           WHERE e.source_item_id = ?`,
    params: [itemId],
  });
  return row!.story_id;
}

async function draftReport(executor: DbExecutor, storyId: string) {
  const draft = await executor.first<{ document_json: string }>({
    sql: 'SELECT document_json FROM drafts WHERE story_id = ? AND version = 1',
    params: [storyId],
  });
  return readEntityMentionsReport(JSON.parse(draft!.document_json) as unknown);
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of [
    'story_entities',
    'entity_aliases',
    'entities',
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

describe('R1.16 — controlled aliases link stories to their registered entities (REAL pipeline)', () => {
  it('Persian and English aliases of ONE entity durably link TWO independent stories (no merge, confidence 0)', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedSource(harness.rawExecutor, SOURCE_Y, 'منبع ایگرگ');
    await seedEntity(harness.rawExecutor, {
      id: 'ent-doom',
      slug: 'doom',
      name: 'Doom',
    });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'Doom', language: 'en' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'دوم', language: 'fa' });
    await seedItem(harness.rawExecutor, {
      id: 'item-en',
      sourceId: SOURCE_X,
      title: 'Doom announced today',
      body: 'A big announcement.',
    });
    await seedItem(harness.rawExecutor, {
      id: 'item-fa',
      sourceId: SOURCE_Y,
      title: 'دوم امروز معرفی شد',
      body: 'یک خبر بزرگ.',
    });

    expect(await enqueueAndRun(harness, 'item-en')).toEqual(['ack:job_completed']);
    expect(await enqueueAndRun(harness, 'item-fa')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(2);

    const storyEn = await storyIdForItem(harness.rawExecutor, 'item-en');
    const storyFa = await storyIdForItem(harness.rawExecutor, 'item-fa');
    expect(storyEn).not.toBe(storyFa);

    // The DURABLE links: two independent stories, one entity, relation
    // `mentioned`, confidence 0 — visible in the table, not just JSON.
    // (Story ids are content-derived hashes — compare as a set.)
    const links = await storyEntityRows(harness.rawExecutor);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((row) => row.story_id))).toEqual(new Set([storyEn, storyFa]));
    expect(
      links.every(
        (row) =>
          row.entity_id === 'ent-doom' && row.relation === 'mentioned' && row.confidence === 0,
      ),
    ).toBe(true);

    // The versioned reports name the alias each text actually matched.
    const reportEn = await draftReport(harness.rawExecutor, storyEn);
    const reportFa = await draftReport(harness.rawExecutor, storyFa);
    expect(reportEn.kind).toBe('entity_mentions_v1');
    expect(reportFa.kind).toBe('entity_mentions_v1');
    if (reportEn.kind === 'entity_mentions_v1') {
      expect(reportEn.report.observation).toBe('mentions_observed');
      expect(reportEn.report.matched).toEqual([{ normalizedAlias: 'Doom', entityId: 'ent-doom' }]);
    }
    if (reportFa.kind === 'entity_mentions_v1') {
      expect(reportFa.report.matched).toEqual([{ normalizedAlias: 'دوم', entityId: 'ent-doom' }]);
    }

    // NO merge and NO trust/confidence raise: two stories, both honest zeros.
    const stories = await harness.rawExecutor.query<{
      confidence: number;
      trust_status: string;
      status: string;
    }>({ sql: 'SELECT confidence, trust_status, status FROM stories' });
    expect(stories.rows.length).toBe(2);
    expect(
      stories.rows.every((row) => row.confidence === 0 && row.trust_status === 'unknown'),
    ).toBe(true);
  });

  it('boundary policy: Doomlike/Doom2 never match Doom; "Doom 2" text matches BOTH the franchise and the game', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-franchise', slug: 'doom', name: 'Doom' });
    await seedEntity(harness.rawExecutor, { id: 'ent-game2', slug: 'doom-2', name: 'Doom 2' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-franchise', alias: 'Doom' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-game2', alias: 'Doom 2' });

    // Glued forms are SINGLE tokens — the standalone alias is never a
    // candidate phrase and 'Doom2' ≠ 'Doom 2' byte-exactly: ZERO links.
    await seedItem(harness.rawExecutor, {
      id: 'item-glued',
      sourceId: SOURCE_X,
      title: 'Doomlike and Doom2 unveiled',
    });
    expect(await enqueueAndRun(harness, 'item-glued')).toEqual(['ack:job_completed']);
    expect(await storyEntityRows(harness.rawExecutor)).toEqual([]);
    const gluedStory = await storyIdForItem(harness.rawExecutor, 'item-glued');
    const gluedReport = await draftReport(harness.rawExecutor, gluedStory);
    expect(gluedReport.kind).toBe('entity_mentions_v1');
    if (gluedReport.kind === 'entity_mentions_v1') {
      expect(gluedReport.report.observation).toBe('no_match_observed');
    }

    // A SEPARATE-token number differs: 'Doom 2' text matches the game alias
    // AND the boundary-valid franchise alias 'Doom' — per the documented
    // policy (different numbers are different aliases, never equated).
    await seedItem(harness.rawExecutor, {
      id: 'item-numbered',
      sourceId: SOURCE_X,
      title: 'Doom 2 revealed',
    });
    expect(await enqueueAndRun(harness, 'item-numbered')).toEqual(['ack:job_completed']);
    const numberedStory = await storyIdForItem(harness.rawExecutor, 'item-numbered');
    const numberedLinks = await storyEntityRows(harness.rawExecutor, numberedStory);
    expect(numberedLinks.map((row) => row.entity_id).sort()).toEqual([
      'ent-franchise',
      'ent-game2',
    ]);
    expect(numberedLinks.every((row) => row.relation === 'mentioned' && row.confidence === 0)).toBe(
      true,
    );
  });

  it('ZWNJ (نیم‌فاصله) is word-INTERNAL: the spaced form never matches the ZWNJ alias', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-studio', slug: 'studio', name: 'استودیو' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-studio', alias: 'بازی‌سازی' });

    await seedItem(harness.rawExecutor, {
      id: 'item-zwnj',
      sourceId: SOURCE_X,
      title: 'استودیوی بازی‌سازی تهرانی گسترش یافت',
    });
    expect(await enqueueAndRun(harness, 'item-zwnj')).toEqual(['ack:job_completed']);
    const zwnjStory = await storyIdForItem(harness.rawExecutor, 'item-zwnj');
    expect((await storyEntityRows(harness.rawExecutor, zwnjStory)).length).toBe(1);

    await seedItem(harness.rawExecutor, {
      id: 'item-spaced',
      sourceId: SOURCE_X,
      title: 'استودیوی بازی سازی دیگر گسترش یافت',
    });
    expect(await enqueueAndRun(harness, 'item-spaced')).toEqual(['ack:job_completed']);
    const spacedStory = await storyIdForItem(harness.rawExecutor, 'item-spaced');
    expect(await storyEntityRows(harness.rawExecutor, spacedStory)).toEqual([]);
  });

  it('multi-word alias with internal separator matches byte-exactly ("Half-Life")', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-hl', slug: 'half-life', name: 'Half-Life' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-hl', alias: 'Half-Life' });
    await seedItem(harness.rawExecutor, {
      id: 'item-hl',
      sourceId: SOURCE_X,
      title: 'Half-Life 3 rumors denied',
    });
    expect(await enqueueAndRun(harness, 'item-hl')).toEqual(['ack:job_completed']);
    const story = await storyIdForItem(harness.rawExecutor, 'item-hl');
    expect(await storyEntityRows(harness.rawExecutor, story)).toEqual([
      { story_id: story, entity_id: 'ent-hl', relation: 'mentioned', confidence: 0 },
    ]);
  });

  it('a shared alias with TWO owners is ambiguous — ZERO auto links, deterministic in real SQL rows', async () => {
    for (const order of ['a-first', 'b-first'] as const) {
      const harness = createHarness();
      // Iteration-local deltas: the D1 tables persist across the loop (the
      // per-test beforeEach clears them only ONCE).
      const draftsBefore = await rowCount(harness.rawExecutor, 'drafts');
      const sourceId = `src-mentions-ambig-${order}`;
      await seedSource(harness.rawExecutor, sourceId, 'منبع ایکس');
      const first = order === 'a-first' ? 'ent-alpha-a' : 'ent-alpha-b';
      const second = order === 'a-first' ? 'ent-beta-a' : 'ent-beta-b';
      // The CATALOG also persists across iterations — a per-iteration
      // shared alias keeps the ambiguity probe exactly two-owner.
      const sharedAlias = order === 'a-first' ? 'Zwerbat' : 'Qwerbat';
      await seedEntity(harness.rawExecutor, { id: first, slug: `alpha-${order}`, name: 'Alpha' });
      await seedEntity(harness.rawExecutor, { id: second, slug: `beta-${order}`, name: 'Beta' });
      await seedAlias(harness.rawExecutor, { entityId: first, alias: sharedAlias });
      await seedAlias(harness.rawExecutor, { entityId: second, alias: sharedAlias });
      await seedItem(harness.rawExecutor, {
        id: `item-ambiguous-${order}`,
        sourceId,
        // Unique composed text per iteration: iteration 1's story is still
        // indexed in the shared D1 — an identical text would take the
        // (correct, by-contract) R1.15 verified-reuse path with zero
        // provider calls, which is not what THIS probe is about.
        title: `${sharedAlias} update shipped in ${order}`,
      });
      expect(await enqueueAndRun(harness, `item-ambiguous-${order}`)).toEqual([
        'ack:job_completed',
      ]);
      expect(await storyEntityRows(harness.rawExecutor)).toEqual([]);
      const story = await storyIdForItem(harness.rawExecutor, `item-ambiguous-${order}`);
      const report = await draftReport(harness.rawExecutor, story);
      expect(report.kind).toBe('entity_mentions_v1');
      if (report.kind === 'entity_mentions_v1') {
        expect(report.report.observation).toBe('ambiguous_only_observed');
        expect(report.report.ambiguous).toEqual([{ normalizedAlias: sharedAlias, ownerCount: 2 }]);
      }
      // The draft STILL landed (the mention layer never blocks the honest
      // path) — and the provider was really called.
      expect(harness.providerCalls).toBe(1);
      expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(draftsBefore + 1);
    }
  });

  it('multiple mentions of the same entity in one item → exactly ONE story_entities row', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-doom', slug: 'doom', name: 'Doom' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'Doom' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'دوم' });
    await seedItem(harness.rawExecutor, {
      id: 'item-double',
      sourceId: SOURCE_X,
      title: 'Doom and دوم together',
    });
    expect(await enqueueAndRun(harness, 'item-double')).toEqual(['ack:job_completed']);
    const story = await storyIdForItem(harness.rawExecutor, 'item-double');
    const links = await storyEntityRows(harness.rawExecutor, story);
    expect(links).toEqual([
      { story_id: story, entity_id: 'ent-doom', relation: 'mentioned', confidence: 0 },
    ]);
  });

  it('empty catalog → honest no_match_observed with zero links; the draft still lands', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedItem(harness.rawExecutor, {
      id: 'item-nocat',
      sourceId: SOURCE_X,
      title: 'Some unrelated title here',
    });
    expect(await enqueueAndRun(harness, 'item-nocat')).toEqual(['ack:job_completed']);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await storyEntityRows(harness.rawExecutor)).toEqual([]);
    const story = await storyIdForItem(harness.rawExecutor, 'item-nocat');
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    if (report.kind === 'entity_mentions_v1') {
      expect(report.report.observation).toBe('no_match_observed');
      expect(report.report.matched).toEqual([]);
      expect(report.report.ambiguous).toEqual([]);
    }
  });

  it('phrase-cap window is honest: coverage truncated, links INSIDE the window still land', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    // 95 single-token aliases p0..p94 — more distinct phrases than the cap.
    for (let i = 0; i < 95; i += 1) {
      await seedEntity(harness.rawExecutor, {
        id: `ent-p${i}`,
        slug: `p${i}`,
        name: `Entity p${i}`,
      });
      await seedAlias(harness.rawExecutor, { entityId: `ent-p${i}`, alias: `p${i}` });
    }
    const body = Array.from({ length: 94 }, (_, i) => `p${i + 1}`).join(' ');
    await seedItem(harness.rawExecutor, {
      id: 'item-cap',
      sourceId: SOURCE_X,
      title: 'p0',
      body,
    });
    expect(await enqueueAndRun(harness, 'item-cap')).toEqual(['ack:job_completed']);
    const story = await storyIdForItem(harness.rawExecutor, 'item-cap');
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    if (report.kind === 'entity_mentions_v1') {
      expect(report.report.scan.phrasesConsidered).toBe(ENTITY_MENTION_MAX_PHRASES);
      expect(report.report.scan.phrasesTruncated).toBe(true);
      expect(report.report.observation).toBe('mentions_observed');
      // Width-major coverage: exactly the first 90 single-token aliases
      // (p0..p89) were scanned and linked; p90..p94 were honestly NOT
      // observed — no fake full-coverage claim.
      expect(report.report.matched.length).toBe(90);
    }
    const links = await storyEntityRows(harness.rawExecutor, story);
    expect(links.length).toBe(90);
    expect(links.every((row) => row.relation === 'mentioned' && row.confidence === 0)).toBe(true);
  });

  it('result overflow (≥91 rows) → ZERO links and the honest lookup_overflow observation', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    // 24 tokens → exactly 90 distinct phrases (no phrase truncation), but
    // each alias maps to FOUR owners → 96 result rows ≥ the 91-row probe →
    // the whole resolution honestly aborts with zero links.
    for (let i = 0; i < 24; i += 1) {
      for (let owner = 0; owner < 4; owner += 1) {
        const entityId = `ent-t${i}o${owner}`;
        await seedEntity(harness.rawExecutor, {
          id: entityId,
          slug: `t${i}o${owner}`,
          name: `Owner ${i}-${owner}`,
        });
        await seedAlias(harness.rawExecutor, { entityId, alias: `t${i}` });
      }
    }
    const body = Array.from({ length: 23 }, (_, i) => `t${i + 1}`).join(' ');
    await seedItem(harness.rawExecutor, {
      id: 'item-overflow',
      sourceId: SOURCE_X,
      title: 't0',
      body,
    });
    expect(await enqueueAndRun(harness, 'item-overflow')).toEqual(['ack:job_completed']);
    expect(await storyEntityRows(harness.rawExecutor)).toEqual([]);
    const story = await storyIdForItem(harness.rawExecutor, 'item-overflow');
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    if (report.kind === 'entity_mentions_v1') {
      expect(report.report.observation).toBe('lookup_overflow');
      expect(report.report.scan.resultOverflow).toBe(true);
      expect(report.report.matched).toEqual([]);
      expect(report.report.ambiguous).toEqual([]);
    }
  });

  it('alias DELETED between lookup and commit → the whole result is withheld, the re-resolve lands honestly with no link', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-doom', slug: 'doom', name: 'Doom' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'Doom' });
    await seedItem(harness.rawExecutor, {
      id: 'item-del',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    harness.runAfterAliasLookup(async () => {
      await harness.rawExecutor.run({
        sql: "DELETE FROM entity_aliases WHERE normalized_alias = 'Doom'",
      });
    });
    expect(await enqueueAndRun(harness, 'item-del')).toEqual(['ack:job_completed']);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await storyEntityRows(harness.rawExecutor)).toEqual([]);
    // R1.16.1 (C1): the first batch was withheld by the catalog gate and
    // the bounded re-resolve saw the DELETED alias — the landed report is
    // the honest no_match_observed, never the stale lookup-moment claim.
    const story = await storyIdForItem(harness.rawExecutor, 'item-del');
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    if (report.kind === 'entity_mentions_v1') {
      expect(report.report.observation).toBe('no_match_observed');
      expect(report.report.matched).toEqual([]);
      expect(report.report.counts.entitiesLinked).toBe(0);
    }
    expect(harness.providerCalls).toBe(1);
  });

  // R1.16.1 (C1) expectation correction — the OLD text asserted the weak
  // no-op-only-link contract ("NO link to either entity" while the lookup-
  // moment report claimed a resolved owner). Under the whole-result catalog
  // gate the invalidated first batch is withheld (typed catalogChanged) and
  // the ONE bounded re-resolve re-reads the CURRENT catalog: the alias NOW
  // (at commit time) maps uniquely to ent-new, so the durable link and the
  // report BOTH say ent-new — the report and the links can never diverge.
  it('alias REMAPPED to another entity between lookup and commit → the commit-time mapping is what both the report and the link say', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-old', slug: 'old', name: 'Old' });
    await seedEntity(harness.rawExecutor, { id: 'ent-new', slug: 'new', name: 'New' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-old', alias: 'Doom' });
    await seedItem(harness.rawExecutor, {
      id: 'item-remap',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    harness.runAfterAliasLookup(async () => {
      await harness.rawExecutor.run({
        sql: "UPDATE entity_aliases SET entity_id = 'ent-new' WHERE normalized_alias = 'Doom'",
      });
    });
    expect(await enqueueAndRun(harness, 'item-remap')).toEqual(['ack:job_completed']);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    const story = await storyIdForItem(harness.rawExecutor, 'item-remap');
    const links = await storyEntityRows(harness.rawExecutor, story);
    expect(links).toEqual([
      { story_id: story, entity_id: 'ent-new', relation: 'mentioned', confidence: 0 },
    ]);
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    if (report.kind === 'entity_mentions_v1') {
      expect(report.report.matched).toEqual([{ normalizedAlias: 'Doom', entityId: 'ent-new' }]);
      expect(report.report.counts.entitiesLinked).toBe(links.length);
    }
    // The bounded re-resolve never re-runs the provider.
    expect(harness.providerCalls).toBe(1);
  });

  it('a SECOND alias owner added between lookup and commit → unambiguity broken IN SQL → the re-resolve reports the honest ambiguity, zero links', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-one', slug: 'one', name: 'One' });
    await seedEntity(harness.rawExecutor, { id: 'ent-two', slug: 'two', name: 'Two' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-one', alias: 'Doom' });
    await seedItem(harness.rawExecutor, {
      id: 'item-second',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    harness.runAfterAliasLookup(async () => {
      await harness.rawExecutor.run({
        sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
              VALUES ('ent-two', 'Doom', 'Doom', 'en')`,
      });
    });
    expect(await enqueueAndRun(harness, 'item-second')).toEqual(['ack:job_completed']);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(1);
    expect(await storyEntityRows(harness.rawExecutor)).toEqual([]);
    // R1.16.1 (C1): the landed report says the alias is AMBIGUOUS (the
    // commit-time reality) — entitiesLinked 0 == the zero durable links.
    const story = await storyIdForItem(harness.rawExecutor, 'item-second');
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    if (report.kind === 'entity_mentions_v1') {
      expect(report.report.observation).toBe('ambiguous_only_observed');
      expect(report.report.ambiguous).toEqual([{ normalizedAlias: 'Doom', ownerCount: 2 }]);
      expect(report.report.counts.entitiesLinked).toBe(0);
    }
    expect(harness.providerCalls).toBe(1);
  });

  // R1.16.1 (C1): the persisted report can NEVER claim a durable link that
  // the catalog invalidated inside the lookup→commit window. The WHOLE
  // editorial result is SQL-conditioned on the validity of EVERY relied
  // mapping: an invalidated mapping means ZERO effects (typed
  // catalogChanged), ONE bounded in-handler re-resolve against the CURRENT
  // catalog (fresh SQL lookup — never a JS reuse of the stale rows, never a
  // new provider call/charge), and the landed draft's report EQUALS the
  // durable story_entities rows for its story.
  it('R1.16.1 C1: a second alias owner inside the window can never persist entitiesLinked without the durable link', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'Source');
    await seedEntity(harness.rawExecutor, { id: 'ent-a', slug: 'a', name: 'A' });
    await seedEntity(harness.rawExecutor, { id: 'ent-b', slug: 'b', name: 'B' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-a', alias: 'Doom' });
    await seedItem(harness.rawExecutor, {
      id: 'item-c1',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    harness.runAfterAliasLookup(async () => {
      await seedAlias(harness.rawExecutor, { entityId: 'ent-b', alias: 'Doom' });
    });
    expect(await enqueueAndRun(harness, 'item-c1')).toEqual(['ack:job_completed']);
    const story = await storyIdForItem(harness.rawExecutor, 'item-c1');
    const report = await draftReport(harness.rawExecutor, story);
    expect(report.kind).toBe('entity_mentions_v1');
    const links = await storyEntityRows(harness.rawExecutor, story);
    if (report.kind === 'entity_mentions_v1') {
      // The report counts EXACTLY the durable links of THIS story.
      expect(report.report.counts.entitiesLinked).toBe(links.length);
      // The invalidated lookup-moment resolution became the honest
      // ambiguity observation — ZERO links claimed, ZERO links written.
      expect(report.report.observation).toBe('ambiguous_only_observed');
      expect(report.report.matched).toEqual([]);
      expect(report.report.ambiguous).toEqual([{ normalizedAlias: 'Doom', ownerCount: 2 }]);
    }
    expect(links).toEqual([]);
    // The bounded in-handler re-resolve NEVER re-runs the provider.
    expect(harness.providerCalls).toBe(1);
  });

  it('real handler replay after success → write-free, charge-free, entity links untouched', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-doom', slug: 'doom', name: 'Doom' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'Doom' });
    await seedItem(harness.rawExecutor, {
      id: 'item-replay',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    expect(await enqueueAndRun(harness, 'item-replay')).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1);
    const before = {
      stories: await rowCount(harness.rawExecutor, 'stories'),
      drafts: await rowCount(harness.rawExecutor, 'drafts'),
      links: await rowCount(harness.rawExecutor, 'story_entities'),
      claims: await rowCount(harness.rawExecutor, 'claims'),
      aiRuns: await rowCount(harness.rawExecutor, 'ai_runs'),
    };
    expect(before.links).toBe(1);

    // The at-least-once window: the terminal bookkeeping was lost; the
    // engine re-claims and the handler RE-EXECUTES in a NEW generation.
    await harness.rawExecutor.run({
      sql: "UPDATE jobs SET status = 'pending', run_after = ?, lease_until = NULL\n             WHERE aggregate_id = 'item-replay' AND status = 'succeeded'",
      params: [NOW],
    });
    harness.clock.advance(1);
    expect(await runPipeline(harness)).toEqual(['ack:job_completed']);
    expect(harness.providerCalls).toBe(1);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(before.stories);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(before.drafts);
    expect(await rowCount(harness.rawExecutor, 'story_entities')).toBe(before.links);
    expect(await rowCount(harness.rawExecutor, 'claims')).toBe(before.claims);
    expect(await rowCount(harness.rawExecutor, 'ai_runs')).toBe(before.aiRuns);
  });
});

describe('R1.16 — store-level fence/snapshot/failure contracts with mentions present', () => {
  function commitInput(overrides: {
    readonly jobId: string;
    readonly generation: number;
    readonly contentHash: string;
    readonly mentions: readonly { normalizedAlias: string; entityId: string }[];
  }): EditorialCommitInput {
    const now = NOW;
    return {
      jobId: overrides.jobId,
      generation: overrides.generation,
      fenceNowMs: now,
      snapshot: {
        sourceItemId: 'item-store',
        sourceId: SOURCE_X,
        contentHash: overrides.contentHash,
      },
      story: {
        id: 'story-store',
        storyKey: 'seeded-store-key',
        workingHeadline: null,
        createdAt: now,
      },
      claim: {
        id: 'edcl-store',
        storyId: 'story-store',
        claimType: 'source_report',
        subject: 'منبع',
        predicate: 'reported',
        objectText: 'متن',
        confidence: 0,
        status: 'unverified',
        createdAt: now,
      },
      evidence: {
        id: 'edev-store',
        claimId: 'edcl-store',
        sourceItemId: 'item-store',
        stance: 'mentions',
        confidence: 0,
        excerpt: 'متن',
        createdAt: now,
      },
      aiRun: {
        id: 'edai-store',
        task: 'news_draft',
        provider: 'workers-ai',
        model: 'test-model',
        promptVersion: 'test',
        inputHash: 'hash',
        status: 'succeeded',
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        completedAt: now,
      },
      draft: {
        id: 'eddr-store',
        storyId: 'story-store',
        status: 'ready',
        language: 'fa',
        layout: 'news_v1',
        title: 'تیتر',
        documentJson: '{}',
        factsJson: '[]',
        warningsJson: '[]',
        aiRunId: 'edai-store',
        version: 1,
        createdBy: 'editorial.prepare_draft',
        createdAt: now,
      },
      fingerprints: [],
      exactContentAnchor: { kind: 'content_hash', value: 'sc1:deadbeef' },
      entityMentions: overrides.mentions,
    };
  }

  it('stale generation (fence lost) → zero effects, zero orphan story_entities rows', async () => {
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    await seedSource(executor, SOURCE_X, 'منبع');
    const hash = await sha256Hex('store-snapshot');
    await seedItem(executor, { id: 'item-store', sourceId: SOURCE_X, title: 'Doom revealed' });
    const result = await commitEditorialResult(
      executor,
      commitInput({
        jobId: 'no-such-job',
        generation: 7,
        contentHash: hash,
        mentions: [{ normalizedAlias: 'Doom', entityId: 'ent-doom' }],
      }),
    );
    expect(result.fenceLost).toBe(true);
    expect(result.entityMentionsInserted).toBe(0);
    expect(await rowCount(executor, 'story_entities')).toBe(0);
    expect(await rowCount(executor, 'drafts')).toBe(0);
  });

  it('snapshot changed between read and commit → zero effects (no fake processed, no links)', async () => {
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    await seedSource(executor, SOURCE_X, 'منبع');
    const realHash = await seedItem(executor, {
      id: 'item-store',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    // A REAL claimed job makes the fence HOLD — the classification must
    // then attribute the zero-effect batch to the SNAPSHOT predicate.
    await executor.run({
      sql: `INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority,
              run_after, attempts, lease_until, idempotency_key, payload_json, created_at, updated_at)
            VALUES ('job-store-snap', 'editorial.prepare_draft', 'source_item', 'item-store',
                    'claimed', 50, ?, 1, ?, 'ik-store-snap', '{}', ?, ?)`,
      params: [NOW, NOW + 10 * 60 * 1000, NOW, NOW],
    });
    const result = await commitEditorialResult(
      executor,
      commitInput({
        jobId: 'job-store-snap',
        generation: 1,
        contentHash: `${realHash}-different`,
        mentions: [{ normalizedAlias: 'Doom', entityId: 'ent-doom' }],
      }),
    );
    expect(result.snapshotChanged).toBe(true);
    expect(result.entityMentionsInserted).toBe(0);
    expect(await rowCount(executor, 'story_entities')).toBe(0);
    const item = await executor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-store'],
    });
    expect(item!.processing_status).toBe('new');
  });

  it('mid-batch failure → the WHOLE batch rolls back: zero orphans, zero links, no fake processed', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_X, 'منبع ایکس');
    await seedEntity(harness.rawExecutor, { id: 'ent-doom', slug: 'doom', name: 'Doom' });
    await seedAlias(harness.rawExecutor, { entityId: 'ent-doom', alias: 'Doom' });
    await seedItem(harness.rawExecutor, {
      id: 'item-midfail',
      sourceId: SOURCE_X,
      title: 'Doom revealed',
    });
    harness.failBatchesMatching((statements) =>
      statements.some((statement) => statement.sql.includes('INSERT INTO story_entities')),
    );
    // The engine classifies the mid-commit storage failure as transient
    // and schedules a bounded retry (the atomic batch left ZERO state).
    await expect(enqueueAndRun(harness, 'item-midfail')).resolves.toEqual(['ack:retry_scheduled']);
    expect(await rowCount(harness.rawExecutor, 'story_entities')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'drafts')).toBe(0);
    expect(await rowCount(harness.rawExecutor, 'stories')).toBe(0);
    const item = await harness.rawExecutor.first<{ processing_status: string }>({
      sql: 'SELECT processing_status FROM source_items WHERE id = ?',
      params: ['item-midfail'],
    });
    expect(item!.processing_status).toBe('new');
  });
});

describe('R1.16 — SQL plan and reader round-trip on real artifacts (LOCAL PROXY only)', () => {
  it('EXPLAIN QUERY PLAN: the alias lookup searches idx_entity_alias_lookup (bounded, no table scan)', async () => {
    await applyMigrations(env.DB);
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const { rows } = await executor.query<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN SELECT entity_id, normalized_alias FROM entity_aliases
             WHERE normalized_alias IN (?, ?) ORDER BY normalized_alias ASC, entity_id ASC LIMIT 91`,
      params: ['Doom', 'دوم'],
    });
    const plan = rows.map((row) => row.detail).join('\n');
    expect(plan).toContain('idx_entity_alias_lookup');
    expect(plan).not.toContain('SCAN entity_aliases');
    // LOCAL PROXY metric only — never a Cloudflare cost proxy.
  });

  // R1.16.1 (C1): the whole-result catalog gate (json_each over the bound
  // pairs parameter) evaluates each claimed pair through the SAME index —
  // bounded work per claimed pair (≤ pairs ≤ phrases ≤ 90), no full-table
  // scan, and +2 bound parameters per statement against the D1 per-query
  // limit of 100 (≤23 own params on the heaviest statement). LOCAL PROXY
  // metric only — never a Cloudflare cost proxy.
  it('EXPLAIN QUERY PLAN: the catalog gate seeks idx_entity_alias_lookup per claimed pair (no table scan)', async () => {
    await applyMigrations(env.DB);
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const { rows } = await executor.query<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM json_each(?) claimed
             WHERE EXISTS (SELECT 1 FROM entity_aliases ea
                            WHERE ea.normalized_alias = json_extract(claimed.value, '$[0]')
                              AND ea.entity_id = json_extract(claimed.value, '$[1]'))
               AND 1 = (SELECT COUNT(DISTINCT ea2.entity_id) FROM entity_aliases ea2
                         WHERE ea2.normalized_alias = json_extract(claimed.value, '$[0]'))`,
      params: [
        JSON.stringify([
          ['Doom', 'ent-a'],
          ['دوم', 'ent-a'],
        ]),
      ],
    });
    const plan = rows.map((row) => row.detail).join('\n');
    expect(plan).toContain('idx_entity_alias_lookup');
    expect(plan).not.toContain('SCAN entity_aliases');
  });

  it('a historical draft WITHOUT the entityMentions field reads as absent (never reinterpreted)', async () => {
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const read = readEntityMentionsReport(JSON.parse('{"schemaVersion":1}') as unknown);
    expect(read.kind).toBe('absent');
    void executor;
  });
});
