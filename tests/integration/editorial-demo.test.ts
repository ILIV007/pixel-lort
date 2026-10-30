import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createLogger } from '../../src/observability/logger';
import { createJobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import type {
  JobsQueueProducerPort,
  DlqProducerPort,
} from '../../src/adapters/queue/jobs-producer';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';
import { enqueueEditorialPrepareDraft } from '../../src/application/editorial/enqueue-prepare-draft';
import { createEditorialPrepareDraftHandler } from '../../src/application/editorial/prepare-draft-handler';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import { readEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';

/**
 * Phase 5A OFFLINE demo/test runner (ADR-0042 §7): the SAME real path as
 * the integration suite — real durable source_item → real durable jobs
 * engine → real `createAiDraftService` (real D1 budget authority, real
 * allowlist/deadline/validation) → real fenced editorial commit — with an
 * ARTIFICIAL provider port (zero network) and a DEMO FIXTURE item whose
 * text is public and displayable.
 *
 * It prints the SAFE summary required by the round instruction:
 *   sourceItemId, storyId, claim/evidence count, draftId, draft status,
 *   artificial headlineFa/summaryFa, provider attempts — plus the LOCAL D1
 *   statement/execution-API counts of one news path (a LOCAL PROXY metric
 *   per ADR-0042 §8 — NOT an official Cloudflare billing figure).
 *
 * R1.12 (Phase 5B): the summary ALSO prints the honest Evidence Guard v1
 * result that traveled inside the same draft — per-claim outcomes
 * (direct_text_observed / unresolved_requires_further_verification), the
 * fixed limitations, and the explicitly unassessed fields. The guard is a
 * deterministic text-presence check ONLY: direct observation is never
 * "verified", unresolved is never "false".
 *
 * This runner creates NO public endpoint, NO send channel, and NO live
 * inference. Run it standalone with: `npm run demo:editorial`.
 */

const NOW = 1_760_000_000_000;
const SOURCE_ID = 'src-demo-official';
const ITEM_ID = 'demo-item-0001';
const DEMO_TITLE = 'عرضهٔ دموی محلی: به‌روزرسانی بزرگ بازی نمونه منتشر شد';
const DEMO_BODY =
  'استودیوی نمونه اعلام کرد به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه و بهبود عملکرد در دسترس قرار گرفت.';

/** Statement/counting executor: the local D1 proxy metric. */
function createCountingExecutor(
  inner: DbExecutor,
): DbExecutor & { readonly stats: () => { statements: number; apiCalls: number } } {
  let statements = 0;
  let apiCalls = 0;
  const counted = (list: readonly DbStatement[]): DbStatement[] => {
    statements += list.length;
    return [...list];
  };
  return {
    query: async (statement) => {
      statements += 1;
      apiCalls += 1;
      return inner.query(statement);
    },
    first: async (statement) => {
      statements += 1;
      apiCalls += 1;
      return inner.first(statement);
    },
    run: async (statement) => {
      statements += 1;
      apiCalls += 1;
      return inner.run(statement);
    },
    batch: async (input) => {
      counted(input);
      apiCalls += 1;
      return inner.batch(input);
    },
    stats: () => ({ statements, apiCalls }),
  };
}

describe('editorial demo — offline source→draft runner', () => {
  it('runs one real news path and prints the safe summary', async () => {
    await applyMigrations(env.DB);
    const clock = fixedClock(NOW);
    const rawExecutor = createDbExecutor(env.DB, { clock });
    const executor = createCountingExecutor(rawExecutor);
    const logger = createLogger({ level: 'error', clock });

    // Demo fixture: a PUBLIC, displayable news item (no secrets, no raw
    // payloads) — persisted through the same schema the pipeline reads.
    await rawExecutor.run({
      sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
              priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
            VALUES (?, 'دموی منبع رسمی', 'rss', 'official', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
      params: [SOURCE_ID, NOW, NOW],
    });
    const contentHash = await sha256Hex(`${ITEM_ID}\u001f${DEMO_TITLE}\u001f${DEMO_BODY}`);
    await rawExecutor.run({
      sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
              author, published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES (?, ?, 'demo-ext-1', 'https://example.com/demo', ?, ?, 'نویسندهٔ دمو', ?, ?, ?, '{}', 'new')`,
      params: [ITEM_ID, SOURCE_ID, DEMO_TITLE, DEMO_BODY, NOW, NOW, contentHash],
    });

    // Artificial provider port: SAME contract, ZERO network. Its Persian
    // output is a DEMO FIXTURE — no live-model Persian quality is claimed.
    let providerAttempts = 0;
    const port: AiProviderPort = {
      provider: 'workers-ai',
      complete: async () => {
        providerAttempts += 1;
        const outcome: AiCallOutcome = {
          kind: 'ok',
          rawText: JSON.stringify({
            headlineFa: 'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه منتشر شد',
            summaryFa:
              'استودیوی نمونه از انتشار به‌روزرسانی بزرگ بازی نمونه خبر داد؛ این به‌روزرسانی بخش داستانی تازه و بهبود عملکرد را به همراه دارد.',
            claims: [
              {
                // ONE claim quotes the evidence VERBATIM → the guard's
                // direct-text observation (an observation, NOT verification).
                text: 'به‌روزرسانی بزرگ بازی نمونه با بخش داستانی تازه و بهبود عملکرد در دسترس قرار گرفت.',
                evidenceIds: [ITEM_ID],
              },
              {
                // ONE PARAPHRASE → honestly unresolved, never "false".
                text: 'نسخهٔ تازهٔ بازی نمونه منتشر شد و کیفیت آن بهتر شده است.',
                evidenceIds: [ITEM_ID],
              },
            ],
          }),
          usage: { inputTokens: 312, outputTokens: 96 },
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
    const handlers = [
      createEditorialPrepareDraftHandler({
        executor,
        aiService,
        nowMs: () => clock.now(),
        logger,
      }),
    ];
    const envelopes: unknown[] = [];
    const engine = createJobsEngine(
      {
        executor,
        handlers: createJobHandlerRegistry(handlers as never),
        idGenerator: { newId: () => `demo-id-${envelopes.length + 1}` },
        clock,
        random: () => 1,
        logger,
        jobsProducer: {
          send: async (envelope) => {
            envelopes.push(envelope);
          },
        } as JobsQueueProducerPort,
        dlqProducer: {
          send: async () => undefined,
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

    // The REAL path: application boundary → durable job → dispatch →
    // consume → AI → fenced commit.
    const enqueued = await enqueueEditorialPrepareDraft({
      engine,
      executor,
      sourceItemId: ITEM_ID,
    });
    expect(enqueued.kind).toBe('created');

    await engine.dispatchDueJobs();
    expect(envelopes).toHaveLength(1);
    const action = await engine.consumeMessage('demo-msg-1', envelopes[0]);
    expect(action).toEqual({ action: 'ack', outcome: 'job_completed' });

    // The safe summary (Posidon R1.11 §8): public identifiers and counts
    // only — never news text dumps, secrets, or private payloads.
    const storyRow = await rawExecutor.first<{ id: string; story_key: string; status: string }>({
      sql: 'SELECT id, story_key, status FROM stories',
    });
    const claimCount = (await rawExecutor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM claims',
    }))!.n;
    const evidenceCount = (await rawExecutor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM evidence',
    }))!.n;
    const draftRow = await rawExecutor.first<{
      id: string;
      status: string;
      title: string;
      document_json: string;
    }>({ sql: 'SELECT id, status, title, document_json FROM drafts' });
    const document = JSON.parse(draftRow!.document_json) as { summaryFa: string };
    // R1.12: the typed guard reader — the SAME report the draft carries.
    const guardRead = readEvidenceGuardReport(JSON.parse(draftRow!.document_json));
    expect(guardRead.kind).toBe('guard_v1');
    const guard = guardRead.kind === 'guard_v1' ? guardRead.report : null;
    const budgetRow = await rawExecutor.first<{ requests: number }>({
      sql: "SELECT requests FROM budgets WHERE scope = 'ai'",
    });
    const stats = executor.stats();

    const summary = {
      sourceItemId: ITEM_ID,
      storyId: storyRow!.id,
      storyStatus: storyRow!.status,
      claimCount,
      evidenceCount,
      draftId: draftRow!.id,
      draftStatus: draftRow!.status,
      headlineFa: draftRow!.title,
      summaryFa: document.summaryFa,
      evidenceGuard: {
        guardVersion: guard!.guardVersion,
        evaluationStatus: guard!.evaluationStatus,
        claims: guard!.claims.map((claim) => ({
          claimIndex: claim.claimIndex,
          status: claim.status,
          reasonCodes: claim.reasonCodes,
        })),
        counts: guard!.counts,
        limitations: guard!.limitations,
        unassessedFields: guard!.unassessedFields,
        excerptTruncated: guard!.evidence.excerptTruncated,
      },
      providerAttempts,
      chargedAiAttempts: budgetRow?.requests ?? 0,
      localD1Statements: stats.statements,
      localD1ExecutionApiCalls: stats.apiCalls,
    };
    // eslint-disable-next-line no-console -- THE demo output (safe summary only)
    console.log('EDITORIAL_DEMO_SUMMARY', JSON.stringify(summary, null, 2));

    // The demo doubles as a regression guard for the happy path.
    expect(summary.storyStatus).toBe('discovered');
    expect(summary.claimCount).toBe(1);
    expect(summary.evidenceCount).toBe(1);
    expect(summary.draftStatus).toBe('ready');
    expect(summary.providerAttempts).toBe(1);
    expect(summary.chargedAiAttempts).toBe(1);
    // R1.12: the guard rode inside the SAME draft; the verbatim claim is
    // an observation, the paraphrase stays unresolved — never verified.
    expect(summary.evidenceGuard.claims.map((claim) => claim.status)).toEqual([
      'direct_text_observed',
      'unresolved_requires_further_verification',
    ]);
    expect(summary.evidenceGuard.counts).toEqual({
      total: 2,
      directTextObserved: 1,
      unresolvedRequiresFurtherVerification: 1,
      invalidReferenceOrSnapshot: 0,
      notEvaluatedIdentityInvalid: 0,
    });
    expect(summary.evidenceGuard.unassessedFields).toEqual(['headlineFa', 'summaryFa']);
  });
});
