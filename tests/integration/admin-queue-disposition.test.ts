import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedAdmin,
  seedDraft,
  seedStory,
  type ReviewHarness,
} from '../helpers/review-test-fixtures';
import { parseAdminReviewConfig } from '../../src/shared/config/phase9';
import { ADMIN_QUEUE_STRINGS } from '../../src/admin/queue-strings';
import type { TelegramBotApiClient } from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';

/**
 * Phase 9C — the write-capable queue disposition surface over REAL workerd
 * D1 (the R1.18/9A/9B shape plus the ONE fenced disposition): the flag
 * family, the router grammar/RBAC family, the detail view with the honest
 * disposition state, the single-use callback flow (apply + audit + the
 * fenced race honesty), and the flag-off byte-identical Phase 9A behavior.
 * The ONLY artificial pieces are the fake Bot API and the counting executor
 * wrapper.
 */

const CHIEF_EDITOR_ID = 2000000001;
const VIEWER_ID = 2000000004;
const SOURCE_MANAGER_ID = 2000000005;
const UNKNOWN_ID = 2000000006;

/** A fake Bot API that ALSO captures reply_markup and callback answers. */
function createCapturingBotApi(): {
  client: TelegramBotApiClient;
  sends: { chatId: number; text: string; keyboardTokens: string[] }[];
  answers: string[];
} {
  const sends: { chatId: number; text: string; keyboardTokens: string[] }[] = [];
  const answers: string[] = [];
  const client: TelegramBotApiClient = {
    async getMe() {
      return { id: 42, username: 'pixel_admin_bot' };
    },
    async sendMessage(input) {
      const keyboardTokens =
        input.replyMarkup?.inline_keyboard
          .flat()
          .map((button) => button.callbackData)
          .filter((data): data is string => typeof data === 'string') ?? [];
      sends.push({ chatId: input.chatId, text: input.text, keyboardTokens });
      return { messageId: sends.length };
    },
    async editMessageText() {
      return true;
    },
    async answerCallbackQuery(input) {
      answers.push(input.text ?? '');
    },
  };
  return { client, sends, answers };
}

function callbackUpdate(updateId: number, fromId: number, token: string): ParsedUpdate {
  return {
    kind: 'callback_query',
    updateId,
    callbackQueryId: `cbq-${updateId}`,
    fromUserId: fromId,
    callbackData: `a:${token}`,
    callbackChatId: fromId,
    callbackMessageId: 9,
  };
}

async function seedQueueFixtures(): Promise<void> {
  await seedAdmin(OWNER_ID, 'owner');
  await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
  await seedAdmin(VIEWER_ID, 'viewer');
  await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');
  await seedStory('story-q-1', 'داستان صف آزمون');
  await seedDraft({
    id: 'draft-q-1',
    storyId: 'story-q-1',
    title: 'پیش‌نویس صف آزمون',
    documentJson: JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: 'پیش‌نویس صف آزمون',
      summaryFa: 'خلاصهٔ آزمون',
      modelClaims: [],
    }),
  });
}

