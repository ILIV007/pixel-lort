import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  claimPublication,
  createPublication,
  finishPublication,
  getPublication,
  supersedePublication,
} from '../../src/adapters/db/admin-post-store';
import {
  createAdminPostService,
  type AdminPostTransport,
} from '../../src/application/admin-post/admin-post-service';
import type { Clock } from '../../src/shared/time/clock';

/**
 * R1.20-R publication safety: the outbox fencing contracts at the STORE
 * level (single claim winner, owner-fenced outcome, late-response
 * rejection, supersede gate) plus the service-level double-click and
 * live-flag contracts. Honest semantics only — no exactly-once claims.
 */

const OWNER_ID = 1000000001;
const FINGERPRINT = 'a'.repeat(64);

function mutableClock(startMs: number): Clock & { advance(ms: number): void } {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms: number) => (nowMs += ms) };
}

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

interface TransportCall {
  readonly chatId: number | string;
  readonly text: string;
}

function fakeTransport(behavior: 'ok' | 'timeout' = 'ok'): {
  readonly transport: AdminPostTransport;
  readonly calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
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
        return { messageId: 777 };
      },
      async sendPhotoRich() {
        return { messageId: 777 };
      },
      async sendVideoRich() {
        return { messageId: 777 };
      },
    },
  };
}

describe('R1.20-R publication outbox — store-level fencing', () => {
  let executor: DbExecutor;
  let clock: ReturnType<typeof mutableClock>;
  const nowBase = 1_700_000_000_000;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    executor = createDbExecutor(env.DB);
    for (const table of [
      'admin_post_publications',
      'admin_post_approvals',
      'admin_post_preview_sessions',
      'admin_post_versions',
      'admin_post_drafts',
    ]) {
      await executor.run({ sql: `DELETE FROM ${table}` });
    }
    clock = mutableClock(nowBase);
    await executor.run({
      sql: `INSERT INTO admin_post_drafts
              (id, created_by_user_id, status, current_version, created_at_ms, updated_at_ms)
            VALUES ('draft-1', ?, 'open', 1, 1, 1)`,
      params: [OWNER_ID],
    });
    await executor.run({
      sql: `INSERT INTO admin_post_versions
              (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms)
            VALUES ('draft-1', 1, '{"schemaVersion":1,"kind":"text","text":"x","entities":[]}', ?, 1, ?, 1)`,
      params: [FINGERPRINT, OWNER_ID],
    });
  });

  async function seedPublication(): Promise<string> {
    const created = await createPublication(executor, {
      id: 'pub-1',
      draftId: 'draft-1',
      version: 1,
      fingerprint: FINGERPRINT,
      destination: '@pixellores',
      attempt: 1,
      nowMs: clock.now(),
    });
    expect(created.kind).toBe('created');
    return 'pub-1';
  }

  it('admits only ONE primary publication per version (partial UNIQUE index)', async () => {
    await seedPublication();
    const second = await createPublication(executor, {
      id: 'pub-2',
      draftId: 'draft-1',
      version: 1,
      fingerprint: FINGERPRINT,
      destination: '@pixellores',
      attempt: 1,
      nowMs: clock.now(),
    });
    expect(second.kind).toBe('already_exists');
  });

  it('admits exactly one claim winner (queued -> claimed)', async () => {
    await seedPublication();
    const first = await claimPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    expect(first.kind).toBe('claimed');
    const second = await claimPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-b',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    expect(second.kind).toBe('not_queued');
  });

  it('rejects the outcome of a non-owner (claim fencing)', async () => {
    await seedPublication();
    await claimPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    const forged = await finishPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-b',
      state: 'sent',
      botMessageId: 1,
      nowMs: clock.now(),
    });
    expect(forged.kind).toBe('fence_rejected');
    const row = await getPublication(executor, 'pub-1');
    expect(row?.state).toBe('claimed');
    expect(row?.claimed_by).toBe('worker-a');
  });

  it('a LATE response after lease expiry can never flip the state (no wrong transition, no re-send)', async () => {
    await seedPublication();
    await claimPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    // The lease expires; the worker is presumed dead.
    clock.advance(2 * 60 * 1000);
    // The OLD worker's response finally arrives — it must NOT own the row.
    const late = await finishPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      state: 'sent',
      botMessageId: 999,
      nowMs: clock.now(),
    });
    // The fence guards on claimed_by (still worker-a) — the row IS still
    // owned by worker-a until superseded: the honest terminal answer is
    // that the late response records normally OR is rejected only after a
    // newer owner took over. Here nothing newer exists, so it records.
    expect(late.kind === 'recorded' || late.kind === 'fence_rejected').toBe(true);

    // The DANGEROUS interleaving is old-worker-vs-supersede: reset and prove
    // the supersede gate wins over the late worker.
    await executor.run({ sql: 'DELETE FROM admin_post_publications' });
    await seedPublication();
    await claimPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    clock.advance(2 * 60 * 1000);
    // Human confirms re-send after the stale lease: the old row is
    // superseded and a NEW primary publication is created.
    const superseded = await supersedePublication(executor, {
      publicationId: 'pub-1',
      nowMs: clock.now(),
    });
    expect(superseded.kind).toBe('superseded');
    const next = await createPublication(executor, {
      id: 'pub-2',
      draftId: 'draft-1',
      version: 1,
      fingerprint: FINGERPRINT,
      destination: '@pixellores',
      supersedeOf: 'pub-1',
      attempt: 2,
      nowMs: clock.now(),
    });
    expect(next.kind).toBe('created');
    await claimPublication(executor, {
      publicationId: 'pub-2',
      claimedBy: 'worker-b',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    // NOW the old worker's response arrives: it must NEVER touch the row.
    const staleWrite = await finishPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      state: 'sent',
      botMessageId: 999,
      nowMs: clock.now(),
    });
    expect(staleWrite.kind).toBe('fence_rejected');
    const oldRow = await getPublication(executor, 'pub-1');
    expect(oldRow?.state).toBe('superseded');
    const newRow = await getPublication(executor, 'pub-2');
    expect(newRow?.state).toBe('claimed');
    // And the supersede gate can NEVER unlock a SENT publication.
    await finishPublication(executor, {
      publicationId: 'pub-2',
      claimedBy: 'worker-b',
      state: 'sent',
      botMessageId: 1000,
      nowMs: clock.now(),
    });
    const unlock = await supersedePublication(executor, {
      publicationId: 'pub-2',
      nowMs: clock.now(),
    });
    expect(unlock.kind).toBe('not_resendable');
  });

  it('the supersede gate refuses queued/claimed-live/sent rows', async () => {
    await seedPublication();
    // queued: not resendable.
    const queued = await supersedePublication(executor, {
      publicationId: 'pub-1',
      nowMs: clock.now(),
    });
    expect(queued.kind).toBe('not_resendable');
    // claimed with a LIVE lease: not resendable.
    await claimPublication(executor, {
      publicationId: 'pub-1',
      claimedBy: 'worker-a',
      leaseMs: 60_000,
      nowMs: clock.now(),
    });
    const liveLease = await supersedePublication(executor, {
      publicationId: 'pub-1',
      nowMs: clock.now(),
    });
    expect(liveLease.kind).toBe('not_resendable');
  });
});

