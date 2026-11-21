import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import type { DeadlineTimeoutScheduler } from '../../src/shared/time/deadline-wait';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createJobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { enqueueFreshSourceItems } from '../../src/application/editorial/enqueue-fresh-items';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import { createEditorialPrepareDraftHandler } from '../../src/application/editorial/prepare-draft-handler';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import {
  findPublicationById,
  listPublicationMessages,
} from '../../src/adapters/db/publication-outbox-store';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { effectiveRegistry } from '../../src/domain/source/dead-sources';
import { withAdditionalSources } from '../../src/domain/source/additional-sources';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { readExplicitPublishMode } from '../../src/adapters/db/publishing-settings-store';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';

/**
 * Slice 9 — the wired autonomous chain over REAL workerd D1, with the
 * ONLY artificial pieces being the provider PORT and the Telegram
 * TRANSPORT (zero network, zero live inference):
 *
 *   REAL source snapshots -> drain (Link 2) -> REAL durable jobs ->
 *   REAL prepare-draft handler (fact-guard riding the commit) -> bridge
 *   (Link 4: ag1 gate -> fenced auto_approved -> idempotent enqueue
 *   with the Soul stamp) -> REAL scheduler scan (Link 5) -> REAL
 *   rendered send through the FAKE transport -> REAL at-most-once
 *   ledger -> published.
 *
 * The slice-9 honesty boundary pinned here:
 *  - paused mode blocks EVERYTHING downstream: the bridge skips with
 *    zero writes and the scan is decision-only (zero sends); a missing
 *    mode row is paused, never the panel default `auto`;
 *  - a requires_review draft never reaches the outbox (it stays `ready`
 *    for the human path) and a refused draft likewise;
 *  - a publication without a resolvable Soul version is never created
 *    (the bridge skips the whole pass);
 *  - the enqueue carries `soul_version = 1` on every autonomous row.
 */

const NOW = 1_760_000_000_000;
/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW_MORNING = 1_700_029_800_000;
const SOURCE_ID = 'src-e2e-09';
const ITEM_A_ID = 'e2e09-item-a';
const ITEM_B_ID = 'e2e09-item-b';
const ITEM_A_TITLE = 'استودیوی نمونه از عرضهٔ نسخهٔ تازه خبر داد';
const ITEM_A_BODY =
  'استودیوی نمونه امروز اعلام کرد که نسخهٔ تازهٔ بازی نمونه با بخش داستانی گسترده و بهبود عملکرد منتشر شده است.';
const ITEM_B_TITLE = 'استودیوی دوم از عرضهٔ بستهٔ تازه خبر داد';
const ITEM_B_BODY =
  'استودیوی دوم امروز اعلام کرد که بستهٔ تازهٔ بازی دوم با مرحله‌های تازه و بهبود عملکرد منتشر شده است.';
const DESTINATION = '@pixel_channel_e2e09';

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

