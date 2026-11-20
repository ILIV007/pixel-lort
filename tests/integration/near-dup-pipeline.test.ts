import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import type { DeadlineTimeoutScheduler } from '../../src/shared/time/deadline-wait';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createJobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { enqueueEditorialPrepareDraft } from '../../src/application/editorial/enqueue-prepare-draft';
import { createEditorialPrepareDraftHandler } from '../../src/application/editorial/prepare-draft-handler';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import { normalizeEntityMentionText } from '../../src/domain/editorial/entity-mentions';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';

/**
 * Slice 6 — the near-dup pipeline over REAL workerd D1, with the ONLY
 * artificial pieces being the provider PORT (zero network, zero live
 * inference) and the fake clock:
 *
 *   - a non-identical duplicate (reworded title, same entities) MERGES
 *     as an update of the canonical story: ZERO AI calls, NO new draft,
 *     NO second post — the story ledger carries the adjudication;
 *   - a genuinely different story proceeds to AI and drafts normally;
 *   - the middle similarity band is HELD for adjudication: permanent
 *     `editorial_near_dup_review`, ZERO AI calls, NO post;
 *   - the negative cache: an AI-refused item is recorded once, and a
 *     re-ingested item with the SAME content fingerprint is NEVER
 *     re-fed to AI (permanent `editorial_negative_cache_skip`).
 */

const NOW = 1_760_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_ID = 'src-nd-06';

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

async function freshDb(executor: DbExecutor): Promise<void> {
  await applyMigrations(env.DB);
  for (const table of [
    'channel_post_deletes',
    'quality_rejections',
    'story_merges',
    'channel_pins',
    'draft_revisions',
    'drafts',
    'ai_runs',
    'evidence',
    'claims',
    'story_fingerprints',
    'story_entities',
    'stories',
    'entity_aliases',
    'entities',
    'source_items',
    'sources',
    'jobs',
    'budgets',
    'settings',
    'audit_events',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
}

async function seedSource(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'منبع رسمی آزمون ۶', 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
}

async function seedItem(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly contentHash?: string;
  },
): Promise<string> {
  const contentHash =
    input.contentHash ?? (await sha256Hex(`${input.id}\u001f${input.title}\u001f${input.body}`));
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, ?, ?, 'نویسندهٔ آزمون', ?, ?, ?, '{}', 'new')`,
    params: [
      input.id,
      SOURCE_ID,
      `nd06-ext-${input.id}`,
      `https://example.com/nd06/${input.id}`,
      input.title,
      input.body,
      NOW,
      NOW,
      contentHash,
    ],
  });
  return contentHash;
}

async function seedEntity(
  executor: DbExecutor,
  input: { id: string; name: string; alias: string },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO entities (id, type, canonical_name, slug, metadata_json, created_at, updated_at)
          VALUES (?, 'game', ?, ?, '{}', ?, ?)`,
    params: [input.id, input.name, input.id, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language)
          VALUES (?, ?, ?, NULL)`,
    params: [input.id, input.alias, normalizeEntityMentionText(input.alias)],
  });
}

