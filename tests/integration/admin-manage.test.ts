import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  NOW,
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedAdmin,
} from '../helpers/review-test-fixtures';
import { parseAdminReviewConfig } from '../../src/shared/config/phase9';
import { ADMIN_MANAGE_STRINGS } from '../../src/admin/admin-manage-strings';
import { parseAdminManageArgument } from '../../src/admin/admin-manage-command';
import type { TelegramBotApiClient } from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';

/**
 * Issue #8 — the owner-only admin management surface over REAL workerd D1
 * (the Phase 9C shape): the flag family, the router grammar/RBAC family,
 * the list view, the add/remove/role confirm flows (apply + audit + the
 * fenced race honesty), replay/expiry/wrong-user rejection, owner
 * protection, and the flag-off byte-identical legacy behavior. The ONLY
 * artificial pieces are the fake Bot API and the counting executor
 * wrapper.
 */

const EDITOR_ID = 2000000002;
const REVIEWER_ID = 2000000003;
const CHIEF_EDITOR_ID = 2000000001;
const UNKNOWN_ID = 2000000006;

/** A fake Bot API that ALSO captures reply_markup and callback answers. */
function createCapturingBotApi(): {
  client: TelegramBotApiClient;
  sends: { chatId: number | string; text: string; keyboardTokens: string[] }[];
  answers: string[];
} {
  const sends: { chatId: number | string; text: string; keyboardTokens: string[] }[] = [];
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

async function adminRow(telegramUserId: number): Promise<{ role: string; status: string } | null> {
  const row = await env.DB.prepare('SELECT role, status FROM admins WHERE telegram_user_id = ?')
    .bind(telegramUserId)
    .first<{ role: string; status: string }>();
  return row ?? null;
}

async function tokenCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_action_tokens').first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

async function tokenConsumed(token: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT consumed_at FROM admin_action_tokens WHERE id = ?')
    .bind(token)
    .first<{ consumed_at: number | null }>();
  if (row === null) return false;
  return row.consumed_at !== null;
}

async function auditRows(): Promise<
  readonly { action: string; actor_id: string | null; target_id: string | null }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT action, actor_id, target_id FROM audit_events ORDER BY created_at ASC',
  ).all<{ action: string; actor_id: string | null; target_id: string | null }>();
  return results;
}

beforeEach(async () => {
  await freshDb();
});

describe('the ADMIN_MANAGE_ENABLED flag family (fail-closed, independent)', () => {
  it('enables ONLY on the exact "true" value', () => {
    expect(parseAdminReviewConfig({ ADMIN_MANAGE_ENABLED: 'true' }).config.adminManageEnabled).toBe(
      true,
    );
  });

  it.each([
    ['absent', {}],
    ['false', { ADMIN_MANAGE_ENABLED: 'false' }],
    ['truthy-looking "1"', { ADMIN_MANAGE_ENABLED: '1' }],
    ['truthy-looking "TRUE"', { ADMIN_MANAGE_ENABLED: 'TRUE' }],
    ['yes', { ADMIN_MANAGE_ENABLED: 'yes' }],
  ])('%s keeps the manage surface disabled', (_name, input) => {
    expect(parseAdminReviewConfig(input as Record<string, unknown>).config.adminManageEnabled).toBe(
      false,
    );
  });

  it('is INDEPENDENT of the other admin flags', () => {
    const only = parseAdminReviewConfig({ ADMIN_MANAGE_ENABLED: 'true' });
    expect(only.config.adminManageEnabled).toBe(true);
    expect(only.config.reviewEnabled).toBe(false);
    expect(only.config.queueEnabled).toBe(false);
    expect(only.config.queueWriteEnabled).toBe(false);
  });
});

