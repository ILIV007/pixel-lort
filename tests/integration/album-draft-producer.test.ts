import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  produceAlbumDraft,
  enqueueAlbumDraft,
} from '../../src/application/publishing/album-draft-producer';
import { readAlbumContentDocumentV1 } from '../../src/domain/media/album-content';
import { discriminateAlbumDocument } from '../../src/domain/media/album-send-plan';
import {
  createRichTextEnvelope,
  serializeRichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import { createLogger } from '../../src/observability/logger';

/**
 * The ALBUM DRAFT PRODUCER (the documented carry of ADR-0060 closed): the
 * editorial flow that turns a story's media candidates into a DURABLE
 * album draft the publication scheduler's album branch can consume.
 *
 * THE SAFE CONTRACT pinned here (the owner priority: media safety and
 * rights before every send path; never forge a license; never mint an
 * approval):
 *  - the producer is LEDGER-BOUND: every plan item must resolve to an
 *    UPLOADED media_assets row whose durable state still supports it
 *    (the SAME resolveAssetReuse predicate the send path enforces —
 *    uploaded + PUBLICATION_MEDIA_RIGHTS_V1 + the kind match); there is
 *    NO fetch, NO staging, NO transport, NO license invented;
 *  - ALL-OR-NOTHING: one unresolved item refuses the WHOLE album typed
 *    with the per-item reasons and ZERO durable writes (a partial album
 *    can never exist, a doomed publication is never created quietly);
 *  - the machine mints NO approval: the draft ships 'ready' and the
 *    album enqueue refuses every non-sendable status (the owner/policy
 *    action is the ONLY route to an approved draft);
 *  - the ONLY legal document construction path (the 7.2 plan + the
 *    resolved file_ids) — a hand-built item list has no entry point;
 *  - the caption rides ordinal 0 ONLY, re-validated by the strict
 *    readers end to end;
 *  - the produced document routes to the scheduler's ALBUM branch (the
 *    ADR-0060 discriminator) and the album enqueue refuses a non-album
 *    draft typed (a text draft can never ride the album enqueuer).
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15. */
const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function producerDeps() {
  return { executor, clock, logger: silentLogger() };
}

async function insertStory(id: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, NOW, NOW, NOW, NOW],
  });
}

function photoCandidate(canonicalUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'photo',
    role: 'cover_key_art',
    origin: 'official_api',
    officiality: 'official',
    relevance: 'primary',
    freshness: 'current_cycle',
    canonicalUrl,
    previouslyUsed: false,
    ...overrides,
  };
}

async function insertUploadedAsset(input: {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly fileId: string;
  readonly type?: string;
  readonly rightsStatus?: string;
  readonly status?: string;
}): Promise<void> {
  await executor.run({
    sql: `INSERT INTO media_assets (id, type, canonical_url, mime_type, rights_status,
            telegram_file_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?)`,
    params: [
      input.id,
      input.type ?? 'photo',
      input.canonicalUrl,
      input.rightsStatus ?? 'official',
      input.fileId,
      input.status ?? 'uploaded',
      NOW,
      NOW,
    ],
  });
}

async function countRows(table: string): Promise<number> {
  const row = await executor.first<{ readonly total: number }>({
    sql: `SELECT COUNT(*) AS total FROM ${table}`,
    params: [],
  });
  return row?.total ?? 0;
}

async function captionEnvelope(text: string) {
  const outcome = createRichTextEnvelope({ kind: 'caption', text, entities: [] });
  if (!outcome.ok) throw new Error(`caption fixture failed: ${JSON.stringify(outcome)}`);
  return outcome.envelope;
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM media_usages').run();
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM media_assets').run();
  await db.prepare('DELETE FROM stories').run();
  clock = fixedClock(NOW);
});