async function seedPublication(
  id: string,
  status: string,
  updatedAt: number,
  lastError: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
      scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
      max_attempts, idempotency_key, last_error, created_at, updated_at)
     VALUES (?, 'story-q-1', 'draft-q-1', ?, 62, 'safe_auto', NULL, ?, NULL, NULL, NULL, 0, 3, ?, ?, ?, ?)`,
  )
    .bind(id, status, updatedAt, `key-${id}`, lastError, updatedAt - 1000, updatedAt)
    .run();
}

async function publicationStatus(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT status FROM publications WHERE id = ?')
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function tokenConsumed(token: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT consumed_at FROM admin_action_tokens WHERE id = ?')
    .bind(token)
    .first<{ consumed_at: number | null }>();
  if (row === null) return false;
  return row.consumed_at !== null;
}

beforeEach(async () => {
  await freshDb();
});

describe('the ADMIN_QUEUE_WRITE_ENABLED flag family (fail-closed, independent)', () => {
  it('enables ONLY on the exact "true" value', () => {
    expect(
      parseAdminReviewConfig({ ADMIN_QUEUE_WRITE_ENABLED: 'true' }).config.queueWriteEnabled,
    ).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['false', { ADMIN_QUEUE_WRITE_ENABLED: 'false' }],
    ['truthy-looking "1"', { ADMIN_QUEUE_WRITE_ENABLED: '1' }],
    ['truthy-looking "TRUE"', { ADMIN_QUEUE_WRITE_ENABLED: 'TRUE' }],
    ['yes', { ADMIN_QUEUE_WRITE_ENABLED: 'yes' }],
  ])('%s keeps the write surface disabled', (_name, input) => {
    expect(parseAdminReviewConfig(input as Record<string, unknown>).config.queueWriteEnabled).toBe(
      false,
    );
  });

  it('is INDEPENDENT of the read flag (write on does not imply read on, and vice versa)', () => {
    const both = parseAdminReviewConfig({
      ADMIN_QUEUE_ENABLED: 'true',
      ADMIN_QUEUE_WRITE_ENABLED: 'true',
    });
    expect(both.config.queueEnabled).toBe(true);
    expect(both.config.queueWriteEnabled).toBe(true);
    const writeOnly = parseAdminReviewConfig({ ADMIN_QUEUE_WRITE_ENABLED: 'true' });
    expect(writeOnly.config.queueEnabled).toBe(false);
    expect(writeOnly.config.queueWriteEnabled).toBe(true);
    const readOnly = parseAdminReviewConfig({ ADMIN_QUEUE_ENABLED: 'true' });
    expect(readOnly.config.queueEnabled).toBe(true);
    expect(readOnly.config.queueWriteEnabled).toBe(false);
  });
});

describe('the router grammar family for /queue <publicationId>', () => {
  it('with the write flag OFF, a one-argument /queue keeps the EXACT Phase 9A invalid-usage text', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9001, OWNER_ID, '/queue pub-123'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe(ADMIN_QUEUE_STRINGS.en.invalidUsage);
  });

  it('with the write flag ON, a valid one-token argument renders the detail', async () => {
    await seedQueueFixtures();
    await seedPublication('pub-detail-1', 'pending', 10_001);
    const harness = buildReviewHarness({ queueEnabled: true, queueWriteEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9002, OWNER_ID, '/queue pub-detail-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('pub-detail-1');
    expect(harness.sends[0]!.text).toContain('pending');
  });

  it('with the write flag ON, the no-argument form is STILL the read screen', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true, queueWriteEnabled: true });
    const outcome = await harness.ingress.processUpdate(privateMessage(9003, OWNER_ID, '/queue'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Status counts:');
  });

  it('with the write flag ON, a grammar-invalid argument is honest invalid usage', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true, queueWriteEnabled: true });
    const invalidInputs = ['/queue two words', '/queue pub\nid', '/queue pub\x01id'];
    let seq = 9004;
    for (const text of invalidInputs) {
      const outcome = await harness.ingress.processUpdate(privateMessage(seq++, OWNER_ID, text));
      expect(outcome).toBe('processed');
      expect(harness.sends).toHaveLength(1);
      expect(harness.sends[0]!.text).toBe(ADMIN_QUEUE_STRINGS.en.invalidUsage);
      harness.sends.length = 0;
    }
  });

  it('the detail surface is private-only; a group or edited message is a noop', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true, queueWriteEnabled: true });
    const groupOutcome = await harness.ingress.processUpdate(
      privateMessage(9005, OWNER_ID, '/queue pub-x', { chatType: 'group' }),
    );
    expect(groupOutcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    const editedOutcome = await harness.ingress.processUpdate(
      privateMessage(9006, OWNER_ID, '/queue pub-x', { kind: 'edited_message' }),
    );
    expect(editedOutcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
  });

  it('the read denial still governs: a source_manager gets the localized denial, ZERO detail reads', async () => {
    await seedQueueFixtures();
    await seedPublication('pub-denied-1', 'pending', 10_005);
    const harness = buildReviewHarness({ queueEnabled: true, queueWriteEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9007, SOURCE_MANAGER_ID, '/queue pub-denied-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('does not include publication viewing permission');
    expect(harness.sends[0]!.text).not.toContain('pub-denied-1');
    // ZERO publications-table statements ever ran for the denied actor.
    const publicationSql = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bpublications\b/i.test(sql));
    expect(publicationSql).toEqual([]);
  });

  it('an unknown actor gets the fixed English denial', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true, queueWriteEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9008, UNKNOWN_ID, '/queue pub-x'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe('Access denied.');
  });
});

describe('the detail view: the disposition state and the button minting rules', () => {
  async function detailHarnessFor(
    publicationId: string,
    status: string,
    fromId: number = OWNER_ID,
    lastError: string | null = null,
  ): Promise<ReturnType<typeof createCapturingBotApi> & { harness: ReviewHarness }> {
    await seedQueueFixtures();
    await seedPublication(publicationId, status, 10_010, lastError);
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9100, fromId, `/queue ${publicationId}`),
    );
    expect(outcome).toBe('processed');
    return { ...bot, harness };
  }

  it('a pending row is cancellable: the button carries ONE opaque a: token', async () => {
    const bot = await detailHarnessFor('pub-pending-1', 'pending');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toContain('pending');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(1);
    expect(bot.sends[0]!.keyboardTokens[0]).toMatch(/^a:[A-Za-z0-9_-]{16,43}$/);
  });

  it('a failed (parked) row is cancellable and keeps its classifier code visible', async () => {
    const bot = await detailHarnessFor('pub-failed-1', 'failed', OWNER_ID, 'telegram_timeout');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toContain('telegram_timeout');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(1);
  });

  it('a claimed row refuses the disposition in_flight — NO button is minted', async () => {
    const bot = await detailHarnessFor('pub-claimed-1', 'claimed');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(0);
    expect(bot.sends[0]!.text).toContain('in flight');
  });

  it('a publishing row refuses the disposition in_flight — NO button', async () => {
    const bot = await detailHarnessFor('pub-publishing-1', 'publishing');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(0);
    expect(bot.sends[0]!.text).toContain('in flight');
  });

  it('a published row refuses the disposition (the supersede flow owns it) — NO button', async () => {
    const bot = await detailHarnessFor('pub-published-1', 'published');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(0);
    expect(bot.sends[0]!.text).toContain('published');
  });

  it('the terminal rows refuse the disposition — NO button', async () => {
    await seedQueueFixtures();
    const terminalStatuses = ['dead_letter', 'cancelled', 'superseded'] as const;
    for (const status of terminalStatuses) {
      await seedPublication(`pub-term-${status}`, status, 10_010);
    }
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    let seq = 9110;
    for (const status of terminalStatuses) {
      const outcome = await harness.ingress.processUpdate(
        privateMessage(seq++, OWNER_ID, `/queue pub-term-${status}`),
      );
      expect(outcome).toBe('processed');
      expect(bot.sends[bot.sends.length - 1]!.keyboardTokens).toHaveLength(0);
      expect(bot.sends[bot.sends.length - 1]!.text).toContain(status);
    }
    expect(bot.sends).toHaveLength(terminalStatuses.length);
  });

  it('a viewer sees the detail (publication.view) but NEVER the cancel button', async () => {
    const bot = await detailHarnessFor('pub-viewer-1', 'pending', VIEWER_ID);
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toContain('pub-viewer-1');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(0);
  });

  it('an unknown publication id is an honest not-found — no fabricated detail', async () => {
    await seedQueueFixtures();
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9101, OWNER_ID, '/queue pub-missing'),
    );
    expect(outcome).toBe('processed');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).not.toContain('pending');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(0);
  });

  it('the detail flow never writes the publications table (observation until the callback)', async () => {
    await detailHarnessFor('pub-readonly-1', 'pending');
  });
});

describe('the disposition callback: the fenced cancel with the audit trail', () => {
  interface MintedView {
    readonly token: string;
    readonly harness: ReviewHarness;
    readonly bot: ReturnType<typeof createCapturingBotApi>;
  }

  /** The button token comes ONLY from the bot's REAL detail reply. */
  async function mintViaDetail(
    publicationId: string,
    status: string,
    fromId: number = CHIEF_EDITOR_ID,
    lastError: string | null = null,
  ): Promise<MintedView> {
    await seedQueueFixtures();
    await seedPublication(publicationId, status, 10_020, lastError);
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9200, fromId, `/queue ${publicationId}`),
    );
    expect(outcome).toBe('processed');
    const token = bot.sends[0]!.keyboardTokens[0]!.replace(/^a:/, '');
    return { token, harness, bot };
  }

  it('the happy path: pending → cancelled, ONE audit row, the token consumed, the honest answer', async () => {
    const { token, harness, bot } = await mintViaDetail('pub-cancel-1', 'pending');
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9201, CHIEF_EDITOR_ID, token),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toHaveLength(1);
    expect(bot.answers[0]).toMatch(/cancelled/i);
    expect(await publicationStatus('pub-cancel-1')).toBe('cancelled');
    expect(await tokenConsumed(token)).toBe(true);
    const audit = await env.DB.prepare(
      'SELECT actor_type, actor_id, action, target_id FROM audit_events WHERE id = ?',
    )
      .bind('queue-cancel:pub-cancel-1')
      .first<{ actor_type: string; actor_id: string; action: string; target_id: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor_type).toBe('admin');
    expect(audit!.actor_id).toBe(String(CHIEF_EDITOR_ID));
    expect(audit!.action).toBe('queue_publication_cancelled');
    expect(audit!.target_id).toBe('pub-cancel-1');
    // The disposition NEVER sends and NEVER touches the delivery evidence:
    const writes = harness.executor
      .stats()
      .sqlTexts.filter(
        (sql) =>
          (/publication_messages|media_usages/i.test(sql) && !/^\s*SELECT/i.test(sql)) ||
          /sendMessage/i.test(sql),
      );
    expect(writes).toEqual([]);
    expect(bot.sends.filter((s) => s.keyboardTokens.length > 0)).toHaveLength(1);
  });

  it('a failed parked row cancels WITH its classifier code preserved (the evidence never rewritten)', async () => {
    const { token, harness, bot } = await mintViaDetail(
      'pub-cancel-2',
      'failed',
      OWNER_ID,
      'telegram_timeout',
    );
    const outcome = await harness.ingress.processUpdate(callbackUpdate(9202, OWNER_ID, token));
    expect(outcome).toBe('processed');
    expect(bot.answers[0]).toMatch(/cancelled/i);
    expect(await publicationStatus('pub-cancel-2')).toBe('cancelled');
    const row = await env.DB.prepare('SELECT last_error FROM publications WHERE id = ?')
      .bind('pub-cancel-2')
      .first<{ last_error: string | null }>();
    expect(row!.last_error).toBe('telegram_timeout');
  });

  it('the token is SINGLE-USE: the second click answers invalid and changes nothing', async () => {
    const { token, harness, bot } = await mintViaDetail('pub-cancel-3', 'pending');
    const first = await harness.ingress.processUpdate(callbackUpdate(9203, CHIEF_EDITOR_ID, token));
    expect(first).toBe('processed');
    const second = await harness.ingress.processUpdate(
      callbackUpdate(9204, CHIEF_EDITOR_ID, token),
    );
    expect(second).toBe('processed');
    expect(bot.answers).toHaveLength(2);
    expect(bot.answers[1]).not.toMatch(/cancelled/i);
    expect(await publicationStatus('pub-cancel-3')).toBe('cancelled');
    const auditCount = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM audit_events WHERE target_id = ?',
    )
      .bind('pub-cancel-3')
      .first<{ total: number }>();
    expect(auditCount!.total).toBe(1);
  });

  it('a token bound to ONE user: a different admin clicking it gets invalid, nothing changes', async () => {
    const { token, harness, bot } = await mintViaDetail('pub-cancel-4', 'pending');
    const outcome = await harness.ingress.processUpdate(callbackUpdate(9205, VIEWER_ID, token));
    expect(outcome).toBe('processed');
    expect(bot.answers).toHaveLength(1);
    expect(bot.answers[0]).not.toContain('cancelled');
    expect(await publicationStatus('pub-cancel-4')).toBe('pending');
    expect(await tokenConsumed(token)).toBe(false);
  });

  it('the permission is RE-CHECKED at callback time: a revoked holder is refused, the row untouched', async () => {
    const { token, harness, bot } = await mintViaDetail('pub-cancel-5', 'pending');
    await env.DB.prepare('UPDATE admins SET role = ? WHERE telegram_user_id = ?')
      .bind('viewer', CHIEF_EDITOR_ID)
      .run();
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9206, CHIEF_EDITOR_ID, token),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toHaveLength(1);
    expect(bot.answers[0]).not.toContain('cancelled');
    expect(await publicationStatus('pub-cancel-5')).toBe('pending');
    expect(await tokenConsumed(token)).toBe(true);
    const audit = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM audit_events WHERE target_id = ?',
    )
      .bind('pub-cancel-5')
      .first<{ total: number }>();
    expect(audit!.total).toBe(0);
  });

  it('the FENCE is the authority: a row claimed between view and click answers not-cancellable with ZERO effect', async () => {
    const { token, harness, bot } = await mintViaDetail('pub-cancel-6', 'pending');
    await env.DB.prepare('UPDATE publications SET status = ? WHERE id = ?')
      .bind('claimed', 'pub-cancel-6')
      .run();
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9207, CHIEF_EDITOR_ID, token),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers[0]).not.toContain('cancelled');
    expect(await publicationStatus('pub-cancel-6')).toBe('claimed');
    const audit = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM audit_events WHERE target_id = ?',
    )
      .bind('pub-cancel-6')
      .first<{ total: number }>();
    expect(audit!.total).toBe(0);
  });

  it('an unknown token answers invalid honestly and consumes nothing', async () => {
    await seedQueueFixtures();
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9208, CHIEF_EDITOR_ID, 'nonexistenttoken12345'),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toHaveLength(1);
    expect(await tokenConsumed('nonexistenttoken12345')).toBe(false);
  });

  it('a FOREIGN action token is routed to its owner service, never consumed by the queue surface', async () => {
    await seedQueueFixtures();
    const foreign = 'foreigntokentest1234';
    await env.DB.prepare(
      `INSERT INTO admin_action_tokens (id, telegram_user_id, permission, action, target_type, target_id, payload_json, expires_at, consumed_at, created_at)
       VALUES (?, ?, 'draft.approve', 'admin_post.approve', 'admin_post_draft', 'draft-q-1', '{}', ?, NULL, ?)`,
    )
      .bind(foreign, CHIEF_EDITOR_ID, 1_760_000_600_000, 1_760_000_000_000)
      .run();
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    // The admin-post service is ABSENT in this harness: the dispatcher
    // routes admin_post.* there and fails RETRYABLY (the 503 rejection) —
    // never consuming the foreign token through the queue path.
    await expect(
      harness.ingress.processUpdate(callbackUpdate(9209, CHIEF_EDITOR_ID, foreign)),
    ).rejects.toThrow();
    expect(await tokenConsumed(foreign)).toBe(false);
    expect((await publicationStatus('pub-cancel-9')) ?? 'absent').toBe('absent');
  });

  it('an UNKNOWN action token answers invalid WITHOUT consuming (a future token can never be burned)', async () => {
    await seedQueueFixtures();
    const future = 'futuretoken12345678';
    await env.DB.prepare(
      `INSERT INTO admin_action_tokens (id, telegram_user_id, permission, action, target_type, target_id, payload_json, expires_at, consumed_at, created_at)
       VALUES (?, ?, 'system.view', 'future.thing', 'future', 'x', '{}', ?, NULL, ?)`,
    )
      .bind(future, CHIEF_EDITOR_ID, 1_760_000_600_000, 1_760_000_000_000)
      .run();
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9210, CHIEF_EDITOR_ID, future),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toHaveLength(1);
    expect(await tokenConsumed(future)).toBe(false);
  });

  it('a missing disposition service is a retryable wiring failure — never a silent skip', async () => {
    await seedQueueFixtures();
    await seedPublication('pub-wiring-1', 'pending', 10_030);
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      queueEnabled: true,
      queueWriteEnabled: true,
      omitQueueDispositionService: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress
      .processUpdate(privateMessage(9211, OWNER_ID, '/queue pub-wiring-1'))
      .catch((error: unknown) => {
        // The retryable wiring failure REJECTS with the 503-semantics
        // AppError — the webhook must not answer 200, Telegram redelivers.
        expect((error as { code?: string }).code).toBe('service_unavailable');
        return 'failed' as const;
      });
    expect(outcome).toBe('failed');
    expect(bot.sends).toHaveLength(0);
  });
});

describe('the flag-off byte-identical legacy behavior', () => {
  it('callbacks stay the legacy noop while the write flag is OFF (even with adminPost off too)', async () => {
    await seedQueueFixtures();
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ queueEnabled: true, botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9300, CHIEF_EDITOR_ID, 'anytokenvalue123456'),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toHaveLength(0);
    expect(bot.sends).toHaveLength(0);
  });
});
