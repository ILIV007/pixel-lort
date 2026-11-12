import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createMediaAssetStore } from '../../src/adapters/db/media-asset-store';
import {
  enqueuePublication,
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
import { deriveAlbumSendIdentityKey } from '../../src/domain/media/album-send-plan';
import { contentTextHash } from '../../src/domain/publishing/publication-identity';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * Phase V4-carry — the ALBUM OUTBOX WIRING over REAL workerd D1 (ADR-0060):
 * the durable publication scheduler's send path consumes the album content
 * document (the 7.3/7.4 contracts) through a dedicated media-group
 * transport seam, with the ADR-0032 gate carried over INTACT:
 *
 *  - the send is file_id-only (the attachments array is always empty — the
 *    fresh-bytes contract belongs to the upload path);
 *  - the send identity key re-derived from the durable document + the
 *    destination is consumed at the send boundary (the A4 scaffold wired);
 *  - the ledger binding is fail-closed: every document item must resolve
 *    to an UPLOADED asset whose telegram_file_id matches — a document that
 *    the ledger cannot vouch for is dead-lettered BEFORE any send;
 *  - per-ordinal delivery records (publication_messages.ordinal) + the
 *    per-ordinal usage binding (media_usages) — the blueprint's ordinal
 *    records finally consumed;
 *  - the honest outcomes: an invalid response shape parks uncertain with
 *    ZERO records; an uncertain send is NEVER auto-resent; 429 retries on
 *    the same row with the 60s floor; the recorded evidence heals;
 *  - a gate enabled without the media transport is a LOUD misconfiguration
 *    for an album scan (zero writes) and never blocks the text path.
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

async function insertStory(id: string, contentType = 'industry'): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', ?, 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, contentType, NOW_MORNING, NOW_MORNING, NOW_MORNING, NOW_MORNING],
  });
}

async function insertAlbumDraft(
  id: string,
  storyId: string,
  documentJson: string,
  options: { status?: string } = {},
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', 'album', 'آلبوم رسانه', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, options.status ?? 'approved', documentJson, NOW_MORNING, NOW_MORNING],
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

async function insertUploadedAsset(input: {
  id: string;
  type: 'photo' | 'video';
  canonicalUrl: string;
  telegramFileId: string;
  status?: string;
}): Promise<void> {
  await executor.run({
    sql: `INSERT INTO media_assets (id, type, canonical_url, mime_type, rights_status,
            telegram_file_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'image/jpeg', 'official', ?, ?, ?, ?)`,
    params: [
      input.id,
      input.type,
      input.canonicalUrl,
      input.telegramFileId,
      input.status ?? 'uploaded',
      NOW_MORNING,
      NOW_MORNING,
    ],
  });
}

function albumDocument(
  items: readonly { kind: 'photo' | 'video'; fileId: string; canonicalUrl: string }[],
  caption?: { text: string; entities: readonly unknown[] },
): string {
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    media: 'album',
    items: items.map((item) => ({
      kind: item.kind,
      fileId: item.fileId,
      canonicalUrl: item.canonicalUrl,
    })),
  };
  if (caption !== undefined)
    body['caption'] = {
      schemaVersion: 1,
      kind: 'caption',
      text: caption.text,
      entities: caption.entities,
    };
  return JSON.stringify(body);
}

const TWO_ITEMS = [
  { kind: 'photo' as const, fileId: 'file-photo-1', canonicalUrl: 'https://media.example/i/1.jpg' },
  { kind: 'photo' as const, fileId: 'file-photo-2', canonicalUrl: 'https://media.example/i/2.jpg' },
];
const CAPTION = { text: 'کپشن آلبوم خبری', entities: [] as readonly unknown[] };

interface MediaGroupCall {
  readonly chatId: number | string;
  readonly items: readonly {
    readonly type: string;
    readonly media: string;
    readonly caption?: { readonly text: string; readonly entities: readonly unknown[] };
  }[];
  readonly attachments: readonly unknown[];
  readonly sendIdentityKey: string;
}

