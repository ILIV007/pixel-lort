import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  createAdminPostService,
  type AdminPostTransport,
} from '../../src/application/admin-post/admin-post-service';
import { createLogger, type LogSink } from '../../src/observability/logger';
import type { Clock } from '../../src/shared/time/clock';
import {
  createRichTextEnvelope,
  serializeRichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';
import {
  createPostContentDocument,
  serializeAndFingerprintPostContent,
  serializePostContentDocument,
} from '../../src/domain/admin-post/post-content';
import { fingerprintOfSerializedEnvelope } from '../../src/domain/admin-post/fingerprint';
import {
  openCaptureSession,
  captureVersion,
  createPreviewSession,
  recordApprovalFenced,
} from '../../src/adapters/db/admin-post-store';
import { issueActionToken } from '../../src/adapters/telegram/action-tokens';
import { randomToken } from '../../src/domain/admin-post/fingerprint';

/**
 * R1.21 requirement 2A — the SEND-INTEGRITY gate: before EVERY send (first
 * publish and confirmed re-send) the stored content is re-read, fully
 * re-validated, and its fingerprint RE-DERIVED from the re-read document.
 * A version whose stored bytes were altered after the approval — even when
 * the fingerprint COLUMN was left untouched — can never be sent: the send is
 * blocked, the outcome is recorded honestly (failed_definitive,
 * content_changed_after_approval) and the human gets the honest answer.
 */

const OWNER_ID = 1000000001;
const START = 1_700_000_000_000;

function mutableClock(startMs: number): Clock & { readonly advance: (ms: number) => void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function silentLogger() {
  return createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });
}

interface SentCall {
  readonly chatId: number | string;
  readonly text?: string;
  readonly photo?: string;
  readonly video?: string;
  readonly caption?: string;
}

function recordingTransport(behavior: 'ok' | 'timeout' = 'ok'): {
  readonly transport: AdminPostTransport;
  readonly calls: SentCall[];
} {
  const calls: SentCall[] = [];
  return {
    calls,
    transport: {
      async sendMessageRich(input) {
        calls.push({ chatId: input.chatId, text: input.content.text });
        if (behavior === 'timeout') {
          throw Object.assign(new Error('Telegram API timeout'), {
            name: 'TelegramApiError',
            code: 'telegram_timeout',
            retryable: true,
          });
        }
        return { messageId: 4242 };
      },
      async sendPhotoRich(input) {
        calls.push({
          chatId: input.chatId,
          photo: input.photo,
          ...(input.caption !== undefined ? { caption: input.caption.text } : {}),
        });
        return { messageId: 4243 };
      },
      async sendVideoRich(input) {
        calls.push({
          chatId: input.chatId,
          video: input.video,
          ...(input.caption !== undefined ? { caption: input.caption.text } : {}),
        });
        return { messageId: 4244 };
      },
    },
  };
}

function makeService(transport: AdminPostTransport, clock: Clock) {
  return createAdminPostService({
    executor,
    clock,
    logger: silentLogger(),
    config: { livePublishEnabled: true, destination: '@pixellores' },
    transport,
  });
}

async function seedTextVersion(input: {
  readonly draftId: string;
  readonly text: string;
}): Promise<string> {
  const envelope = createRichTextEnvelope({ kind: 'text', text: input.text, entities: [] });
  if (!envelope.ok) throw new Error('fixture envelope rejected');
  const doc = createPostContentDocument({ media: 'none', text: envelope.envelope });
  if (!doc.ok) throw new Error('fixture document rejected');
  const serialized = await serializeAndFingerprintPostContent(doc.document);
  if (!serialized.ok) throw new Error('fixture serialization rejected');
  await captureVersion(executor, {
    draftId: input.draftId,
    existingDraftId: undefined,
    envelopeJson: serialized.json,
    fingerprint: serialized.fingerprint,
    sourceUpdateId: 1,
    telegramUserId: OWNER_ID,
    nowMs: START,
  });
  return serialized.fingerprint;
}

