import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createMediaAssetStore } from '../../src/adapters/db/media-asset-store';
import {
  enqueuePublication,
  findPublicationById,
  listPublicationMediaUsages,
  listPublicationMessages,
  recordPublicationMediaUsages,
  recordPublicationMessage,
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
 * F2 — THE INDEPENDENT REVIEW (PIXEL_REVIEW_d65d811_FA.md, probe P1-2)
 * RED-FIRST FIX ROUND over REAL workerd D1: an album's delivery proof is
 * COMPLETE only when EVERY ordinal is recorded to the configured
 * destination AND the per-ordinal media usages are bound. A partial proof
 * NEVER heals to published and NEVER auto-resends — it parks uncertain for
 * the human dispositions with the partial records kept (the ADR-0032 gate,
 * now shape-aware). The old shape-blind heal (one witness ⇒ published,
 * pinned by the review as the defect) is corrected HERE.
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

const ALBUM_ITEMS = [
  { fileId: 'file-photo-1', canonicalUrl: 'https://media.example/i/1.jpg' },
  { fileId: 'file-photo-2', canonicalUrl: 'https://media.example/i/2.jpg' },
] as const;

async function insertAlbumDraft(id: string, storyId: string): Promise<void> {
  const document = JSON.stringify({
    schemaVersion: 1,
    media: 'album',
    items: ALBUM_ITEMS.map((item) => ({
      kind: 'photo',
      fileId: item.fileId,
      canonicalUrl: item.canonicalUrl,
    })),
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'album', 'آلبوم رسانه', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, document, NOW_MORNING, NOW_MORNING],
  });
}

async function seedTwoAssetAlbum(): Promise<void> {
  for (const [index, item] of ALBUM_ITEMS.entries()) {
    await executor.run({
      sql: `INSERT INTO media_assets (id, type, canonical_url, mime_type, rights_status,
              telegram_file_id, status, created_at, updated_at)
            VALUES (?, 'photo', ?, 'image/jpeg', 'official', ?, 'uploaded', ?, ?)`,
      params: [`a${index + 1}`, item.canonicalUrl, item.fileId, NOW_MORNING, NOW_MORNING],
    });
  }
}

async function enqueueAlbumPublication(publicationId: string, draftId: string): Promise<void> {
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

async function recordOrdinal(
  publicationId: string,
  ordinal: number,
  messageId: number,
  chatId: string = DESTINATION,
): Promise<void> {
  const recorded = await recordPublicationMessage(executor, {
    publicationId,
    chatId,
    messageId,
    textHash: null,
    nowMs: clock.now(),
    ordinal,
  });
  expect(recorded.kind).toBe('recorded');
}

function makeMediaTransport(): PublicationMediaGroupTransport & {
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    async sendMediaGroup() {
      calls.push({});
      return [{ messageId: 700 }, { messageId: 800 }];
    },
  };
}

function makeTextTransport(): PublicationChannelTransport & { calls: number } {
  const self: PublicationChannelTransport & { calls: number } = {
    calls: 0,
    async sendMessageRich() {
      self.calls += 1;
      return { messageId: 500 };
    },
  };
  return self;
}

function buildScheduler(
  transport: PublicationChannelTransport,
  mediaTransport?: PublicationMediaGroupTransport,
) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    ...(mediaTransport !== undefined
      ? { mediaTransport, mediaAssets: createMediaAssetStore(executor) }
      : {}),
    sendGate: { enabled: true },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
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

