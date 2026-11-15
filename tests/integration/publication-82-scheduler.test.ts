import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  claimPublication,
  enqueuePublication,
  findPublicationById,
  listDuePublications,
  listPublicationMessages,
  recordPublicationMessage,
  releaseClaimed,
} from '../../src/adapters/db/publication-outbox-store';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import { contentTextHash } from '../../src/domain/publishing/publication-identity';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * Phase 8.2 — the DURABLE publication scheduler over REAL workerd D1 (the
 * blueprint-approved `publications` / `publication_messages` tables from
 * migration 0001 — consumed, ZERO DDL, schema stays 6).
 *
 * The ONLY artificial piece is the Telegram channel transport (the
 * ADR-0042 §6 seam discipline); the store, the state machine, the policy
 * context provider (real JOINs over stories/drafts), the reconciliation
 * logic and the whole durable state are the SHIPPED code.
 *
 * Proven here end-to-end:
 *  - enqueue: the blueprint §7 idempotency (UNIQUE derived key — a duplicate
 *    enqueue can never create a second publication for the same draft +
 *    destination) + the typed eligibility/mode/score validations;
 *  - the full happy path: due scan → atomic claim (the attempts generation
 *    fence) → the REAL 8.1 policy decision (psp1 over the provider's JOINed
 *    context) → the pre-send evidence check → the send → the message
 *    recorded (the at-most-once ledger with the content hash) → the fenced
 *    terminal;
 *  - THE ADR-0032 GATE: a recorded delivery heals a crashed claim WITHOUT a
 *    second send (the recorded sub-window of the ambiguous window is closed
 *    — stronger at-most-once protection than raw webhook responses);
 *  - the HONEST ambiguous window: an uncertain outcome is NEVER auto-resent
 *    and never lies about delivery;
 *  - 429: the retry honors the server's retry_after on the SAME row with
 *    the SAME idempotency key, bounded by the blueprint §7 attempt budget
 *    (3 normal / 5 P0) enforced AT the claim boundary (ADR-0037 lesson);
 *  - the hold family (4xx) never blind-retries;
 *  - eligibility lost → dead_letter (no send, no retry);
 *  - the policy defers: non-time-resolvable caps re-evaluate on a pinned
 *    interval with attempts RESTORED; the window gate defers to the exact
 *    next active window start;
 *  - the gate OFF: decision-only observation, zero durable writes;
 *  - a misconfigured enablement (gate ON, transport absent) is LOUD, zero
 *    writes;
 *  - the cross-publication UNIQUE(chat_id, message_id) guard: a forged
 *    reused message id can never be recorded twice — the honest outcome is
 *    uncertain, never a claimed published.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW_MORNING = 1_700_029_800_000;
/** Tehran 03:00:00 on 2023-11-15 — inside the quiet window (01:00–08:30). */
const NOW_QUIET = 1_700_004_600_000;

const DESTINATION = '@pixel_lores';

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

async function insertStory(id: string, contentType = 'industry'): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', ?, 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, contentType, NOW_MORNING, NOW_MORNING, NOW_MORNING, NOW_MORNING],
  });
}

let draftVersionCounter = 0;

async function insertDraft(
  id: string,
  storyId: string,
  options: { status?: string; layout?: string; headline?: string; version?: number } = {},
): Promise<void> {
  draftVersionCounter += 1;
  const document = {
    schemaVersion: 1,
    headlineFa: options.headline ?? 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  };
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', ?, ?, ?, '[]', '[]', ?, 'test', ?, ?)`,
    params: [
      id,
      storyId,
      options.status ?? 'approved',
      options.layout ?? 'standard',
      options.headline ?? 'تیتر خبر گیمینگ',
      JSON.stringify(document),
      options.version ?? draftVersionCounter,
      NOW_MORNING,
      NOW_MORNING,
    ],
  });
}

interface SendCall {
  readonly chatId: number | string;
  readonly text: string;
  readonly entityCount: number;
}

