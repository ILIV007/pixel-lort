import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  createEditCorrectionEngine,
  type PublicationEditTransport,
  type SweepPriorOutcome,
} from '../../src/application/publishing/edit-correction-engine';
import { renderEditorialPostText } from '../../src/domain/admin-post/editorial-post-render';
import {
  createRichTextEnvelope,
  serializeRichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';
import { readAlbumContentDocumentV1 } from '../../src/domain/media/album-content';
import { contentTextHash } from '../../src/domain/publishing/publication-identity';
import { findCorrectionAuditEvent } from '../../src/adapters/db/publication-correction-store';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * publication-93 — the WHOLE-STORY CORRECTION SWEEP (the 8.4 documented
 * carry closed): one revision drives EVERY active prior publication of the
 * story through the correction engine, one prior at a time.
 *
 * THE SAFE CONTRACT pinned here:
 *  - the ORIGINAL envelope is re-derived per prior from the STORED draft
 *    document (the text render the scheduler sent; the album's ordinal-0
 *    caption) and VERIFIED against the ledger's exact-bytes text_hash —
 *    a document altered after publication is refused per prior
 *    (content_changed_after_publication), the readers' seen text is never
 *    silently re-interpreted;
 *  - the deterministic caid1 LINK audit is the per-(revision, prior)
 *    at-most-once anchor: a re-swept prior is skipped (already_swept),
 *    ZERO transport calls on the skip;
 *  - per-prior isolation: one unrenderable/unverifiable prior is refused
 *    and the OTHER priors still receive their correction;
 *  - the sweep is BOUNDED (16 priors): beyond the cap the whole sweep
 *    refuses typed with ZERO writes (the human drives the remainder);
 *  - the gate stays the engine's: OFF = per-prior decision-only reports,
 *    ZERO durable writes, ZERO transport calls;
 *  - the minor-detail class refuses up-front (no reader value — the ecl1
 *    machine never edits a minor detail);
 *  - an album prior corrects ONLY its ordinal-0 caption (a photo is not
 *    text-editable — the other ordinals are honestly untouched).
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15. */
const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const STATEMENT = 'در نسخهٔ پیشین نام استودیو اشتباه درج شده بود؛ نام صحیح در این پیام آمده است.';
const REVISION = 'revision-r93';

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
    params: [id, `key-${id}`, NOW, NOW, NOW, NOW],
  });
}

function textDocument() {
  return {
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [{ status: 'unverified', text: 'ادعای مدل دربارهٔ تاریخ انتشار' }],
  };
}

let draftVersionCounter = 0;