async function seedPhotoVersion(input: {
  readonly draftId: string;
  readonly fileId: string;
  readonly caption: string;
}): Promise<string> {
  const caption = createRichTextEnvelope({
    kind: 'caption',
    text: input.caption,
    entities: [{ type: 'bold', offset: 0, length: 4 }],
  });
  if (!caption.ok) throw new Error('fixture caption rejected');
  const doc = createPostContentDocument({
    media: 'photo',
    fileId: input.fileId,
    caption: caption.envelope,
  });
  if (!doc.ok) throw new Error('fixture document rejected');
  const serialized = await serializeAndFingerprintPostContent(doc.document);
  if (!serialized.ok) throw new Error('fixture serialization rejected');
  await captureVersion(executor, {
    draftId: input.draftId,
    existingDraftId: undefined,
    envelopeJson: serialized.json,
    fingerprint: serialized.fingerprint,
    sourceUpdateId: 2,
    telegramUserId: OWNER_ID,
    nowMs: START,
  });
  return serialized.fingerprint;
}

/**
 * Approved-and-ready setup: preview session + ACTIVE approval. NO
 * publication row — the REAL publish callback creates it atomically
 * (consumeApprovalAndCreatePublication) exactly like production.
 */
async function seedApproval(input: {
  readonly draftId: string;
  readonly version: number;
  readonly fingerprint: string;
}): Promise<string> {
  const nowMs = START;
  await openCaptureSession(executor, {
    telegramUserId: OWNER_ID,
    startedAtMs: nowMs,
    updateId: 100,
  });
  const sessionId = randomToken();
  await createPreviewSession(executor, {
    id: sessionId,
    draftId: input.draftId,
    version: input.version,
    fingerprint: input.fingerprint,
    previewChatId: OWNER_ID,
    sourceUpdateId: 101,
    expiresAtMs: nowMs + 30 * 60 * 1000,
    nowMs,
  });
  const approved = await recordApprovalFenced(executor, {
    draftId: input.draftId,
    version: input.version,
    fingerprint: input.fingerprint,
    telegramUserId: OWNER_ID,
    sessionId,
    nowMs,
  });
  if (approved.kind !== 'approved') throw new Error('fixture approval rejected');
  return sessionId;
}

async function issuePublishToken(input: {
  readonly draftId: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly nowMs: number;
}): Promise<string> {
  const token = randomToken();
  await issueActionToken(executor, {
    token,
    telegramUserId: OWNER_ID,
    permission: 'publication.publish',
    action: 'admin_post.publish',
    targetType: 'admin_post_draft',
    targetId: input.draftId,
    payloadJson: JSON.stringify({
      version: input.version,
      fingerprint: input.fingerprint,
      sessionId: input.sessionId,
    }),
    expiresAtMs: input.nowMs + 30 * 60 * 1000,
    nowMs: input.nowMs,
  });
  return token;
}

