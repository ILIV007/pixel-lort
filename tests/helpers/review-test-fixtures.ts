import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import type { TelegramIngressDeps } from '../../src/application/telegram-ingress';
import { createEditorialReviewService } from '../../src/application/editorial/draft-review-view';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
import type {
  TelegramBotApiClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * R1.18 read-only review test infrastructure — REAL workerd D1 + fake Bot
 * API (zero network), shared by the coherent admin-review suites.
 */

export const NOW = 1_760_000_000_000;
export const OWNER_ID = 1000000001;
export const APPLICATION_VERSION = '1.12.3';

export interface CountingExecutor extends DbExecutor {
  readonly stats: () => {
    readonly total: number;
    readonly draftsSql: number;
    readonly writes: number;
    readonly sqlTexts: readonly string[];
  };
}

/** Counting executor wrapper: the LOCAL PROXY metric for the review suites. */
export function createCountingExecutor(inner: DbExecutor): CountingExecutor {
  let total = 0;
  let draftsSql = 0;
  let writes = 0;
  const sqlTexts: string[] = [];
  const record = (statement: DbStatement, isWrite: boolean): void => {
    total += 1;
    sqlTexts.push(statement.sql);
    if (/\bdrafts\b/i.test(statement.sql)) {
      draftsSql += 1;
    }
    if (isWrite) {
      writes += 1;
    }
  };
  return {
    // NON-async passthroughs (the workerd test pool reports a rejection
    // that crosses an async `return innerPromise` boundary as unhandled
    // even when the caller awaits it — plain delegation avoids that).
    query: (statement) => {
      record(statement, false);
      return inner.query(statement);
    },
    first: (statement) => {
      record(statement, false);
      return inner.first(statement);
    },
    run: (statement) => {
      record(statement, true);
      return inner.run(statement);
    },
    batch: (statements) => {
      for (const statement of statements) {
        record(statement, true);
      }
      return inner.batch(statements);
    },
    stats: () => ({ total, draftsSql, writes, sqlTexts }),
  };
}

/** Counting fake Bot API client — records every sendMessage call. */
export function createFakeBotApi(): {
  client: TelegramBotApiClient;
  sends: { chatId: number; text: string }[];
} {
  const sends: { chatId: number; text: string }[] = [];
  const client: TelegramBotApiClient = {
    async getMe() {
      return { id: 42, username: 'pixel_admin_bot' };
    },
    async sendMessage(input) {
      sends.push({ chatId: input.chatId, text: input.text });
      const message: TelegramSentMessage = { messageId: sends.length };
      return message;
    },
    async editMessageText() {
      return true;
    },
    async answerCallbackQuery() {},
  };
  return { client, sends };
}

export function captureLogger() {
  const lines: string[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(line);
  };
  return { lines, logger: createLogger({ level: 'error', sink }) };
}

export interface ReviewHarnessOptions {
  /** Override the ADMIN_REVIEW_ENABLED parsing result (default: enabled). */
  readonly reviewEnabled?: boolean;
  /** Omit the editorial review service (wiring-failure tests). */
  readonly omitReviewService?: boolean;
  readonly botApi?: TelegramBotApiClient;
  readonly executor?: CountingExecutor;
}

export interface ReviewHarness {
  readonly ingress: ReturnType<typeof createTelegramIngress>;
  readonly executor: CountingExecutor;
  readonly sends: { chatId: number; text: string }[];
}

/**
 * Build the REAL production path for one review test: counting executor ->
 * real authorization (owner bootstrap + admins table) -> real router with
 * the fail-closed review gate -> real ingress with the injected review
 * service -> fake Bot API.
 */
export function buildReviewHarness(options: ReviewHarnessOptions = {}): ReviewHarness {
  const executor =
    options.executor ??
    createCountingExecutor(createDbExecutor(env.DB, { clock: fixedClock(NOW) }));
  const { client, sends } = options.botApi
    ? { client: options.botApi, sends: [] }
    : createFakeBotApi();
  const { logger } = captureLogger();
  const reviewEnabled = options.reviewEnabled ?? true;
  const deps: TelegramIngressDeps = {
    executor,
    authorization: createAuthorizationService({
      ownerTelegramId: OWNER_ID,
      lookup: createAdminRoleLookup(executor),
    }),
    commandRouter: createCommandRouter({
      applicationVersion: APPLICATION_VERSION,
      reviewEnabled,
    }),
    ...(options.omitReviewService
      ? {}
      : { editorialReview: createEditorialReviewService({ executor }) }),
    botApi: client,
    clock: fixedClock(NOW),
    logger,
  };
  return { ingress: createTelegramIngress(deps), executor, sends };
}

/** A private, fresh message update from the given sender. */
export function privateMessage(
  updateId: number,
  fromUserId: number,
  text: string,
  overrides: Partial<Omit<Extract<ParsedUpdate, { kind: 'message' }>, 'kind' | 'updateId'>> & {
    kind?: 'message' | 'edited_message';
  } = {},
): ParsedUpdate {
  return {
    kind: 'message',
    updateId,
    messageId: updateId,
    date: Math.floor(NOW / 1000),
    chatId: fromUserId,
    chatType: 'private',
    fromUserId,
    text,
    command: text.replace('/', '').split(/[ @]/)[0],
    ...overrides,
  };
}

/** Seed one admin row (owner resolves via the bootstrap ID instead). */
export async function seedAdmin(
  telegramUserId: number,
  role: string,
  status: 'active' | 'disabled' = 'active',
): Promise<void> {
  const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [telegramUserId, `admin-${telegramUserId}`, role, status, NOW, NOW],
  });
}