function makeMediaTransport(
  handler: (
    call: number,
    input: MediaGroupCall,
  ) => Promise<{ readonly messageId: number; readonly fileId?: string }[]> = (call) =>
    Promise.resolve([{ messageId: 700 + call }, { messageId: 800 + call }]),
): PublicationMediaGroupTransport & { readonly calls: MediaGroupCall[] } {
  const calls: MediaGroupCall[] = [];
  let count = 0;
  return {
    calls,
    async sendMediaGroup(input) {
      count += 1;
      const callNumber = count;
      calls.push({
        chatId: input.chatId,
        items: input.items,
        attachments: input.attachments,
        sendIdentityKey: input.sendIdentityKey,
      });
      return handler(callNumber, input as MediaGroupCall);
    },
  };
}

function telegramErrorShape(code: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error('telegram failure') as Error & Record<string, unknown>;
  error.name = 'TelegramApiError';
  error.code = code;
  return Object.assign(error, extra) as Error;
}

function makeTextTransport(): PublicationChannelTransport & { calls: number } {
  return {
    calls: 0,
    async sendMessageRich() {
      this.calls += 1;
      return { messageId: 500 };
    },
  };
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

function buildScheduler(deps: {
  transport: PublicationChannelTransport | undefined;
  mediaTransport?: PublicationMediaGroupTransport;
  gateEnabled: boolean;
}) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport: deps.transport,
    // The pair rule: the ledger rides ONLY with the media seam (the
    // misconfiguration tests construct a seam-less scheduler on purpose).
    ...(deps.mediaTransport !== undefined
      ? { mediaTransport: deps.mediaTransport, mediaAssets: createMediaAssetStore(executor) }
      : {}),
    sendGate: { enabled: deps.gateEnabled },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
  });
}

async function seedTwoAssetAlbum(): Promise<void> {
  await insertUploadedAsset({
    id: 'a1',
    type: 'photo',
    canonicalUrl: TWO_ITEMS[0]!.canonicalUrl,
    telegramFileId: TWO_ITEMS[0]!.fileId,
  });
  await insertUploadedAsset({
    id: 'a2',
    type: 'photo',
    canonicalUrl: TWO_ITEMS[1]!.canonicalUrl,
    telegramFileId: TWO_ITEMS[1]!.fileId,
  });
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM media_usages').run();
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM media_assets').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM stories').run();
  clock = fixedClock(NOW_MORNING);
});

