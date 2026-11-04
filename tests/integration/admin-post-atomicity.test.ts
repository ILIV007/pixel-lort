import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  createAdminPostService,
  type AdminPostTransport,
} from '../../src/application/admin-post/admin-post-service';
import {
  claimPublication,
  consumeApproval,
  createPreviewSession,
  createPublication,
  findPrimaryPublication,
  finishPublication,
  getApproval,
  getPublication,
  getVersion,
  supersedeAndCreatePublication,
  captureVersion,
} from '../../src/adapters/db/admin-post-store';
import { issueActionToken } from '../../src/adapters/telegram/action-tokens';
import {
  createRichTextEnvelope,
  readRichTextEnvelope,
} from '../../src/domain/telegram/rich-text-envelope';
import { randomToken, serializeAndFingerprint } from '../../src/domain/admin-post/fingerprint';
import type { Clock } from '../../src/shared/time/clock';
import type { Logger } from '../../src/observability/logger';

/**
 * R1.20-R1 — atomicity and honest recovery for the admin post pipeline,
 * over REAL workerd D1:
 * - approve is FENCED BY THE DRAFT HEAD (a capture committing between the
 *   bind and the write can never leave a stale ACTIVE approval behind);
 * - consume+create is ONE atomic batch (a crash between them is impossible;
 *   the historical crash state is honestly recoverable);
 * - supersede+create is ONE atomic batch (a losing race never creates a
 *   replacement without superseding);
 * - expired leases, late worker responses and uncertain outcomes are
 *   recorded HONESTLY — no blind auto-retry, no exactly-once claim.
 * Service-level tests drive the REAL callback path (durable action tokens +
 * the server-side preview binding), never a shortcut.
 */

const OWNER_ID = 1000000001;
const START = 1_700_000_000_000;

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

