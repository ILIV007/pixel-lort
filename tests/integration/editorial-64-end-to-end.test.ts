import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { seedDraft, seedStory, OWNER_ID } from '../helpers/review-test-fixtures';
import { buildReviewHarness, privateMessage } from '../helpers/review-test-fixtures';
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
import { authorizeAiRequestAttempt, readAiBudget } from '../../src/adapters/db/ai-budget-store';
import { readFactGuardReport } from '../../src/domain/editorial/fact-guard';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';

/**
 * Phase 6.4 (V4 roadmap «مسیر سرتاسری») — the END-TO-END path review over
 * REAL workerd D1 with the ONLY artificial piece being the provider PORT
 * (zero network, zero live inference):
 *
 *   REAL source snapshot -> REAL durable job -> REAL engine dispatch ->
 *   REAL prepare-draft handler -> REAL budget authority + allowlist ladder
 *   + wall deadline + output validation -> REAL fenced commit -> REAL
 *   /drafts review view -> REAL /post_from_draft conversion.
 *
 * The roadmap's failure paths are re-verified ALONG this whole chain:
 * provider deadline, wall-deadline race with a LATE response (absorbed —
 * never resurrected), budget-first quota denial with ZERO provider calls,
 * INVALID provider output versions (unparseable / unknown evidence
 * reference / untraced claims), retry exhaustion, and the terminal safety
 * refusal. The fact-guard report (6.3) rides the same commit when its
 * independent flag is ON and is surfaced by the REAL review view; the
 * flag-OFF path stays byte-identical and the view shows the honest absent
 * state. Every live surface stays BLOCKED_LIVE (Posidon only).
 */

const NOW = 1_760_000_000_000;
const SOURCE_ID = 'src-e2e-64';
const ITEM_ID = 'e2e64-item-00000001';
const ITEM_TITLE = 'استودیوی نمونه از عرضهٔ نسخهٔ تازه خبر داد';
const ITEM_BODY =
  'استودیوی نمونه امروز اعلام کرد که نسخهٔ تازهٔ بازی نمونه با بخش داستانی گسترده و بهبود عملکرد منتشر شده است.';

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
// Deliberately NOT a real Telegram token SHAPE (the secret scanner treats
// `digits:AA...` as a credential): a stable URL component, never a credential.
const FAKE_BOT_TOKEN = '123456789:AB-FAKE-not-a-credential-shape-0000000000';
const TARGET_CHANNEL = '@pixel_channel';

const WEBHOOK_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  BOT_TOKEN: FAKE_BOT_TOKEN,
  TARGET_CHANNEL,
  DB: env.DB,
  ADMIN_POST_ENABLED: 'true',
  ADMIN_REVIEW_ENABLED: 'true',
  EDITORIAL_TO_POST_ENABLED: 'true',
};

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`condition not reached: ${what}`);
}