describe('publication-85 album wiring: the send path', () => {
  it('a due album publication sends the file_id-only media group and records per-ordinal delivery + usage', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS, CAPTION));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport();
    const text = makeTextTransport();
    const scheduler = buildScheduler({ transport: text, mediaTransport: media, gateEnabled: true });

    const report = await scheduler.scanDuePublications();
    expect(report.misconfigured).toBe(false);
    expect(report.details).toHaveLength(1);
    expect(report.details[0]!.outcome).toBe('sent');

    // ONE media-group call; the text transport never fired.
    expect(media.calls).toHaveLength(1);
    expect(text.calls).toBe(0);
    const call = media.calls[0]!;
    expect(call.chatId).toBe(DESTINATION);
    expect(call.items).toEqual([
      { type: 'photo', media: 'file-photo-1', caption: { text: CAPTION.text, entities: [] } },
      { type: 'photo', media: 'file-photo-2' },
    ]);
    expect(call.attachments).toHaveLength(0);

    // The per-ordinal delivery ledger.
    const messages = await listPublicationMessages(executor, 'pub-1');
    expect(messages.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(messages.map((row) => row.message_id)).toEqual([701, 801]);
    const captionHash = await contentTextHash(CAPTION.text);
    expect(captionHash.ok).toBe(true);
    if (!captionHash.ok) return;
    expect(messages[0]!.text_hash).toBe(captionHash.hash);
    expect(messages[1]!.text_hash).toBeNull();

    // The per-ordinal usage binding.
    const usages = await executor.query<{
      publication_id: string;
      ordinal: number;
      media_asset_id: string;
    }>({
      sql: `SELECT publication_id, ordinal, media_asset_id FROM media_usages WHERE publication_id = ? ORDER BY ordinal ASC`,
      params: ['pub-1'],
    });
    expect(usages.rows).toEqual([
      { publication_id: 'pub-1', ordinal: 0, media_asset_id: 'a1' },
      { publication_id: 'pub-1', ordinal: 1, media_asset_id: 'a2' },
    ]);

    const row = await executor.first<{ status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'pub-1'`,
      params: [],
    });
    expect(row?.status).toBe('published');
  });

  it('the send identity consumed by the port is the shared derivation of the durable document', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS, CAPTION));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });
    await scheduler.scanDuePublications();

    const expected = await deriveAlbumSendIdentityKey({
      destination: DESTINATION,
      items: TWO_ITEMS.map((item) => ({ kind: item.kind, canonicalUrl: item.canonicalUrl })),
      captionText: CAPTION.text,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(media.calls[0]!.sendIdentityKey).toBe(expected.key);
  });

  it('a three-item album maps the response message ids by ordinal order', async () => {
    const three = [
      ...TWO_ITEMS,
      { kind: 'video' as const, fileId: 'file-video-1', canonicalUrl: 'https://media.example/v/1' },
    ];
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(three));
    await insertUploadedAsset({
      id: 'a1',
      type: 'photo',
      canonicalUrl: three[0]!.canonicalUrl,
      telegramFileId: three[0]!.fileId,
    });
    await insertUploadedAsset({
      id: 'a2',
      type: 'photo',
      canonicalUrl: three[1]!.canonicalUrl,
      telegramFileId: three[1]!.fileId,
    });
    await insertUploadedAsset({
      id: 'a3',
      type: 'video',
      canonicalUrl: three[2]!.canonicalUrl,
      telegramFileId: three[2]!.fileId,
    });
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport(() =>
      Promise.resolve([{ messageId: 11 }, { messageId: 22 }, { messageId: 33 }]),
    );
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('sent');
    const messages = await listPublicationMessages(executor, 'pub-1');
    expect(messages.map((row) => [row.ordinal, row.message_id])).toEqual([
      [0, 11],
      [1, 22],
      [2, 33],
    ]);
    expect(messages.every((row) => row.text_hash === null)).toBe(true);
  });
});

describe('publication-85 album wiring: the ADR-0032 gate over albums', () => {
  it('a COMPLETE delivery proof (every ordinal + usages) heals the album WITHOUT any media send', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    // The independent review d65d811 (P1-2) correction: the heal asserts
    // the COMPLETE delivery — EVERY ordinal recorded to the destination
    // AND the usages bound. One witness proves one message, never the
    // album; the old shape-blind heal on a partial witness was the defect
    // the probe demonstrated (published with messages=1, usages=0).
    for (const [ordinal, messageId] of [
      [0, 555],
      [1, 556],
    ] as const) {
      const recorded = await recordPublicationMessage(executor, {
        publicationId: 'pub-1',
        chatId: DESTINATION,
        messageId,
        textHash: null,
        nowMs: clock.now(),
        ordinal,
      });
      expect(recorded.kind).toBe('recorded');
    }
    const bound = await recordPublicationMediaUsages(executor, {
      publicationId: 'pub-1',
      usages: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 1, mediaAssetId: 'a2' },
      ],
      nowMs: clock.now(),
    });
    expect(bound.kind).toBe('recorded');

    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('healed_from_evidence');
    expect(media.calls).toHaveLength(0);
    const row = await executor.first<{ status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'pub-1'`,
      params: [],
    });
    expect(row?.status).toBe('published');
  });

  it('a PARTIAL delivery proof (one ordinal of two) parks uncertain — no heal, no send, no re-send', async () => {
    await insertStory('s1b');
    await insertAlbumDraft('d1b', 's1b', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1b', 'd1b');
    // The crashed-mid-album shape: only ordinal 0 was ever recorded.
    const recorded = await recordPublicationMessage(executor, {
      publicationId: 'pub-1b',
      chatId: DESTINATION,
      messageId: 555,
      textHash: null,
      nowMs: clock.now(),
      ordinal: 0,
    });
    expect(recorded.kind).toBe('recorded');

    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });
    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!).toMatchObject({
      publicationId: 'pub-1b',
      outcome: 'failed_unconfirmed',
      code: 'album_evidence_incomplete',
    });
    expect(media.calls).toHaveLength(0);
    const row = await executor.first<{ status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'pub-1b'`,
      params: [],
    });
    expect(row?.status).toBe('failed');
    // The partial records stay (the evidence heal governs them later):
    const messages = await listPublicationMessages(executor, 'pub-1b');
    expect(messages).toHaveLength(1);
    // And a later scan NEVER auto-resends the partial album:
    clock.advance(60 * 60_000);
    const later = await buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    }).scanDuePublications();
    expect(media.calls).toHaveLength(0);
    expect(later.details.map((detail) => detail.publicationId)).not.toContain('pub-1b');
  });

  it('an invalid response shape parks uncertain with ZERO ledger records and NEVER auto-resends', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    // The reply loses an ordinal: the shape gate rejects BEFORE any record.
    const media = makeMediaTransport(() => Promise.resolve([{ messageId: 701 }]));
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const first = await scheduler.scanDuePublications();
    expect(first.details[0]!.outcome).toBe('failed_unconfirmed');
    expect(first.details[0]!.code).toBe('response_media_group_shape_invalid');
    expect(await listPublicationMessages(executor, 'pub-1')).toHaveLength(0);
    expect(
      (await executor.query({ sql: `SELECT media_asset_id FROM media_usages`, params: [] })).rows,
    ).toHaveLength(0);

    // The parked row is NEVER auto-resent: a second scan sends nothing.
    const second = await scheduler.scanDuePublications();
    expect(media.calls).toHaveLength(1);
    expect(second.details.every((detail) => detail.outcome !== 'sent')).toBe(true);
  });

  it('an uncertain timeout parks failed and is NEVER auto-resent', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport(() => {
      throw telegramErrorShape('telegram_timeout');
    });
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const first = await scheduler.scanDuePublications();
    expect(first.details[0]!.outcome).toBe('failed_unconfirmed');
    expect(first.details[0]!.code).toBe('telegram_timeout');
    const second = await scheduler.scanDuePublications();
    expect(media.calls).toHaveLength(1);
    expect(second.details.every((detail) => detail.outcome !== 'sent')).toBe(true);
  });

  it('a 429 schedules the retry on the SAME row with the 60s floor and the retry re-sends', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport(() => {
      throw telegramErrorShape('telegram_rate_limited', { retryAfterMs: 5_000 });
    });
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const first = await scheduler.scanDuePublications();
    expect(first.details[0]!.outcome).toBe('retry_scheduled');
    expect(first.details[0]!.code).toBe('telegram_rate_limited');
    const parked = await executor.first<{ run_after: number; status: string }>({
      sql: `SELECT run_after, status FROM publications WHERE id = 'pub-1'`,
      params: [],
    });
    expect(parked?.status).toBe('retry_wait');
    expect(parked!.run_after).toBeGreaterThanOrEqual(clock.now() + 60_000);

    // The floor holds the retry; then the SAME row re-sends (proved non-delivery).
    clock.advance(61_000);
    const second = await scheduler.scanDuePublications();
    expect(media.calls).toHaveLength(2);
    expect(second.details[0]!.outcome).toBe('retry_scheduled');
  });

  it('a 4xx hold parks failed_hold without any retry', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport(() => {
      throw telegramErrorShape('telegram_bad_request');
    });
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('failed_hold');
    expect(report.details[0]!.code).toBe('telegram_bad_request');
    const row = await executor.first<{ status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'pub-1'`,
      params: [],
    });
    expect(row?.status).toBe('failed');
  });
});