describe('the /admins argument parser (pure grammar)', () => {
  it('parses the list form and rejects everything else', () => {
    expect(parseAdminManageArgument(undefined)).toEqual({ kind: 'list' });
    expect(parseAdminManageArgument('')).toEqual({ kind: 'list' });
    expect(parseAdminManageArgument('add 2000000002 editor')).toEqual({
      kind: 'add',
      targetUserId: 2000000002,
      role: 'editor',
    });
    expect(parseAdminManageArgument('remove 2000000002')).toEqual({
      kind: 'remove',
      targetUserId: 2000000002,
    });
    expect(parseAdminManageArgument('role 2000000002 reviewer')).toEqual({
      kind: 'role',
      targetUserId: 2000000002,
      role: 'reviewer',
    });
  });

  it('rejects usernames, the owner role, bad ids, extra tokens, and control characters', () => {
    const invalid = [
      'add @someone editor',
      'add 2000000002 owner',
      'role 2000000002 owner',
      'add 0 editor',
      'add 0123 editor',
      'add 99999999999999999 editor',
      'add 2000000002 editor extra',
      'add 2000000002',
      'add',
      'remove',
      'role 2000000002',
      'frobnicate 2000000002',
      'ADD 2000000002 editor',
      'add 2000000002 editor\nx',
      'add 2000000002\teditor\t',
    ];
    for (const remainder of invalid) {
      expect(parseAdminManageArgument(remainder)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('the router grammar/RBAC family for /admins', () => {
  it('with the flag OFF, /admins keeps the EXACT unknown-command noop for the owner', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(privateMessage(9101, OWNER_ID, '/admins'));
    expect(outcome).toBe('processed');
    expect(bot.sends).toHaveLength(0);
    expect(await tokenCount()).toBe(0);
  });

  it('with the flag OFF, /help never advertises /admins', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(9102, OWNER_ID, '/help'));
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).not.toContain('/admins');
  });

  it('an unknown actor gets the fixed English denial', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9103, UNKNOWN_ID, '/admins'),
    );
    expect(outcome).toBe('processed');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toBe('Access denied.');
    expect(await tokenCount()).toBe(0);
  });

  it('a non-owner admin gets the localized denial and ZERO admin writes', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9104, CHIEF_EDITOR_ID, '/admins add 2000000002 editor'),
    );
    expect(outcome).toBe('processed');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toBe(ADMIN_MANAGE_STRINGS.en.permissionDenied);
    expect(await tokenCount()).toBe(0);
    expect(await adminRow(EDITOR_ID)).toBeNull();
    const adminWrites = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /INSERT INTO admins|UPDATE admins/i.test(sql));
    expect(adminWrites).toEqual([]);
  });

  it('the surface is private-only; a group or edited message is a noop', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const groupOutcome = await harness.ingress.processUpdate(
      privateMessage(9105, OWNER_ID, '/admins', { chatType: 'group' }),
    );
    expect(groupOutcome).toBe('processed');
    expect(bot.sends).toHaveLength(0);
    const editedOutcome = await harness.ingress.processUpdate(
      privateMessage(9106, OWNER_ID, '/admins', { kind: 'edited_message' }),
    );
    expect(editedOutcome).toBe('processed');
    expect(bot.sends).toHaveLength(0);
  });

  it('grammar-invalid arguments get honest invalid usage and mint NO token', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const invalidInputs = [
      '/admins add',
      '/admins add abc editor',
      '/admins add 2000000002 owner',
      '/admins add 2000000002 editor extra',
      '/admins remove',
      '/admins role 2000000002',
      '/admins frobnicate',
    ];
    let seq = 9107;
    for (const text of invalidInputs) {
      const outcome = await harness.ingress.processUpdate(privateMessage(seq++, OWNER_ID, text));
      expect(outcome).toBe('processed');
      expect(bot.sends).toHaveLength(1);
      expect(bot.sends[0]!.text).toBe(ADMIN_MANAGE_STRINGS.en.invalidUsage);
      bot.sends.length = 0;
    }
    expect(await tokenCount()).toBe(0);
  });
});