async function seedCanonicalStory(
  executor: DbExecutor,
  input: { id: string; headline: string; entityIds: readonly string[] },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority, confidence,
            working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
          VALUES (?, ?, 'published', 'official', 'official_news', 90, 80, ?, ?, ?, 1, ?, ?)`,
    params: [input.id, `nd-key-${input.id}`, input.headline, NOW - DAY_MS, NOW - DAY_MS, NOW, NOW],
  });
  for (const entityId of input.entityIds) {
    await executor.run({
      sql: `INSERT INTO story_entities (story_id, entity_id, relation, confidence)
            VALUES (?, ?, 'about', 90)`,
      params: [input.id, entityId],
    });
  }
}

interface ChainHarness {
  readonly executor: DbExecutor;
  readonly clock: MutableClock;
  readonly portCalls: { readonly modelId: string }[];
  readonly drain: () => Promise<readonly string[]>;
  readonly enqueue: (sourceItemId: string) => Promise<void>;
  readonly jobRow: () => Promise<{
    readonly status: string;
    readonly last_error: string | null;
  } | null>;
  readonly draftCount: () => Promise<number>;
  readonly itemStatus: (sourceItemId: string) => Promise<string | null>;
  readonly storyStatus: (storyId: string) => Promise<string | null>;
  readonly merges: () => Promise<
    readonly {
      readonly disposition: string;
      readonly method: string;
      readonly canonical_story_id: string;
    }[]
  >;
  readonly rejections: () => Promise<
    readonly { readonly fingerprint: string; readonly reason: string }[]
  >;
}

interface ChainOptions {
  readonly script: (
    callIndex: number,
    input: Parameters<AiProviderPort['complete']>[0],
  ) => AiCallOutcome | Promise<AiCallOutcome>;
}

async function createChain(options: ChainOptions): Promise<ChainHarness> {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  await freshDb(executor);
  await seedSource(executor);

  const portCalls: { modelId: string }[] = [];
  const port: AiProviderPort = {
    provider: 'workers-ai',
    complete: async (input) => {
      portCalls.push({ modelId: input.modelId });
      return options.script(portCalls.length - 1, input);
    },
  };

  const live = new Set<() => void>();
  const schedule: DeadlineTimeoutScheduler = (callback) => {
    live.add(callback);
    return () => {
      live.delete(callback);
    };
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
    deadlineScheduler: schedule,
  });

  const envelopes: unknown[] = [];
  let jobSeq = 0;
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createEditorialPrepareDraftHandler({
          executor,
          aiService,
          nowMs: () => clock.now(),
          logger,
          nearDup: { enabled: true },
          negativeCache: { enabled: true },
        }),
      ] as never),
      idGenerator: { newId: () => `nd06-job-${(jobSeq += 1)}` },
      clock,
      random: () => 1,
      logger,
      jobsProducer: {
        send: async (envelope: unknown) => {
          envelopes.push(envelope);
        },
      } as never,
      dlqProducer: { send: async () => undefined } as never,
      policyGates: { ingestionGateOn: true, editorialGateOn: true },
    },
    {
      leaseMs: 120_000,
      dispatchBatch: 25,
      dlqReconcileBatch: 25,
      reclaimBatch: 25,
      dispatchGraceMs: 60_000,
      backoff: { baseMs: 1, capMs: 3_600_000 },
      retryHintMaxSeconds: 3_600,
    },
  );

  const enqueue = async (sourceItemId: string): Promise<void> => {
    const enqueued = await enqueueEditorialPrepareDraft({ engine, executor, sourceItemId });
    if (enqueued.kind !== 'created' && enqueued.kind !== 'existing') {
      throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    }
  };

  const drain = async (): Promise<readonly string[]> => {
    const outcomes: string[] = [];
    for (let guard = 0; guard < 5; guard += 1) {
      await engine.dispatchDueJobs();
      if (envelopes.length === 0) break;
      const envelope = envelopes.shift() as never;
      const action = (await engine.consumeMessage(`nd06-msg-${guard}`, envelope)) as {
        action: string;
        outcome?: string;
      };
      outcomes.push(`${action.action}:${action.outcome ?? ''}`);
      if (action.action !== 'ack') break;
    }
    return outcomes;
  };

  return {
    executor,
    clock,
    portCalls,
    drain,
    enqueue,
    jobRow: async () =>
      executor.first<{ status: string; last_error: string | null }>({
        sql: 'SELECT status, last_error FROM jobs ORDER BY created_at LIMIT 1',
      }),
    draftCount: async () => {
      const row = await executor.first<{ n: number }>({
        sql: 'SELECT COUNT(*) AS n FROM drafts',
      });
      return row?.n ?? 0;
    },
    itemStatus: async (sourceItemId: string) => {
      const row = await executor.first<{ processing_status: string }>({
        sql: 'SELECT processing_status FROM source_items WHERE id = ?',
        params: [sourceItemId],
      });
      return row?.processing_status ?? null;
    },
    storyStatus: async (storyId: string) => {
      const row = await executor.first<{ status: string }>({
        sql: 'SELECT status FROM stories WHERE id = ?',
        params: [storyId],
      });
      return row?.status ?? null;
    },
    merges: async () =>
      executor
        .query<{ disposition: string; method: string; canonical_story_id: string }>({
          sql: 'SELECT disposition, method, canonical_story_id FROM story_merges ORDER BY created_at_ms',
        })
        .then((result) => result.rows),
    rejections: async () =>
      executor
        .query<{ fingerprint: string; reason: string }>({
          sql: 'SELECT fingerprint, reason FROM quality_rejections ORDER BY created_at_ms',
        })
        .then((result) => result.rows),
  };
}

/** The traceable provider draft JSON (the SAME discipline as Phase 5A/6.4). */
const EVIDENCE_HEADER_RE = /شواهد غیرقابل‌اعتماد — شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>>/;

function tracedDraftJson(userContent: string | undefined, claimText: string): string {
  const evidenceId =
    (userContent !== undefined ? EVIDENCE_HEADER_RE.exec(userContent)?.[1] : null) ??
    'missing-evidence-id';
  return JSON.stringify({
    headlineFa: 'تیتر زنجیرهٔ ۶',
    summaryFa: 'خلاصهٔ زنجیرهٔ ۶ بر اساس شواهد ارائه‌شده.',
    claims: [{ text: claimText, evidenceIds: [evidenceId] }],
  });
}

function okOutcome(
  input: Parameters<AiProviderPort['complete']>[0] | undefined,
  claimText: string,
): AiCallOutcome {
  const userContent = input?.messages.at(-1)?.content;
  return {
    kind: 'ok',
    rawText: tracedDraftJson(userContent, claimText),
    usage: { inputTokens: 300, outputTokens: 90 },
  };
}

beforeEach(async () => {
  // Each test builds its own chain (which wipes the shared file storage).
});

describe('slice 6 — the near-dup pipeline over REAL D1', () => {
  it('a non-identical duplicate merges as an update: ZERO AI calls, NO draft, NO second post', async () => {
    const chain = await createChain({
      script: async (_callIndex, input) => okOutcome(input, 'تریلر GTA VI فردا منتشر می‌شود.'),
    });
    await seedEntity(chain.executor, {
      id: 'ent-gta-vi',
      name: 'GTA VI',
      alias: 'GTA VI',
    });
    await seedCanonicalStory(chain.executor, {
      id: 'story-gta-vi',
      headline: 'GTA VI trailer drops tomorrow',
      entityIds: ['ent-gta-vi'],
    });
    await seedItem(chain.executor, {
      id: 'nd-item-merge',
      title: 'GTA VI trailer drops tomorrow morning',
      body: 'Rockstar says the GTA VI trailer drops tomorrow morning.',
    });
    await chain.enqueue('nd-item-merge');
    const outcomes = await chain.drain();
    expect(outcomes[0]?.startsWith('ack')).toBe(true);
    expect(outcomes[0]).not.toContain('dead_lettered');

    // ZERO provider calls — the merge decided before any AI work.
    expect(chain.portCalls).toHaveLength(0);
    expect(await chain.draftCount()).toBe(0);

    // The ledger carries the adjudication; the canonical story is updated;
    // the item is a duplicate, never a second post.
    expect(await chain.merges()).toEqual([
      {
        disposition: 'merged_as_update',
        method: 'deterministic',
        canonical_story_id: 'story-gta-vi',
      },
    ]);
    expect(await chain.storyStatus('story-gta-vi')).toBe('updated');
    expect(await chain.itemStatus('nd-item-merge')).toBe('duplicate');
  });

  it('a genuinely different story proceeds to AI and drafts normally', async () => {
    const chain = await createChain({
      script: async (_callIndex, input) =>
        okOutcome(input, 'تاریخ انتشار Hollow Knight Silksong مشخص شد.'),
    });
    await seedEntity(chain.executor, {
      id: 'ent-gta-vi',
      name: 'GTA VI',
      alias: 'GTA VI',
    });
    await seedCanonicalStory(chain.executor, {
      id: 'story-gta-vi',
      headline: 'GTA VI trailer drops tomorrow',
      entityIds: ['ent-gta-vi'],
    });
    await seedItem(chain.executor, {
      id: 'nd-item-distinct',
      title: 'Hollow Knight Silksong release date revealed',
      body: 'Team Cherry announced the Hollow Knight Silksong release date today.',
    });
    await chain.enqueue('nd-item-distinct');
    const outcomes = await chain.drain();
    expect(outcomes[0]?.startsWith('ack')).toBe(true);
    expect(chain.portCalls).toHaveLength(1);
    expect(await chain.draftCount()).toBe(1);
    expect(await chain.merges()).toEqual([]);
    expect(await chain.itemStatus('nd-item-distinct')).not.toBe('duplicate');
  });

  it('the middle band is HELD: permanent review, ZERO AI calls, NO post', async () => {
    const chain = await createChain({
      script: async (_callIndex, input) => okOutcome(input, 'بستهٔ الحاقی Elden Ring معرفی شد.'),
    });
    await seedCanonicalStory(chain.executor, {
      id: 'story-elden-ring',
      headline: 'Elden Ring DLC announced for next month',
      entityIds: [],
    });
    await seedItem(chain.executor, {
      id: 'nd-item-review',
      title: 'Elden Ring DLC announced for next month, new trailer',
      body: 'The Elden Ring DLC was announced for next month with a new trailer.',
    });
    await chain.enqueue('nd-item-review');
    const outcomes = await chain.drain();
    expect(outcomes).toEqual(['ack:job_dead_lettered']);
    expect(chain.portCalls).toHaveLength(0);
    expect(await chain.draftCount()).toBe(0);
    expect(await chain.jobRow()).toMatchObject({
      status: 'dead_letter',
      last_error: 'editorial_near_dup_review',
    });
    expect(await chain.merges()).toEqual([
      {
        disposition: 'needs_review',
        method: 'deterministic',
        canonical_story_id: 'story-elden-ring',
      },
    ]);
    // Held for adjudication — queued, never posted.
    expect(await chain.itemStatus('nd-item-review')).toBe('queued');
  });

  it('the negative cache: an AI refusal is recorded once and never re-fed to AI', async () => {
    const chain = await createChain({
      script: () => ({ kind: 'refused' }),
    });
    const fingerprint = await seedItem(chain.executor, {
      id: 'nd-item-refused',
      title: 'A story the provider refuses to draft',
      body: 'The provider refuses this content on safety grounds.',
    });
    await chain.enqueue('nd-item-refused');
    expect(await chain.drain()).toEqual(['ack:job_dead_lettered']);
    expect(chain.portCalls).toHaveLength(1);
    expect(await chain.jobRow()).toMatchObject({
      status: 'dead_letter',
      last_error: 'editorial_ai_refused',
    });
    expect(await chain.rejections()).toEqual([{ fingerprint, reason: 'editorial_ai_refused' }]);

    // A re-ingested item with the SAME content fingerprint is skipped
    // before any provider work — the AI call count stays exactly 1.
    await seedItem(chain.executor, {
      id: 'nd-item-refused-again',
      title: 'A story the provider refuses to draft',
      body: 'The provider refuses this content on safety grounds.',
      contentHash: fingerprint,
    });
    await chain.enqueue('nd-item-refused-again');
    expect(await chain.drain()).toEqual(['ack:job_dead_lettered']);
    expect(chain.portCalls).toHaveLength(1);
    expect(await chain.draftCount()).toBe(0);
    // The second job dead-lettered on the cache, not on a fresh refusal.
    // (aggregate_id is the source item id — created_at ties under the
    // fixed test clock, so ordering by it would pick either job.)
    const secondJob = await chain.executor.first<{
      readonly status: string;
      readonly last_error: string | null;
    }>({
      sql: 'SELECT status, last_error FROM jobs WHERE aggregate_id = ?',
      params: ['nd-item-refused-again'],
    });
    expect(secondJob).toMatchObject({
      status: 'dead_letter',
      last_error: 'editorial_negative_cache_skip',
    });
  });
});