describe('album-draft-producer: the ledger-bound producing side (ADR-0060 carry closed)', () => {
  it('produces an album draft from two uploaded rights-cleared ledger assets, bindings exact per ordinal', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'file-photo-1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'file-photo-2',
    });

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم رسانهٔ خبر',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.version).toBe(1);
    expect(outcome.items).toEqual([
      { ordinal: 0, mediaAssetId: 'a1', rightsStatus: 'official' },
      { ordinal: 1, mediaAssetId: 'a2', rightsStatus: 'official' },
    ]);

    const draft = await executor.first<{
      readonly status: string;
      readonly document_json: string;
      readonly version: number;
      readonly layout: string;
    }>({
      sql: `SELECT status, document_json, version, layout FROM drafts WHERE id = ?`,
      params: [outcome.draftId],
    });
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('ready');
    expect(draft!.version).toBe(1);
    expect(draft!.layout).toBe('album');

    const read = await readAlbumContentDocumentV1(JSON.parse(draft!.document_json));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.document.items.map((item) => item.fileId)).toEqual([
      'file-photo-1',
      'file-photo-2',
    ]);
    expect(read.document.caption).toBeUndefined();
  });

  it('routes the produced document to the scheduler album branch', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
    });

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = await executor.first<{ readonly document_json: string }>({
      sql: `SELECT document_json FROM drafts WHERE id = ?`,
      params: [outcome.draftId],
    });
    expect(discriminateAlbumDocument(row!.document_json)).toBe('album');
  });

  it('the machine mints no approval: the draft ships ready and the enqueue refuses it', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
    });

    const produced = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;

    const enqueue = await enqueueAlbumDraft(producerDeps(), {
      draftId: produced.draftId,
      destination: DESTINATION,
      approvalMode: 'safe_auto',
      publicationId: 'pub-1',
    });
    expect(enqueue.kind).toBe('rejected');
    if (enqueue.kind !== 'rejected') return;
    expect(enqueue.reason).toBe('draft_not_sendable');

    const publications = await countRows('publications');
    expect(publications).toBe(0);
  });

  it('enqueues only after an explicit approval transition, idempotent on a repeat', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
    });

    const produced = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;

    // The EXPLICIT owner/policy action: the only route an album draft
    // becomes sendable. The machine performed no part of it.
    await executor.run({
      sql: `UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?`,
      params: [clock.now(), produced.draftId],
    });

    const first = await enqueueAlbumDraft(producerDeps(), {
      draftId: produced.draftId,
      destination: DESTINATION,
      approvalMode: 'safe_auto',
      publicationId: 'pub-1',
    });
    expect(first.kind).toBe('created');

    const row = await executor.first<{ readonly status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'pub-1'`,
      params: [],
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');

    // The duplicate enqueue: the SAME draft + destination rides the
    // idempotency key — the existing row wins, never a second publication.
    const second = await enqueueAlbumDraft(producerDeps(), {
      draftId: produced.draftId,
      destination: DESTINATION,
      approvalMode: 'safe_auto',
      publicationId: 'pub-2',
    });
    expect(second.kind).toBe('duplicate');
    if (second.kind !== 'duplicate') return;
    expect(second.publicationId).toBe('pub-1');
  });

  it('all-or-nothing: one unuploaded candidate refuses the whole album with zero writes', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    // ordinal 1's URL has NO uploaded row.

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('ledger_binding_unresolved');
    expect(outcome.detail?.items).toEqual([
      {
        ordinal: 0,
        canonicalUrl: 'https://media.example/i/1.jpg',
        reason: 'resolved',
        mediaAssetId: 'a1',
        rightsStatus: 'official',
      },
      { ordinal: 1, canonicalUrl: 'https://media.example/i/2.jpg', reason: 'no_uploaded_asset' },
    ]);
    expect(await countRows('drafts')).toBe(0);
    expect(await countRows('media_assets')).toBe(1);
  });

  it('the machine mints no clearance: an unknown-rights uploaded asset is refused', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
      rightsStatus: 'unknown',
    });

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('ledger_binding_unresolved');
    expect(outcome.detail?.items?.[1]?.reason).toBe('rights_not_publishable');
    expect(await countRows('drafts')).toBe(0);
  });

  it('a revoked (blocked) asset is refused', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
      rightsStatus: 'blocked',
    });

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail?.items?.[1]?.reason).toBe('rights_not_publishable');
    expect(await countRows('drafts')).toBe(0);
  });

  it('a kind mismatch between the plan item and the ledger row is refused', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
      type: 'video',
    });

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('ledger_binding_unresolved');
    expect(outcome.detail?.items?.[1]?.reason).toBe('kind_mismatch');
    expect(await countRows('drafts')).toBe(0);
  });

  it('a single candidate is not an album: plan_not_album typed, zero writes', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });

    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [photoCandidate('https://media.example/i/1.jpg')],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('plan_not_album');
    expect(outcome.detail?.planMode).toBe('single');
    expect(await countRows('drafts')).toBe(0);
  });

  it('malformed candidates fail typed before any durable effect', async () => {
    await insertStory('s1');
    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [{ broken: true } as unknown as Record<string, unknown>],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('plan_derivation_failed');
    expect(await countRows('drafts')).toBe(0);
  });

  it('an unknown story refuses typed', async () => {
    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 'missing',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('story_not_found');
  });

  it('the caption rides ordinal 0 only, present in the produced document once', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
    });

    const caption = await captionEnvelope('کپشن آلبوم روی آیتم صفر');
    const outcome = await produceAlbumDraft(producerDeps(), {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      caption,
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = await executor.first<{ readonly document_json: string }>({
      sql: `SELECT document_json FROM drafts WHERE id = ?`,
      params: [outcome.draftId],
    });
    const parsed = JSON.parse(row!.document_json) as { caption?: unknown; items: unknown[] };
    expect(parsed.caption).toBeDefined();
    expect(parsed.items).toHaveLength(2);
    const serialized = serializeRichTextEnvelope(caption);
    expect(serialized.ok).toBe(true);
    // The serialized document carries the EXACT caption envelope bytes.
    expect(row!.document_json).toContain(JSON.parse(serialized.ok ? serialized.json : '""').text);
  });

  it('versions honestly: a second production for the same story carries version 2', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
    });

    const input = {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
    };
    const first = await produceAlbumDraft(producerDeps(), input);
    const second = await produceAlbumDraft(producerDeps(), input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.draftId).not.toBe(first.draftId);
    expect(await countRows('drafts')).toBe(2);
  });

  it('a duplicate draft id refuses typed, never a silent overwrite', async () => {
    await insertStory('s1');
    await insertUploadedAsset({
      id: 'a1',
      canonicalUrl: 'https://media.example/i/1.jpg',
      fileId: 'f1',
    });
    await insertUploadedAsset({
      id: 'a2',
      canonicalUrl: 'https://media.example/i/2.jpg',
      fileId: 'f2',
    });

    const input = {
      storyId: 's1',
      candidates: [
        photoCandidate('https://media.example/i/1.jpg'),
        photoCandidate('https://media.example/i/2.jpg'),
      ],
      title: 'آلبوم',
      createdBy: 'editorial-pipeline',
      draftId: 'fixed-draft',
    };
    const first = await produceAlbumDraft(producerDeps(), input);
    const second = await produceAlbumDraft(producerDeps(), input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('draft_write_failed');
    expect(await countRows('drafts')).toBe(1);
  });

  it('the album enqueue refuses a non-album draft typed', async () => {
    await insertStory('s1');
    const document = {
      schemaVersion: 1,
      headlineFa: 'تیتر خبر گیمینگ',
      summaryFa: 'خلاصهٔ خبر',
      modelClaims: [{ status: 'unverified', text: 'ادعا' }],
    };
    await executor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, version, created_by, created_at, updated_at)
            VALUES (?, ?, 'approved', 'fa', 'standard', 'تیتر', ?, '[]', '[]', 1, 'test', ?, ?)`,
      params: ['text-draft', 's1', JSON.stringify(document), NOW, NOW],
    });

    const enqueue = await enqueueAlbumDraft(producerDeps(), {
      draftId: 'text-draft',
      destination: DESTINATION,
      approvalMode: 'safe_auto',
      publicationId: 'pub-9',
    });
    expect(enqueue.kind).toBe('rejected');
    if (enqueue.kind !== 'rejected') return;
    expect(enqueue.reason).toBe('not_album_document');
    expect(await countRows('publications')).toBe(0);
  });

  it('the album enqueue refuses an unknown draft', async () => {
    const enqueue = await enqueueAlbumDraft(producerDeps(), {
      draftId: 'no-such-draft',
      destination: DESTINATION,
      approvalMode: 'safe_auto',
      publicationId: 'pub-10',
    });
    expect(enqueue.kind).toBe('rejected');
    if (enqueue.kind !== 'rejected') return;
    expect(enqueue.reason).toBe('draft_not_found');
  });
});