describe('the /admins list view', () => {
  it('lists the bootstrap owner even when no admins row exists yet', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(privateMessage(9201, OWNER_ID, '/admins'));
    expect(outcome).toBe('processed');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toContain(ADMIN_MANAGE_STRINGS.en.listTitle);
    expect(bot.sends[0]!.text).toContain(String(OWNER_ID));
    expect(bot.sends[0]!.text).toContain('owner');
    expect(await adminRow(OWNER_ID)).toEqual({ role: 'owner', status: 'active' });
  });

  it('lists every admin with role and status', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    await seedAdmin(REVIEWER_ID, 'reviewer', 'disabled');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(9202, OWNER_ID, '/admins'));
    expect(bot.sends).toHaveLength(1);
    const text = bot.sends[0]!.text;
    expect(text).toContain(`${EDITOR_ID} · Role: editor · Status: active`);
    expect(text).toContain(`${REVIEWER_ID} · Role: reviewer · Status: disabled`);
  });

  it('/help advertises /admins to the owner only', async () => {
    await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(9203, OWNER_ID, '/help'));
    expect(bot.sends[0]!.text).toContain(ADMIN_MANAGE_STRINGS.en.helpAdminsLine);
    bot.sends.length = 0;
    await harness.ingress.processUpdate(privateMessage(9204, CHIEF_EDITOR_ID, '/help'));
    expect(bot.sends[0]!.text).not.toContain('/admins');
  });
});

