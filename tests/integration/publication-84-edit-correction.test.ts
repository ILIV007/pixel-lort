import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  enqueuePublication,
  findPublicationById,
} from '../../src/adapters/db/publication-outbox-store';
import {
  findCorrectionAuditEvent,
  listActivePublicationsForStory,
  markDraftSuperseded,
  supersedePublicationById,
} from '../../src/adapters/db/publication-correction-store';
import {
  createEditCorrectionEngine,
  type CorrectionEditMessage,
  type PublicationEditTransport,
} from '../../src/application/publishing/edit-correction-engine';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
} from '../../src/application/publishing/scheduler';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * Phase 8.4 — the EDIT/CORRECTION workflow over REAL workerd D1. The store,
 * the lifecycle machine and the whole durable state are the SHIPPED code;
 * the ONLY artificial piece is the Telegram edit transport (the house seam
 * discipline).
 *
 * Proven here end-to-end:
 *  - the machine-legal supersede: pending/retry_wait/published/failed rows
 *    supersede; a claimed/publishing row (owned by an in-flight generation)
 *    is NOT supersedable; terminal rows are not supersedable; an unknown id
 *    is honest not_found;
 *  - the queued-on-supersede behavior: a superseded DRAFT leaves the
 *    sendable set, so the scheduler's eligibility check dead-letters its
 *    still-pending publication (eligibility_lost) — the old version can
 *    never reach the channel through the supersede path;
 *  - the correction engine, decision-only under the OFF gate: zero writes;
 *  - the LOUD misconfiguration: the gate ON with an edit disposition and
 *    no transport refuses with ZERO writes;
 *  - the follow-up application: the prior row supersedes, the prior draft
 *    supersedes, the deterministic link audit event is recorded once;
 *  - the edit application: per-recorded-message audit claimed BEFORE the
 *    transport (at-most-once per revision), the outcome recorded after;
 *    a re-invocation with the same revision is already_recorded and never
 *    re-calls the transport;
 *  - the honest outcomes: 429 is failed_proved (retryable — recorded, no
 *    auto-retry inside the engine), a timeout is uncertain (the edit MAY
 *    have applied — recorded, never re-applied automatically), a partial
 *    pass keeps per-message honesty.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW = 1_700_029_800_000;
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
    params: [id, `key-${id}`, contentType, NOW, NOW, NOW, NOW],
  });
}

let draftVersionCounter = 0;

async function insertDraft(
  id: string,
  storyId: string,
  options: { status?: string; version?: number } = {},
): Promise<void> {
  draftVersionCounter += 1;
  const document = {
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  };
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', 'standard', ?, ?, '[]', '[]', ?, 'test', ?, ?)`,
    params: [
      id,
      storyId,
      options.status ?? 'approved',
      'تیتر خبر گیمینگ',
      JSON.stringify(document),
      options.version ?? draftVersionCounter,
      NOW,
      NOW,
    ],
  });
}