describe('F2: the album evidence heal is completeness-aware (ALL ordinals + destination + usages)', () => {
  it('a PARTIAL album proof (ordinal 0 of 2) parks uncertain — ZERO sends, never healed, never re-sent', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    await recordOrdinal('pub-1', 0, 555);

    const media = makeMediaTransport();
    const first = await buildScheduler(makeTextTransport(), media).scanDuePublications();

    // THE SAFE BEHAVIOR (the review probe asserted published/messages=1 on
    // the broken tree): the partial proof parks uncertain — no send.
    expect(first.details[0]).toMatchObject({
      publicationId: 'pub-1',
      outcome: 'failed_unconfirmed',
      code: 'album_evidence_incomplete',
    });
    expect(media.calls).toHaveLength(0);
    let row = await findPublicationById(executor, 'pub-1');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('album_evidence_incomplete');
    expect((await listPublicationMessages(executor, 'pub-1')).length).toBe(1);
    expect(await listPublicationMediaUsages(executor, 'pub-1')).toHaveLength(0);

    // A later scan NEVER auto-resends the partial album:
    clock.advance(60 * 60_000);
    const second = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(media.calls).toHaveLength(0);
    expect(second.details.map((detail) => detail.publicationId)).not.toContain('pub-1');
    row = await findPublicationById(executor, 'pub-1');
    expect(row?.status).toBe('failed');
  });

  it('a COMPLETE album proof (all ordinals + usages bound) still heals without any send', async () => {
    await insertStory('s2');
    await insertAlbumDraft('d2', 's2');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-2', 'd2');
    await recordOrdinal('pub-2', 0, 111);
    await recordOrdinal('pub-2', 1, 222);
    const bound = await recordPublicationMediaUsages(executor, {
      publicationId: 'pub-2',
      usages: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 1, mediaAssetId: 'a2' },
      ],
      nowMs: clock.now(),
    });
    expect(bound.kind).toBe('recorded');

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-2',
      outcome: 'healed_from_evidence',
    });
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-2');
    expect(row?.status).toBe('published');
  });

  it('complete ordinals with MISSING usages are reconciled during the heal (the honest ledger)', async () => {
    await insertStory('s3');
    await insertAlbumDraft('d3', 's3');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-3', 'd3');
    await recordOrdinal('pub-3', 0, 311);
    await recordOrdinal('pub-3', 1, 322);
    // The crash-after-delivery shape: the usages were never bound.

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-3',
      outcome: 'healed_from_evidence',
    });
    expect(media.calls).toHaveLength(0);
    const usages = await listPublicationMediaUsages(executor, 'pub-3');
    expect(usages.map((usage) => [usage.ordinal, usage.media_asset_id]).sort()).toEqual([
      [0, 'a1'],
      [1, 'a2'],
    ]);
    const row = await findPublicationById(executor, 'pub-3');
    expect(row?.status).toBe('published');
  });

  it('a delivery record to a FOREIGN destination is not a proof — the row parks uncertain', async () => {
    await insertStory('s4');
    await insertAlbumDraft('d4', 's4');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-4', 'd4');
    await recordOrdinal('pub-4', 0, 411, '@someone_else');
    await recordOrdinal('pub-4', 1, 422);

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-4',
      outcome: 'failed_unconfirmed',
      code: 'album_evidence_incomplete',
    });
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-4');
    expect(row?.status).toBe('failed');
  });

  it('Phase A reconciliation applies the SAME completeness rule to parked failed rows', async () => {
    await insertStory('s5');
    await insertAlbumDraft('d5', 's5');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-5-partial', 'd5');
    await recordOrdinal('pub-5-partial', 0, 511);
    // Park it failed WITHOUT a delivery proof beyond ordinal 0 (the parked
    // uncertain family the 8.2 machine holds for the human dispositions).
    await executor.run({
      sql: `UPDATE publications SET status = 'failed', last_error = 'telegram_timeout',
              lease_until = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`,
      params: [clock.now(), 'pub-5-partial'],
    });

    await insertStory('s5b');
    await insertAlbumDraft('d5b', 's5b');
    await enqueueAlbumPublication('pub-5-complete', 'd5b');
    await recordOrdinal('pub-5-complete', 0, 521);
    await recordOrdinal('pub-5-complete', 1, 522);
    await recordPublicationMediaUsages(executor, {
      publicationId: 'pub-5-complete',
      usages: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 1, mediaAssetId: 'a2' },
      ],
      nowMs: clock.now(),
    });
    // Park it failed too (the crash-before-terminal family): its evidence
    // is COMPLETE, so Phase A must heal it.
    await executor.run({
      sql: `UPDATE publications SET status = 'failed', last_error = 'delivery_record_rejected',
              lease_until = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`,
      params: [clock.now(), 'pub-5-complete'],
    });

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.uncertaintyHealed).toBe(1);
    expect(media.calls).toHaveLength(0);
    const partial = await findPublicationById(executor, 'pub-5-partial');
    expect(partial?.status).toBe('failed');
    const complete = await findPublicationById(executor, 'pub-5-complete');
    expect(complete?.status).toBe('published');
  });
});