describe('the add confirm flow', () => {
  it('mints confirm+cancel tokens, writes NOTHING, and applies + audits on confirm', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9301, OWNER_ID, '/admins add 2000000002 editor'),
    );
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toContain(ADMIN_MANAGE_STRINGS.en.confirmTitle);
    expect(bot.sends[0]!.text).toContain('2000000002');
    expect(bot.sends[0]!.text).toContain('editor');
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(2);
    // Nothing written yet — the command only mints tokens.
    expect(await adminRow(EDITOR_ID)).toBeNull();
    expect((await auditRows()).length).toBe(0);

    const [confirmToken, cancelToken] = bot.sends[0]!.keyboardTokens as [string, string];
    expect(confirmToken).not.toBe(cancelToken);
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9302, OWNER_ID, confirmToken.slice(2)),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.confirmedAdd]);
    expect(await adminRow(EDITOR_ID)).toEqual({ role: 'editor', status: 'active' });
    expect(await tokenConsumed(confirmToken.slice(2))).toBe(true);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      action: 'admin.added',
      actor_id: String(OWNER_ID),
      target_id: String(EDITOR_ID),
    });
  });

  it('replaying the confirm token answers invalid and audits NOTHING twice', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9311, OWNER_ID, '/admins add 2000000002 editor'),
    );
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    await harness.ingress.processUpdate(callbackUpdate(9312, OWNER_ID, confirmToken.slice(2)));
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.confirmedAdd]);
    const replay = await harness.ingress.processUpdate(
      callbackUpdate(9313, OWNER_ID, confirmToken.slice(2)),
    );
    expect(replay).toBe('processed');
    expect(bot.answers).toEqual([
      ADMIN_MANAGE_STRINGS.en.confirmedAdd,
      ADMIN_MANAGE_STRINGS.en.callbackInvalidToken,
    ]);
    expect((await auditRows()).length).toBe(1);
    expect(await adminRow(EDITOR_ID)).toEqual({ role: 'editor', status: 'active' });
  });

  it('the cancel button consumes its token and writes NOTHING', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9321, OWNER_ID, '/admins add 2000000002 editor'),
    );
    const [, cancelToken] = bot.sends[0]!.keyboardTokens as [string, string];
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9322, OWNER_ID, cancelToken.slice(2)),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.confirmedCancelled]);
    expect(await tokenConsumed(cancelToken.slice(2))).toBe(true);
    expect(await adminRow(EDITOR_ID)).toBeNull();
    expect((await auditRows()).length).toBe(0);
  });

  it('a token clicked by another user is invalid and writes NOTHING', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9331, OWNER_ID, '/admins add 2000000002 editor'),
    );
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9332, CHIEF_EDITOR_ID, confirmToken.slice(2)),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.callbackInvalidToken]);
    expect(await tokenConsumed(confirmToken.slice(2))).toBe(false);
    expect(await adminRow(EDITOR_ID)).toBeNull();
  });

  it('an expired token answers invalid and writes NOTHING', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9341, OWNER_ID, '/admins add 2000000002 editor'),
    );
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    await env.DB.prepare('UPDATE admin_action_tokens SET expires_at = ? WHERE id = ?')
      .bind(NOW - 1, confirmToken.slice(2))
      .run();
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9342, OWNER_ID, confirmToken.slice(2)),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.callbackInvalidToken]);
    expect(await adminRow(EDITOR_ID)).toBeNull();
    expect((await auditRows()).length).toBe(0);
  });

  it('a confirm after a concurrent change answers no-change with ZERO effect', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9351, OWNER_ID, '/admins add 2000000002 editor'),
    );
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    // A concurrent confirmation already added the admin.
    await seedAdmin(EDITOR_ID, 'editor');
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(9352, OWNER_ID, confirmToken.slice(2)),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.callbackNoChange]);
    expect((await auditRows()).length).toBe(0);
    expect(await adminRow(EDITOR_ID)).toEqual({ role: 'editor', status: 'active' });
  });

  it('adding the bootstrap owner is refused and mints NO token', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9361, OWNER_ID, `/admins add ${OWNER_ID} editor`),
    );
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]!.text).toBe(ADMIN_MANAGE_STRINGS.en.ownerProtected);
    expect(bot.sends[0]!.keyboardTokens).toHaveLength(0);
    expect(await tokenCount()).toBe(0);
  });

  it('adding an already-active admin answers honestly and mints NO token', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(EDITOR_ID, 'editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9371, OWNER_ID, '/admins add 2000000002 editor'),
    );
    expect(bot.sends[0]!.text).toBe(ADMIN_MANAGE_STRINGS.en.alreadyAdminSameRole);
    expect(await tokenCount()).toBe(0);
    await harness.ingress.processUpdate(
      privateMessage(9372, OWNER_ID, '/admins add 2000000002 reviewer'),
    );
    expect(bot.sends[1]!.text).toBe(ADMIN_MANAGE_STRINGS.en.alreadyAdminOtherRole);
    expect(await tokenCount()).toBe(0);
  });

  it('adding a disabled admin reactivates it on confirm', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(EDITOR_ID, 'editor', 'disabled');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9381, OWNER_ID, '/admins add 2000000002 reviewer'),
    );
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    await harness.ingress.processUpdate(callbackUpdate(9382, OWNER_ID, confirmToken.slice(2)));
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.confirmedReactivated]);
    expect(await adminRow(EDITOR_ID)).toEqual({ role: 'reviewer', status: 'active' });
    expect((await auditRows()).length).toBe(1);
  });
});

