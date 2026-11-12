import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createMediaAssetStore } from '../../src/adapters/db/media-asset-store';
import {
  claimPublication,
  enqueuePublication,
  findPublicationById,
  listPublicationMessages,
  markClaimedSendStarted,
  recordPublicationMessage,
  SEND_MAY_HAVE_STARTED_ERROR,
} from '../../src/adapters/db/publication-outbox-store';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
  type PublicationMediaGroupTransport,
} from '../../src/application/publishing/scheduler';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * F1 — THE INDEPENDENT REVIEW (PIXEL_REVIEW_d65d811_FA.md, probe P1-1)
 * RED-FIRST FIX ROUND over REAL workerd D1: a send whose claim lease
 * expires while the transport call is in flight can NEVER be re-sent by a
 * concurrent generation. The durable send-started state (the machine's
 * `mark_send_started`: claimed -> publishing, fenced by the generation,
 * with the in-flight lease extension) makes the reclaim SAFE:
 *
 *  - a row still 'claimed' with an expired lease is PROVABLY pre-send
 *    (the send-started write never landed) — the reclaim returns it to
 *    pending and the next generation sends (the crashed-claimer path,
 *    preserved);
 *  - a row 'publishing' with an expired IN-FLIGHT lease is the AMBIGUOUS
 *    window — the scan parks it failed (`send_may_have_started`) for the
 *    human dispositions; it is NEVER auto-resent; a recorded delivery
 *    proof still heals it honestly (Phase A);
 *  - while the send is in flight (the lease extended), a concurrent scan
 *    can neither reclaim nor re-send: exactly ONE transport call.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window. */
const NOW_MORNING = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

async function insertStory(id: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, NOW_MORNING, NOW_MORNING, NOW_MORNING, NOW_MORNING],
  });
}

async function insertTextDraft(id: string, storyId: string): Promise<void> {
  const document = JSON.stringify({
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', 'standard', 'تیتر خبر گیمینگ', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, 'approved', document, NOW_MORNING, NOW_MORNING],
  });
}

async function enqueueTextPublication(publicationId: string, draftId: string): Promise<void> {
  const created = await enqueuePublication(executor, {
    publicationId,
    draftId,
    destination: DESTINATION,
    priorityScore: 62,
    approvalMode: 'safe_auto',
    nowMs: clock.now(),
  });
  expect(created.kind).toBe('created');
}

interface DeferredTransport {
  readonly transport: PublicationChannelTransport & { readonly calls: number };
  readonly callStarted: Promise<void>;
  finishCall(call: number, messageId: number): void;
  failCall(call: number, error: Error): void;
}

/** A transport whose every call is held until the test releases (or breaks) it. */
function makeDeferredTransport(): DeferredTransport {
  let calls = 0;
  const pending = new Map<number, { resolve: (id: number) => void; reject: (e: Error) => void }>();
  let notifyStart!: () => void;
  const callStarted = new Promise<void>((resolve) => {
    notifyStart = resolve;
  });
  const transport = {
    get calls() {
      return calls;
    },
    async sendMessageRich(): Promise<{ readonly messageId: number }> {
      calls += 1;
      const call = calls;
      notifyStart();
      return new Promise<{ readonly messageId: number }>((resolve, reject) => {
        pending.set(call, {
          resolve: (id) => resolve({ messageId: id }),
          reject,
        });
      });
    },
  };
  return {
    transport: transport as PublicationChannelTransport & { readonly calls: number },
    callStarted,
    finishCall(call, messageId) {
      pending.get(call)?.resolve(messageId);
      pending.delete(call);
    },
    failCall(call, error) {
      pending.get(call)?.reject(error);
      pending.delete(call);
    },
  };
}

function buildScheduler(transport: PublicationChannelTransport) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    sendGate: { enabled: true },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
  });
}

function telegramTimeoutError(): Error {
  const error = new Error('telegram timeout') as Error & Record<string, unknown>;
  error.name = 'TelegramApiError';
  error.code = 'telegram_timeout';
  return error;
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM media_usages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM media_assets').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM stories').run();
  clock = fixedClock(NOW_MORNING);
});