function mutableClock(startMs: number): Clock & { readonly advance: (ms: number) => void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function okTransport(messageId = 4242): AdminPostTransport {
  return {
    async sendMessageRich() {
      return { messageId };
    },
    async sendPhotoRich() {
      return { messageId };
    },
    async sendVideoRich() {
      return { messageId };
    },
  };
}

function timeoutTransport(): AdminPostTransport {
  return {
    async sendMessageRich() {
      throw Object.assign(new Error('Telegram API timeout'), {
        name: 'TelegramApiError',
        code: 'telegram_timeout',
        retryable: true,
      });
    },
    async sendPhotoRich() {
      throw Object.assign(new Error('Telegram API timeout'), {
        name: 'TelegramApiError',
        code: 'telegram_timeout',
        retryable: true,
      });
    },
    async sendVideoRich() {
      throw Object.assign(new Error('Telegram API timeout'), {
        name: 'TelegramApiError',
        code: 'telegram_timeout',
        retryable: true,
      });
    },
  };
}

async function seedDraftWithVersion(
  executor: DbExecutor,
  text = 'پست اتمیک برای تست بازیابی',
  sourceUpdateId = 1,
): Promise<{ draftId: string; version: number; fingerprint: string; envelopeJson: string }> {
  // The CANONICAL envelope (schemaVersion included) is what production
  // stores — build it through the same factory the service uses.
  const canonical = createRichTextEnvelope({ kind: 'text', text, entities: [] });
  if (!canonical.ok) throw new Error('fixture envelope rejected');
  const envelopeOutcome = await serializeAndFingerprint(canonical.envelope);
  if (!envelopeOutcome.ok) throw new Error('fixture envelope serialization rejected');
  const draftId = randomToken();
  const capture = await captureVersion(executor, {
    draftId,
    existingDraftId: undefined,
    envelopeJson: envelopeOutcome.json,
    fingerprint: envelopeOutcome.fingerprint,
    sourceUpdateId,
    telegramUserId: OWNER_ID,
    nowMs: START,
  });
  if (capture.kind !== 'created') throw new Error('fixture draft capture failed');
  return {
    draftId,
    version: 1,
    fingerprint: envelopeOutcome.fingerprint,
    envelopeJson: envelopeOutcome.json,
  };
}

async function seedApproval(
  executor: DbExecutor,
  draftId: string,
  version: number,
  fingerprint: string,
): Promise<void> {
  const outcome = await executor.run({
    sql: `INSERT INTO admin_post_approvals
            (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
          VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    params: [draftId, version, fingerprint, OWNER_ID, randomToken(), START],
  });
  if (outcome.changes !== 1) throw new Error('fixture approval failed');
}

/** Bind a REAL preview session (the server-side binding the callbacks resolve). */
async function seedPreviewSession(
  executor: DbExecutor,
  draftId: string,
  version: number,
  fingerprint: string,
): Promise<string> {
  const sessionId = randomToken();
  await createPreviewSession(executor, {
    id: sessionId,
    draftId,
    version,
    fingerprint,
    previewChatId: OWNER_ID,
    sourceUpdateId: 900,
    expiresAtMs: START + 30 * 60_000,
    nowMs: START,
  });
  return sessionId;
}

async function issuePublishToken(
  executor: DbExecutor,
  draftId: string,
  version: number,
  fingerprint: string,
  sessionId: string,
  nowMs: number,
): Promise<string> {
  const token = randomToken();
  await issueActionToken(executor, {
    token,
    telegramUserId: OWNER_ID,
    permission: 'publication.publish',
    action: 'admin_post.publish',
    targetType: 'admin_post_draft',
    targetId: draftId,
    payloadJson: JSON.stringify({ version, fingerprint, sessionId }),
    expiresAtMs: nowMs + 30 * 60_000,
    nowMs,
  });
  return token;
}

async function issueConfirmRepublishToken(
  executor: DbExecutor,
  draftId: string,
  publicationId: string,
  version: number,
  fingerprint: string,
  nowMs: number,
): Promise<string> {
  const token = randomToken();
  await issueActionToken(executor, {
    token,
    telegramUserId: OWNER_ID,
    permission: 'publication.publish',
    action: 'admin_post.confirm_republish',
    targetType: 'admin_post_draft',
    targetId: draftId,
    payloadJson: JSON.stringify({ publicationId, version, fingerprint }),
    expiresAtMs: nowMs + 30 * 60_000,
    nowMs,
  });
  return token;
}

let executor: DbExecutor;

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  for (const table of [
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
    'telegram_updates',
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

describe('R1.20-R1 — the approve write is fenced by the draft head (edit-vs-approve race)', () => {
  it('a capture that commits between the bind and the write makes the approval STALE (real callback path)', async () => {
    const seeded = await seedDraftWithVersion(executor);
    const sessionId = await seedPreviewSession(executor, seeded.draftId, 1, seeded.fingerprint);

    // The EDITOR captures version 2 (bumps the head + invalidates v1 approvals).
    const canonical2 = createRichTextEnvelope({ kind: 'text', text: 'نسخهٔ دوم', entities: [] });
    if (!canonical2.ok) throw new Error('fixture envelope 2 rejected');
    const env2 = await serializeAndFingerprint(canonical2.envelope);
    if (!env2.ok) throw new Error('fixture envelope 2 serialization rejected');
    const capture = await captureVersion(executor, {
      draftId: seeded.draftId,
      existingDraftId: seeded.draftId,
      envelopeJson: env2.json,
      fingerprint: env2.fingerprint,
      sourceUpdateId: 11,
      telegramUserId: OWNER_ID,
      nowMs: START + 5,
    });
    expect(capture.kind).toBe('version_added');

    // The approve click happens LAST (a stale preview session/token).
    const clock = mutableClock(START + 20);
    const token = randomToken();
    await issueActionToken(executor, {
      token,
      telegramUserId: OWNER_ID,
      permission: 'draft.approve',
      action: 'admin_post.approve',
      targetType: 'admin_post_draft',
      targetId: seeded.draftId,
      payloadJson: JSON.stringify({
        version: 1,
        fingerprint: seeded.fingerprint,
        sessionId,
      }),
      expiresAtMs: START + 30 * 60_000,
      nowMs: clock.now(),
    });
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: false, destination: '@pixel_channel' },
    });
    const result = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      // The head moved: the honest stale answer — never a wrong approval.
      expect(result.callbackText).toContain('newer version');
    }
    // The stale approval was never written: the fence rolled the batch back.
    const approval = await getApproval(executor, seeded.draftId, 1);
    expect(approval).toBeNull();
  });
});

describe('R1.20-R1 — consume+create is ATOMIC (crash-proof, honestly recoverable)', () => {
  it('no active approval -> nothing happens (never a half transition)', async () => {
    const seeded = await seedDraftWithVersion(executor);
    const outcome = await executor.batch([]);
    void outcome;
    const { consumeApprovalAndCreatePublication } =
      await import('../../src/adapters/db/admin-post-store');
    const result = await consumeApprovalAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START,
    });
    expect(result.kind).toBe('not_active');
    expect(await findPrimaryPublication(executor, seeded.draftId, 1)).toBeNull();
  });

  it('RECOVERY: the historical crash state (approval consumed, publication never created) heals honestly on the next publish', async () => {
    const seeded = await seedDraftWithVersion(executor);
    await seedApproval(executor, seeded.draftId, 1, seeded.fingerprint);
    // The LEGACY crash window: the approval was consumed, then the process
    // died before the publication row existed.
    const consumed = await consumeApproval(executor, {
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
    });
    expect(consumed.kind).toBe('consumed');
    expect(await findPrimaryPublication(executor, seeded.draftId, 1)).toBeNull();

    // The R1.20-R1 transition heals it: the consumed approval for the EXACT
    // fingerprint is the durable proof; the publication is recreated.
    const publicationId = randomToken();
    const { consumeApprovalAndCreatePublication } =
      await import('../../src/adapters/db/admin-post-store');
    const result = await consumeApprovalAndCreatePublication(executor, {
      id: publicationId,
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START,
    });
    expect(result).toEqual({ kind: 'created', publicationId });
    const publication = await getPublication(executor, publicationId);
    expect(publication?.state).toBe('queued');
    expect(publication?.fingerprint).toBe(seeded.fingerprint);
  });

  it('a WRONG fingerprint can never ride the recovery path (fingerprint-guarded)', async () => {
    const seeded = await seedDraftWithVersion(executor);
    await consumeApproval(executor, {
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
    });
    const { consumeApprovalAndCreatePublication } =
      await import('../../src/adapters/db/admin-post-store');
    const result = await consumeApprovalAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: 'a'.repeat(64),
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START,
    });
    expect(result.kind).toBe('not_active');
    expect(await findPrimaryPublication(executor, seeded.draftId, 1)).toBeNull();
  });

  it('a captured version invalidates the approval the publish was ABOUT to consume (edit-vs-publish race)', async () => {
    const seeded = await seedDraftWithVersion(executor);
    await seedApproval(executor, seeded.draftId, 1, seeded.fingerprint);
    // The capture commits BEFORE the publish's atomic transition.
    const canonical2 = createRichTextEnvelope({ kind: 'text', text: 'نسخهٔ ۲', entities: [] });
    if (!canonical2.ok) throw new Error('fixture envelope 2 rejected');
    const env2 = await serializeAndFingerprint(canonical2.envelope);
    if (!env2.ok) throw new Error('fixture envelope 2 serialization rejected');
    await captureVersion(executor, {
      draftId: seeded.draftId,
      existingDraftId: seeded.draftId,
      envelopeJson: env2.json,
      fingerprint: env2.fingerprint,
      sourceUpdateId: 21,
      telegramUserId: OWNER_ID,
      nowMs: START + 1,
    });
    const { consumeApprovalAndCreatePublication } =
      await import('../../src/adapters/db/admin-post-store');
    const result = await consumeApprovalAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START + 2,
    });
    // The v1 approval was invalidated by the capture: honest rejection.
    expect(result.kind).toBe('not_active');
    expect(await findPrimaryPublication(executor, seeded.draftId, 1)).toBeNull();
  });

  it('the approval consumed by the WINNING publish stays consumed for a losing racer (already_exists, no second publication)', async () => {
    const seeded = await seedDraftWithVersion(executor);
    await seedApproval(executor, seeded.draftId, 1, seeded.fingerprint);
    const { consumeApprovalAndCreatePublication } =
      await import('../../src/adapters/db/admin-post-store');
    // Winner: consumes + creates (atomically).
    const winner = await consumeApprovalAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START,
    });
    expect(winner.kind).toBe('created');
    // Loser (same bind): the primary exists -> already_exists; the approval
    // is NOT resurrected and no second publication can appear.
    const loser = await consumeApprovalAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START + 1,
    });
    expect(loser.kind).toBe('already_exists');
    const approval = await getApproval(executor, seeded.draftId, 1);
    expect(approval?.state).toBe('consumed');
  });
});

describe('R1.20-R1 — supersede+create is ATOMIC (the re-send gate)', () => {
  it('refuses a non-resendable publication WITHOUT creating any replacement', async () => {
    const seeded = await seedDraftWithVersion(executor);
    const primaryId = randomToken();
    await createPublication(executor, {
      id: primaryId,
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START,
    });
    // A LIVE claimed row is NOT resendable.
    await claimPublication(executor, {
      publicationId: primaryId,
      claimedBy: 'owner-1',
      leaseMs: 60_000,
      nowMs: START,
    });
    const result = await supersedeAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 2,
      supersedeOf: primaryId,
      supersedeMarker: randomToken(),
      nowMs: START + 1,
    });
    expect(result.kind).toBe('not_resendable');
    const primary = await getPublication(executor, primaryId);
    expect(primary?.state).toBe('claimed'); // unchanged
  });

  it('an expired-lease claimed row is resendable EXACTLY once (atomic supersede+replacement)', async () => {
    const seeded = await seedDraftWithVersion(executor);
    const primaryId = randomToken();
    await createPublication(executor, {
      id: primaryId,
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 1,
      nowMs: START,
    });
    await claimPublication(executor, {
      publicationId: primaryId,
      claimedBy: 'owner-1',
      leaseMs: 60_000,
      nowMs: START,
    });
    // While the lease is expired but NOTHING else moved, the SAME owner's
    // resolution is still authoritative (no one else owns the claim):
    const sameOwner = await finishPublication(executor, {
      publicationId: primaryId,
      claimedBy: 'owner-1',
      state: 'uncertain',
      errorCode: 'telegram_timeout',
      nowMs: START + 61_000,
    });
    expect(sameOwner.kind).toBe('recorded');
    // Reset to an expired claim for the fencing half of the proof: reclaim
    // semantics are owned by the service; emulate by a fresh claim + expiry.
    const reclaim = await claimPublication(executor, {
      publicationId: primaryId,
      claimedBy: 'owner-1',
      leaseMs: 60_000,
      nowMs: START + 62_000,
    });
    void reclaim;

    // The human confirm supersedes the expired claim and creates the
    // replacement in ONE atomic batch.
    const replacementId = randomToken();
    const result = await supersedeAndCreatePublication(executor, {
      id: replacementId,
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 3,
      supersedeOf: primaryId,
      supersedeMarker: randomToken(),
      nowMs: START + 130_000,
    });
    expect(result).toEqual({ kind: 'created', publicationId: replacementId });

    // NOW the old worker's LATE resolution arrives: the claim is gone —
    // fence-rejected, no state flip, no duplicate-send bookkeeping.
    const late = await finishPublication(executor, {
      publicationId: primaryId,
      claimedBy: 'owner-1',
      state: 'sent',
      botMessageId: 77,
      nowMs: START + 131_000,
    });
    expect(late.kind).toBe('fence_rejected');
    const oldRow = await getPublication(executor, primaryId);
    expect(oldRow?.state).toBe('superseded');
    const replacement = await getPublication(executor, replacementId);
    expect(replacement?.state).toBe('queued');
    expect(replacement?.supersede_of).toBe(primaryId);

    // A SECOND confirm can never run: the old row is no longer resendable.
    const second = await supersedeAndCreatePublication(executor, {
      id: randomToken(),
      draftId: seeded.draftId,
      version: 1,
      fingerprint: seeded.fingerprint,
      destination: '@pixel_channel',
      attempt: 4,
      supersedeOf: primaryId,
      supersedeMarker: randomToken(),
      nowMs: START + 63_000,
    });
    expect(second.kind).toBe('not_resendable');
  });
});

describe('R1.20-R1 — honest outcomes on the REAL callback path (no auto-retry, no exactly-once)', () => {
  function makeService(transport: AdminPostTransport | undefined, clock: Clock) {
    return createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixel_channel' },
      transport,
    });
  }

  async function seedApprovedPublishable(): Promise<{
    draftId: string;
    version: number;
    fingerprint: string;
    envelopeJson: string;
    sessionId: string;
  }> {
    const seeded = await seedDraftWithVersion(executor);
    await seedApproval(executor, seeded.draftId, 1, seeded.fingerprint);
    const sessionId = await seedPreviewSession(executor, seeded.draftId, 1, seeded.fingerprint);
    return { ...seeded, sessionId };
  }

  it('a TIMEOUT records UNCERTAIN (the message MAY have arrived); nothing is auto-resent', async () => {
    const seeded = await seedApprovedPublishable();
    const clock = mutableClock(START);
    const service = makeService(timeoutTransport(), clock);
    const token = await issuePublishToken(
      executor,
      seeded.draftId,
      1,
      seeded.fingerprint,
      seeded.sessionId,
      clock.now(),
    );
    const result = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      expect(result.callbackText).toContain('UNKNOWN');
    }
    const publication = await findPrimaryPublication(executor, seeded.draftId, 1);
    expect(publication?.state).toBe('uncertain');
    // Time passes — no automatic retry ever happens.
    clock.advance(10 * 60_000);
    const still = await findPrimaryPublication(executor, seeded.draftId, 1);
    expect(still?.state).toBe('uncertain');
    expect(still?.attempt).toBe(1);
  });

  it('the uncertain outcome unlocks ONLY the explicit human-confirmed re-send (atomic supersede+replacement)', async () => {
    const seeded = await seedApprovedPublishable();
    const clock = mutableClock(START);
    const failing = makeService(timeoutTransport(), clock);
    const publishToken = await issuePublishToken(
      executor,
      seeded.draftId,
      1,
      seeded.fingerprint,
      seeded.sessionId,
      clock.now(),
    );
    await failing.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: publishToken,
    });
    const uncertain = await findPrimaryPublication(executor, seeded.draftId, 1);
    expect(uncertain?.state).toBe('uncertain');

    // The human confirms via a FRESH confirm-republish token.
    const okService = makeService(okTransport(555), clock);
    const confirmToken = await issueConfirmRepublishToken(
      executor,
      seeded.draftId,
      uncertain!.id,
      1,
      seeded.fingerprint,
      clock.now(),
    );
    const result = await okService.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: confirmToken,
    });
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      expect(result.callbackText).toContain('PUBLISHED');
    }
    const oldRow = await getPublication(executor, uncertain!.id);
    expect(oldRow?.state).toBe('superseded');
    const replacement = await executor.first<{
      state: string;
      bot_message_id: number;
      fingerprint: string;
    }>({
      sql: 'SELECT state, bot_message_id, fingerprint FROM admin_post_publications WHERE supersede_of = ?',
      params: [uncertain!.id],
    });
    expect(replacement?.state).toBe('sent');
    expect(replacement?.bot_message_id).toBe(555);
    // The re-send is bound to the SAME version bytes.
    expect(replacement?.fingerprint).toBe(seeded.fingerprint);
  });

  it('the sent content is the EXACT stored bytes (re-read from storage before the send)', async () => {
    const seeded = await seedApprovedPublishable();
    let sentText: string | undefined;
    const capturingTransport: AdminPostTransport = {
      async sendMessageRich(input) {
        sentText = input.content.text;
        return { messageId: 9 };
      },
      async sendPhotoRich() {
        throw new Error('unexpected photo send in this test');
      },
      async sendVideoRich() {
        throw new Error('unexpected video send in this test');
      },
    };
    const clock = mutableClock(START);
    const service = makeService(capturingTransport, clock);
    const token = await issuePublishToken(
      executor,
      seeded.draftId,
      1,
      seeded.fingerprint,
      seeded.sessionId,
      clock.now(),
    );
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    const stored = readRichTextEnvelope(seeded.envelopeJson);
    expect(stored.ok).toBe(true);
    expect(sentText).toBe(stored.ok ? stored.envelope.text : undefined);
    // The version row re-read by the send path carried the SAME fingerprint.
    const versionRow = await getVersion(executor, seeded.draftId, 1);
    expect(versionRow?.fingerprint).toBe(seeded.fingerprint);
  });
});