let executor: DbExecutor;
let clock: ReturnType<typeof mutableClock>;

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  clock = mutableClock(START);
  for (const table of [
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
    'admins',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, 'Owner', 'owner', 'active', 1, 1)`,
    params: [OWNER_ID],
  });
});

describe('R1.21 — the send-integrity gate (fingerprint re-derived from the re-read content)', () => {
  it('blocks the send when the stored TEXT changed after approval — fingerprint column untouched', async () => {
    const draftId = 'draft-text-tamper';
    const fingerprint = await seedTextVersion({ draftId, text: 'متن تأییدشده' });
    const sessionId = await seedApproval({ draftId, version: 1, fingerprint });
    const token = await issuePublishToken({
      draftId,
      version: 1,
      fingerprint,
      sessionId,
      nowMs: clock.now(),
    });

    // TAMPER: swap the stored text WITHOUT touching the fingerprint column.
    const tamperedEnvelope = createRichTextEnvelope({
      kind: 'text',
      text: 'متن دستکاری‌شده پس از تأیید',
      entities: [],
    });
    if (!tamperedEnvelope.ok) throw new Error('unreachable');
    const tamperedDoc = createPostContentDocument({
      media: 'none',
      text: tamperedEnvelope.envelope,
    });
    if (!tamperedDoc.ok) throw new Error('unreachable');
    const tamperedSerialized = serializePostContentDocument(tamperedDoc.document);
    if (!tamperedSerialized.ok) throw new Error('unreachable');
    await executor.run({
      sql: 'UPDATE admin_post_versions SET envelope_json = ? WHERE draft_id = ? AND version = 1',
      params: [tamperedSerialized.json, draftId],
    });

    const fake = recordingTransport('ok');
    const service = makeService(fake.transport, clock);
    const result = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind !== 'answer') throw new Error('unreachable');
    expect(result.callbackText).toContain('no longer matches the approved content');
    expect(fake.calls).toHaveLength(0); // NOTHING was sent.

    const publication = await executor.first<{ state: string; error_code: string | null }>({
      sql: 'SELECT state, error_code FROM admin_post_publications WHERE draft_id = ?',
      params: [draftId],
    });
    expect(publication?.state).toBe('failed_definitive');
    expect(publication?.error_code).toBe('content_changed_after_approval');
  });

  it('blocks the send when a MEDIA version (file_id or caption) was altered after approval', async () => {
    const draftId = 'draft-media-tamper';
    const fingerprint = await seedPhotoVersion({
      draftId,
      fileId: 'AgAC_original_photo_id',
      caption: 'کپشن تأییدشده',
    });
    const sessionId = await seedApproval({ draftId, version: 1, fingerprint });
    const token = await issuePublishToken({
      draftId,
      version: 1,
      fingerprint,
      sessionId,
      nowMs: clock.now(),
    });

    // TAMPER: swap the file_id (the caption stays valid) — the fingerprint
    // column is untouched, so ONLY the re-derivation can catch this.
    const tamperedCaption = createRichTextEnvelope({
      kind: 'caption',
      text: 'کپشن تأییدشده',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
    });
    if (!tamperedCaption.ok) throw new Error('unreachable');
    const tamperedDoc = createPostContentDocument({
      media: 'photo',
      fileId: 'AgAC_SWAPPED_photo_id',
      caption: tamperedCaption.envelope,
    });
    if (!tamperedDoc.ok) throw new Error('unreachable');
    const tamperedSerialized = serializePostContentDocument(tamperedDoc.document);
    if (!tamperedSerialized.ok) throw new Error('unreachable');
    await executor.run({
      sql: 'UPDATE admin_post_versions SET envelope_json = ? WHERE draft_id = ? AND version = 1',
      params: [tamperedSerialized.json, draftId],
    });

    const fake = recordingTransport('ok');
    const service = makeService(fake.transport, clock);
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(fake.calls).toHaveLength(0);
    const publication = await executor.first<{ state: string; error_code: string | null }>({
      sql: 'SELECT state, error_code FROM admin_post_publications WHERE draft_id = ?',
      params: [draftId],
    });
    expect(publication?.state).toBe('failed_definitive');
    expect(publication?.error_code).toBe('content_changed_after_approval');
  });

  it('still sends when the stored bytes are INTACT (the gate never blocks honest content)', async () => {
    const draftId = 'draft-intact';
    const fingerprint = await seedTextVersion({ draftId, text: 'متن سالم' });
    const sessionId = await seedApproval({ draftId, version: 1, fingerprint });
    const token = await issuePublishToken({
      draftId,
      version: 1,
      fingerprint,
      sessionId,
      nowMs: clock.now(),
    });

    const fake = recordingTransport('ok');
    const service = makeService(fake.transport, clock);
    const result = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind !== 'answer') throw new Error('unreachable');
    expect(result.callbackText).toContain('PUBLISHED');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.text).toBe('متن سالم');
  });

  it('a LEGACY bare-envelope row still passes the gate via the documented fallback', async () => {
    const draftId = 'draft-legacy';
    // R1.20-R1 storage shape: a bare envelope + fingerprint over ITS bytes.
    const envelope = createRichTextEnvelope({ kind: 'text', text: 'نسخهٔ قدیمی', entities: [] });
    if (!envelope.ok) throw new Error('unreachable');
    const legacy = serializeRichTextEnvelope(envelope.envelope);
    if (!legacy.ok) throw new Error('unreachable');
    const fingerprint = await fingerprintOfSerializedEnvelope(legacy.json);
    await captureVersion(executor, {
      draftId,
      existingDraftId: undefined,
      envelopeJson: legacy.json,
      fingerprint,
      sourceUpdateId: 3,
      telegramUserId: OWNER_ID,
      nowMs: START,
    });
    const sessionId = await seedApproval({ draftId, version: 1, fingerprint });
    const token = await issuePublishToken({
      draftId,
      version: 1,
      fingerprint,
      sessionId,
      nowMs: clock.now(),
    });

    const fake = recordingTransport('ok');
    const service = makeService(fake.transport, clock);
    const result = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind !== 'answer') throw new Error('unreachable');
    expect(result.callbackText).toContain('PUBLISHED');
    expect(fake.calls[0]?.text).toBe('نسخهٔ قدیمی');
  });

  it('the confirmed RE-SEND passes the same gate (a tampered version cannot ride the recovery path)', async () => {
    const draftId = 'draft-resend-tamper';
    const fingerprint = await seedTextVersion({ draftId, text: 'متن برای ارسال مجدد' });
    const firstSessionId = await seedApproval({ draftId, version: 1, fingerprint });

    // First attempt times out -> uncertain.
    const timeoutFake = recordingTransport('timeout');
    const timeoutService = makeService(timeoutFake.transport, clock);
    const token = await issuePublishToken({
      draftId,
      version: 1,
      fingerprint,
      sessionId: firstSessionId,
      nowMs: clock.now(),
    });
    await timeoutService.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    const first = await executor.first<{ id: string; state: string }>({
      sql: 'SELECT id, state FROM admin_post_publications WHERE draft_id = ?',
      params: [draftId],
    });
    expect(first?.state).toBe('uncertain');
    const firstPublicationId = first!.id;

    // TAMPER after the uncertain outcome, before the human-confirmed re-send.
    const tamperedEnvelope = createRichTextEnvelope({
      kind: 'text',
      text: 'متن عوض‌شده',
      entities: [],
    });
    if (!tamperedEnvelope.ok) throw new Error('unreachable');
    const tamperedDoc = createPostContentDocument({
      media: 'none',
      text: tamperedEnvelope.envelope,
    });
    if (!tamperedDoc.ok) throw new Error('unreachable');
    const tamperedSerialized = serializePostContentDocument(tamperedDoc.document);
    if (!tamperedSerialized.ok) throw new Error('unreachable');
    await executor.run({
      sql: 'UPDATE admin_post_versions SET envelope_json = ? WHERE draft_id = ? AND version = 1',
      params: [tamperedSerialized.json, draftId],
    });

    // The human confirms the re-send via the CONFIRM-REPUBLISH action —
    // the exact action /post_status mints (the publication row carries the
    // version fingerprint it was created for). The gate blocks it.
    const confirmToken = randomToken();
    await issueActionToken(executor, {
      token: confirmToken,
      telegramUserId: OWNER_ID,
      permission: 'publication.publish',
      action: 'admin_post.confirm_republish',
      targetType: 'admin_post_draft',
      targetId: draftId,
      payloadJson: JSON.stringify({
        publicationId: firstPublicationId,
        version: 1,
        fingerprint,
      }),
      expiresAtMs: clock.now() + 30 * 60 * 1000,
      nowMs: clock.now(),
    });
    const okFake = recordingTransport('ok');
    const okService = makeService(okFake.transport, clock);
    await okService.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: confirmToken,
    });
    expect(okFake.calls).toHaveLength(0);
    // The OLD row was honestly superseded; the REPLACEMENT (attempt 2) is
    // the row the gate blocked.
    const after = await executor.first<{ state: string; error_code: string | null }>({
      sql: 'SELECT state, error_code FROM admin_post_publications WHERE draft_id = ? AND supersede_of IS NOT NULL',
      params: [draftId],
    });
    expect(after?.state).toBe('failed_definitive');
    expect(after?.error_code).toBe('content_changed_after_approval');
  });
});
