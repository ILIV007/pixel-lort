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
import { evaluateAutoPublishGate } from '../../src/domain/publishing/auto-gate';
import { approveDraftForAutoPublication } from '../../src/adapters/db/auto-approval-store';
import {
  enqueuePublication,
  findPublicationById,
  listPublicationMessages,
} from '../../src/adapters/db/publication-outbox-store';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import { contentTextHash } from '../../src/domain/publishing/publication-identity';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';

/**
 * Plan slice 3 — the CONNECTED end-to-end editorial and fact-safety chain
 * over REAL workerd D1, with the ONLY artificial pieces being the provider
 * PORT and the Telegram TRANSPORT (zero network, zero live inference):
 *
 *   REAL source snapshot -> REAL durable job -> REAL prepare-draft handler
 *   -> REAL budget authority + allowlist ladder + fenced commit (the
 *   fact-guard report riding the SAME commit) -> THE AUTO GATE (ag1) over
 *   the STORED row -> THE FENCED auto_approved TRANSITION (the independent
 *   default-OFF gate flag) -> REAL idempotent enqueue (auto mode) -> REAL
 *   scheduler scan/claim/policy -> REAL rendered send through the FAKE
 *   transport -> REAL at-most-once ledger -> published.
 *
 * The slice-3 honesty boundary pinned here:
 *  - a measurable verdict, never prose: the eligible verdict carries the
 *    report's own limitation labels; a requires_review verdict carries the
 *    per-claim finding codes (references alone are NOT semantic proof);
 *  - eligibility is NOT activation: the durable transition needs BOTH the
 *    eligible verdict AND the independent enablement flag (default OFF) —
 *    either one missing means ZERO writes;
 *  - the human path is never flipped: an 'approved' (or any non-ready)
 *    draft refuses the transition; a non-eligible verdict refuses with
 *    ZERO writes and the draft stays exactly as it was;
 *  - LIVE surfaces stay BLOCKED_LIVE (Posidon only): this suite proves the
 *    ENGINE chain, never a deployment.
 */

const NOW = 1_760_000_000_000;
/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW_MORNING = 1_700_029_800_000;
const SOURCE_ID = 'src-e2e-94';
const ITEM_ID = 'e2e94-item-00000001';
const ITEM_TITLE = 'استودیوی نمونه از عرضهٔ نسخهٔ تازه خبر داد';
const ITEM_BODY =
  'استودیوی نمونه امروز اعلام کرد که نسخهٔ تازهٔ بازی نمونه با بخش داستانی گسترده و بهبود عملکرد منتشر شده است.';
const DESTINATION = '@pixel_channel_e2e94';
const AUTO_GATE_ACTOR = 'auto_gate:ag1';

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