/** Seed one story row (drafts.story_id FK target). */
export async function seedStory(
  storyId: string,
  headline: string,
  createdAt: number = NOW,
): Promise<void> {
  const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority, confidence,
            working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
          VALUES (?, ?, 'discovered', 'reported', 'official_news', 50, 10, ?, ?, ?, 1, ?, ?)`,
    params: [storyId, `key-${storyId}`, headline, createdAt, createdAt, createdAt, createdAt],
  });
}

export interface SeedDraftInput {
  readonly id: string;
  readonly storyId: string;
  readonly status?: string;
  readonly title: string;
  readonly documentJson: string;
  readonly createdAt?: number;
  readonly version?: number;
}

/** Seed one draft row exactly the way the pipeline's schema defines it. */
export async function seedDraft(input: SeedDraftInput): Promise<void> {
  const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json, version,
            created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', 'news_v1', ?, ?, ?, 'editorial.prepare_draft', ?, ?)`,
    params: [
      input.id,
      input.storyId,
      input.status ?? 'ready',
      input.title,
      input.documentJson,
      input.version ?? 1,
      input.createdAt ?? NOW,
      input.createdAt ?? NOW,
    ],
  });
}

/**
 * Re-apply migrations AND clear the mutable fixture tables so a suite's
 * beforeEach is idempotent (storage persists across tests within one file —
 * the same pattern the existing admin suites use).
 */
export async function freshDb(): Promise<void> {
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  await executor.run({ sql: 'DELETE FROM telegram_updates' });
  await executor.run({ sql: 'DELETE FROM settings' });
  await executor.run({ sql: 'DELETE FROM admins' });
  await executor.run({ sql: 'DELETE FROM draft_revisions' });
  await executor.run({ sql: 'DELETE FROM drafts' });
  await executor.run({ sql: 'DELETE FROM stories' });
  await executor.run({ sql: 'DELETE FROM source_items' });
  await executor.run({ sql: 'DELETE FROM sources' });
  await executor.run({ sql: 'DELETE FROM jobs' });
  await executor.run({ sql: 'DELETE FROM ai_runs' });
  await executor.run({ sql: 'DELETE FROM budgets' });
}

const PIPELINE_DEMO_TITLE = 'عرضهٔ دموی محلی: به‌روزرسانی بزرگ بازی نمونه منتشر شد';
const PIPELINE_DEMO_BODY =
  'استودیوی نمونه اعلام کرد به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه و بهبود عملکرد در دسترس قرار گرفت.';

export const PIPELINE_DEMO_ITEM_ID = 'review-demo-item-0001';

/**
 * Build ONE real pipeline Persian ready draft through the REAL fenced
 * editorial path (durable source item -> durable job -> dispatch -> consume
 * -> artificial provider -> Evidence Guard v1 -> discovery/assessment ->
 * mentions -> honest `disabled` event-relation ledger -> fenced commit).
 * ZERO live inference, ZERO network.
 */
