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
import { readFactGuardReport } from '../../src/domain/editorial/fact-guard';
import { readEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';

/**
 * Phase 6.3 (V4, post 5→6 gate) REAL-D1 integration suite for the
 * FACT-GUARD report: the report is produced on the REAL editorial path
 * (real engine + real AI service + real fenced atomic commit over workerd
 * D1; the ONLY artificial piece stays the provider port) ONLY when the
 * independent EDITORIAL_FACT_GUARD_ENABLED gate is ON, and travels INSIDE
 * `drafts.document_json` of the SAME commit. This suite proves:
 *
 * - flag OFF (production defaults): the accepted path stays byte-identical
 *   and the stored document carries NO factGuard key;
 * - flag ON: the fact-guard report rides the SAME commit — produced by a
 *   derivation only, ZERO new SQL (proven by the captured batch shape);
 * - the stored report's claims/counts describe the STORED document's own
 *   modelClaims exactly (the reader validates the REAL stored payload);
 * - the honesty boundary end-to-end: a claim whose wording hides the
 *   source's rumor language carries reviewRequired true WITHOUT any
 *   claim-status change (every stored claim stays `unverified`);
 * - flags never imply each other: fact-guard ON with matching/adjudication
 *   OFF stores ONLY the factGuard payload;
 * - replay stays free (no provider call) and byte-stable;
 * - a snapshot race writes NO draft and hence NO report.
 */

const NOW = 1_760_000_000_000;
const SOURCE_A = 'src-fg-a';

/** Module-level harness id counter — see createHarness (shared D1). */
let FG_ID_COUNTER = 0;

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
  readonly factGuardEnabled?: boolean;
  readonly matchingEnabled?: boolean;
  readonly adjudicationEnabled?: boolean;
  readonly captureBatches?: DbStatement[][];
  readonly providerDraft?: {
    readonly headlineFa: string;
    readonly summaryFa: string;
    readonly claims: readonly {
      readonly text: string;
      readonly evidenceIds?: readonly string[];
    }[];
  };
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
    batch: async (statements) => {
      options?.captureBatches?.push([...statements]);
      return rawExecutor.batch(statements);
    },
  };

  const fixedDraft = options?.providerDraft ?? {
    headlineFa: 'تیتر آزمایشی fact-guard',
    summaryFa: 'خلاصهٔ آزمایشی؛ فیکسچر آفلاین مسیر واقعی.',
    claims: [], // filled per-call with the evidence id
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
          const claims =
            fixedDraft.claims.length > 0
              ? fixedDraft.claims
              : [{ text: 'ادعای آزمایشی مرتبط با شاهد.', evidenceIds: [evidenceId] }];
          return {
            kind: 'ok',
            rawText: JSON.stringify({
              headlineFa: fixedDraft.headlineFa,
              summaryFa: fixedDraft.summaryFa,
              claims: claims.map((claim) => ({
                text: claim.text,
                evidenceIds: claim.evidenceIds ?? [evidenceId],
              })),
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
          ...(options?.factGuardEnabled === true ? { factGuard: { enabled: true } } : {}),
          ...(options?.matchingEnabled === true ? { matching: { enabled: true } } : {}),
          ...(options?.adjudicationEnabled === true ? { adjudication: { enabled: true } } : {}),
          nowMs: () => clock.now(),
          logger,
        }),
      ] as never),
      idGenerator: { newId: () => `fg-id-${(FG_ID_COUNTER += 1)}` },
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

/** Enqueue + dispatch + consume ONE item; returns the LAST stored draft. */
async function runItem(
  harness: ReturnType<typeof createHarness>,
  item: DemoItem,
  index: string,
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
  const action = await harness.engine.consumeMessage(`fg-msg-${index}`, envelope);
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

describe('fact guard — flag OFF keeps the accepted path byte-identical', () => {
  it('default options store NO factGuard key; the typed reader reads absent', async () => {
    const harness = createHarness();
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-fg-off1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر fact-guard خاموش',
      body: 'بدنهٔ دمو برای fact-guard خاموش.',
      url: 'https://example.com/fg-off1',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 'off1');
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(Object.hasOwn(document, 'factGuard')).toBe(false);
    expect(readFactGuardReport(document)).toEqual({ kind: 'absent' });
    // The sibling layer the report complements stays present and valid:
    expect(readEvidenceGuardReport(document).kind).toBe('guard_v1');
  });
});