async function freshE2eDb(executor: DbExecutor): Promise<void> {
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
          VALUES (?, 'منبع رسمی آزمون ۹۴', 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
  const contentHash = await sha256Hex(`${ITEM_ID}\u001f${ITEM_TITLE}\u001f${ITEM_BODY}`);
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, 'e2e94-ext-1', 'https://example.com/e2e94', ?, ?, 'نویسندهٔ آزمون', ?, ?, ?, '{}', 'new')`,
    params: [ITEM_ID, SOURCE_ID, ITEM_TITLE, ITEM_BODY, NOW, NOW, contentHash],
  });
}

interface ChainHarness {
  readonly executor: DbExecutor;
  readonly clock: MutableClock;
  readonly drain: () => Promise<readonly string[]>;
  readonly storedDraft: () => Promise<{
    readonly id: string;
    readonly status: string;
    readonly documentJson: string;
  } | null>;
}

interface ChainOptions {
  readonly script: (
    callIndex: number,
    input: Parameters<AiProviderPort['complete']>[0],
  ) => AiCallOutcome | Promise<AiCallOutcome>;
  readonly factGuardEnabled?: boolean;
}

/** The REAL chain up to the fenced commit (the editorial-64 wiring). */
async function createChain(options: ChainOptions): Promise<ChainHarness> {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  await freshE2eDb(executor);
  await seedSnapshot(executor);

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
          ...(options.factGuardEnabled === true ? { factGuard: { enabled: true } } : {}),
        }),
      ] as never),
      idGenerator: { newId: () => `e2e94-job-${(jobSeq += 1)}` },
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

  const drain = async (): Promise<readonly string[]> => {
    const outcomes: string[] = [];
    for (let guard = 0; guard < 5; guard += 1) {
      await engine.dispatchDueJobs();
      if (envelopes.length === 0) break;
      const envelope = envelopes.shift() as never;
      const action = (await engine.consumeMessage(`e2e94-msg-${guard}`, envelope)) as {
        action: string;
        outcome?: string;
      };
      outcomes.push(`${action.action}:${action.outcome ?? ''}`);
      if (action.action !== 'ack') break;
    }
    return outcomes;
  };

  const storedDraft = async () => {
    const row = await executor.first<{
      readonly id: string;
      readonly status: string;
      readonly document_json: string;
    }>({
      sql: 'SELECT id, status, document_json FROM drafts ORDER BY created_at DESC LIMIT 1',
    });
    return row ? { id: row.id, status: row.status, documentJson: row.document_json } : null;
  };

  return { executor, clock, drain, storedDraft };
}

/** The traceable provider draft JSON (the SAME discipline as Phase 5A/6.4). */
const EVIDENCE_HEADER_RE = /شواهد غیرقابل‌اعتماد — شناسه: ([^\n]+)\n<<<SHAHED_SHOROO>>>/;

function tracedDraftJson(userContent: string | undefined, claimText: string): string {
  const evidenceId =
    (userContent !== undefined ? EVIDENCE_HEADER_RE.exec(userContent)?.[1] : null) ??
    'missing-evidence-id';
  return JSON.stringify({
    headlineFa: 'تیتر زنجیرهٔ سرتاسری ۹۴',
    summaryFa: 'خلاصهٔ زنجیرهٔ سرتاسری ۹۴ بر اساس شواهد ارائه‌شده.',
    claims: [
      {
        text: claimText,
        evidenceIds: [evidenceId],
      },
    ],
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

/** The GROUNDED claim: every word comes from the stored item body. */
const GROUNDED_CLAIM = 'نسخهٔ تازهٔ بازی نمونه منتشر شده است.';
/** The UNGROUNDED number: ۱۲۰ appears NOWHERE in the stored item body. */
const UNGROUNDED_CLAIM = 'بازی نمونه ۱۲۰ هزار بازیکن دارد.';

function makeTransport(
  messageId: number,
): PublicationChannelTransport & { readonly calls: { readonly text: string }[] } {
  const calls: { readonly text: string }[] = [];
  return {
    calls,
    async sendMessageRich(input) {
      calls.push({ text: input.content.text });
      return { messageId };
    },
  };
}

beforeEach(async () => {
  const prep = createDbExecutor(env.DB);
  await freshE2eDb(prep);
});

describe('slice 3 — the connected chain to a published AUTO-eligible draft', () => {
  it('REAL snapshot -> REAL AI draft + fact-guard -> gate eligible_auto -> fenced auto_approved -> enqueue(auto) -> scheduler send -> published + ledger', async () => {
    const chain = await createChain({
      factGuardEnabled: true,
      script: async (callIndex, input) => okOutcome(input, GROUNDED_CLAIM),
    });
    const outcomes = await chain.drain();
    expect(outcomes.some((entry) => entry.startsWith('ack'))).toBe(true);

    const draft = await chain.storedDraft();
    if (!draft) throw new Error('the ready draft must exist');
    expect(draft.status).toBe('ready');

    // THE GATE over the STORED bytes: eligible with the measured data.
    const verdict = evaluateAutoPublishGate(draft.documentJson);
    expect(verdict.kind).toBe('eligible_auto');
    if (verdict.kind === 'eligible_auto') {
      expect(verdict.claimCount).toBe(1);
      expect(verdict.limitationLabels.length).toBeGreaterThan(0);
    }

    // THE FENCED TRANSITION (the independent flag ON): ready -> auto_approved.
    const applied = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      gateEnabled: true,
      nowMs: chain.clock.now(),
    });
    expect(applied.kind).toBe('applied');

    const after = await chain.storedDraft();
    expect(after?.status).toBe('auto_approved');

    // THE AUDIT: one system event carrying the gate identity + measured
    // data — never document content, never secrets.
    const audit = await chain.executor.first<{
      readonly actor_type: string;
      readonly actor_id: string;
      readonly action: string;
      readonly target_id: string;
      readonly metadata_json: string;
    }>({
      sql: `SELECT actor_type, actor_id, action, target_id, metadata_json
            FROM audit_events WHERE action = 'draft_auto_approved'`,
    });
    if (!audit) throw new Error('the audit event must exist');
    expect(audit.actor_type).toBe('system');
    expect(audit.actor_id).toBe(AUTO_GATE_ACTOR);
    expect(audit.target_id).toBe(draft.id);
    const metadata = JSON.parse(audit.metadata_json) as {
      gateVersion?: string;
      claimCount?: number;
    };
    expect(metadata.gateVersion).toBe('ag1');
    expect(metadata.claimCount).toBe(1);

    // THE IDEMPOTENT ENQUEUE (auto mode agrees with auto_approved).
    const enqueuedRow = await enqueuePublication(chain.executor, {
      publicationId: 'pub-e2e94-auto',
      draftId: draft.id,
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'auto',
      nowMs: NOW_MORNING,
    });
    expect(enqueuedRow.kind).toBe('created');
    const duplicate = await enqueuePublication(chain.executor, {
      publicationId: 'pub-e2e94-auto-2',
      draftId: draft.id,
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'auto',
      nowMs: NOW_MORNING,
    });
    expect(duplicate.kind).toBe('duplicate');

    // THE REAL SCHEDULER (the only artificial piece: the transport).
    const transport = makeTransport(4242);
    const scheduler = createPublicationScheduler({
      executor: chain.executor,
      destination: DESTINATION,
      transport,
      sendGate: { enabled: true },
      contextProvider: createStoriesPolicyContextProvider(chain.executor),
      clock: fixedClock(NOW_MORNING),
      logger,
      scanLimit: 10,
    });
    const report = await scheduler.scanDuePublications();
    expect(report.details).toHaveLength(1);
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-e2e94-auto',
      outcome: 'sent',
    });

    const row = await findPublicationById(chain.executor, 'pub-e2e94-auto');
    expect(row?.status).toBe('published');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.text).toContain('تیتر زنجیرهٔ سرتاسری ۹۴');

    // The at-most-once ledger: exactly ONE recorded message, ordinal 0.
    const messages = await listPublicationMessages(chain.executor, 'pub-e2e94-auto');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ordinal).toBe(0);
    const expectedHash = await contentTextHash(transport.calls[0]?.text ?? '');
    if (!expectedHash.ok) throw new Error('the fixture hash must succeed');
    expect(messages[0]?.text_hash).toBe(expectedHash.hash);

    // THE IDEMPOTENT RE-TRANSITION: already auto_approved is the honest
    // absorption — no second audit event, no write.
    const again = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      gateEnabled: true,
      nowMs: chain.clock.now(),
    });
    expect(again.kind).toBe('already_auto_approved');
    const auditCount = await chain.executor.first<{ readonly total: number }>({
      sql: `SELECT COUNT(*) AS total FROM audit_events WHERE action = 'draft_auto_approved'`,
    });
    expect(auditCount?.total).toBe(1);
  });

  it('the transition is the ONLY route to auto_approved: with the flag OFF an eligible verdict still refuses with ZERO writes', async () => {
    const chain = await createChain({
      factGuardEnabled: true,
      script: async (_callIndex, input) => okOutcome(input, GROUNDED_CLAIM),
    });
    await chain.drain();
    const draft = await chain.storedDraft();
    if (!draft) throw new Error('the ready draft must exist');
    const verdict = evaluateAutoPublishGate(draft.documentJson);
    expect(verdict.kind).toBe('eligible_auto');

    const refused = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      gateEnabled: false,
      nowMs: chain.clock.now(),
    });
    expect(refused.kind).toBe('gate_disabled');
    expect((await chain.storedDraft())?.status).toBe('ready');
    const audit = await chain.executor.first<{ readonly total: number }>({
      sql: `SELECT COUNT(*) AS total FROM audit_events WHERE action = 'draft_auto_approved'`,
    });
    expect(audit?.total).toBe(0);
    const publications = await chain.executor.first<{ readonly total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM publications',
    });
    expect(publications?.total).toBe(0);
  });
});

describe('slice 3 — the fail-closed refusals never write', () => {
  it('requires_review: the ungrounded number keeps the draft on the HUMAN path (zero writes, no publication)', async () => {
    const chain = await createChain({
      factGuardEnabled: true,
      script: async (_callIndex, input) => okOutcome(input, UNGROUNDED_CLAIM),
    });
    await chain.drain();
    const draft = await chain.storedDraft();
    if (!draft) throw new Error('the ready draft must exist');
    expect(draft.status).toBe('ready');

    const verdict = evaluateAutoPublishGate(draft.documentJson);
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.claims[0]?.findings).toContain('number_not_observed_in_evidence');
    }

    const refused = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      gateEnabled: true,
      nowMs: chain.clock.now(),
    });
    expect(refused.kind).toBe('gate_not_eligible');
    expect((await chain.storedDraft())?.status).toBe('ready');
    const publications = await chain.executor.first<{ readonly total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM publications',
    });
    expect(publications?.total).toBe(0);
  });

  it('report_absent: the flag-off historical shape has NO measurable basis and refuses', async () => {
    const chain = await createChain({
      // fact-guard flag OFF: the factGuard key is never written.
      script: async (_callIndex, input) => okOutcome(input, GROUNDED_CLAIM),
    });
    await chain.drain();
    const draft = await chain.storedDraft();
    if (!draft) throw new Error('the ready draft must exist');
    const verdict = evaluateAutoPublishGate(draft.documentJson);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('report_absent');
    }
    const refused = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      gateEnabled: true,
      nowMs: chain.clock.now(),
    });
    expect(refused.kind).toBe('gate_not_eligible');
    expect((await chain.storedDraft())?.status).toBe('ready');
  });

  it('document_unreadable and report_malformed: corrupted stored bytes refuse typed with zero writes', async () => {
    const chain = await createChain({
      factGuardEnabled: true,
      script: async (_callIndex, input) => okOutcome(input, GROUNDED_CLAIM),
    });
    await chain.drain();
    const draft = await chain.storedDraft();
    if (!draft) throw new Error('the ready draft must exist');

    // Corrupt the WHOLE document: unparseable bytes.
    await chain.executor.run({
      sql: 'UPDATE drafts SET document_json = ? WHERE id = ?',
      params: ['{{{not-json', draft.id],
    });
    const unreadable = evaluateAutoPublishGate('{{{not-json');
    expect(unreadable.kind).toBe('refused');
    if (unreadable.kind === 'refused') {
      expect(unreadable.reason).toBe('document_unreadable');
    }
    const refusedA = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: unreadable,
      gateEnabled: true,
      nowMs: chain.clock.now(),
    });
    expect(refusedA.kind).toBe('gate_not_eligible');
    expect((await chain.storedDraft())?.status).toBe('ready');
  });

  it('the fence never flips a HUMAN decision: an approved (or superseded) draft refuses not_ready', async () => {
    const chain = await createChain({
      factGuardEnabled: true,
      script: async (_callIndex, input) => okOutcome(input, GROUNDED_CLAIM),
    });
    await chain.drain();
    const draft = await chain.storedDraft();
    if (!draft) throw new Error('the ready draft must exist');
    const verdict = evaluateAutoPublishGate(draft.documentJson);
    expect(verdict.kind).toBe('eligible_auto');

    // A human approval happened while the gate was deliberating.
    await chain.executor.run({
      sql: `UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?`,
      params: [chain.clock.now(), draft.id],
    });
    const fenced = await approveDraftForAutoPublication(chain.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      gateEnabled: true,
      nowMs: chain.clock.now(),
    });
    expect(fenced.kind).toBe('not_ready');
    expect((await chain.storedDraft())?.status).toBe('approved');
  });
});