async function freshE2eDb(): Promise<void> {
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB);
  for (const table of [
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
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

/** Seed the REAL durable source snapshot (source + source_item). */
async function seedSnapshot(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'منبع رسمی آزمون', 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
  const contentHash = await sha256Hex(`${ITEM_ID}\u001f${ITEM_TITLE}\u001f${ITEM_BODY}`);
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, 'e2e64-ext-1', 'https://example.com/e2e64', ?, ?, 'نویسندهٔ آزمون', ?, ?, ?, '{}', 'new')`,
    params: [ITEM_ID, SOURCE_ID, ITEM_TITLE, ITEM_BODY, NOW, NOW, contentHash],
  });
}

interface JobRowLite {
  readonly id: string;
  readonly status: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly last_error: string | null;
}

interface AiRunRowLite {
  readonly status: string;
  readonly error_code: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
}

interface ChainHarness {
  readonly clock: MutableClock;
  readonly portCalls: { readonly modelId: string }[];
  readonly executor: DbExecutor;
  readonly scheduler: {
    readonly liveCount: () => number;
    readonly fireAll: () => void;
  };
  readonly drain: () => Promise<readonly string[]>;
  readonly jobRow: () => Promise<JobRowLite | null>;
  readonly draftRows: () => Promise<{ readonly id: string; readonly documentJson: string }[]>;
  readonly aiRunRows: () => Promise<readonly AiRunRowLite[]>;
  readonly workersAiBudget: () => Promise<number>;
}

interface ChainOptions {
  /** Scripted port outcome per call index (0-based). */
  readonly script: (
    callIndex: number,
    input: Parameters<AiProviderPort['complete']>[0],
  ) => AiCallOutcome | Promise<AiCallOutcome>;
  readonly factGuardEnabled?: boolean;
}

/**
 * Build the REAL end-to-end chain with the ONE artificial piece (the
 * provider port). The wall deadline is raced with a MANUAL scheduler the
 * test controls (the production default is real timers; the injectable
 * primitive is the documented test seam, round 1.10.6.1).
 */
async function createChain(options: ChainOptions): Promise<ChainHarness> {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  await seedSnapshot(executor);

  const portCalls: { modelId: string }[] = [];
  const port: AiProviderPort = {
    provider: 'workers-ai',
    complete: async (input) => {
      portCalls.push({ modelId: input.modelId });
      return options.script(portCalls.length - 1, input);
    },
  };

  // Manual deadline scheduler: the callback is captured, never auto-fired.
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
          ...(options.factGuardEnabled === true ? { factGuard: { enabled: true } } : {}),
        }),
      ] as never),
      idGenerator: { newId: () => `e2e64-job-${(jobSeq += 1)}` },
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

  const enqueued = await enqueueEditorialPrepareDraft({
    engine,
    executor,
    sourceItemId: ITEM_ID,
  });
  if (enqueued.kind !== 'created') {
    throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
  }

  // Dispatch due jobs and consume every pending envelope; returns the
  // consume outcomes ('ack:job_completed', 'ack:retry_scheduled', ...).
  const drain = async (): Promise<readonly string[]> => {
    const outcomes: string[] = [];
    for (let guard = 0; guard < 5; guard += 1) {
      await engine.dispatchDueJobs();
      if (envelopes.length === 0) break;
      const envelope = envelopes.shift() as never;
      const action = (await engine.consumeMessage(`e2e64-msg-${guard}`, envelope)) as {
        action: string;
        outcome?: string;
      };
      outcomes.push(`${action.action}:${action.outcome ?? ''}`);
      if (action.action !== 'ack') break;
    }
    return outcomes;
  };

  const jobRow = async (): Promise<JobRowLite | null> =>
    executor.first<JobRowLite>({
      sql: 'SELECT id, status, attempts, max_attempts, last_error FROM jobs ORDER BY created_at LIMIT 1',
    });

  const draftRows = async (): Promise<{ id: string; documentJson: string }[]> => {
    const result = await executor.query<{ id: string; document_json: string }>({
      sql: 'SELECT id, document_json FROM drafts ORDER BY created_at',
    });
    return result.rows.map((row) => ({ id: row.id, documentJson: row.document_json }));
  };

  const aiRunRows = async (): Promise<readonly AiRunRowLite[]> => {
    const result = await executor.query<AiRunRowLite>({
      sql: 'SELECT status, error_code, input_tokens, output_tokens FROM ai_runs ORDER BY created_at',
    });
    return result.rows;
  };

  const workersAiBudget = async (): Promise<number> =>
    readAiBudget(executor, { provider: 'workers-ai', nowMs: clock.now() });

  return {
    clock,
    portCalls,
    executor,
    scheduler: {
      liveCount: () => live.size,
      fireAll: () => {
        for (const callback of [...live]) {
          live.delete(callback);
          callback();
        }
      },
    },
    drain,
    jobRow,
    draftRows,
    aiRunRows,
    workersAiBudget,
  };
}

/** The traceable artificial draft JSON (the SAME discipline as Phase 5A). */
const EVIDENCE_HEADER_RE = /شواهد غیرقابل‌اعتماد — شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>>/;

function tracedDraftJson(userContent: string | undefined, tag: string): string {
  const evidenceId =
    (userContent !== undefined ? EVIDENCE_HEADER_RE.exec(userContent)?.[1] : null) ??
    'missing-evidence-id';
  return JSON.stringify({
    headlineFa: `تیتر سرتاسری ${tag}`,
    summaryFa: `خلاصهٔ سرتاسری ${tag} بر اساس شواهد ارائه‌شده.`,
    claims: [
      {
        text: `ادعای سرتاسری ${tag} بر پایهٔ شواهد ثبت‌شده در بخش شواهد ارائه شد.`,
        evidenceIds: [evidenceId],
      },
    ],
  });
}

function okOutcome(
  input: Parameters<AiProviderPort['complete']>[0] | undefined,
  tag: string,
): AiCallOutcome {
  const userContent = input?.messages.at(-1)?.content;
  return {
    kind: 'ok',
    rawText: tracedDraftJson(userContent, tag),
    usage: { inputTokens: 300, outputTokens: 90 },
  };
}

beforeEach(async () => {
  await freshE2eDb();
});

describe('Phase 6.4 — failure paths along the REAL end-to-end chain', () => {
  it('provider deadline_exceeded → typed recoverable retry, honest failed ai_run, NO draft', async () => {
    const h = await createChain({ script: () => ({ kind: 'deadline_exceeded' }) });

    const outcomes = await h.drain();
    expect(outcomes).toEqual(['ack:retry_scheduled']);

    const job = await h.jobRow();
    expect(job?.status).toBe('retry_wait');
    expect(job?.attempts).toBe(1);
    expect(job?.last_error).toBe('job_handler_retryable_error');

    // The provider DID run and stays honestly auditable; zero usage invented.
    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('deadline_exceeded');
    expect(runs[0]?.input_tokens).toBeNull();
    expect(runs[0]?.output_tokens).toBeNull();

    expect(await h.draftRows()).toHaveLength(0);
  });

  it('wall deadline fires while a call is in flight → the LATE response is absorbed (never resurrected) and the legitimate retry succeeds', async () => {
    const releaseLateRef: { resolve?: (outcome: AiCallOutcome) => void } = {};
    const latePromise = new Promise<AiCallOutcome>((resolve) => {
      releaseLateRef.resolve = resolve;
    });
    const h = await createChain({
      script: (callIndex, input) => (callIndex === 0 ? latePromise : okOutcome(input, 'دوم')),
    });

    // Attempt 1 starts; the provider-call deadline is the ONE live timer.
    const firstDrain = h.drain();
    await until(() => h.scheduler.liveCount() === 1, 'provider-call deadline scheduled');
    h.scheduler.fireAll();
    expect(await firstDrain).toEqual(['ack:retry_scheduled']);

    const job1 = await h.jobRow();
    expect(job1?.status).toBe('retry_wait');
    expect(await h.draftRows()).toHaveLength(0);
    // The attempt was charged conservatively (the authorization landed).
    expect(await h.workersAiBudget()).toBe(1);

    // The LATE response arrives AFTER the outcome was decided: it must be
    // absorbed — no commit, no resurrection, no extra draft, ever. (The
    // primitive's handlers observe the settlement; the service never reads
    // the late value, so its content is inert by construction.)
    releaseLateRef.resolve?.({
      kind: 'ok',
      rawText: JSON.stringify({ headlineFa: 'تیتر دیرهنگام', claims: [] }),
    });
    await sleep(30);
    expect(await h.draftRows()).toHaveLength(0);
    expect((await h.jobRow())?.status).toBe('retry_wait');

    // Attempt 2 (a legitimate fresh attempt) succeeds and is the ONLY draft.
    h.clock.advance(60_000);
    expect(await h.drain()).toEqual(['ack:job_completed']);

    const drafts = await h.draftRows();
    expect(drafts).toHaveLength(1);
    const document = JSON.parse(drafts[0]!.documentJson) as { headlineFa: string };
    expect(document.headlineFa).toBe('تیتر سرتاسری دوم');

    const job = await h.jobRow();
    expect(job?.status).toBe('succeeded');

    // Two honest ai_runs: the absorbed deadline attempt + the real success.
    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('deadline_exceeded');
    expect(runs[1]?.status).toBe('succeeded');
    expect(runs[1]?.input_tokens).toBe(300);
    expect(runs[1]?.output_tokens).toBe(90);
    expect(await h.workersAiBudget()).toBe(2);
  });

  it('budget-first quota denial → ZERO provider calls, typed retry, no fabricated run', async () => {
    // Pre-exhaust the workers-ai day bucket (cap 40) BEFORE the chain runs.
    const executor = createDbExecutor(env.DB);
    for (let i = 0; i < 40; i += 1) {
      const authorization = await authorizeAiRequestAttempt(executor, {
        provider: 'workers-ai',
        cap: 40,
        nowMs: NOW,
      });
      expect(authorization.kind).toBe('authorized');
    }
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: NOW })).toBe(40);

    const h = await createChain({ script: () => okOutcome(undefined, 'هرگز') });
    const outcomes = await h.drain();
    expect(outcomes).toEqual(['ack:retry_scheduled']);

    // Budget-first: the denial happened BEFORE any provider involvement.
    expect(h.portCalls).toHaveLength(0);
    expect(await h.workersAiBudget()).toBe(40);

    const job = await h.jobRow();
    expect(job?.status).toBe('retry_wait');
    expect(await h.draftRows()).toHaveLength(0);

    // The ledger observed the denial honestly (no usage, no success row).
    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('budget_denied');
    expect(runs[0]?.input_tokens).toBeNull();
  });

  it('invalid provider output (unknown evidence reference) → invalid_output, ladder exhausts, typed retry, no draft, no usage charge', async () => {
    const h = await createChain({
      script: () => ({
        kind: 'ok',
        rawText: JSON.stringify({
          headlineFa: 'تیتر با ارجاع ناشناس',
          summaryFa: 'خلاصهٔ آزمون ارجاع ناشناس.',
          claims: [
            {
              text: 'ادعای آزمون با ارجاع به شواهد ناشناس ثبت شد.',
              evidenceIds: ['unknown-evidence-id'],
            },
          ],
        }),
      }),
    });

    const outcomes = await h.drain();
    expect(outcomes).toEqual(['ack:retry_scheduled']);

    // The provider WAS called once per allowlist model (the ladder retries
    // invalid output on the NEXT model — only refusals are terminal) and
    // every attempt stays charged; no usage is invented for invalid output.
    expect(h.portCalls).toHaveLength(2);
    expect(await h.workersAiBudget()).toBe(2);
    expect(await h.draftRows()).toHaveLength(0);

    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('provider_unavailable');
  });

  it('retry exhaustion with a persistently failing provider → dead_letter job_exhausted, still NO draft', async () => {
    const h = await createChain({ script: () => ({ kind: 'deadline_exceeded' }) });

    // Attempt 1 → retry; advance past the (tiny) backoff; repeat to spend
    // the whole attempt budget (max_attempts 3).
    expect(await h.drain()).toEqual(['ack:retry_scheduled']);
    h.clock.advance(60_000);
    expect(await h.drain()).toEqual(['ack:retry_scheduled']);
    h.clock.advance(60_000);
    expect(await h.drain()).toEqual(['ack:job_dead_lettered']);

    const job = await h.jobRow();
    expect(job?.status).toBe('dead_letter');
    expect(job?.attempts).toBe(3);
    expect(job?.last_error).toBe('job_exhausted');
    expect(await h.draftRows()).toHaveLength(0);

    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.status).toBe('failed');
      expect(run.error_code).toBe('deadline_exceeded');
    }
    expect(await h.workersAiBudget()).toBe(3);
  });

  it('terminal provider safety refusal → permanent dead_letter editorial_ai_refused, honest failed run, NO draft', async () => {
    const h = await createChain({ script: () => ({ kind: 'refused' }) });

    expect(await h.drain()).toEqual(['ack:job_dead_lettered']);

    const job = await h.jobRow();
    expect(job?.status).toBe('dead_letter');
    expect(job?.attempts).toBe(1);
    expect(job?.last_error).toBe('editorial_ai_refused');

    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('provider_safety_refusal');

    expect(await h.draftRows()).toHaveLength(0);
    // The refusal is terminal: the budget was charged for the real call.
    expect(await h.workersAiBudget()).toBe(1);
  });

  it('schema-valid draft with NO traced claim → terminal editorial_input_invalid, invalid run, NO draft', async () => {
    const h = await createChain({
      script: () => ({
        kind: 'ok',
        rawText: JSON.stringify({
          headlineFa: 'تیتر بدون ادعای مرتبط',
          summaryFa: 'خلاصهٔ بدون ادعای مرتبط با شواهد.',
          claims: [],
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    expect(await h.drain()).toEqual(['ack:job_dead_lettered']);

    const job = await h.jobRow();
    expect(job?.status).toBe('dead_letter');
    expect(job?.last_error).toBe('editorial_no_traced_claim');
    expect(await h.draftRows()).toHaveLength(0);

    const runs = await h.aiRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('invalid');
  });
});

describe('Phase 6.4 — the fact-guard report on the surfaced end-to-end path', () => {
  it('flag ON: the report rides the SAME commit, the REAL review view surfaces it, and the conversion preserves provenance + unverified status', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    try {
      const h = await createChain({
        script: (i, input) => okOutcome(input, `اول ${i}`),
        factGuardEnabled: true,
      });
      expect(await h.drain()).toEqual(['ack:job_completed']);

      // The stored document carries the typed fact-guard report.
      const drafts = await h.draftRows();
      expect(drafts).toHaveLength(1);
      const stored: unknown = JSON.parse(drafts[0]!.documentJson);
      const guardRead = readFactGuardReport(stored);
      expect(guardRead.kind).toBe('fact_guard_v1');
      if (guardRead.kind !== 'fact_guard_v1') return;
      expect(guardRead.report.counts.total).toBe(1);
      // The claim stays UNVERIFIED — the lexical report never rewrites it.
      const claims = (stored as { modelClaims?: { status?: string }[] }).modelClaims;
      expect(claims?.[0]?.status).toBe('unverified');

      await seedWebhookAdmins();
      const draftId = drafts[0]!.id;

      // The REAL /drafts list delivers the id; the detail view surfaces the
      // fact-guard section with honest labels and counts.
      await deliver(WEBHOOK_ENV, textUpdate(9100, OWNER_ID, '/drafts'));
      const listText = lastReplyText(fake, OWNER_ID);
      expect(listText).toContain(draftId);

      await deliver(WEBHOOK_ENV, textUpdate(9101, OWNER_ID, `/drafts ${draftId}`));
      const detail = lastReplyText(fake, OWNER_ID);
      expect(detail).toContain('Fact guard');
      expect(detail).toContain('evaluated');
      expect(detail).toContain('requiring review');
      expect(detail).toContain('lexical observations');
      expect(detail).toContain('UNASSESSED');

      // The conversion is UNAFFECTED by the additive report (the flags
      // never imply each other): the provenance lands and the rendered
      // post keeps the unverified note.
      await deliver(WEBHOOK_ENV, textUpdate(9102, OWNER_ID, `/post_from_draft ${draftId}`));
      const postDraftId = postDraftIdFromReply(fake, OWNER_ID);
      const converted = lastReplyText(fake, OWNER_ID);
      expect(converted).toContain('unverified status preserved');
      expect(converted).toContain(draftId);

      const executor = createDbExecutor(env.DB);
      const version = await executor.first<{
        editorial_draft_id: string | null;
        editorial_draft_version: number | null;
      }>({
        sql: 'SELECT editorial_draft_id, editorial_draft_version FROM admin_post_versions WHERE draft_id = ?',
        params: [postDraftId],
      });
      expect(version?.editorial_draft_id).toBe(draftId);
      expect(version?.editorial_draft_version).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('flag OFF (default): the accepted document shape stays byte-identical (NO factGuard key) and the view states the honest absent line', async () => {
    const fake = createTelegramApiFake();
    vi.stubGlobal('fetch', fake.fetchFn);
    try {
      const h = await createChain({ script: (_i, input) => okOutcome(input, 'خاموش') });
      expect(await h.drain()).toEqual(['ack:job_completed']);

      const drafts = await h.draftRows();
      expect(drafts).toHaveLength(1);
      const stored = JSON.parse(drafts[0]!.documentJson) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(stored, 'factGuard')).toBe(false);

      await seedWebhookAdmins();
      await deliver(WEBHOOK_ENV, textUpdate(9110, OWNER_ID, `/drafts ${drafts[0]!.id}`));
      const detail = lastReplyText(fake, OWNER_ID);
      expect(detail).toContain('Fact guard');
      expect(detail).toContain('not present in this stored document');
      // The unverified note is INDEPENDENT of the fact-guard flag.
      expect(detail).toContain('UNVERIFIED');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a stored LIE (corrupted fact-guard counts) is displayed as malformed — never guessed into ok, never a crash', async () => {
    await seedStory('story-e2e64-lie', 'تیتر روایت آزمون');
    const corrupted = JSON.stringify({
      schemaVersion: 1,
      headlineFa: 'تیتر سند خراب',
      summaryFa: 'خلاصهٔ سند خراب.',
      sourceReport: {
        sourceName: 'منبع آزمون',
        excerptText: 'گزارهٔ آزمون.',
        sourceItemId: ITEM_ID,
        truncated: false,
      },
      modelClaims: [
        {
          text: 'ادعای آزمون.',
          status: 'unverified',
          evidenceIds: [ITEM_ID],
        },
      ],
      factGuard: {
        factGuardVersion: 1,
        evaluationStatus: 'evaluated',
        snapshot: { sourceItemId: ITEM_ID, contentHash: 'hash' },
        evidence: { evidenceId: ITEM_ID, excerptTruncated: false, excerptMaxChars: 600 },
        limitations: ['lexical_presence_not_truth'],
        unassessedFields: ['headlineFa', 'summaryFa'],
        claims: [],
        counts: {
          total: 1,
          claimsRequiringReview: 7,
          unwitnessedClaims: 0,
          numberFindings: 0,
          quotationFindings: 0,
          rumorFindings: 0,
          negationFindings: 0,
        },
      },
    });
    await seedDraft({
      id: 'draft-e2e64-lie-0000001',
      storyId: 'story-e2e64-lie',
      title: 'پیش‌نویس سند خراب',
      documentJson: corrupted,
    });

    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9120, OWNER_ID, '/drafts draft-e2e64-lie-0000001'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    const text = harness.sends[0]!.text;
    // The typed reader rejected the stored lie; the view says so honestly.
    expect(text).toContain('Fact guard');
    expect(text).toContain('malformed');
    expect(text).not.toContain('requiring review');
    // The core document still renders (the corrupt OPTIONAL report never
    // crashes the preview).
    expect(text).toContain('تیتر سند خراب');
  });
});

// ---------------------------------------------------------------------------
// Webhook helpers (the SAME real-reply discipline as the R1.22 bridge suite).
// ---------------------------------------------------------------------------

interface ApiFake {
  readonly fetchFn: typeof fetch;
  readonly sentMessages: Record<string, unknown>[];
}

function createTelegramApiFake(): ApiFake {
  const sentMessages: Record<string, unknown>[] = [];
  let nextMessageId = 9000;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText.length > 0 ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    if (url.endsWith('/sendMessage')) {
      sentMessages.push(body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, sentMessages };
}

function replyTexts(fake: ApiFake, chatId: number): string[] {
  return fake.sentMessages
    .filter((message) => message['chat_id'] === chatId && typeof message['text'] === 'string')
    .map((message) => message['text'] as string);
}

function lastReplyText(fake: ApiFake, chatId: number): string {
  const texts = replyTexts(fake, chatId);
  if (texts.length === 0) {
    throw new Error(`no reply was delivered to chat ${chatId}`);
  }
  return texts[texts.length - 1]!;
}

function postDraftIdFromReply(fake: ApiFake, chatId: number): string {
  for (const text of replyTexts(fake, chatId)) {
    const match = /Post draft id: ([0-9a-f-]{36})/u.exec(text);
    if (match !== null) return match[1]!;
  }
  throw new Error(`no post draft id was delivered to chat ${chatId}`);
}

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<number> {
  const request = new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TELEGRAM_SECRET_HEADER]: FAKE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  const response = await handleTelegramWebhook(request, envOverrides, { logger }).then(
    (res) => res.status,
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? 'internal_error';
      return code === 'service_unavailable' ? 503 : 500;
    },
  );
  return response;
}

function textUpdate(updateId: number, fromId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId },
      text,
    },
  };
}

async function seedWebhookAdmins(): Promise<void> {
  const executor = createDbExecutor(env.DB);
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', 1, 1)`,
    params: [OWNER_ID, `Admin ${OWNER_ID}`],
  });
}