describe('F1: the in-flight send is never re-sent (the durable send-started state)', () => {
  it('a concurrent scan during an in-flight text send performs ZERO extra transport calls', async () => {
    await insertStory('s1');
    await insertTextDraft('d1', 's1');
    await enqueueTextPublication('pub-1', 'd1');

    const deferred = makeDeferredTransport();
    const scheduler = buildScheduler(deferred.transport);

    const first = scheduler.scanDuePublications();
    await deferred.callStarted;
    // The first generation has claimed AND marked the send started; the
    // transport call is hanging. Advance past the ORIGINAL claim lease:
    clock.advance(61_000);
    const second = await scheduler.scanDuePublications();

    // THE SAFE BEHAVIOR (the review probe asserted calls=2 on the broken tree):
    expect(deferred.transport.calls).toBe(1);
    expect(second.details.map((detail) => detail.outcome)).not.toContain('sent');

    // The first generation completes honestly: published exactly once.
    deferred.finishCall(1, 9001);
    const firstReport = await first;
    expect(firstReport.details[0]).toMatchObject({ publicationId: 'pub-1', outcome: 'sent' });
    const row = await findPublicationById(executor, 'pub-1');
    expect(row?.status).toBe('published');
    const ledger = await listPublicationMessages(executor, 'pub-1');
    expect(ledger.map((entry) => entry.message_id)).toEqual([9001]);
  });

  it('the same guard holds on the ALBUM path (one media-group call, no second send)', async () => {
    await insertStory('s2');
    const document = JSON.stringify({
      schemaVersion: 1,
      media: 'album',
      items: [
        { kind: 'photo', fileId: 'file-a', canonicalUrl: 'https://media.example/i/a.jpg' },
        { kind: 'photo', fileId: 'file-b', canonicalUrl: 'https://media.example/i/b.jpg' },
      ],
    });
    await executor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, version, created_by, created_at, updated_at)
            VALUES (?, ?, 'approved', 'fa', 'album', 'آلبوم', ?, '[]', '[]', 1, 'test', ?, ?)`,
      params: ['d2', 's2', document, NOW_MORNING, NOW_MORNING],
    });
    for (const [id, url, fileId] of [
      ['a1', 'https://media.example/i/a.jpg', 'file-a'],
      ['a2', 'https://media.example/i/b.jpg', 'file-b'],
    ] as const) {
      await executor.run({
        sql: `INSERT INTO media_assets (id, type, canonical_url, mime_type, rights_status,
                telegram_file_id, status, created_at, updated_at)
              VALUES (?, 'photo', ?, 'image/jpeg', 'official', ?, 'uploaded', ?, ?)`,
        params: [id, url, fileId, NOW_MORNING, NOW_MORNING],
      });
    }
    await enqueueTextPublication('pub-2', 'd2');

    let mediaCalls = 0;
    let releaseMedia!: (messages: readonly { messageId: number }[]) => void;
    const mediaTransport: PublicationMediaGroupTransport = {
      async sendMediaGroup() {
        mediaCalls += 1;
        return new Promise<readonly { readonly messageId: number }[]>((resolve) => {
          releaseMedia = resolve;
        });
      },
    };
    const scheduler = createPublicationScheduler({
      executor,
      destination: DESTINATION,
      transport: {
        async sendMessageRich() {
          throw new Error('the album path must not use the text transport');
        },
      },
      mediaTransport,
      mediaAssets: createMediaAssetStore(executor),
      sendGate: { enabled: true },
      contextProvider: createStoriesPolicyContextProvider(executor),
      clock,
      logger: silentLogger(),
      scanLimit: 10,
    });

    const first = scheduler.scanDuePublications();
    // Wait until the durable send-started marker has landed (the row is
    // 'publishing' and the media call is hanging).
    await vi.waitFor(async () => {
      const row = await findPublicationById(executor, 'pub-2');
      expect(row?.status).toBe('publishing');
      expect(mediaCalls).toBe(1);
    });
    clock.advance(61_000);
    const second = await scheduler.scanDuePublications();
    expect(mediaCalls).toBe(1);
    expect(second.details.map((detail) => detail.outcome)).not.toContain('sent');
    releaseMedia([{ messageId: 700 }, { messageId: 800 }]);
    const firstReport = await first;
    expect(firstReport.details[0]).toMatchObject({ outcome: 'sent' });
    const ledger = await listPublicationMessages(executor, 'pub-2');
    expect(ledger).toHaveLength(2);
  });

  it('a crashed IN-FLIGHT generation (expired extended lease) parks uncertain and is NEVER auto-resent', async () => {
    await insertStory('s3');
    await insertTextDraft('d3', 's3');
    await enqueueTextPublication('pub-3', 'd3');

    const deferred = makeDeferredTransport();
    const scheduler = buildScheduler(deferred.transport);

    const first = scheduler.scanDuePublications();
    await deferred.callStarted;
    // The in-flight window: the extended lease covers the send; advancing
    // past IT (10 minutes) simulates the crashed generation.
    clock.advance(10 * 60_000 + 1_000);
    await scheduler.scanDuePublications();
    expect(deferred.transport.calls).toBe(1);
    const parkedRow = await findPublicationById(executor, 'pub-3');
    expect(parkedRow?.status).toBe('failed');
    expect(parkedRow?.last_error).toBe(SEND_MAY_HAVE_STARTED_ERROR);

    // The hung generation's late failure cannot un-park or re-send.
    deferred.failCall(1, telegramTimeoutError());
    const lateReport = await first;
    expect(lateReport.details[0]?.outcome).toBe('fence_rejected');

    // Further scans NEVER auto-resend the unknown outcome (no evidence):
    clock.advance(60 * 60_000);
    const later = await scheduler.scanDuePublications();
    expect(deferred.transport.calls).toBe(1);
    expect(later.details.map((detail) => detail.publicationId)).not.toContain('pub-3');
    const still = await findPublicationById(executor, 'pub-3');
    expect(still?.status).toBe('failed');
  });

  it('a parked send-may-have-started row WITH recorded delivery evidence heals to published without any send', async () => {
    await insertStory('s4');
    await insertTextDraft('d4', 's4');
    await enqueueTextPublication('pub-4', 'd4');

    // The REAL crash-after-record shape: claim, mark the send started, the
    // ledger records the delivery, THEN the generation dies before the
    // terminal write.
    const claim = await claimPublication(executor, {
      publicationId: 'pub-4',
      nowMs: clock.now(),
      leaseMs: 60_000,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture claim must succeed');
    const started = await markClaimedSendStarted(executor, {
      publicationId: 'pub-4',
      generation: claim.generation,
      nowMs: clock.now(),
      leaseMs: 10 * 60_000,
    });
    expect(started.kind).toBe('marked');
    const recorded = await recordPublicationMessage(executor, {
      publicationId: 'pub-4',
      chatId: DESTINATION,
      messageId: 4321,
      textHash: null,
      nowMs: clock.now(),
    });
    expect(recorded.kind).toBe('recorded');

    // The in-flight lease expires (the crash) — the next scan parks, then
    // the EVIDENCE (the recorded proof) heals honestly. ZERO sends.
    clock.advance(11 * 60_000);
    let sends = 0;
    const countingTransport: PublicationChannelTransport = {
      async sendMessageRich() {
        sends += 1;
        return { messageId: 5999 };
      },
    };
    const report = await buildScheduler(countingTransport).scanDuePublications();
    expect(sends).toBe(0);
    expect(report.details.map((detail) => detail.outcome)).not.toContain('sent');
    const row = await findPublicationById(executor, 'pub-4');
    expect(row?.status).toBe('published');
    const ledger = await listPublicationMessages(executor, 'pub-4');
    expect(ledger.map((entry) => entry.message_id)).toEqual([4321]);
  });

  it('a claimed row that expired BEFORE the send (no send-started marker) still reclaims and sends', async () => {
    await insertStory('s5');
    await insertTextDraft('d5', 's5');
    await enqueueTextPublication('pub-5', 'd5');

    // The crashed-claimer fixture: claimed, never sent, the lease expires.
    const claim = await claimPublication(executor, {
      publicationId: 'pub-5',
      nowMs: clock.now(),
      leaseMs: 1_000,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture claim must succeed');
    clock.advance(2_000);

    let sends = 0;
    const countingTransport: PublicationChannelTransport = {
      async sendMessageRich() {
        sends += 1;
        return { messageId: 5100 };
      },
    };
    const report = await buildScheduler(countingTransport).scanDuePublications();
    expect(report.reclaimed).toBe(1);
    expect(report.details[0]).toMatchObject({ publicationId: 'pub-5', outcome: 'sent' });
    expect(sends).toBe(1);
    const row = await findPublicationById(executor, 'pub-5');
    expect(row?.status).toBe('published');
    expect(row?.attempts).toBe(2);
  });
});
