import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createMediaAssetStore } from '../../src/adapters/db/media-asset-store';
import {
  enqueuePublication,
  findPublicationById,
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
 * F3 — THE INDEPENDENT REVIEW (PIXEL_REVIEW_d65d811_FA.md, probe P1-3)
 * RED-FIRST FIX ROUND over REAL workerd D1: the SEND-TIME rights gate.
 * The ledger binding re-checks the durable rights echo at the moment of
 * publication: `blocked` (revoked) and `unknown` (never cleared) NEVER
 * pass — the publication dead-letters typed with ZERO media transport
 * calls. The affirmative clearances (official / licensed /
 * attribution_required) still send. A rights clearance recorded at
 * staging time is re-validated HERE — source officialness alone was never
 * a republish license, and the durable echo is what the gate trusts.
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

async function seedTwoAssetAlbum(rightsStatus: string): Promise<void> {
  for (const [index, item] of ALBUM_ITEMS.entries()) {
    await executor.run({
      sql: `INSERT INTO media_assets (id, type, canonical_url, mime_type, rights_status,
              telegram_file_id, status, created_at, updated_at)
            VALUES (?, 'photo', ?, 'image/jpeg', ?, ?, 'uploaded', ?, ?)`,
      params: [
        `a${index + 1}`,
        item.canonicalUrl,
        rightsStatus,
        item.fileId,
        NOW_MORNING,
        NOW_MORNING,
      ],
    });
  }
}

async function setAssetRights(assetId: string, rightsStatus: string): Promise<void> {
  await executor.run({
    sql: `UPDATE media_assets SET rights_status = ? WHERE id = ?`,
    params: [rightsStatus, assetId],
  });
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

function makeMediaTransport(): PublicationMediaGroupTransport & { readonly calls: unknown[] } {
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
  mediaTransport: PublicationMediaGroupTransport,
) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    mediaTransport,
    mediaAssets: createMediaAssetStore(executor),
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

describe('F3: the send-time rights gate — blocked and unknown never pass', () => {
  it('a BLOCKED rights asset (revoked at send time) dead-letters typed with ZERO media calls', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1');
    await seedTwoAssetAlbum('official');
    await setAssetRights('a1', 'blocked');
    await enqueueAlbumPublication('pub-1', 'd1');

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();

    // THE SAFE BEHAVIOR (the review probe asserted calls=1 + sent on the
    // broken tree): the gate refuses BEFORE any transport effect.
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-1',
      outcome: 'dead_lettered',
      code: 'media_rights_not_publishable',
    });
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-1');
    expect(row?.status).toBe('dead_letter');
    expect(row?.last_error).toBe('media_rights_not_publishable');
  });

  it('an UNKNOWN rights asset never passes the send gate', async () => {
    await insertStory('s2');
    await insertAlbumDraft('d2', 's2');
    await seedTwoAssetAlbum('unknown');
    await enqueueAlbumPublication('pub-2', 'd2');

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-2',
      outcome: 'dead_lettered',
      code: 'media_rights_not_publishable',
    });
    expect(media.calls).toHaveLength(0);
  });

  it('a revocation AFTER enqueue still stops the send (the re-check reads the ledger fresh)', async () => {
    await insertStory('s3');
    await insertAlbumDraft('d3', 's3');
    await seedTwoAssetAlbum('official');
    await enqueueAlbumPublication('pub-3', 'd3');
    // The revocation lands between the enqueue and the send:
    await setAssetRights('a2', 'blocked');

    const media = makeMediaTransport();
    const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-3',
      outcome: 'dead_lettered',
      code: 'media_rights_not_publishable',
    });
    expect(media.calls).toHaveLength(0);
  });

  it.each(['official', 'licensed', 'attribution_required'] as const)(
    'an affirmative clearance (%s) still publishes',
    async (rightsStatus) => {
      await insertStory(`s-ok-${rightsStatus}`);
      const draftId = `d-ok-${rightsStatus}`;
      const publicationId = `pub-ok-${rightsStatus}`;
      await insertAlbumDraft(draftId, `s-ok-${rightsStatus}`);
      await seedTwoAssetAlbum(rightsStatus);
      await enqueueAlbumPublication(publicationId, draftId);

      const media = makeMediaTransport();
      const report = await buildScheduler(makeTextTransport(), media).scanDuePublications();
      expect(report.details[0]).toMatchObject({
        publicationId,
        outcome: 'sent',
      });
      expect(media.calls).toHaveLength(1);
      const row = await findPublicationById(executor, publicationId);
      expect(row?.status).toBe('published');
    },
  );
});