async function insertPublication(
  id: string,
  storyId: string,
  draftId: string,
  status: string,
  publishedAtMs: number | null = null,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
            scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
            max_attempts, idempotency_key, last_error, created_at, updated_at)
          VALUES (?, ?, ?, ?, 62, 'safe_auto', NULL, ?, NULL, NULL, ?, 0, 3, ?, NULL, ?, ?)`,
    params: [id, storyId, draftId, status, NOW, publishedAtMs, `key-${id}`, NOW, NOW],
  });
}

async function insertRecordedMessage(
  publicationId: string,
  chatId: string,
  messageId: number,
  ordinal: number,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO publication_messages (publication_id, chat_id, message_id,
            media_group_id, ordinal, text_hash, created_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    params: [publicationId, chatId, messageId, ordinal, `hash-${publicationId}-${ordinal}`, NOW],
  });
}

async function auditRowCount(): Promise<number> {
  const row = await executor.first<{ readonly total: number }>({
    sql: `SELECT COUNT(*) AS total FROM audit_events`,
    params: [],
  });
  return row?.total ?? 0;
}

function telegramErrorShape(code: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error('telegram failure') as Error & Record<string, unknown>;
  error.name = 'TelegramApiError';
  error.code = code;
  return Object.assign(error, extra) as Error;
}

interface EditCall {
  readonly chatId: string;
  readonly messageId: number;
  readonly shape: 'text' | 'caption';
  readonly text: string;
}

function makeEditTransport(
  handler: (call: EditCall) => Promise<number>,
): PublicationEditTransport & { readonly calls: EditCall[] } {
  const calls: EditCall[] = [];
  return {
    calls,
    async editMessageTextRich(input) {
      const call = {
        chatId: String(input.chatId),
        messageId: input.messageId,
        shape: 'text' as const,
        text: input.content.text,
      };
      calls.push(call);
      return { messageId: await handler(call) };
    },
    async editMessageCaptionRich(input) {
      const call = {
        chatId: String(input.chatId),
        messageId: input.messageId,
        shape: 'caption' as const,
        text: input.caption.text,
      };
      calls.push(call);
      return { messageId: await handler(call) };
    },
  };
}

function buildEngine(transport: PublicationEditTransport | undefined, gateEnabled: boolean) {
  return createEditCorrectionEngine({
    executor,
    editTransport: transport,
    applyGate: { enabled: gateEnabled },
    clock,
    logger: silentLogger(),
  });
}

function textEdit(chatId: string, messageId: number, label: string): CorrectionEditMessage {
  return {
    chatId,
    messageId,
    shape: 'text',
    content: { kind: 'rich_text_v1', text: label, entities: [] },
  };
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM audit_events').run();
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM stories').run();
  clock = fixedClock(NOW);
});

describe('publication-84: the machine-legal supersede over the store', () => {
  it.each(['pending', 'retry_wait', 'published', 'failed'])(
    'supersedes a %s row',
    async (status) => {
      await insertStory('s1');
      await insertDraft('d1', 's1');
      await insertPublication('p1', 's1', 'd1', status, status === 'published' ? NOW : null);
      const outcome = await supersedePublicationById(executor, {
        publicationId: 'p1',
        nowMs: clock.now(),
      });
      expect(outcome).toEqual({ kind: 'superseded' });
      const row = await findPublicationById(executor, 'p1');
      expect(row?.status).toBe('superseded');
    },
  );

  it.each(['claimed', 'publishing', 'dead_letter', 'cancelled', 'superseded'])(
    'refuses to supersede a %s row',
    async (status) => {
      await insertStory('s1');
      await insertDraft('d1', 's1');
      await insertPublication('p1', 's1', 'd1', status, status === 'published' ? NOW : null);
      const outcome = await supersedePublicationById(executor, {
        publicationId: 'p1',
        nowMs: clock.now(),
      });
      expect(outcome).toEqual({ kind: 'not_supersedable' });
      const row = await findPublicationById(executor, 'p1');
      expect(row?.status).toBe(status);
    },
  );

  it('reports an unknown publication honestly as not_found', async () => {
    const outcome = await supersedePublicationById(executor, {
      publicationId: 'missing',
      nowMs: clock.now(),
    });
    expect(outcome).toEqual({ kind: 'not_found' });
  });

  it('lists only the supersedable active rows of a story, excluding the new one', async () => {
    await insertStory('s1');
    await insertDraft('d1', 's1');
    await insertStory('s2');
    await insertDraft('d2', 's2');
    await insertPublication('p-pending', 's1', 'd1', 'pending');
    await insertPublication('p-published', 's1', 'd1', 'published', NOW);
    await insertPublication('p-claimed', 's1', 'd1', 'claimed');
    await insertPublication('p-cancelled', 's1', 'd1', 'cancelled');
    await insertPublication('p-other-story', 's2', 'd2', 'pending');
    const rows = await listActivePublicationsForStory(executor, {
      storyId: 's1',
      excludePublicationId: 'p-new',
    });
    expect(rows.map((row) => row.id).sort()).toEqual(['p-pending', 'p-published']);
  });
});

describe('publication-84: the superseded draft loses eligibility (queued-on-supersede)', () => {
  it('dead-letters a still-pending publication once its draft is superseded', async () => {
    await insertStory('s1', 'official_news');
    await insertDraft('d1', 's1', { status: 'auto_approved' });
    const enqueued = await enqueuePublication(executor, {
      publicationId: 'p1',
      draftId: 'd1',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'auto',
      nowMs: clock.now(),
    });
    expect(enqueued.kind).toBe('created');

    const supersede = await markDraftSuperseded(executor, { draftId: 'd1', nowMs: clock.now() });
    expect(supersede).toEqual({ kind: 'superseded' });

    // The scheduler sees the superseded draft and dead-letters the row
    // (eligibility_lost) BEFORE any transport call.
    const sendAttempts: number[] = [];
    const scheduler = createPublicationScheduler({
      executor,
      destination: DESTINATION,
      transport: {
        async sendMessageRich() {
          sendAttempts.push(1);
          return { messageId: 1 };
        },
      },
      sendGate: { enabled: true },
      contextProvider: createStoriesPolicyContextProvider(executor),
      clock,
      logger: silentLogger(),
      scanLimit: 10,
    });
    await scheduler.scanDuePublications();
    expect(sendAttempts).toHaveLength(0);
    const row = await findPublicationById(executor, 'p1');
    expect(row?.status).toBe('dead_letter');
    expect(row?.last_error).toContain('eligibility_lost');
  });

  it('refuses to supersede a non-active draft and reports a missing draft', async () => {
    await insertStory('s1');
    await insertDraft('d-rejected', 's1', { status: 'rejected' });
    expect(
      await markDraftSuperseded(executor, { draftId: 'd-rejected', nowMs: clock.now() }),
    ).toEqual({ kind: 'not_supersedable' });
    expect(await markDraftSuperseded(executor, { draftId: 'missing', nowMs: clock.now() })).toEqual(
      { kind: 'not_found' },
    );
  });
});

describe('publication-84: the correction engine — gates and decision-only', () => {
  it('is decision-only under the OFF gate: the plan is reported, ZERO writes', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const engine = buildEngine(undefined, false);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-1',
      correctionClass: 'rumor_confirmed',
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 101, 'برچسب: تأیید شد')],
    });
    expect(report.applied).toBe(false);
    expect(report.refusal).toBeUndefined();
    expect(report.disposition).toBe('edit_and_follow_up');
    expect(report.supersededPublications).toEqual([]);
    expect(report.draftSuperseded).toBe(false);
    expect(report.edits).toEqual([]);
    expect(await auditRowCount()).toBe(0);
    const row = await findPublicationById(executor, 'p-old');
    expect(row?.status).toBe('published');
  });

  it('LOUD misconfiguration: gate ON with an edit disposition and no transport — zero writes', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-1',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 101, 'برچسب: تکذیب شد')],
    });
    expect(report.applied).toBe(false);
    expect(report.refusal).toBe('misconfigured_transport_absent');
    expect(await auditRowCount()).toBe(0);
    const row = await findPublicationById(executor, 'p-old');
    expect(row?.status).toBe('published');
  });

  it('refuses a not_supersedable plan with zero writes (in-flight prior)', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'claimed');
    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-1',
      correctionClass: 'meaningful_update',
      followUpMaterial: true,
      correctionFollowUpDesired: false,
    });
    expect(report.applied).toBe(false);
    expect(report.refusal).toBe('not_supersedable');
    expect(await auditRowCount()).toBe(0);
  });

  it('a none disposition writes nothing and reports honestly', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-1',
      correctionClass: 'minor_detail',
      followUpMaterial: true,
      correctionFollowUpDesired: true,
    });
    expect(report.applied).toBe(true);
    expect(report.disposition).toBe('none');
    expect(report.supersededPublications).toEqual([]);
    expect(report.edits).toEqual([]);
    expect(await auditRowCount()).toBe(0);
  });
});

describe('publication-84: the follow-up application', () => {
  it('supersedes the prior publication + draft and records the link audit once', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 72 * 3_600_000);
    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-follow-1',
      correctionClass: 'meaningful_update',
      followUpMaterial: true,
      correctionFollowUpDesired: false,
    });
    expect(report.applied).toBe(true);
    expect(report.disposition).toBe('follow_up');
    expect(report.supersededPublications).toEqual(['p-old']);
    expect(report.draftSuperseded).toBe(true);
    expect(report.auditLinkEventId).toMatch(/^link:1:[0-9a-f]{64}$/);
    expect(await findCorrectionAuditEvent(executor, report.auditLinkEventId)).not.toBeNull();

    const second = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-follow-1',
      correctionClass: 'meaningful_update',
      followUpMaterial: true,
      correctionFollowUpDesired: false,
    });
    // The prior row is now terminal-superseded; the re-run plans the
    // follow-up without a further supersede (prior_inactive) and the audit
    // link id is identical (deterministic) — absorbed as duplicate.
    expect(second.applied).toBe(true);
    expect(second.supersededPublications).toEqual([]);
    expect(second.auditLinkEventId).toBe(report.auditLinkEventId);
  });

  it('a stale-prior follow-up still supersedes a retry_wait row of the same story', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-retry', 's1', 'd-old', 'retry_wait');
    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-retry',
      revisionId: 'rev-follow-2',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: true,
    });
    expect(report.supersededPublications).toEqual(['p-retry']);
    expect(report.draftSuperseded).toBe(true);
  });
});

describe('publication-84: the edit application (at-most-once per revision)', () => {
  it('claims the audit before the transport and records the applied outcome', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    await insertRecordedMessage('p-old', DESTINATION, 102, 1);
    const transport = makeEditTransport(async () => 101);
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-1',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [
        textEdit(DESTINATION, 101, 'برچسب: تکذیب شد — متن اصلاح‌شده'),
        {
          chatId: DESTINATION,
          messageId: 102,
          shape: 'caption',
          content: { kind: 'rich_text_v1', text: 'برچسب: تکذیب شد — کپشن اصلاح‌شده', entities: [] },
        },
      ],
    });
    expect(report.applied).toBe(true);
    expect(report.edits.map((edit) => edit.outcome)).toEqual(['applied', 'applied']);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.shape).toBe('text');
    expect(transport.calls[1]?.shape).toBe('caption');
    for (const edit of report.edits) {
      expect(await findCorrectionAuditEvent(executor, edit.auditEventId)).not.toBeNull();
    }
    // An EDIT-ONLY correction keeps the row `published`: the delivery is
    // corrected in place, the ledger records the original delivery — the
    // supersede is reserved for rows a NEWER publication replaces.
    const row = await findPublicationById(executor, 'p-old');
    expect(row?.status).toBe('published');
  });

  it('a re-invocation with the same revision never re-calls the transport', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const transport = makeEditTransport(async () => 101);
    const engine = buildEngine(transport, true);
    const input = {
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-2',
      correctionClass: 'rumor_denied' as const,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 101, 'برچسب: تکذیب شد')],
    };
    const first = await engine.applyCorrection(input);
    expect(first.edits.map((edit) => edit.outcome)).toEqual(['applied']);
    const second = await engine.applyCorrection(input);
    expect(second.edits.map((edit) => edit.outcome)).toEqual(['already_recorded']);
    expect(transport.calls).toHaveLength(1);
  });

  it('429 is failed_proved (retryable, recorded) with NO auto-retry', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const transport = makeEditTransport(async () => {
      throw telegramErrorShape('telegram_rate_limited', { retryAfterMs: 5000 });
    });
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-3',
      correctionClass: 'rumor_confirmed',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 101, 'برچسب: تأیید شد')],
    });
    expect(report.edits).toHaveLength(1);
    expect(report.edits[0]?.outcome).toBe('failed_proved');
    expect(report.edits[0]?.code).toBe('telegram_rate_limited');
    expect(transport.calls).toHaveLength(1);
  });

  it('a timeout is uncertain: recorded, never re-applied automatically', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const transport = makeEditTransport(async () => {
      throw telegramErrorShape('telegram_timeout');
    });
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-4',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 101, 'برچسب: تکذیب شد')],
    });
    expect(report.edits[0]?.outcome).toBe('uncertain');
    // A second pass does NOT re-apply: the audit claim already exists.
    const second = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-4',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 101, 'برچسب: تکذیب شد')],
    });
    expect(second.edits[0]?.outcome).toBe('already_recorded');
    expect(transport.calls).toHaveLength(1);
  });

  it('a partial pass keeps per-message honesty (one applied, one uncertain)', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    await insertRecordedMessage('p-old', DESTINATION, 102, 1);
    const transport = makeEditTransport(async (call) => {
      if (call.messageId === 102) throw telegramErrorShape('telegram_timeout');
      return call.messageId;
    });
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-5',
      correctionClass: 'rumor_confirmed',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [
        textEdit(DESTINATION, 101, 'برچسب: تأیید شد'),
        textEdit(DESTINATION, 102, 'برچسب: تأیید شد'),
      ],
    });
    expect(report.edits.map((edit) => edit.outcome)).toEqual(['applied', 'uncertain']);
  });

  it('an edit targeting a message outside the recorded ledger is skipped without transport', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old', 'published', NOW - 60 * 60_000);
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    const transport = makeEditTransport(async () => 101);
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-edit-6',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [textEdit(DESTINATION, 999, 'برچسب: تکذیب شد')],
    });
    expect(report.edits).toEqual([
      { messageId: 999, outcome: 'not_recorded', auditEventId: '', code: 'message_not_in_ledger' },
    ]);
    expect(transport.calls).toHaveLength(0);
  });
});
