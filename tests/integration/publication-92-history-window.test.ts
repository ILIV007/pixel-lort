import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  enqueuePublication,
  findPublicationById,
  listRecentPublishedHistory,
} from '../../src/adapters/db/publication-outbox-store';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * publication-92 — THE RECENT-HISTORY WINDOW (the independent review
 * a279e13, finding 2, RED-first over REAL workerd D1): the store's
 * `listRecentPublishedHistory` ordered OLDEST-FIRST and then applied
 * LIMIT — after 512 publications the selection window held the OLDEST
 * rows and every NEW send fell outside it, so the scheduler's
 * cooldown/mix/layout policy consumed stale data (the review's 513-record
 * probe: the newest record was absent from the output). THE SAFE CONTRACT
 * pinned here:
 *  - the selection picks the NEWEST `limit` published records (the
 *    deterministic tie-break: published_at DESC, then id DESC at equal
 *    timestamps) and returns them OLDEST-FIRST — the consumer's expected
 *    order (the trail's last entry IS the previous send);
 *  - the time boundary is honest: a record newer than `nowMs` is never
 *    in the window; a record AT `nowMs` is;
 *  - the cooldown/mix consumer boundary: with 513 records where only the
 *    newest is recent, a due P2 candidate must be scheduled AFTER the
 *    newest send's gap floor (deferred_time, zero transport calls) —
 *    never sent immediately on a stale trail.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window. */
const NOW_MORNING = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const BASE = NOW_MORNING - 10_000;

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

async function insertDraft(id: string, storyId: string, layout: string): Promise<void> {
  const document = JSON.stringify({
    schemaVersion: 1,
    media: 'text',
    headline: 'سرITLE',
    body: 'متن',
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', ?, 'ت', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, layout, document, NOW_MORNING, NOW_MORNING],
  });
}

/**
 * The published-history seeder: one story + one draft carry the whole
 * trail (the history query JOINs both). Row n is published at BASE + n so
 * every row is distinct and the window's ends are exactly assertable.
 */
async function seedPublishedTrail(count: number, draftId: string, storyId: string): Promise<void> {
  await executor.run({
    sql: `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
          INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
            run_after, published_at, idempotency_key, created_at, updated_at)
          SELECT 'trail-' || n, ?, ?, 'published', 62, 'approval', 0, ? + n, 'idem-' || n, 0, 0
          FROM seq`,
    params: [count, storyId, draftId, BASE],
  });
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

describe('publication-92: the recent-history window selects the NEWEST records', () => {
  it('with 513 published records the window holds the newest 512 — the newest record is the LAST entry', async () => {
    await insertStory('hs');
    await insertDraft('hd', 'hs', 'album');
    await seedPublishedTrail(513, 'hd', 'hs');

    const history = await listRecentPublishedHistory(executor, {
      nowMs: NOW_MORNING,
      limit: 512,
    });
    expect(history).toHaveLength(512);
    // OLDEST-FIRST order preserved for the consumer...
    for (let index = 1; index < history.length; index += 1) {
      expect(history[index]!.publishedAtMs).toBeGreaterThan(history[index - 1]!.publishedAtMs);
    }
    // ...and the window ends are the NEWEST data: the first entry is the
    // oldest record of the SELECTED window (BASE+2 — the trail's row 1
    // fell out of the newest-512 window), the last entry is THE newest.
    expect(history[0]!.publishedAtMs).toBe(BASE + 2);
    expect(history.at(-1)!.publishedAtMs).toBe(BASE + 513);
  });

  it('with exactly 512 records every record is returned, oldest-first', async () => {
    await insertStory('hs');
    await insertDraft('hd', 'hs', 'album');
    await seedPublishedTrail(512, 'hd', 'hs');

    const history = await listRecentPublishedHistory(executor, {
      nowMs: NOW_MORNING,
      limit: 512,
    });
    expect(history).toHaveLength(512);
    expect(history[0]!.publishedAtMs).toBe(BASE + 1);
    expect(history.at(-1)!.publishedAtMs).toBe(BASE + 512);
  });

  it('equal timestamps break ties deterministically (id DESC selection, id ASC return)', async () => {
    await insertStory('ts');
    await insertDraft('td', 'ts', 'album');
    // Four records: one older + THREE sharing the newest timestamp. With
    // limit 2 the tie-break decides which two survive — pinned to the
    // id-greatest pair, returned id-ascending (a stable order for the
    // consumer, never engine-arbitrary).
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              run_after, published_at, idempotency_key, created_at, updated_at)
            VALUES ('tie-0', 'ts', 'td', 'published', 1, 'approval', 0, ?, 'idem-0', 0, 0)`,
      params: [BASE],
    });
    for (const [id, priority] of [
      ['tie-1', 11],
      ['tie-2', 12],
      ['tie-3', 13],
    ] as const) {
      await executor.run({
        sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
                run_after, published_at, idempotency_key, created_at, updated_at)
              VALUES (?, 'ts', 'td', 'published', ?, 'approval', 0, ?, 'idem-' || ?, 0, 0)`,
        params: [id, priority, BASE + 513, id],
      });
    }

    const history = await listRecentPublishedHistory(executor, {
      nowMs: NOW_MORNING,
      limit: 2,
    });
    expect(history.map((entry) => entry.priority)).toEqual([12, 13]);
    expect(history.at(-1)!.publishedAtMs).toBe(BASE + 513);
  });

  it('the time boundary: a record AT nowMs is in the window; a FUTURE record never is', async () => {
    await insertStory('bs');
    await insertDraft('bd', 'bs', 'album');
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              run_after, published_at, idempotency_key, created_at, updated_at)
            VALUES ('b-at', 'bs', 'bd', 'published', 30, 'approval', 0, ?, 'idem-at', 0, 0)`,
      params: [NOW_MORNING],
    });
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              run_after, published_at, idempotency_key, created_at, updated_at)
            VALUES ('b-future', 'bs', 'bd', 'published', 40, 'approval', 0, ?, 'idem-future', 0, 0)`,
      params: [NOW_MORNING + 1],
    });

    const history = await listRecentPublishedHistory(executor, {
      nowMs: NOW_MORNING,
      limit: 512,
    });
    expect(history.map((entry) => entry.priority)).toEqual([30]);
  });

  it('the consumer boundary: a due P2 candidate is scheduled AFTER the newest send, never sent on a stale trail', async () => {
    await insertStory('cs');
    await insertDraft('cd', 'cs', 'album');
    // 512 records 400h old (far outside the 168h mix window) + ONE newest
    // record 2 minutes old. The policy's previousSend MUST be the newest.
    await executor.run({
      sql: `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n <= 512)
            INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              run_after, published_at, idempotency_key, created_at, updated_at)
            SELECT 'old-' || n, 'cs', 'cd', 'published', 62, 'approval', 0,
              ? , 'idem-old-' || n, 0, 0 FROM seq`,
      params: [NOW_MORNING - 400 * 3_600_000],
    });
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              run_after, published_at, idempotency_key, created_at, updated_at)
            VALUES ('cs-newest', 'cs', 'cd', 'published', 62, 'approval', 0, ?,
              'idem-newest', 0, 0)`,
      params: [NOW_MORNING - 2 * 60_000],
    });

    // The due P2 text candidate (the 25–45 min NORMAL gap band applies).
    await insertStory('cand-s');
    await insertDraft('cand-d', 'cand-s', 'text');
    const created = await enqueuePublication(executor, {
      publicationId: 'cand-pub',
      draftId: 'cand-d',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    expect(created.kind).toBe('created');

    let sends = 0;
    const transport: PublicationChannelTransport & { calls: number } = {
      calls: 0,
      async sendMessageRich() {
        sends += 1;
        return { messageId: 900 };
      },
    };
    const report = await createPublicationScheduler({
      executor,
      destination: DESTINATION,
      transport,
      sendGate: { enabled: true },
      contextProvider: createStoriesPolicyContextProvider(executor),
      clock,
      logger: silentLogger(),
      scanLimit: 10,
    }).scanDuePublications();

    // THE SAFE SHAPE: the newest send is 2 minutes old — the NORMAL gap
    // band (25–45 min) puts the candidate's due time ~23–43 min ahead:
    // deferred_time, ZERO transport calls, the row released with a future
    // run_after. (The stale-trail shape sent immediately.)
    expect(report.details[0]).toMatchObject({
      publicationId: 'cand-pub',
      outcome: 'deferred_time',
    });
    const detail = report.details[0] as { readonly dueAtMs?: number };
    expect(detail.dueAtMs).toBeGreaterThanOrEqual(NOW_MORNING + 20 * 60_000);
    expect(sends).toBe(0);
    const row = await findPublicationById(executor, 'cand-pub');
    expect(row?.status).toBe('pending');
    expect(row?.run_after).toBeGreaterThanOrEqual(NOW_MORNING + 20 * 60_000);
  });
});