function makeTransport(
  handler: (
    call: number,
    input: { chatId: number | string; text: string },
  ) => Promise<number> | number,
): PublicationChannelTransport & { readonly calls: readonly SendCall[] } {
  const calls: SendCall[] = [];
  let count = 0;
  return {
    calls,
    async sendMessageRich(input) {
      count += 1;
      const callNumber = count;
      calls.push({
        chatId: input.chatId,
        text: input.content.text,
        entityCount: input.content.entities.length,
      });
      const messageId = await handler(callNumber, {
        chatId: input.chatId,
        text: input.content.text,
      });
      return { messageId };
    },
  };
}

function telegramErrorShape(code: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error('telegram failure') as Error & Record<string, unknown>;
  error.name = 'TelegramApiError';
  error.code = code;
  return Object.assign(error, extra) as Error;
}

function buildScheduler(transport: PublicationChannelTransport | undefined, gateEnabled: boolean) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    sendGate: { enabled: gateEnabled },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
  });
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM stories').run();
  clock = fixedClock(NOW_MORNING);
  draftVersionCounter = 0;
});

describe('publishing-82 scheduler: enqueue identity and validation', () => {
  it('creates exactly one pending row per draft+destination — the duplicate enqueue is absorbed', async () => {
    await insertStory('s1');
    await insertDraft('d1', 's1');
    const first = await enqueuePublication(executor, {
      publicationId: 'pub-1',
      draftId: 'd1',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    expect(first.kind).toBe('created');
    if (first.kind !== 'created') return;
    expect(first.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    const duplicate = await enqueuePublication(executor, {
      publicationId: 'pub-2',
      draftId: 'd1',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    expect(duplicate).toEqual({ kind: 'duplicate', publicationId: 'pub-1' });

    const row = await findPublicationById(executor, 'pub-1');
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.max_attempts).toBe(3);
    expect(row.priority).toBe(62);
    expect(row.story_id).toBe('s1');
    expect(row.idempotency_key).toBe(first.idempotencyKey);
    expect(row.lease_until).toBeNull();
  });

  it('the P0 attempt budget is pinned at enqueue (score >= 90 -> 5, else 3)', async () => {
    await insertStory('s-p0', 'breaking');
    await insertDraft('d-p0', 's-p0', { status: 'auto_approved' });
    const created = await enqueuePublication(executor, {
      publicationId: 'pub-p0',
      draftId: 'd-p0',
      destination: DESTINATION,
      priorityScore: 95,
      approvalMode: 'auto',
      nowMs: clock.now(),
    });
    expect(created.kind).toBe('created');
    const row = await findPublicationById(executor, 'pub-p0');
    expect(row?.max_attempts).toBe(5);
  });

  it('the typed enqueue rejections: unknown draft, unsendable status, mode mismatch, invalid score', async () => {
    await insertStory('s2');
    await insertDraft('d-rejected', 's2', { status: 'rejected' });
    await insertDraft('d-auto', 's2', { status: 'auto_approved' });
    await insertDraft('d-approved', 's2', { status: 'approved' });

    expect(
      await enqueuePublication(executor, {
        publicationId: 'pub-missing',
        draftId: 'no-such-draft',
        destination: DESTINATION,
        priorityScore: 62,
        approvalMode: 'safe_auto',
        nowMs: clock.now(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'draft_not_found' });

    expect(
      await enqueuePublication(executor, {
        publicationId: 'pub-rejected',
        draftId: 'd-rejected',
        destination: DESTINATION,
        priorityScore: 62,
        approvalMode: 'safe_auto',
        nowMs: clock.now(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'draft_not_sendable' });

    expect(
      await enqueuePublication(executor, {
        publicationId: 'pub-mode',
        draftId: 'd-auto',
        destination: DESTINATION,
        priorityScore: 62,
        approvalMode: 'approval',
        nowMs: clock.now(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'mode_status_mismatch' });

    expect(
      await enqueuePublication(executor, {
        publicationId: 'pub-score',
        draftId: 'd-approved',
        destination: DESTINATION,
        priorityScore: 101,
        approvalMode: 'safe_auto',
        nowMs: clock.now(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid_score' });
  });
});

describe('publishing-82 scheduler: the atomic claim and its generation fence', () => {
  it('claims a due row once — the second claim is not_claimable and the generation increments', async () => {
    await insertStory('s3');
    await insertDraft('d3', 's3');
    await enqueuePublication(executor, {
      publicationId: 'pub-claim',
      draftId: 'd3',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const first = await claimPublication(executor, {
      publicationId: 'pub-claim',
      nowMs: clock.now(),
      leaseMs: 60_000,
    });
    expect(first).toEqual({ kind: 'claimed', generation: 1 });
    const second = await claimPublication(executor, {
      publicationId: 'pub-claim',
      nowMs: clock.now(),
      leaseMs: 60_000,
    });
    expect(second).toEqual({ kind: 'not_claimable' });
    const row = await findPublicationById(executor, 'pub-claim');
    expect(row?.status).toBe('claimed');
    expect(row?.attempts).toBe(1);
    expect(row?.lease_until).toBe(clock.now() + 60_000);
  });

  it('a future run_after row is not claimable; a released row restores its attempts', async () => {
    await insertStory('s4');
    await insertDraft('d4', 's4');
    await enqueuePublication(executor, {
      publicationId: 'pub-future',
      draftId: 'd4',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const claimed = await claimPublication(executor, {
      publicationId: 'pub-future',
      nowMs: clock.now(),
      leaseMs: 60_000,
    });
    if (claimed.kind !== 'claimed') throw new Error('fixture claim must succeed');
    const released = await releaseClaimed(executor, {
      publicationId: 'pub-future',
      generation: claimed.generation,
      runAfterMs: clock.now() + 500_000,
      scheduledAtMs: clock.now() + 500_000,
      nowMs: clock.now(),
    });
    expect(released).toEqual({ kind: 'written' });
    const row = await findPublicationById(executor, 'pub-future');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.run_after).toBe(clock.now() + 500_000);
    expect(row?.scheduled_at).toBe(clock.now() + 500_000);
    expect(row?.lease_until).toBeNull();
    const due = await listDuePublications(executor, { nowMs: clock.now(), limit: 10 });
    expect(due.map((entry) => entry.id)).not.toContain('pub-future');
  });
});

describe('publishing-82 scheduler: the full happy path over the real policy', () => {
  it('due scan -> claim -> psp1 due-now -> pre-send evidence check -> send -> record -> published', async () => {
    await insertStory('s5');
    await insertDraft('d5', 's5');
    await enqueuePublication(executor, {
      publicationId: 'pub-happy',
      draftId: 'd5',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const transport = makeTransport(() => 101);
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();

    expect(report.gateEnabled).toBe(true);
    expect(report.decisionOnly).toBe(false);
    expect(report.misconfigured).toBe(false);
    expect(report.dueCount).toBe(1);
    expect(report.details).toHaveLength(1);
    expect(report.details[0]).toMatchObject({ publicationId: 'pub-happy', outcome: 'sent' });

    const row = await findPublicationById(executor, 'pub-happy');
    expect(row?.status).toBe('published');
    expect(row?.published_at).toBe(clock.now());
    expect(row?.attempts).toBe(1);
    expect(row?.lease_until).toBeNull();
    expect(row?.last_error).toBeNull();

    // The send carried the RENDERED editorial text with the bold headline entity.
    expect(transport.calls).toHaveLength(1);
    const sentCall = transport.calls[0];
    if (!sentCall) throw new Error('the send call must be recorded');
    expect(sentCall.chatId).toBe(DESTINATION);
    expect(sentCall.text).toContain('تیتر خبر گیمینگ');
    expect(sentCall.entityCount).toBe(1);

    // The at-most-once ledger: exactly one recorded message with the content hash.
    const messages = await listPublicationMessages(executor, 'pub-happy');
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (!message) throw new Error('the ledger row must exist');
    expect(message.chat_id).toBe(DESTINATION);
    expect(message.message_id).toBe(101);
    expect(message.ordinal).toBe(0);
    const expectedHash = await contentTextHash(sentCall.text);
    if (!expectedHash.ok) throw new Error('fixture hash must succeed');
    expect(message.text_hash).toBe(expectedHash.hash);
  });

  it('the recorded sub-window of the ambiguous window HEALS without a second send (ADR-0032 gate)', async () => {
    await insertStory('s6');
    await insertDraft('d6', 's6');
    await enqueuePublication(executor, {
      publicationId: 'pub-heal',
      draftId: 'd6',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    // Simulate the crashed generation: claimed, the send happened, the
    // message was recorded, the terminal write never landed.
    const claim = await claimPublication(executor, {
      publicationId: 'pub-heal',
      nowMs: clock.now(),
      leaseMs: 1_000,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture claim must succeed');
    const recorded = await recordPublicationMessage(executor, {
      publicationId: 'pub-heal',
      chatId: DESTINATION,
      messageId: 555,
      textHash: 'a'.repeat(64),
      nowMs: clock.now(),
    });
    expect(recorded).toEqual({ kind: 'recorded' });
    clock.advance(2_000); // the lease expires — the crash is durable

    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      return 999;
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();

    // The pre-send evidence check found the recorded delivery: healed, NOT re-sent.
    expect(report.details).toHaveLength(1);
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-heal',
      outcome: 'healed_from_evidence',
    });
    expect(sendCalls).toBe(0);
    const row = await findPublicationById(executor, 'pub-heal');
    expect(row?.status).toBe('published');
    expect(row?.attempts).toBe(2);
    const messages = await listPublicationMessages(executor, 'pub-heal');
    expect(messages).toHaveLength(1);
    const healMessage = messages[0];
    if (!healMessage) throw new Error('the healed ledger row must exist');
    expect(healMessage.message_id).toBe(555);
  });

  it('the ambiguous window WITHOUT evidence parks as failed-unconfirmed and is NEVER auto-resent', async () => {
    await insertStory('s7');
    await insertDraft('d7', 's7');
    await enqueuePublication(executor, {
      publicationId: 'pub-ambig',
      draftId: 'd7',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      throw telegramErrorShape('telegram_timeout');
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-ambig',
      outcome: 'failed_unconfirmed',
    });
    expect(sendCalls).toBe(1);

    // The schema's honest parking state: 'failed' with the classifier's
    // code in last_error (ADR-0058 pin — the status vocabulary has no
    // 'uncertain' value; the CODE carries the epistemic truth).
    const row = await findPublicationById(executor, 'pub-ambig');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('telegram_timeout');
    expect(row?.lease_until).toBeNull();

    // Later scans never re-send a parked row; with no evidence it stays parked.
    clock.advance(600_000);
    const later = await scheduler.scanDuePublications();
    expect(later.dueCount).toBe(0);
    expect(sendCalls).toBe(1);
    const still = await findPublicationById(executor, 'pub-ambig');
    expect(still?.status).toBe('failed');
  });

  it('the evidence reconciliation heals a parked row when delivery evidence exists', async () => {
    await insertStory('s8');
    await insertDraft('d8', 's8');
    await enqueuePublication(executor, {
      publicationId: 'pub-recon',
      draftId: 'd8',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const ambiguous = makeTransport(() => {
      throw telegramErrorShape('telegram_network_error');
    });
    const firstScheduler = buildScheduler(ambiguous, true);
    await firstScheduler.scanDuePublications();
    expect((await findPublicationById(executor, 'pub-recon'))?.status).toBe('failed');

    // Evidence appears (e.g. a repair path recorded the delivery proof):
    // the proof outranks the earlier inference.
    await recordPublicationMessage(executor, {
      publicationId: 'pub-recon',
      chatId: DESTINATION,
      messageId: 777,
      textHash: 'b'.repeat(64),
      nowMs: clock.now(),
    });
    const healingScheduler = buildScheduler(undefined, false);
    const report = await healingScheduler.scanDuePublications();
    expect(report.uncertaintyHealed).toBe(1);
    const row = await findPublicationById(executor, 'pub-recon');
    expect(row?.status).toBe('published');
  });
});

describe('publishing-82 scheduler: the retry budget and the honest failure families', () => {
  it('429 honors retry_after on the SAME row, bounded by the 3-attempt budget dead-lettered at the claim boundary', async () => {
    await insertStory('s9');
    await insertDraft('d9', 's9');
    await enqueuePublication(executor, {
      publicationId: 'pub-429',
      draftId: 'd9',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      throw telegramErrorShape('telegram_rate_limited', { retryAfterMs: 90_000 });
    });
    const scheduler = buildScheduler(transport, true);

    // Attempt 1: 429 -> retry_wait honoring the server's retry_after.
    const first = await scheduler.scanDuePublications();
    expect(first.details[0]).toMatchObject({
      publicationId: 'pub-429',
      outcome: 'retry_scheduled',
    });
    const afterFirst = await findPublicationById(executor, 'pub-429');
    expect(afterFirst?.status).toBe('retry_wait');
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.last_error).toBe('telegram_rate_limited');
    expect(afterFirst?.run_after).toBe(clock.now() + 90_000);

    // Attempt 2 (after the retry_after elapses): 429 again -> retry_wait.
    clock.advance(91_000);
    const second = await scheduler.scanDuePublications();
    expect(second.details[0]).toMatchObject({ outcome: 'retry_scheduled' });
    expect((await findPublicationById(executor, 'pub-429'))?.attempts).toBe(2);

    // Attempt 3 (the last for a non-P0 score): the retry decision itself
    // finds the budget spent (attempts 3 >= max 3) and dead-letters —
    // send calls stay at 3, no fourth attempt is ever possible.
    clock.advance(91_000);
    const third = await scheduler.scanDuePublications();
    expect(third.details[0]).toMatchObject({
      publicationId: 'pub-429',
      outcome: 'dead_lettered',
      code: 'attempt_budget_spent',
    });
    expect(sendCalls).toBe(3);
    const finalRow = await findPublicationById(executor, 'pub-429');
    expect(finalRow?.status).toBe('dead_letter');
    expect(finalRow?.last_error).toBe('attempt_budget_spent');
    expect(finalRow?.attempts).toBe(3);
    expect(finalRow?.lease_until).toBeNull();

    // The dead row is never due again; the same idempotency identity: the
    // retry loop never created a second row.
    clock.advance(91_000);
    const fourth = await scheduler.scanDuePublications();
    expect(fourth.dueCount).toBe(0);
    expect(sendCalls).toBe(3);
    const due = await listDuePublications(executor, { nowMs: clock.now(), limit: 10 });
    expect(due.map((entry) => entry.id)).not.toContain('pub-429');
  });

  it('the hold family (4xx) terminates as failed — no blind retry, one send ever', async () => {
    await insertStory('s10');
    await insertDraft('d10', 's10');
    await enqueuePublication(executor, {
      publicationId: 'pub-hold',
      draftId: 'd10',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      throw telegramErrorShape('telegram_bad_request');
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]).toMatchObject({ publicationId: 'pub-hold', outcome: 'failed_hold' });
    expect(sendCalls).toBe(1);
    const row = await findPublicationById(executor, 'pub-hold');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('telegram_bad_request');
    clock.advance(600_000);
    await scheduler.scanDuePublications();
    expect(sendCalls).toBe(1);
  });

  it('eligibility lost after enqueue dead-letters before any send', async () => {
    await insertStory('s11');
    await insertDraft('d11', 's11');
    await enqueuePublication(executor, {
      publicationId: 'pub-elig',
      draftId: 'd11',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    await executor.run({ sql: `UPDATE drafts SET status = 'rejected' WHERE id = 'd11'` });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      return 1;
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-elig',
      outcome: 'dead_lettered',
    });
    expect(sendCalls).toBe(0);
    const row = await findPublicationById(executor, 'pub-elig');
    expect(row?.status).toBe('dead_letter');
    expect(row?.last_error).toBe('eligibility_lost');
  });
});

describe('publishing-82 scheduler: the policy defers and the scan order', () => {
  it('a non-time-resolvable layout-cap block releases with attempts RESTORED and a pinned re-evaluation interval', async () => {
    // Seed three published posts of the SAME layout as the candidate: the
    // trailing-run cap (<=3) blocks the fourth — a NON-time-resolvable defer.
    const base = clock.now();
    await insertStory('ssame');
    for (let index = 0; index < 3; index += 1) {
      await insertDraft(`sd-${index}`, 'ssame', { layout: 'standard' });
      await executor.run({
        sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
                scheduled_at, run_after, published_at, attempts, max_attempts, idempotency_key,
                created_at, updated_at)
              VALUES (?, 'ssame', ?, 'published', 62, 'auto', ?, ?, ?, 1, 3, ?, ?, ?)`,
        params: [
          `seed-${index}`,
          `sd-${index}`,
          base - (index + 1) * 60_000,
          base - (index + 1) * 60_000,
          base - (index + 1) * 60_000,
          `seeded-${index}`,
          base - (index + 1) * 60_000 - 1_000,
          base - (index + 1) * 60_000,
        ],
      });
    }
    await insertStory('s12');
    await insertDraft('d12', 's12', { layout: 'standard' });
    await enqueuePublication(executor, {
      publicationId: 'pub-cap',
      draftId: 'd12',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      return 5;
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-cap',
      outcome: 'deferred_policy',
    });
    expect(sendCalls).toBe(0);
    const row = await findPublicationById(executor, 'pub-cap');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.scheduled_at).toBeNull();
    expect(row?.run_after).toBe(clock.now() + 10 * 60_000);
  });

  it('a quiet-hours P2 defers to the EXACT next active window start (time-resolvable)', async () => {
    clock = fixedClock(NOW_QUIET); // Tehran 03:00 — quiet
    await insertStory('s13');
    await insertDraft('d13', 's13');
    await enqueuePublication(executor, {
      publicationId: 'pub-window',
      draftId: 'd13',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      return 6;
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-window',
      outcome: 'deferred_time',
    });
    expect(sendCalls).toBe(0);
    const detail = report.details[0];
    if (!detail) throw new Error('the defer detail must exist');
    const dueAt = detail.dueAtMs;
    if (dueAt === undefined) throw new Error('a time-resolvable defer carries dueAtMs');
    // The next active window start after 03:00 Tehran is morning_scan 09:30
    // — 6.5 hours later exactly.
    expect(dueAt).toBe(clock.now() + 6.5 * 3_600_000);
    const row = await findPublicationById(executor, 'pub-window');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.scheduled_at).toBe(dueAt);
    expect(row?.run_after).toBe(dueAt);
  });

  it('the due scan orders by priority DESC then run_after ASC and honors the scan limit', async () => {
    await insertStory('so1');
    await insertDraft('d-p0', 'so1', { status: 'auto_approved' });
    await insertDraft('d-p1', 'so1', { status: 'auto_approved' });
    await insertDraft('d-p3', 'so1');
    await enqueuePublication(executor, {
      publicationId: 'ord-p0',
      draftId: 'd-p0',
      destination: DESTINATION,
      priorityScore: 95,
      approvalMode: 'auto',
      nowMs: clock.now(),
    });
    await enqueuePublication(executor, {
      publicationId: 'ord-p1',
      draftId: 'd-p1',
      destination: DESTINATION,
      priorityScore: 80,
      approvalMode: 'auto',
      nowMs: clock.now(),
    });
    await enqueuePublication(executor, {
      publicationId: 'ord-p3',
      draftId: 'd-p3',
      destination: DESTINATION,
      priorityScore: 10,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const scheduler = createPublicationScheduler({
      executor,
      destination: DESTINATION,
      transport: makeTransport(() => 8),
      sendGate: { enabled: true },
      contextProvider: createStoriesPolicyContextProvider(executor),
      clock,
      logger: silentLogger(),
      scanLimit: 2,
    });
    const report = await scheduler.scanDuePublications();
    expect(report.dueCount).toBe(3);
    expect(report.processed).toBe(2);
    // P0 first (no previous send: gap 0 -> sent), then P1 (latency jitter
    // puts it in the future: deferred_time). P3 is beyond the limit.
    expect(report.details[0]).toMatchObject({ publicationId: 'ord-p0', outcome: 'sent' });
    expect(report.details[1]).toMatchObject({ publicationId: 'ord-p1', outcome: 'deferred_time' });
    expect(report.details.map((detail) => detail.publicationId)).not.toContain('ord-p3');
  });
});

describe('publishing-82 scheduler: the gate, the misconfiguration and the stale lease', () => {
  it('the gate OFF is decision-only observation: zero durable writes, zero sends', async () => {
    await insertStory('s14');
    await insertDraft('d14', 's14');
    await enqueuePublication(executor, {
      publicationId: 'pub-gate',
      draftId: 'd14',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      return 9;
    });
    const scheduler = buildScheduler(transport, false);
    const report = await scheduler.scanDuePublications();
    expect(report.decisionOnly).toBe(true);
    expect(report.gateEnabled).toBe(false);
    expect(report.dueCount).toBe(1);
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-gate',
      outcome: 'decision_only',
    });
    expect(sendCalls).toBe(0);
    const row = await findPublicationById(executor, 'pub-gate');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.run_after).toBe(clock.now());
    expect(row?.lease_until).toBeNull();
  });

  it('a misconfigured enablement (gate ON, transport absent) is LOUD with zero writes', async () => {
    await insertStory('s15');
    await insertDraft('d15', 's15');
    await enqueuePublication(executor, {
      publicationId: 'pub-misconf',
      draftId: 'd15',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const scheduler = buildScheduler(undefined, true);
    const report = await scheduler.scanDuePublications();
    expect(report.misconfigured).toBe('transport_absent');
    expect(report.processed).toBe(0);
    const row = await findPublicationById(executor, 'pub-misconf');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
  });

  it('a stale claimed lease is reclaimed with attempts PRESERVED and then completed by the next generation', async () => {
    await insertStory('s16');
    await insertDraft('d16', 's16');
    await enqueuePublication(executor, {
      publicationId: 'pub-stale',
      draftId: 'd16',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    // A crashed claimer: claimed, never sent, the lease expires.
    const claim = await claimPublication(executor, {
      publicationId: 'pub-stale',
      nowMs: clock.now(),
      leaseMs: 1_000,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture claim must succeed');
    clock.advance(2_000);

    let sendCalls = 0;
    const transport = makeTransport(() => {
      sendCalls += 1;
      return 12;
    });
    const scheduler = buildScheduler(transport, true);
    const report = await scheduler.scanDuePublications();
    expect(report.reclaimed).toBe(1);
    expect(report.details[0]).toMatchObject({ publicationId: 'pub-stale', outcome: 'sent' });
    expect(sendCalls).toBe(1);
    const row = await findPublicationById(executor, 'pub-stale');
    expect(row?.status).toBe('published');
    expect(row?.attempts).toBe(2);
  });

  it('a forged reused message id can never be recorded twice — the honest outcome is uncertain', async () => {
    await insertStory('s17');
    await insertDraft('d-a', 's17');
    await insertDraft('d-b', 's17');
    await enqueuePublication(executor, {
      publicationId: 'pub-dup-a',
      draftId: 'd-a',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    await enqueuePublication(executor, {
      publicationId: 'pub-dup-b',
      draftId: 'd-b',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    // The first scan sends ONE of them (the anti-robot gap policy then
    // defers the other — a same-round second send is exactly what the
    // policy forbids); both transport calls return the SAME message id 777.
    const transport = makeTransport(() => 777);
    const scheduler = buildScheduler(transport, true);
    const firstReport = await scheduler.scanDuePublications();
    const firstOutcomes = firstReport.details.map((detail) => detail.outcome);
    expect(firstOutcomes).toContain('sent');

    // Advance past the gap band (the deferred row's run_after is at most
    // 45 min ahead; 50 min also stays inside the morning_scan window).
    clock.advance(50 * 60_000);
    const secondReport = await scheduler.scanDuePublications();
    const secondOutcomes = secondReport.details.map((detail) => detail.outcome);
    expect(secondOutcomes).toContain('failed_unconfirmed');

    // Final states: exactly one publication is published; the other's send
    // response carried a REUSED message id — the ledger rejected the record
    // and the row parked unconfirmed (never a claimed published).
    const first = await findPublicationById(executor, 'pub-dup-a');
    const second = await findPublicationById(executor, 'pub-dup-b');
    const publishedOnes = [first, second].filter((row) => row?.status === 'published');
    const parkedOnes = [first, second].filter((row) => row?.status === 'failed');
    expect(publishedOnes).toHaveLength(1);
    expect(parkedOnes).toHaveLength(1);
    expect(parkedOnes[0]?.last_error).toBe('delivery_record_rejected');
    const recordedTotal =
      (await listPublicationMessages(executor, 'pub-dup-a')).length +
      (await listPublicationMessages(executor, 'pub-dup-b')).length;
    expect(recordedTotal).toBe(1);
  });
});
