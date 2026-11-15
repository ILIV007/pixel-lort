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
 * publication-91 — THE ENGINE-LEVEL BINDING MATCH (the independent review
 * a279e13, finding 1, RED-first over REAL workerd D1): the review's probe
 * registered two correct delivery messages for a two-item album but bound
 * the media_usages SWAPPED (ordinal 0 -> asset 2, ordinal 1 -> asset 1);
 * the a279e13 scheduler promoted the row `published`/`healed_from_evidence`
 * with the wrong provenance — the evaluator counted the numbers and never
 * matched each bound asset against the plan. THE SAFE CONTRACT pinned here:
 *  - the heal demands the EXACT per-ordinal (ordinal -> media_asset_id)
 *    match against the plan-resolved ledger bindings — a mismatch parks
 *    the row uncertain (`album_usage_mismatch`), keeps the evidence
 *    INTACT (records AND the swapped usages stay — never rewritten), and
 *    NEVER auto-resends;
 *  - the same rule governs Phase A's failed-row reconcile;
 *  - the honest families keep their shapes: matching bindings heal,
 *    unbound usages reconcile from the ledger then heal;
 *  - the heal-moment rights re-check (the d65d811 F3 gate extended to the
 *    evidence path): a rights revocation AFTER delivery dead-letters
 *    typed, zero sends.
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