async function insertTextDraft(id: string, storyId: string, documentJson?: string): Promise<void> {
  draftVersionCounter += 1;
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'standard', 'تیتر خبر گیمینگ', ?, '[]', '[]', ?, 'test', ?, ?)`,
    params: [
      id,
      storyId,
      documentJson ?? JSON.stringify(textDocument()),
      draftVersionCounter,
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
  textHash: string | null,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO publication_messages (publication_id, chat_id, message_id,
            media_group_id, ordinal, text_hash, created_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    params: [publicationId, chatId, messageId, ordinal, textHash, NOW],
  });
}

/** A published TEXT prior with the ledger carrying the EXACT sent-text hash. */
async function seedPublishedTextPrior(
  publicationId: string,
  storyId: string,
  draftId: string,
  messageId: number,
): Promise<{ readonly sentText: string }> {
  await insertTextDraft(draftId, storyId);
  await insertPublication(publicationId, storyId, draftId, 'published', NOW - 3_600_000);
  const row = await executor.first<{ readonly document_json: string }>({
    sql: `SELECT document_json FROM drafts WHERE id = ?`,
    params: [draftId],
  });
  const rendered = renderEditorialPostText(row!.document_json);
  if (!rendered.ok) throw new Error(`render fixture failed: ${rendered.reason}`);
  const hash = await contentTextHash(rendered.text);
  if (!hash.ok) throw new Error('hash fixture failed');
  await insertRecordedMessage(publicationId, DESTINATION, messageId, 0, hash.hash);
  return { sentText: rendered.text };
}

interface RecordedEditCall {
  readonly chatId: string;
  readonly messageId: number;
  readonly seam: 'text' | 'caption';
  readonly text: string;
}

function makeEditTransport(): PublicationEditTransport & { readonly calls: RecordedEditCall[] } {
  const calls: RecordedEditCall[] = [];
  return {
    calls,
    async editMessageTextRich(input) {
      calls.push({
        chatId: String(input.chatId),
        messageId: input.messageId,
        seam: 'text',
        text: input.content.text,
      });
      return { messageId: input.messageId };
    },
    async editMessageCaptionRich(input) {
      calls.push({
        chatId: String(input.chatId),
        messageId: input.messageId,
        seam: 'caption',
        text: input.caption.text,
      });
      return { messageId: input.messageId };
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

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM audit_events').run();
  await db.prepare('DELETE FROM media_usages').run();
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM stories').run();
  clock = fixedClock(NOW);
});

describe('publication-93: the whole-story correction sweep', () => {
  it('drives every active prior: both published priors receive the label-prepended edit', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);
    await seedPublishedTextPrior('p2', 's1', 'd2', 502);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.priors).toHaveLength(2);
    expect(report.totals.priors).toBe(2);
    expect(report.totals.applied).toBe(2);
    expect(report.totals.refused).toBe(0);
    for (const prior of report.priors) {
      expect(prior.outcome).toBe('applied');
      if (prior.outcome !== 'applied') continue;
      expect(prior.disposition).toBe('edit');
      expect(prior.edits).toHaveLength(1);
    }
    expect(transport.calls).toHaveLength(2);
    for (const call of transport.calls) {
      expect(call.seam).toBe('text');
      expect(call.text.startsWith('اصلاحیه: ')).toBe(true);
      expect(call.text).toContain(STATEMENT);
    }
  });

  it('is at-most-once per (revision, prior): the re-sweep skips both priors with zero transport calls', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);
    await seedPublishedTextPrior('p2', 's1', 'd2', 502);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const first = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.totals.applied).toBe(2);
    expect(transport.calls).toHaveLength(2);

    const second = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.totals.skipped).toBe(2);
    expect(second.totals.applied).toBe(0);
    for (const prior of second.priors) {
      expect(prior.outcome).toBe('already_swept');
    }
    // The skip performed ZERO channel effects.
    expect(transport.calls).toHaveLength(2);
  });

  it('a different revision drives the priors again (the anchor is per revision)', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: 'rev-a',
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(transport.calls).toHaveLength(1);

    const second = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: 'rev-b',
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.totals.applied).toBe(1);
    expect(transport.calls).toHaveLength(2);
  });

  it('per-prior isolation: a prior with a tampered document is refused, the other prior is still corrected', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);
    // p2's draft document is ALTERED after the recorded hash — the ledger
    // can no longer vouch for the render.
    await seedPublishedTextPrior('p2', 's1', 'd2', 502);
    await executor.run({
      sql: `UPDATE drafts SET document_json = ? WHERE id = 'd2'`,
      params: [JSON.stringify({ ...textDocument(), headlineFa: 'تیتر دستکاری‌شده' })],
    });

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.totals.applied).toBe(1);
    expect(report.totals.refused).toBe(1);
    const refused = report.priors.find((prior: SweepPriorOutcome) => prior.outcome === 'refused');
    expect(refused).toBeDefined();
    if (refused?.outcome !== 'refused') return;
    expect(refused.reason).toBe('content_changed_after_publication');
    // Only the verifiable prior reached the transport.
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.messageId).toBe(501);
  });

  it('the gate OFF is decision-only: per-prior plans reported, zero writes, zero transport calls', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, false);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.totals.decisionOnly).toBe(1);
    expect(report.totals.applied).toBe(0);
    expect(transport.calls).toHaveLength(0);
    const audit = await executor.first<{ readonly total: number }>({
      sql: `SELECT COUNT(*) AS total FROM audit_events`,
      params: [],
    });
    expect(audit?.total).toBe(0);
    const pub = await executor.first<{ readonly status: string }>({
      sql: `SELECT status FROM publications WHERE id = 'p1'`,
      params: [],
    });
    expect(pub?.status).toBe('published');
  });

  it('the minor-detail class refuses up-front with zero writes', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'minor_detail',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });

    expect(report).toMatchObject({ ok: false, reason: 'minor_detail_not_editable' });
    expect(transport.calls).toHaveLength(0);
    const audit = await executor.first<{ readonly total: number }>({
      sql: `SELECT COUNT(*) AS total FROM audit_events`,
      params: [],
    });
    expect(audit?.total).toBe(0);
  });

  it('an unknown correction class refuses typed', async () => {
    await insertStory('s1');
    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'not-a-class',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(report).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(transport.calls).toHaveLength(0);
  });

  it('beyond the sweep cap the whole sweep refuses typed with zero writes', async () => {
    await insertStory('s1');
    for (let index = 0; index < 17; index += 1) {
      await seedPublishedTextPrior(`p${index}`, 's1', `d${index}`, 600 + index);
    }

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });

    expect(report).toMatchObject({ ok: false, reason: 'too_many_priors' });
    expect(transport.calls).toHaveLength(0);
    const audit = await executor.first<{ readonly total: number }>({
      sql: `SELECT COUNT(*) AS total FROM audit_events`,
      params: [],
    });
    expect(audit?.total).toBe(0);
    const statuses = await executor.first<{ readonly total: number }>({
      sql: `SELECT COUNT(*) AS total FROM publications WHERE status = 'published'`,
      params: [],
    });
    expect(statuses?.total).toBe(17);
  });

  it('a story with no active priors yields the honest empty report', async () => {
    await insertStory('s1');
    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.priors).toHaveLength(0);
    expect(report.totals.priors).toBe(0);
  });

  it('an album prior corrects ONLY its ordinal-0 caption through the caption seam', async () => {
    await insertStory('s1');
    // An ALBUM prior: the draft document is an album content document with
    // an ordinal-0 caption; the ledger carries the caption hash on ordinal 0.
    const caption = createRichTextEnvelope({
      kind: 'caption',
      text: 'کپشن اصلی آلبوم',
      entities: [],
    });
    expect(caption.ok).toBe(true);
    if (!caption.ok) return;
    const serializedCaption = serializeRichTextEnvelope(caption.envelope);
    expect(serializedCaption.ok).toBe(true);
    if (!serializedCaption.ok) return;
    const document = {
      schemaVersion: 1,
      media: 'album',
      items: [
        { kind: 'photo', fileId: 'f1', canonicalUrl: 'https://media.example/i/1.jpg' },
        { kind: 'photo', fileId: 'f2', canonicalUrl: 'https://media.example/i/2.jpg' },
      ],
      caption: JSON.parse(serializedCaption.json),
    };
    await executor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, version, created_by, created_at, updated_at)
            VALUES (?, ?, 'approved', 'fa', 'album', 'آلبوم', ?, '[]', '[]', 1, 'test', ?, ?)`,
      params: ['ad1', 's1', JSON.stringify(document), NOW, NOW],
    });
    const read = await readAlbumContentDocumentV1(JSON.parse(JSON.stringify(document)));
    expect(read.ok).toBe(true);
    await insertPublication('ap1', 's1', 'ad1', 'published', NOW - 3_600_000);
    const captionHash = await contentTextHash(caption.envelope.text);
    expect(captionHash.ok).toBe(true);
    if (!captionHash.ok) return;
    await insertRecordedMessage('ap1', DESTINATION, 701, 0, captionHash.hash);
    await insertRecordedMessage('ap1', DESTINATION, 702, 1, null);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.totals.applied).toBe(1);
    const prior = report.priors[0];
    expect(prior?.outcome).toBe('applied');
    if (prior?.outcome !== 'applied') return;
    // ONLY the caption ordinal was editable; ordinal 1 (a photo with no
    // envelope) is honestly not part of the derived edits.
    expect(prior.edits).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.seam).toBe('caption');
    expect(transport.calls[0]?.messageId).toBe(701);
    expect(transport.calls[0]?.text.startsWith('اصلاحیه: ')).toBe(true);
    expect(transport.calls[0]?.text).toContain('کپشن اصلی آلبوم');
  });

  it('the link audit id recorded by the sweep matches the deterministic caid1 anchor', async () => {
    await insertStory('s1');
    await seedPublishedTextPrior('p1', 's1', 'd1', 501);

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrectionSweep({
      storyId: 's1',
      revisionId: REVISION,
      correctionClass: 'correction',
      statement: STATEMENT,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // The recorded link audit for (revision, prior) exists — the anchor the
    // next sweep's skip reads.
    const applied = report.priors[0];
    expect(applied?.outcome).toBe('applied');
    if (applied?.outcome !== 'applied') return;
    expect(applied.auditLinkEventId).not.toBe('');
    const stored = await findCorrectionAuditEvent(executor, applied.auditLinkEventId);
    expect(stored).not.toBeNull();
  });
});