async function freshDb(executor: DbExecutor): Promise<void> {
  await applyMigrations(env.DB);
  for (const table of [
    'publication_messages',
    'publications',
    'audit_events',
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
    'souls',
    'telegram_updates',
    'admins',
    'draft_revisions',
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
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
}

async function seedSnapshot(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'منبع رسمی آزمون ۰۹', 'rss', 'official', 96, 1, 300, 50, 300, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
  for (const [itemId, title, body, publishedAt] of [
    [ITEM_A_ID, ITEM_A_TITLE, ITEM_A_BODY, NOW - 2000],
    [ITEM_B_ID, ITEM_B_TITLE, ITEM_B_BODY, NOW - 1000],
  ] as const) {
    const contentHash = await sha256Hex(`${itemId}\u001f${title}\u001f${body}`);
    await executor.run({
      sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
              author, published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES (?, ?, ?, ?, ?, ?, 'نویسندهٔ آزمون', ?, ?, ?, '{}', 'new')`,
      params: [
        itemId,
        SOURCE_ID,
        `${itemId}-ext`,
        `https://example.com/${itemId}`,
        title,
        body,
        publishedAt,
        NOW,
        contentHash,
      ],
    });
  }
}

async function seedSoulPointer(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES ('soul.current_version', '{"version": 1}', 1, NULL, ?)`,
    params: [NOW],
  });
}

interface ChainHarness {
  readonly executor: DbExecutor;
  readonly clock: MutableClock;
  readonly engine: ReturnType<typeof createJobsEngine>;
  readonly drainJobs: () => Promise<readonly string[]>;
  readonly listDrafts: () => Promise<readonly { readonly id: string; readonly status: string }[]>;
}

async function createChain(claimByCallIndex: (callIndex: number) => string): Promise<ChainHarness> {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  await freshDb(executor);
  await seedSnapshot(executor);

  const portCalls: { modelId: string }[] = [];
  const port: AiProviderPort = {
    provider: 'workers-ai',
    complete: async (input) => {
      const callIndex = portCalls.length;
      portCalls.push({ modelId: input.modelId });
      const userContent = input.messages.at(-1)?.content;
      const evidenceId =
        /شواهد غیرقابل‌اعتماد — شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>>/.exec(
          userContent ?? '',
        )?.[1] ?? 'missing-evidence-id';
      const outcome: AiCallOutcome = {
        kind: 'ok',
        rawText: JSON.stringify({
          headlineFa: 'تیتر زنجیرهٔ سرتاسری ۰۹',
          summaryFa: 'خلاصهٔ زنجیرهٔ سرتاسری ۰۹ بر اساس شواهد ارائه‌شده.',
          claims: [{ text: claimByCallIndex(callIndex), evidenceIds: [evidenceId] }],
        }),
        usage: { inputTokens: 300, outputTokens: 90 },
      };
      return outcome;
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
          factGuard: { enabled: true },
        }),
      ] as never),
      idGenerator: { newId: () => `e2e09-job-${(jobSeq += 1)}` },
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

  let msgSeq = 0;
  const drainJobs = async (): Promise<readonly string[]> => {
    const outcomes: string[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      await engine.dispatchDueJobs();
      if (envelopes.length === 0) break;
      const envelope = envelopes.shift() as never;
      const action = (await engine.consumeMessage(`e2e09-msg-${(msgSeq += 1)}`, envelope)) as {
        action: string;
        outcome?: string;
      };
      outcomes.push(`${action.action}:${action.outcome ?? ''}`);
      if (action.action !== 'ack') break;
    }
    return outcomes;
  };

  const listDrafts = async () => {
    const rows = await executor.query<{ id: string; status: string }>({
      sql: `SELECT id, status FROM drafts ORDER BY created_at ASC`,
    });
    return rows.rows;
  };

  return { executor, clock, engine, drainJobs, listDrafts };
}

/** The GROUNDED claims: every word comes from the matching stored item body. */
const GROUNDED_CLAIM_A = 'نسخهٔ تازهٔ بازی نمونه منتشر شده است.';
const GROUNDED_CLAIM_B = 'بستهٔ تازهٔ بازی دوم منتشر شده است.';
/** The UNGROUNDED number: ۱۲۰ appears NOWHERE in either stored item body. */
const UNGROUNDED_CLAIM = 'بازی نمونه ۱۲۰ هزار بازیکن دارد.';

function makeTransport(
  messageIdStart: number,
): PublicationChannelTransport & { readonly calls: { readonly text: string }[] } {
  const calls: { readonly text: string }[] = [];
  let next = messageIdStart;
  return {
    calls,
    async sendMessageRich(input) {
      calls.push({ text: input.content.text });
      return { messageId: next++ };
    },
  };
}

beforeEach(async () => {
  const prep = createDbExecutor(env.DB);
  await freshDb(prep);
});

describe('slice 9 — the wired autonomous chain', () => {
  it('drain: fresh items -> prepare_draft jobs (bounded, oldest-first, claimed once)', async () => {
    const chain = await createChain(() => GROUNDED_CLAIM_A);
    const first = await enqueueFreshSourceItems({
      executor: chain.executor,
      engine: chain.engine,
      logger,
    });
    expect(first).toEqual({
      scanned: 2,
      enqueued: 2,
      alreadyQueued: 0,
      rejected: 0,
      conflicts: 0,
    });
    const statuses = await chain.executor.query<{ processing_status: string }>({
      sql: `SELECT processing_status FROM source_items ORDER BY published_at ASC`,
    });
    expect(statuses.rows).toEqual([
      { processing_status: 'queued' },
      { processing_status: 'queued' },
    ]);
    // The second pass observes nothing fresh — no duplicate jobs.
    const second = await enqueueFreshSourceItems({
      executor: chain.executor,
      engine: chain.engine,
      logger,
    });
    expect(second.scanned).toBe(0);
    expect(second.enqueued).toBe(0);
  });

  it('full chain: drain -> drafts -> bridge (Soul-stamped) -> scheduler scan -> published', async () => {
    const chain = await createChain((callIndex) =>
      callIndex === 0 ? GROUNDED_CLAIM_A : GROUNDED_CLAIM_B,
    );
    await seedSoulPointer(chain.executor);

    const drained = await enqueueFreshSourceItems({
      executor: chain.executor,
      engine: chain.engine,
      logger,
    });
    expect(drained.enqueued).toBe(2);
    const outcomes = await chain.drainJobs();
    expect(outcomes.filter((entry) => entry.startsWith('ack'))).toHaveLength(2);

    const drafts = await chain.listDrafts();
    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.status === 'ready')).toBe(true);

    const bridged = await bridgeReadyDrafts({
      executor: chain.executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW_MORNING,
      logger,
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 2,
      approved: 2,
      enqueued: 2,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      rejected: 0,
    });
    expect((await chain.listDrafts()).every((draft) => draft.status === 'auto_approved')).toBe(
      true,
    );
    const publications = await chain.executor.query<{
      id: string;
      status: string;
      priority: number;
      approval_mode: string;
      soul_version: number | null;
    }>({
      sql: `SELECT id, status, priority, approval_mode, soul_version FROM publications ORDER BY created_at ASC`,
    });
    expect(publications.rows).toHaveLength(2);
    for (const row of publications.rows) {
      expect(row.status).toBe('pending');
      expect(row.priority).toBe(80);
      expect(row.approval_mode).toBe('auto');
      expect(row.soul_version).toBe(1);
    }

    // THE REAL SCHEDULER (the only artificial piece: the transport).
    const transport = makeTransport(9001);
    const scanClock = fixedClock(NOW_MORNING);
    const scheduler = createPublicationScheduler({
      executor: chain.executor,
      destination: DESTINATION,
      transport,
      sendGate: { enabled: true },
      contextProvider: createStoriesPolicyContextProvider(chain.executor),
      clock: scanClock,
      logger,
      scanLimit: 10,
    });
    // P1 latency (5–20 min) defers the first scan; nothing sends yet.
    const first = await scheduler.scanDuePublications();
    expect(first.details.map((detail) => detail.outcome)).toEqual([
      'deferred_time',
      'deferred_time',
    ]);
    expect(transport.calls).toHaveLength(0);
    // Advance past the latency + the 8-minute P1 gap, scanning until both
    // are published (bounded rounds — the second send waits for the gap).
    for (let round = 0; round < 6; round += 1) {
      scanClock.advance(10 * 60_000);
      await scheduler.scanDuePublications();
      const published = await chain.executor.query<{ n: number }>({
        sql: `SELECT COUNT(*) AS n FROM publications WHERE status = 'published'`,
      });
      if (published.rows[0]?.n === 2) break;
    }
    const published = await chain.executor.query<{ id: string; status: string }>({
      sql: `SELECT id, status FROM publications ORDER BY created_at ASC`,
    });
    expect(published.rows).toEqual([
      { id: publications.rows[0]!.id, status: 'published' },
      { id: publications.rows[1]!.id, status: 'published' },
    ]);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.text).toContain('تیتر زنجیرهٔ سرتاسری ۰۹');
    for (const row of publications.rows) {
      const found = await findPublicationById(chain.executor, row.id);
      expect(found?.status).toBe('published');
      const messages = await listPublicationMessages(chain.executor, row.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.ordinal).toBe(0);
    }
  });

  it('bridge paused: zero writes, drafts stay ready; scan gate-off is decision-only', async () => {
    const chain = await createChain(() => GROUNDED_CLAIM_A);
    await seedSoulPointer(chain.executor);
    // No mode row at all: the strict read is NULL (never the panel `auto`).
    expect(await readExplicitPublishMode(chain.executor)).toBeNull();

    await enqueueFreshSourceItems({
      executor: chain.executor,
      engine: chain.engine,
      logger,
    });
    await chain.drainJobs();
    expect((await chain.listDrafts()).map((draft) => draft.status)).toEqual(['ready', 'ready']);

    const bridged = await bridgeReadyDrafts({
      executor: chain.executor,
      destination: DESTINATION,
      mode: 'paused',
      nowMs: NOW_MORNING,
      logger,
    });
    expect(bridged).toEqual({ kind: 'skipped', reason: 'mode_blocks_auto' });
    expect((await chain.listDrafts()).map((draft) => draft.status)).toEqual(['ready', 'ready']);
    const publications = await chain.executor.query<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM publications`,
    });
    expect(publications.rows[0]?.n).toBe(0);

    const transport = makeTransport(9100);
    const scheduler = createPublicationScheduler({
      executor: chain.executor,
      destination: DESTINATION,
      transport,
      sendGate: { enabled: false },
      contextProvider: createStoriesPolicyContextProvider(chain.executor),
      clock: fixedClock(NOW_MORNING),
      logger,
      scanLimit: 10,
    });
    const report = await scheduler.scanDuePublications();
    expect(report.decisionOnly).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });

  it('bridge requires_review: an ungrounded draft never reaches the outbox', async () => {
    const chain = await createChain(() => UNGROUNDED_CLAIM);
    await seedSoulPointer(chain.executor);
    await enqueueFreshSourceItems({
      executor: chain.executor,
      engine: chain.engine,
      logger,
    });
    await chain.drainJobs();
    const drafts = await chain.listDrafts();
    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.status === 'ready')).toBe(true);

    const bridged = await bridgeReadyDrafts({
      executor: chain.executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW_MORNING,
      logger,
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 2,
      approved: 0,
      enqueued: 0,
      duplicates: 0,
      requiresReview: 2,
      refused: 0,
      rejected: 0,
    });
    expect((await chain.listDrafts()).every((draft) => draft.status === 'ready')).toBe(true);
    const publications = await chain.executor.query<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM publications`,
    });
    expect(publications.rows[0]?.n).toBe(0);
  });

  it('bridge soul unknown: no Soul version resolvable -> the whole pass skips', async () => {
    const chain = await createChain(() => GROUNDED_CLAIM_A);
    // Deliberately NO soul pointer and NO souls rows.
    await enqueueFreshSourceItems({
      executor: chain.executor,
      engine: chain.engine,
      logger,
    });
    await chain.drainJobs();
    expect((await chain.listDrafts()).map((draft) => draft.status)).toEqual(['ready', 'ready']);

    const bridged = await bridgeReadyDrafts({
      executor: chain.executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW_MORNING,
      logger,
    });
    expect(bridged).toEqual({ kind: 'skipped', reason: 'soul_version_unknown' });
    expect((await chain.listDrafts()).every((draft) => draft.status === 'ready')).toBe(true);
    const publications = await chain.executor.query<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM publications`,
    });
    expect(publications.rows[0]?.n).toBe(0);
  });

  it('registry seeding: the effective registry seeds VGC / Gematsu / GameSpot disabled', async () => {
    const executor = createDbExecutor(env.DB);
    await freshDb(executor);
    const embedded = parseEmbeddedRegistry();
    expect(embedded.ok).toBe(true);
    if (!embedded.ok) return;
    const merged = withAdditionalSources(effectiveRegistry(embedded.registry));
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    await seedSourcesFromRegistry(executor, merged.registry, NOW);
    const rows = await executor.query<{ id: string; enabled: number; connector: string }>({
      sql: `SELECT id, enabled, connector FROM sources
             WHERE id IN ('vgc_news', 'gematsu_news', 'gamespot_news') ORDER BY id`,
    });
    expect(rows.rows).toEqual([
      { id: 'gamespot_news', enabled: 0, connector: 'rss' },
      { id: 'gematsu_news', enabled: 0, connector: 'rss' },
      { id: 'vgc_news', enabled: 0, connector: 'rss' },
    ]);
  });
});