describe('the role-change and deactivate confirm flows', () => {
  it('role change applies + audits with the prior role', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(EDITOR_ID, 'editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9401, OWNER_ID, '/admins role 2000000002 reviewer'),
    );
    expect(bot.sends[0]!.text).toContain(ADMIN_MANAGE_STRINGS.en.confirmRoleLine);
    expect(bot.sends[0]!.text).toContain('editor');
    expect(bot.sends[0]!.text).toContain('reviewer');
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    await harness.ingress.processUpdate(callbackUpdate(9402, OWNER_ID, confirmToken.slice(2)));
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.confirmedRoleChanged]);
    expect(await adminRow(EDITOR_ID)).toEqual({ role: 'reviewer', status: 'active' });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('admin.role_changed');
    const meta = await env.DB.prepare('SELECT metadata_json FROM audit_events WHERE action = ?')
      .bind('admin.role_changed')
      .first<{ metadata_json: string }>();
    expect(JSON.parse(meta!.metadata_json)).toMatchObject({
      permission: 'admin.manage',
      role: 'reviewer',
      priorRole: 'editor',
    });
  });

  it('role change of an unknown, disabled, same-role, or owner id is honest', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(EDITOR_ID, 'editor');
    await seedAdmin(REVIEWER_ID, 'reviewer', 'disabled');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const cases: [string, string][] = [
      ['/admins role 2000000009 editor', ADMIN_MANAGE_STRINGS.en.notAnAdmin],
      ['/admins role 2000000003 editor', ADMIN_MANAGE_STRINGS.en.alreadyDisabled],
      ['/admins role 2000000002 editor', ADMIN_MANAGE_STRINGS.en.alreadyAdminSameRole],
      [`/admins role ${OWNER_ID} editor`, ADMIN_MANAGE_STRINGS.en.ownerProtected],
    ];
    let seq = 9411;
    for (const [text, expected] of cases) {
      await harness.ingress.processUpdate(privateMessage(seq++, OWNER_ID, text));
      expect(bot.sends.at(-1)!.text).toBe(expected);
    }
    expect(await tokenCount()).toBe(0);
    expect((await auditRows()).length).toBe(0);
  });

  it('deactivation applies + audits, and a second remove is already-disabled', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(EDITOR_ID, 'editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9421, OWNER_ID, '/admins remove 2000000002'),
    );
    const [confirmToken] = bot.sends[0]!.keyboardTokens as [string, string];
    await harness.ingress.processUpdate(callbackUpdate(9422, OWNER_ID, confirmToken.slice(2)));
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.confirmedDeactivated]);
    expect(await adminRow(EDITOR_ID)).toEqual({ role: 'editor', status: 'disabled' });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      action: 'admin.deactivated',
      actor_id: String(OWNER_ID),
      target_id: String(EDITOR_ID),
    });
    await harness.ingress.processUpdate(
      privateMessage(9423, OWNER_ID, '/admins remove 2000000002'),
    );
    expect(bot.sends.at(-1)!.text).toBe(ADMIN_MANAGE_STRINGS.en.alreadyDisabled);
    expect(await tokenCount()).toBe(2);
  });

  it('removing an unknown id or the bootstrap owner is honest', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(9431, OWNER_ID, '/admins remove 2000000009'),
    );
    expect(bot.sends[0]!.text).toBe(ADMIN_MANAGE_STRINGS.en.notAnAdmin);
    await harness.ingress.processUpdate(
      privateMessage(9432, OWNER_ID, `/admins remove ${OWNER_ID}`),
    );
    expect(bot.sends[1]!.text).toBe(ADMIN_MANAGE_STRINGS.en.ownerProtected);
    expect(await tokenCount()).toBe(0);
    expect((await auditRows()).length).toBe(0);
  });

  it('a foreign admins.* token is never burned by another service', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    // A token minted for a FUTURE admins action the service does not know.
    const future = 'futureadminstoken123';
    await env.DB.prepare(
      `INSERT INTO admin_action_tokens (id, telegram_user_id, permission, action, target_type, target_id, payload_json, expires_at, consumed_at, created_at)
       VALUES (?, ?, 'admin.manage', 'admins.confirm_future', 'admin', '2000000002', '{}', ?, NULL, ?)`,
    )
      .bind(future, OWNER_ID, NOW + 600_000, NOW)
      .run();
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ adminManageEnabled: true, botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(callbackUpdate(9441, OWNER_ID, future));
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_MANAGE_STRINGS.en.callbackInvalidToken]);
    expect(await tokenConsumed(future)).toBe(true);
    expect(await adminRow(EDITOR_ID)).toBeNull();
    expect((await auditRows()).length).toBe(0);
  });

  it('a missing manage service is a retryable wiring failure — never a silent skip', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      adminManageEnabled: true,
      omitAdminManageService: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress
      .processUpdate(privateMessage(9451, OWNER_ID, '/admins'))
      .catch((error: unknown) => {
        expect((error as { code?: string }).code).toBe('service_unavailable');
        return 'failed' as const;
      });
    expect(outcome).toBe('failed');
    expect(bot.sends).toHaveLength(0);
  });
});