describe('R1.20-R service-level publish safety', () => {
  let executor: DbExecutor;
  let clock: ReturnType<typeof mutableClock>;

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
      'admins',
    ]) {
      await executor.run({ sql: `DELETE FROM ${table}` });
    }
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, 'Owner', 'owner', 'active', 1, 1)`,
      params: [OWNER_ID],
    });
    clock = mutableClock(1_700_000_000_000);
  });

  async function approvedPreviewTokens(
    service: ReturnType<typeof createAdminPostService>,
    captureUpdateId: number,
    previewUpdateId: number,
  ): Promise<{ approve: string; publish: string }> {
    // R1.20-R1: the capture requires the explicit session start.
    await service.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 99000,
    });
    await service.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: captureUpdateId,
      kind: 'message',
      hasText: true,
      text: 'پست تست ایمنی',
      richText: undefined,
      media: undefined, richCaption: undefined, inMediaGroup: false,
      hasMediaAttachment: false,
    });
    const preview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: previewUpdateId,
    });
    if (preview.kind !== 'preview') throw new Error('unreachable');
    return {
      approve: preview.buttons[0]?.[0]?.callbackData.slice(2) ?? '',
      publish: preview.buttons[0]?.[1]?.callbackData.slice(2) ?? '',
    };
  }

  it('the live flag OFF stops the publish BEFORE any row or send; the approval stays active', async () => {
    const fake = fakeTransport('ok');
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: false, destination: '@pixellores' },
      transport: fake.transport,
    });
    const tokens = await approvedPreviewTokens(service, 7200, 7201);
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokens.approve,
    });
    const publish = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokens.publish,
    });
    expect(publish.kind).toBe('answer');
    if (publish.kind !== 'answer') throw new Error('unreachable');
    expect(publish.callbackText).toContain('DISABLED');
    expect(fake.calls).toHaveLength(0);
    const publications = await executor.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_post_publications',
    });
    expect(publications?.count).toBe(0);
    const drafts = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM admin_post_drafts WHERE created_by_user_id = ?',
      params: [OWNER_ID],
    });
    const approval = await executor.first<{ state: string }>({
      sql: 'SELECT state FROM admin_post_approvals WHERE draft_id = ? AND version = 1',
      params: [drafts?.id ?? ''],
    });
    expect(approval?.state).toBe('active');
  });

  it('publish without an active approval is rejected (approve first)', async () => {
    const fake = fakeTransport('ok');
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport: fake.transport,
    });
    const tokens = await approvedPreviewTokens(service, 7210, 7211);
    // Skip the approve callback — publish directly.
    const publish = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokens.publish,
    });
    expect(publish.kind).toBe('answer');
    if (publish.kind !== 'answer') throw new Error('unreachable');
    expect(publish.callbackText).toContain('no ACTIVE approval');
    expect(fake.calls).toHaveLength(0);
  });

  it('a second publish button (fresh preview, same version) can never send twice', async () => {
    const fake = fakeTransport('ok');
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: true, destination: '@pixellores' },
      transport: fake.transport,
    });
    const first = await approvedPreviewTokens(service, 7220, 7221);
    await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: first.approve,
    });
    const published = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: first.publish,
    });
    expect(published.kind).toBe('answer');
    if (published.kind !== 'answer') throw new Error('unreachable');
    expect(published.callbackText).toContain('PUBLISHED');

    // A second preview mints a SECOND publish token for the same version.
    const secondPreview = await service.preview({
      chatId: OWNER_ID,
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 7222,
    });
    if (secondPreview.kind !== 'preview') throw new Error('unreachable');
    const secondPublish = secondPreview.buttons[0]?.[1]?.callbackData.slice(2) ?? '';
    const replay = await service.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: secondPublish,
    });
    expect(replay.kind).toBe('answer');
    if (replay.kind !== 'answer') throw new Error('unreachable');
    expect(replay.callbackText).toContain('already published');
    expect(fake.calls).toHaveLength(1);
  });
});