describe('publication-85 album wiring: the fail-closed ledger binding', () => {
  it('a document file_id the ledger cannot vouch for dead-letters BEFORE any send', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    // The asset EXISTS but its file_id differs from the document's.
    await insertUploadedAsset({
      id: 'a1',
      type: 'photo',
      canonicalUrl: TWO_ITEMS[0]!.canonicalUrl,
      telegramFileId: 'a-different-file-id',
    });
    await insertUploadedAsset({
      id: 'a2',
      type: 'photo',
      canonicalUrl: TWO_ITEMS[1]!.canonicalUrl,
      telegramFileId: TWO_ITEMS[1]!.fileId,
    });
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('dead_lettered');
    expect(report.details[0]!.code).toBe('ledger_binding_unresolved');
    expect(media.calls).toHaveLength(0);
    expect(await listPublicationMessages(executor, 'pub-1')).toHaveLength(0);
  });

  it('a missing ledger asset dead-letters BEFORE any send', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('dead_lettered');
    expect(report.details[0]!.code).toBe('ledger_binding_unresolved');
    expect(media.calls).toHaveLength(0);
  });

  it('a non-uploaded asset (still candidate) dead-letters BEFORE any send', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await insertUploadedAsset({
      id: 'a1',
      type: 'photo',
      canonicalUrl: TWO_ITEMS[0]!.canonicalUrl,
      telegramFileId: TWO_ITEMS[0]!.fileId,
      status: 'candidate',
    });
    await insertUploadedAsset({
      id: 'a2',
      type: 'photo',
      canonicalUrl: TWO_ITEMS[1]!.canonicalUrl,
      telegramFileId: TWO_ITEMS[1]!.fileId,
    });
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('dead_lettered');
    expect(report.details[0]!.code).toBe('ledger_binding_unresolved');
    expect(media.calls).toHaveLength(0);
  });
});