async function bindUsages(
  publicationId: string,
  usages: readonly { readonly ordinal: number; readonly mediaAssetId: string }[],
): Promise<void> {
  const bound = await recordPublicationMediaUsages(executor, {
    publicationId,
    usages: usages.map((usage) => ({ ordinal: usage.ordinal, mediaAssetId: usage.mediaAssetId })),
    nowMs: clock.now(),
  });
  expect(bound.kind).toBe('recorded');
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

describe('publication-91: the album heal verifies the per-ordinal asset binding (the a279e13 review)', () => {
  it('a SWAPPED usage binding parks uncertain — the evidence stays INTACT and nothing is re-sent', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    await recordOrdinal('pub-1', 0, 601);
    await recordOrdinal('pub-1', 1, 602);
    await bindUsages('pub-1', [
      { ordinal: 0, mediaAssetId: 'a2' },
      { ordinal: 1, mediaAssetId: 'a1' },
    ]);

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();

    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-1',
      outcome: 'failed_unconfirmed',
      code: 'album_usage_mismatch',
    });
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-1');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('album_usage_mismatch');

    // THE EVIDENCE STAYS INTACT: both delivery records AND the swapped
    // usages survive untouched — the human dispositions own the proof,
    // the machine never rewrites it into a lie.
    const messages = await listPublicationMessages(executor, 'pub-1');
    expect(messages.map((message) => message.ordinal).sort()).toEqual([0, 1]);
    const usages = await listPublicationMediaUsages(executor, 'pub-1');
    expect(usages.map((usage) => [usage.ordinal, usage.media_asset_id]).sort()).toEqual([
      [0, 'a2'],
      [1, 'a1'],
    ]);
  });

  it('a later scan NEVER auto-resends the mismatched album and never rewrites the evidence', async () => {
    await insertStory('s2');
    await insertAlbumDraft('d2', 's2');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-2', 'd2');
    await recordOrdinal('pub-2', 0, 611);
    await recordOrdinal('pub-2', 1, 612);
    await bindUsages('pub-2', [
      { ordinal: 0, mediaAssetId: 'a2' },
      { ordinal: 1, mediaAssetId: 'a1' },
    ]);

    const media = makeMediaTransport();
    await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(media.calls).toHaveLength(0);

    clock.advance(60 * 60_000);
    const second = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(media.calls).toHaveLength(0);
    expect(second.details.map((detail) => detail.publicationId)).not.toContain('pub-2');
    const row = await findPublicationById(executor, 'pub-2');
    expect(row?.status).toBe('failed');
    const usages = await listPublicationMediaUsages(executor, 'pub-2');
    expect(usages.map((usage) => [usage.ordinal, usage.media_asset_id]).sort()).toEqual([
      [0, 'a2'],
      [1, 'a1'],
    ]);
  });

  it('matching bindings still heal from the evidence without any send (the honest family)', async () => {
    await insertStory('s3');
    await insertAlbumDraft('d3', 's3');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-3', 'd3');
    await recordOrdinal('pub-3', 0, 621);
    await recordOrdinal('pub-3', 1, 622);
    await bindUsages('pub-3', [
      { ordinal: 0, mediaAssetId: 'a1' },
      { ordinal: 1, mediaAssetId: 'a2' },
    ]);

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-3',
      outcome: 'healed_from_evidence',
    });
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-3');
    expect(row?.status).toBe('published');
  });

  it('complete ordinals with MISSING usages are still reconciled from the ledger then healed', async () => {
    await insertStory('s4');
    await insertAlbumDraft('d4', 's4');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-4', 'd4');
    await recordOrdinal('pub-4', 0, 631);
    await recordOrdinal('pub-4', 1, 632);
    // The crash-after-delivery shape: the usages were never bound.

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-4',
      outcome: 'healed_from_evidence',
    });
    expect(media.calls).toHaveLength(0);
    const usages = await listPublicationMediaUsages(executor, 'pub-4');
    expect(usages.map((usage) => [usage.ordinal, usage.media_asset_id]).sort()).toEqual([
      [0, 'a1'],
      [1, 'a2'],
    ]);
    const row = await findPublicationById(executor, 'pub-4');
    expect(row?.status).toBe('published');
  });

  it('Phase A applies the SAME binding-match rule: a parked failed album with swapped usages stays failed', async () => {
    await insertStory('s5');
    await insertAlbumDraft('d5', 's5');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-5', 'd5');
    await recordOrdinal('pub-5', 0, 641);
    await recordOrdinal('pub-5', 1, 642);
    await bindUsages('pub-5', [
      { ordinal: 0, mediaAssetId: 'a2' },
      { ordinal: 1, mediaAssetId: 'a1' },
    ]);
    // Park it failed (the crash-before-terminal family the 8.2 machine
    // holds for the human dispositions).
    await executor.run({
      sql: `UPDATE publications SET status = 'failed', last_error = 'telegram_timeout',
              lease_until = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`,
      params: [clock.now(), 'pub-5'],
    });

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.uncertaintyHealed).toBe(0);
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-5');
    expect(row?.status).toBe('failed');
    const usages = await listPublicationMediaUsages(executor, 'pub-5');
    expect(usages.map((usage) => [usage.ordinal, usage.media_asset_id]).sort()).toEqual([
      [0, 'a2'],
      [1, 'a1'],
    ]);
  });

  it('a rights revocation AFTER the delivery records dead-letters at the heal moment — zero sends', async () => {
    await insertStory('s6');
    await insertAlbumDraft('d6', 's6');
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-6', 'd6');
    await recordOrdinal('pub-6', 0, 651);
    await recordOrdinal('pub-6', 1, 652);
    await bindUsages('pub-6', [
      { ordinal: 0, mediaAssetId: 'a1' },
      { ordinal: 1, mediaAssetId: 'a2' },
    ]);
    // The revocation lands AFTER the honest delivery + binding — the heal
    // must re-read the durable rights echo AT the verification moment
    // (the d65d811 F3 gate, extended to the evidence path).
    await executor.run({
      sql: `UPDATE media_assets SET rights_status = 'blocked', updated_at = ? WHERE id = 'a1'`,
      params: [clock.now()],
    });

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-6',
      outcome: 'dead_lettered',
      code: 'media_rights_not_publishable',
    });
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-6');
    expect(row?.status).toBe('dead_letter');
    // The delivery evidence survives the dead-letter (never destroyed).
    const messages = await listPublicationMessages(executor, 'pub-6');
    expect(messages).toHaveLength(2);
  });
});