export async function buildPipelineReadyDraft(): Promise<string> {
  await applyMigrations(env.DB);
  const clock = fixedClock(NOW);
  const rawExecutor = createDbExecutor(env.DB, { clock });
  const logger = {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as never;

  const SOURCE_ID = 'src-review-demo';
  await rawExecutor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'دموی منبع رسمی', 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
  const { sha256Hex } = await import('../../src/shared/ids/idempotency-key');
  const contentHash = await sha256Hex(
    `${PIPELINE_DEMO_ITEM_ID}\u001f${PIPELINE_DEMO_TITLE}\u001f${PIPELINE_DEMO_BODY}`,
  );
  await rawExecutor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, 'review-demo-ext-1', 'https://example.com/review-demo', ?, ?, 'نویسندهٔ دمو', ?, ?, ?, '{}', 'new')`,
    params: [
      PIPELINE_DEMO_ITEM_ID,
      SOURCE_ID,
      PIPELINE_DEMO_TITLE,
      PIPELINE_DEMO_BODY,
      NOW,
      NOW,
      contentHash,
    ],
  });

  const { createAiDraftService } = await import('../../src/application/ai/draft-service');
  const { enqueueEditorialPrepareDraft } =
    await import('../../src/application/editorial/enqueue-prepare-draft');
  const { createEditorialPrepareDraftHandler } =
    await import('../../src/application/editorial/prepare-draft-handler');
  const { createJobsEngine } = await import('../../src/application/jobs/engine');
  const { createJobHandlerRegistry } = await import('../../src/domain/jobs/handler');

  const port = {
    provider: 'workers-ai',
    complete: async () => ({
      kind: 'ok',
      rawText: JSON.stringify({
        headlineFa: 'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه منتشر شد',
        summaryFa:
          'استودیوی نمونه از انتشار به‌روزرسانی بزرگ بازی نمونه خبر داد؛ این به‌روزرسانی بخش داستانی تازه و بهبود عملکرد را به همراه دارد.',
        claims: [
          {
            text: 'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه و بهبود عملکرد در دسترس قرار گرفت.',
            evidenceIds: [PIPELINE_DEMO_ITEM_ID],
          },
        ],
      }),
      usage: { inputTokens: 300, outputTokens: 90 },
    }),
  } as never;
  const aiService = createAiDraftService({
    executor: rawExecutor,
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
  const engine = createJobsEngine(
    {
      executor: rawExecutor,
      handlers: createJobHandlerRegistry([
        createEditorialPrepareDraftHandler({
          executor: rawExecutor,
          aiService,
          nowMs: () => clock.now(),
          logger,
        }),
      ] as never),
      idGenerator: { newId: () => 'review-demo-job-1' },
      clock,
      random: () => 1,
      logger,
      jobsProducer: {
        send: async (envelope: unknown) => envelopes.push(envelope),
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
      backoff: { baseMs: 2_000, capMs: 3_600_000 },
      retryHintMaxSeconds: 3_600,
    },
  );
  const enqueued = await enqueueEditorialPrepareDraft({
    engine,
    executor: rawExecutor,
    sourceItemId: PIPELINE_DEMO_ITEM_ID,
  });
  if (enqueued.kind !== 'created') {
    throw new Error(`pipeline fixture enqueue failed: ${JSON.stringify(enqueued)}`);
  }
  await engine.dispatchDueJobs();
  if (envelopes.length !== 1) {
    throw new Error('pipeline fixture produced no dispatch envelope');
  }
  const action = await engine.consumeMessage('review-demo-msg-1', envelopes[0]);
  if (
    (action as { action?: string; outcome?: string }).action !== 'ack' ||
    (action as { outcome?: string }).outcome !== 'job_completed'
  ) {
    throw new Error(`pipeline fixture consume failed: ${JSON.stringify(action)}`);
  }
  const draft = await rawExecutor.first<{ id: string }>({ sql: 'SELECT id FROM drafts' });
  if (draft === null) {
    throw new Error('pipeline fixture produced no draft');
  }
  return draft.id;
}