describe('publication-85 album wiring: the typed content refusals', () => {
  it('a malformed album document dead-letters typed with ZERO sends', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument([TWO_ITEMS[0]!]));
    await enqueueAlbumPublication('pub-1', 'd1');
    const media = makeMediaTransport();
    const scheduler = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: media,
      gateEnabled: true,
    });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('dead_lettered');
    expect(report.details[0]!.code).toBe('album_content_invalid:album_items_out_of_bounds');
    expect(media.calls).toHaveLength(0);
  });
});

describe('publication-85 album wiring: the text path is untouched', () => {
  it('a text publication rides the text transport and never the media port', async () => {
    await insertStory('s1');
    await insertTextDraft('d-text', 's1');
    await enqueueAlbumPublication('pub-text', 'd-text');
    const media = makeMediaTransport();
    const text = makeTextTransport();
    const scheduler = buildScheduler({ transport: text, mediaTransport: media, gateEnabled: true });

    const report = await scheduler.scanDuePublications();
    expect(report.details[0]!.outcome).toBe('sent');
    expect(text.calls).toBe(1);
    expect(media.calls).toHaveLength(0);
  });
});

describe('publication-85 album wiring: the LOUD misconfiguration', () => {
  it('the gate ON without the media transport refuses an album scan with ZERO writes', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');
    const scheduler = buildScheduler({ transport: makeTextTransport(), gateEnabled: true });

    const report = await scheduler.scanDuePublications();
    expect(report.misconfigured).toBe('media_transport_absent');
    expect(report.details).toHaveLength(0);
    const row = await executor.first<{ status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'pub-1'`,
      params: [],
    });
    expect(row?.status).toBe('pending');

    // The recovery: with the media transport present the SAME scan sends.
    const healed = buildScheduler({
      transport: makeTextTransport(),
      mediaTransport: makeMediaTransport(),
      gateEnabled: true,
    });
    const after = await healed.scanDuePublications();
    expect(after.misconfigured).toBe(false);
    expect(after.details[0]!.outcome).toBe('sent');
  });

  it('the gate ON without the media transport still sends TEXT', async () => {
    await insertStory('s1');
    await insertTextDraft('d-text', 's1');
    await enqueueAlbumPublication('pub-text', 'd-text');
    const text = makeTextTransport();
    const scheduler = buildScheduler({ transport: text, gateEnabled: true });

    const report = await scheduler.scanDuePublications();
    expect(report.misconfigured).toBe(false);
    expect(report.details[0]!.outcome).toBe('sent');
    expect(text.calls).toBe(1);
  });
});

describe('publication-85 album wiring: the per-ordinal ledger fence', () => {
  it('recordPublicationMessage honors the ordinal and the (publication_id, ordinal) fence', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    await enqueueAlbumPublication('pub-1', 'd1');

    expect(
      (
        await recordPublicationMessage(executor, {
          publicationId: 'pub-1',
          chatId: DESTINATION,
          messageId: 10,
          textHash: null,
          nowMs: clock.now(),
          ordinal: 0,
        })
      ).kind,
    ).toBe('recorded');
    expect(
      (
        await recordPublicationMessage(executor, {
          publicationId: 'pub-1',
          chatId: DESTINATION,
          messageId: 20,
          textHash: null,
          nowMs: clock.now(),
          ordinal: 5,
        })
      ).kind,
    ).toBe('recorded');
    // The same ordinal twice is the fence.
    expect(
      (
        await recordPublicationMessage(executor, {
          publicationId: 'pub-1',
          chatId: DESTINATION,
          messageId: 30,
          textHash: null,
          nowMs: clock.now(),
          ordinal: 0,
        })
      ).kind,
    ).toBe('duplicate_message');

    const rows = await listPublicationMessages(executor, 'pub-1');
    expect(rows.map((row) => row.ordinal)).toEqual([0, 5]);

    // A negative ordinal is a typed bad request, never a silent 0.
    await expect(
      recordPublicationMessage(executor, {
        publicationId: 'pub-1',
        chatId: DESTINATION,
        messageId: 40,
        textHash: null,
        nowMs: clock.now(),
        ordinal: -1,
      }),
    ).rejects.toThrow();
  });

  it('recordPublicationMediaUsages binds the ordinals and fences duplicates', async () => {
    await insertStory('s1');
    await insertAlbumDraft('d1', 's1', albumDocument(TWO_ITEMS));
    // The FK parents: the binding references REAL ledger assets.
    await seedTwoAssetAlbum();
    await enqueueAlbumPublication('pub-1', 'd1');

    expect(
      (
        await recordPublicationMediaUsages(executor, {
          publicationId: 'pub-1',
          usages: [
            { ordinal: 0, mediaAssetId: 'a1' },
            { ordinal: 1, mediaAssetId: 'a2' },
          ],
          nowMs: clock.now(),
        })
      ).kind,
    ).toBe('recorded');
    expect(
      (
        await recordPublicationMediaUsages(executor, {
          publicationId: 'pub-1',
          usages: [{ ordinal: 0, mediaAssetId: 'a1' }],
          nowMs: clock.now(),
        })
      ).kind,
    ).toBe('duplicate_usage');
    const rows = await executor.query<{ ordinal: number; media_asset_id: string }>({
      sql: `SELECT ordinal, media_asset_id FROM media_usages WHERE publication_id = 'pub-1' ORDER BY ordinal ASC`,
      params: [],
    });
    expect(rows.rows).toEqual([
      { ordinal: 0, media_asset_id: 'a1' },
      { ordinal: 1, media_asset_id: 'a2' },
    ]);
  });
});