describe('fact guard — the flag-gated payload on the REAL commit', () => {
  it('flag ON: the report rides INSIDE document_json of the SAME commit with ZERO new SQL', async () => {
    const batches: DbStatement[][] = [];
    const harness = createHarness({ factGuardEnabled: true, captureBatches: batches });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-fg-on1',
      sourceId: SOURCE_A,
      title: 'دمو: تیتر fact-guard روشن',
      body: 'شرکت سازنده اعلام کرد بازی «رستاخیز پیکسل» در تاریخ ۱۴۰۳/۰۹/۱۵ منتشر می‌شود.',
      url: 'https://example.com/fg-on1',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 'on1');
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(Object.hasOwn(document, 'factGuard')).toBe(true);

    // The stored payload reads as a REAL v1 report:
    const read = readFactGuardReport(document);
    expect(read.kind).toBe('fact_guard_v1');
    const report = read.kind === 'fact_guard_v1' ? read.report : null;
    expect(report).not.toBeNull();
    expect(report!.evaluationStatus).toBe('evaluated');
    expect(report!.snapshot.sourceItemId).toBe('item-fg-on1');

    // The report's claims describe the STORED document's OWN modelClaims:
    const modelClaims = document['modelClaims'] as readonly { text: string }[];
    expect(report!.counts.total).toBe(modelClaims.length);
    expect(report!.claims.map((c) => c.claimIndex)).toEqual(modelClaims.map((_, index) => index));

    // ZERO new SQL: the batch shape equality — the editorial commit batch
    // carries NO statement beyond the known editorial set (the same
    // statement set the flag-OFF path produces; only document_json CONTENT
    // differs, which is a parameter, never a new statement).
    const flagOffBatches: DbStatement[][] = [];
    const harnessOff = createHarness({ captureBatches: flagOffBatches });
    await seedSource(harnessOff.rawExecutor, 'src-fg-b', 'منبع ب');
    const itemOff = {
      id: 'item-fg-off2',
      sourceId: 'src-fg-b',
      title: 'دمو: تیتر مقایسهٔ شکل بچ',
      body: 'شرکت سازنده اعلام کرد بازی «رستاخیز پیکسل» در تاریخ ۱۴۰۳/۰۹/۱۵ منتشر می‌شود.',
      url: 'https://example.com/fg-off2',
    };
    await seedItem(harnessOff.rawExecutor, itemOff);
    await runItem(harnessOff, itemOff, 'off2');
    const onShape = batches
      .find((batch) => batch.some((s) => s.sql.includes('INSERT INTO drafts')))
      ?.map((s) => s.sql);
    const offShape = flagOffBatches
      .find((batch) => batch.some((s) => s.sql.includes('INSERT INTO drafts')))
      ?.map((s) => s.sql);
    expect(onShape).toBeDefined();
    expect(offShape).toBeDefined();
    expect(onShape).toEqual(offShape);
  });

  it('the honesty boundary END-TO-END: source rumor language hidden in the claim ⇒ reviewRequired true and EVERY stored claim stays unverified', async () => {
    const harness = createHarness({
      factGuardEnabled: true,
      providerDraft: {
        headlineFa: 'تیتر شایعهٔ پنهان',
        summaryFa: 'خلاصهٔ آزمایشی برای شایعهٔ پنهان.',
        claims: [], // per-call evidence id
      },
    });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-fg-rumor',
      sourceId: SOURCE_A,
      title: 'دمو: شایعهٔ پنهان',
      body: 'طبق شایعات، بازی «رستاخیز پیکسل» در سال ۲۰۲۵ عرضه می‌شود.',
      url: 'https://example.com/fg-rumor',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 'rumor');
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    const read = readFactGuardReport(document);
    expect(read.kind).toBe('fact_guard_v1');
    const report = read.kind === 'fact_guard_v1' ? read.report : null;
    expect(report).not.toBeNull();
    expect(report!.counts.claimsRequiringReview).toBeGreaterThan(0);
    expect(
      report!.claims.some((claim) =>
        claim.findings.some((f) => f.code === 'source_rumor_language_absent_from_claim'),
      ),
    ).toBe(true);

    // The structural honesty boundary: the fact guard NEVER rewrites the
    // stored claim statuses — every model claim stays exactly `unverified`.
    const modelClaims = document['modelClaims'] as readonly { status: string }[];
    expect(modelClaims.length).toBeGreaterThan(0);
    for (const claim of modelClaims) {
      expect(claim.status).toBe('unverified');
    }
    const facts = JSON.parse(
      (await harness.rawExecutor.first<{ facts_json: string }>({
        sql: 'SELECT facts_json FROM drafts ORDER BY rowid DESC LIMIT 1',
      }))!.facts_json,
    ) as readonly { status: string }[];
    for (const fact of facts) {
      expect(fact.status).toBe('unverified');
    }
  });

  it('flags never imply each other: fact-guard ON with matching/adjudication OFF stores ONLY factGuard', async () => {
    const harness = createHarness({ factGuardEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-fg-solo',
      sourceId: SOURCE_A,
      title: 'دمو: fact-guard تنها',
      body: 'بدنهٔ دمو برای fact-guard تنها.',
      url: 'https://example.com/fg-solo',
    };
    await seedItem(harness.rawExecutor, item);
    const draft = await runItem(harness, item, 'solo');
    const document = JSON.parse(draft.document_json) as Record<string, unknown>;
    expect(Object.hasOwn(document, 'factGuard')).toBe(true);
    expect(Object.hasOwn(document, 'candidateMatching')).toBe(false);
    expect(Object.hasOwn(document, 'candidateAdjudication')).toBe(false);
  });

  it('replay stays FREE (no provider call) and BYTE-STABLE with the flag ON', async () => {
    const harness = createHarness({ factGuardEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-fg-replay',
      sourceId: SOURCE_A,
      title: 'دمو: تکرار fact-guard',
      body: 'بدنهٔ دمو برای تکرار fact-guard با عدد ۲۲ ثابت.',
      url: 'https://example.com/fg-replay',
    };
    await seedItem(harness.rawExecutor, item);
    const enqueued = await enqueueEditorialPrepareDraft({
      engine: harness.engine,
      executor: harness.rawExecutor,
      sourceItemId: item.id,
    });
    expect(enqueued.kind).toBe('created');
    await harness.engine.dispatchDueJobs();
    await harness.engine.consumeMessage('fg-msg-replay1', harness.envelopes.shift());
    expect(harness.providerCalls).toHaveLength(1);
    const firstDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    expect(firstDraft).not.toBeNull();
    const firstDocumentJson = firstDraft!.document_json;
    expect(Object.hasOwn(JSON.parse(firstDocumentJson), 'factGuard')).toBe(true);

    // Replay: the SAME handler re-executed with NO provider ports AT ALL —
    // a replay must never need one (stable-result reuse path).
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
      factGuard: { enabled: true },
      nowMs: () => harness.clock.now(),
    });
    const replayOutcome = await replayHandler.execute({
      jobId: enqueued.kind === 'created' ? enqueued.jobId : '',
      generation: 1,
      payload: {
        sourceItemId: item.id,
        snapshotHash: await sha256Hex(`${item.id}\u001f${item.title}\u001f${item.body}`),
      },
    });
    expect(replayOutcome).toEqual({ kind: 'success' });
    expect(harness.providerCalls).toHaveLength(1); // NO new provider call
    const count = await harness.rawExecutor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM drafts',
    });
    expect(count?.n).toBe(1); // no duplicate draft
    const secondDraft = await harness.rawExecutor.first<{ document_json: string }>({
      sql: 'SELECT document_json FROM drafts',
    });
    expect(secondDraft!.document_json).toBe(firstDocumentJson); // byte-identical
  });

  it('a snapshot race writes NO draft and hence NO factGuard report', async () => {
    const harness = createHarness({ factGuardEnabled: true });
    await seedSource(harness.rawExecutor, SOURCE_A, 'منبع الف');
    const item = {
      id: 'item-fg-race',
      sourceId: SOURCE_A,
      title: 'دمو: مسابقهٔ اسنپ‌شات',
      body: 'بدنهٔ دمو برای مسابقهٔ اسنپ‌شات.',
      url: 'https://example.com/fg-race',
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

    // The item CHANGES under the job before it is consumed (the race):
    await env.DB.prepare('UPDATE source_items SET body_excerpt = ?, content_hash = ? WHERE id = ?')
      .bind('متن تغییر یافتهٔ مسابقه.', 'f'.repeat(64), item.id)
      .run();

    const action = await harness.engine.consumeMessage('fg-msg-race', envelope);
    expect(action).toMatchObject({ action: 'ack' });
    const draft = await harness.rawExecutor.first<{ id: string }>({
      sql: 'SELECT id FROM drafts',
    });
    expect(draft).toBeNull();
  });
});
