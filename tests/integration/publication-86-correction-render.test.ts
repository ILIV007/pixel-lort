import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  listPublicationMessages,
  findPublicationById,
} from '../../src/adapters/db/publication-outbox-store';
import { findCorrectionAuditEvent } from '../../src/adapters/db/publication-correction-store';
import {
  createEditCorrectionEngine,
  type PublicationEditTransport,
} from '../../src/application/publishing/edit-correction-engine';
import { renderEditorialPostText } from '../../src/domain/admin-post/editorial-post-render';
import {
  CORRECTION_LABELS,
  deriveCorrectionEdits,
  renderCorrectionEditEnvelope,
} from '../../src/domain/publishing/correction-render';
import { serializeRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * Phase 8.4b — the CORRECTION CONTENT RENDER consumed by the REAL
 * edit/correction engine over REAL workerd D1. The 8.4 design carried the
 * render pipeline; this suite pins the delivered composition end-to-end:
 *
 *  - the ORIGINAL envelope is the EXACT render the scheduler sends
 *    (renderEditorialPostText over the stored draft document) — the
 *    correction edits what the readers actually saw, never a parallel text;
 *  - deriveCorrectionEdits output feeds applyCorrection's `edits` DIRECTLY
 *    (the exact CorrectionEditMessage shape) — the transport receives the
 *    label-prepended text with every original entity offset-shifted;
 *  - the edit-only path keeps the row `published` and the ledger's original
 *    delivery record untouched (the 8.4 contract);
 *  - edit_and_follow_up renders AND supersedes (the full disposition);
 *  - the minor_detail honesty: the render refuses typed AND the engine's
 *    gate-ON pass stays decision-only with ZERO durable writes;
 *  - a caption original routes through the caption transport seam.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const STATEMENT = 'در نسخهٔ پیشین نام استودیو اشتباه درج شده بود؛ نام صحیح در این پیام آمده است.';

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
    modelClaims: [{ status: 'unverified', text: 'ادعای مدل دربارهٔ تاریخ انتشار' }],
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

interface RecordedEditCall {
  readonly chatId: string;
  readonly messageId: number;
  readonly seam: 'text' | 'caption';
  readonly kind: string;
  readonly text: string;
  readonly entities: readonly unknown[];
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
        kind: input.content.kind,
        text: input.content.text,
        entities: input.content.entities,
      });
      return { messageId: input.messageId };
    },
    async editMessageCaptionRich(input) {
      calls.push({
        chatId: String(input.chatId),
        messageId: input.messageId,
        seam: 'caption',
        kind: input.caption.kind,
        text: input.caption.text,
        entities: input.caption.entities,
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

/** The REAL original envelope: exactly what the scheduler renders at send time. */
async function originalEnvelopeForDraft(draftId: string) {
  const row = await executor.first<{ readonly document_json: string }>({
    sql: `SELECT document_json FROM drafts WHERE id = ?`,
    params: [draftId],
  });
  if (!row) throw new Error(`draft ${draftId} missing`);
  const rendered = renderEditorialPostText(row.document_json);
  if (!rendered.ok) throw new Error(`editorial render failed: ${rendered.reason}`);
  const serialized = serializeRichTextEnvelope(rendered.envelope);
  if (!serialized.ok) throw new Error(`serialization failed: ${serialized.reason}`);
  return { text: rendered.text, envelopeJson: serialized.json };
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

describe('publication-86: the correction render consumed by the real engine', () => {
  it('applies the rendered edit end-to-end: the transport receives the label-prepended content', async () => {
    await insertStory('s1');
    await insertDraft('d1', 's1');
    await insertPublication('p1', 's1', 'd1', 'published', NOW - 3_600_000);
    await insertRecordedMessage('p1', DESTINATION, 501, 0);

    const original = await originalEnvelopeForDraft('d1');
    const rendered = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original.envelopeJson,
      kind: 'text',
      correctionClass: 'correction',
      statement: STATEMENT,
    });
    expect(rendered.ok).toBe(true);

    const ledger = await listPublicationMessages(executor, 'p1');
    const derived = deriveCorrectionEdits({
      correctionClass: 'correction',
      statement: STATEMENT,
      messages: ledger.map((message) => ({
        chatId: message.chat_id,
        messageId: message.message_id,
        ordinal: message.ordinal,
        kind: 'text' as const,
        originalEnvelopeJson: original.envelopeJson,
      })),
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p1',
      revisionId: 'draft-next-1',
      correctionClass: 'correction',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: derived.edits,
    });

    expect(report.applied).toBe(true);
    expect(report.disposition).toBe('edit');
    expect(report.planReasons).toContain('edit_window_open');
    expect(report.edits).toHaveLength(1);
    expect(report.edits[0]?.outcome).toBe('applied');

    // The transport received the EXACT corrected composition.
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.seam).toBe('text');
    expect(call?.chatId).toBe(DESTINATION);
    expect(call?.messageId).toBe(501);
    const lead = `${CORRECTION_LABELS.correction}: ${STATEMENT}`;
    expect(call?.text).toBe(`${lead}\n\n${original.text}`);
    expect(call?.kind).toBe('text');
    // The original's bold headline entity rides the corrected text SHIFTED.
    const headlineShift = lead.length + 2;
    const entities = call?.entities as readonly { type: string; offset: number; length: number }[];
    expect(entities[0]).toEqual({
      type: 'bold',
      offset: 0,
      length: CORRECTION_LABELS.correction.length + 2,
    });
    expect(entities[1]?.offset).toBe(headlineShift);

    // The audit event records the APPLIED outcome.
    if (report.edits[0]?.auditEventId) {
      const audit = await findCorrectionAuditEvent(executor, report.edits[0].auditEventId);
      expect(audit).not.toBeNull();
      expect(JSON.parse(audit?.metadata_json ?? '{}')).toMatchObject({
        outcome: 'applied',
        publicationId: 'p1',
        ordinal: 0,
      });
    }

    // The edit-only contract: the row stays published, the ledger keeps the
    // ORIGINAL delivery record untouched.
    const row = await findPublicationById(executor, 'p1');
    expect(row?.status).toBe('published');
    const ledgerAfter = await listPublicationMessages(executor, 'p1');
    expect(ledgerAfter).toHaveLength(1);
    expect(ledgerAfter[0]?.message_id).toBe(501);
  });

  it('renders AND supersedes for edit_and_follow_up (rumor_denied, follow-up desired)', async () => {
    await insertStory('s1');
    await insertDraft('d1', 's1');
    await insertPublication('p1', 's1', 'd1', 'published', NOW - 3_600_000);
    await insertRecordedMessage('p1', DESTINATION, 502, 0);

    const original = await originalEnvelopeForDraft('d1');
    const derived = deriveCorrectionEdits({
      correctionClass: 'rumor_denied',
      statement: STATEMENT,
      messages: [
        {
          chatId: DESTINATION,
          messageId: 502,
          ordinal: 0,
          kind: 'text',
          originalEnvelopeJson: original.envelopeJson,
        },
      ],
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p1',
      revisionId: 'draft-next-2',
      correctionClass: 'rumor_denied',
      followUpMaterial: true,
      correctionFollowUpDesired: true,
      edits: derived.edits,
    });

    expect(report.disposition).toBe('edit_and_follow_up');
    expect(report.supersededPublications).toEqual(['p1']);
    expect(report.draftSuperseded).toBe(true);
    expect(report.auditLinkEventId).not.toBe('');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.text).toBe(
      `${CORRECTION_LABELS.rumor_denied}: ${STATEMENT}\n\n${original.text}`,
    );
    const row = await findPublicationById(executor, 'p1');
    expect(row?.status).toBe('superseded');
  });

  it('keeps a minor_detail correction at decision-only honesty: the render refuses, zero writes', async () => {
    await insertStory('s1');
    await insertDraft('d1', 's1');
    await insertPublication('p1', 's1', 'd1', 'published', NOW - 3_600_000);
    await insertRecordedMessage('p1', DESTINATION, 503, 0);
    const before = await auditRowCount();

    // The render side refuses FIRST — no edit payload can even be built.
    const original = await originalEnvelopeForDraft('d1');
    const rendered = renderCorrectionEditEnvelope({
      originalEnvelopeJson: original.envelopeJson,
      kind: 'text',
      correctionClass: 'minor_detail',
      statement: STATEMENT,
    });
    expect(rendered).toEqual({ ok: false, reason: 'class_not_editable' });

    const engine = buildEngine(undefined, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p1',
      revisionId: 'draft-next-3',
      correctionClass: 'minor_detail',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
    });
    // The shipped 8.4 contract: a gate-ON pass with a none disposition
    // reports applied:true (the pass EXECUTED) while the disposition itself
    // carries zero effects — the honesty lives in the zero writes below.
    expect(report.applied).toBe(true);
    expect(report.disposition).toBe('none');
    expect(report.planReasons).toContain('minor_detail_no_reader_value');
    expect(report.edits).toEqual([]);
    expect(await auditRowCount()).toBe(before);
    const row = await findPublicationById(executor, 'p1');
    expect(row?.status).toBe('published');
  });

  it('routes a caption original through the caption transport seam', async () => {
    await insertStory('s1');
    await insertDraft('d1', 's1');
    await insertPublication('p1', 's1', 'd1', 'published', NOW - 3_600_000);
    await insertRecordedMessage('p1', DESTINATION, 504, 0);

    // The honest caption original: the album caption envelope shape (the
    // ordinal-0 caption the album send path records), serialized canonically.
    const { createRichTextEnvelope } = await import('../../src/domain/telegram/rich-text-envelope');
    const captionOutcome = createRichTextEnvelope({
      kind: 'caption',
      text: 'عنوان آلبوم تصویری',
      entities: [{ type: 'bold', offset: 0, length: 6 }],
    });
    expect(captionOutcome.ok).toBe(true);
    if (!captionOutcome.ok) return;
    const serialized = serializeRichTextEnvelope(captionOutcome.envelope);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const derived = deriveCorrectionEdits({
      correctionClass: 'correction',
      statement: STATEMENT,
      messages: [
        {
          chatId: DESTINATION,
          messageId: 504,
          ordinal: 0,
          kind: 'caption',
          originalEnvelopeJson: serialized.json,
        },
      ],
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.edits[0]?.shape).toBe('caption');

    const transport = makeEditTransport();
    const engine = buildEngine(transport, true);
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p1',
      revisionId: 'draft-next-4',
      correctionClass: 'correction',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: derived.edits,
    });

    expect(report.edits[0]?.outcome).toBe('applied');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.seam).toBe('caption');
    expect(transport.calls[0]?.kind).toBe('caption');
    expect(transport.calls[0]?.text).toBe(
      `${CORRECTION_LABELS.correction}: ${STATEMENT}\n\nعنوان آلبوم تصویری`,
    );
  });
});
