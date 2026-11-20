import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  NOW,
  OWNER_ID,
  buildReviewHarness,
  captureLogger,
  freshDb,
  privateMessage,
  seedAdmin,
} from '../helpers/review-test-fixtures';
import { parseAdminReviewConfig } from '../../src/shared/config/phase9';
import { ADMIN_PANEL_STRINGS } from '../../src/admin/panel-strings';
import { parseMenuArgument } from '../../src/admin/panel-command';
import { createAdminPanelService } from '../../src/application/admin-panel/admin-panel-service';
import {
  checkPublishGate,
  readPublishingSettings,
  readTodayCounts,
  recordOwnerPublication,
  recordPublication,
  setDailyCap,
  setPublishMode,
  triggerEventOnP0,
} from '../../src/adapters/db/publishing-settings-store';
import {
  DEFAULT_DAILY_CAP,
  canChangePublishingSettings,
  effectiveDailyCap,
  evaluatePublishGate,
  minGapMinutes,
  nextTehranDate,
  resolveEventState,
  tehranDateOf,
} from '../../src/domain/publishing/publishing-settings';
import { createAdminPostService } from '../../src/application/admin-post/admin-post-service';
import { findOpenCaptureSession } from '../../src/adapters/db/admin-post-store';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import type { TelegramBotApiClient } from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';

/**
 * Slice 3 — the /menu admin panel (mode toggle + adjustable daily cap +
 * event mode) over REAL workerd D1: the flag family, the router
 * grammar/RBAC family, the four screens, the single-use button flows
 * (apply + audit + the fenced race honesty), the Tehran-midnight budget
 * reset, the next-day cap rule, the P0 bypass, the mandatory event end,
 * and the paused inbound rejection. The ONLY artificial pieces are the
 * fake Bot API and the mutable test clock.
 */

const CHIEF_EDITOR_ID = 2000000001;
const EDITOR_ID = 2000000002;
const VIEWER_ID = 2000000004;
const UNKNOWN_ID = 2000000006;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** NOW is 2025-10-09 12:23 Tehran — the tests pin that date. */
const TODAY_TEHRAN = '2025-10-09';
const TOMORROW_TEHRAN = '2025-10-10';

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

async function auditRows(): Promise<
  readonly { action: string; actor_id: string | null; metadata_json: string }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT action, actor_id, metadata_json FROM audit_events ORDER BY created_at ASC',
  ).all<{ action: string; actor_id: string | null; metadata_json: string }>();
  return results;
}

async function settingsRow(key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value_json FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value_json: string }>();
  return row?.value_json ?? null;
}

async function tokenConsumed(token: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT consumed_at FROM admin_action_tokens WHERE id = ?')
    .bind(token)
    .first<{ consumed_at: number | null }>();
  if (row === null) return false;
  return row.consumed_at !== null;
}

async function sessionCountFor(telegramUserId: number): Promise<number> {
  // Capture sessions live in the settings table (admin_post_capture:<id>),
  // not in admin_sessions — count the open session through the store.
  const session = await findOpenCaptureSession(createDbExecutor(env.DB), telegramUserId);
  return session === null ? 0 : 1;
}

async function adminPostDraftCountFor(telegramUserId: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM admin_post_drafts WHERE created_by_user_id = ?',
  )
    .bind(telegramUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await freshDb();
});

describe('the ADMIN_PANEL_ENABLED flag family (fail-closed, independent)', () => {
  it('enables ONLY on the exact "true" value', () => {
    expect(parseAdminReviewConfig({ ADMIN_PANEL_ENABLED: 'true' }).config.panelEnabled).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['false', { ADMIN_PANEL_ENABLED: 'false' }],
    ['TRUE', { ADMIN_PANEL_ENABLED: 'TRUE' }],
    ['1', { ADMIN_PANEL_ENABLED: '1' }],
  ])('stays disabled for %s', (_label, envVars) => {
    expect(parseAdminReviewConfig(envVars).config.panelEnabled).toBe(false);
  });

  it('leaves the slice-2 ADMIN_MANAGE_ENABLED flag untouched (still off)', () => {
    expect(parseAdminReviewConfig({}).config.adminManageEnabled).toBe(false);
    expect(
      parseAdminReviewConfig({ ADMIN_MANAGE_ENABLED: 'false' }).config.adminManageEnabled,
    ).toBe(false);
  });
});

describe('the /menu argument grammar (pure)', () => {
  it('parses the main form and the three screens, rejects everything else', () => {
    expect(parseMenuArgument(undefined)).toEqual({ kind: 'main' });
    expect(parseMenuArgument('')).toEqual({ kind: 'main' });
    expect(parseMenuArgument('mode')).toEqual({ kind: 'screen', screen: 'mode' });
    expect(parseMenuArgument('cap')).toEqual({ kind: 'screen', screen: 'cap' });
    expect(parseMenuArgument('event')).toEqual({ kind: 'screen', screen: 'event' });
    expect(parseMenuArgument('bogus')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('mode cap')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('mode\ncap')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('MODE')).toEqual({ kind: 'invalid' });
  });
});

describe('the publishing-settings domain (pure)', () => {
  it('pins the Tehran dates of the fixed test clock', () => {
    expect(tehranDateOf(NOW)).toBe(TODAY_TEHRAN);
    expect(tehranDateOf(NOW + DAY_MS)).toBe(TOMORROW_TEHRAN);
    expect(nextTehranDate(TODAY_TEHRAN)).toBe(TOMORROW_TEHRAN);
    expect(nextTehranDate('2025-12-31')).toBe('2026-01-01');
  });

  it('keeps today’s cap on the day of the change, applies the new one tomorrow', () => {
    const record = { cap: 15, previousCap: 15, changedTehranDate: '' };
    expect(effectiveDailyCap(record, TODAY_TEHRAN)).toBe(15);
    const changed = {
      cap: 12,
      previousCap: effectiveDailyCap(record, TODAY_TEHRAN),
      changedTehranDate: TODAY_TEHRAN,
    };
    expect(effectiveDailyCap(changed, TODAY_TEHRAN)).toBe(15);
    expect(effectiveDailyCap(changed, TOMORROW_TEHRAN)).toBe(12);
  });

  it('only owner and chief_editor may change publishing settings', () => {
    expect(canChangePublishingSettings('owner')).toBe(true);
    expect(canChangePublishingSettings('chief_editor')).toBe(true);
    for (const role of ['editor', 'reviewer', 'source_manager', 'viewer'] as const) {
      expect(canChangePublishingSettings(role)).toBe(false);
    }
  });

  it('paused denies everything, P0 bypasses the cap, the cap binds the rest', () => {
    const base = { eventActive: false, todayCounted: 0, cap: 15, priority: 'normal' as const };
    expect(evaluatePublishGate({ ...base, mode: 'paused' }).allowed).toBe(false);
    expect(evaluatePublishGate({ ...base, mode: 'paused', priority: 'p0' })).toEqual({
      allowed: false,
      reason: 'paused',
    });
    expect(evaluatePublishGate({ ...base, mode: 'auto' })).toEqual({
      allowed: true,
      bypass: false,
      p0: false,
    });
    expect(evaluatePublishGate({ ...base, mode: 'auto', priority: 'p0' })).toEqual({
      allowed: true,
      bypass: true,
      p0: true,
    });
    expect(evaluatePublishGate({ ...base, mode: 'auto', todayCounted: 15 })).toEqual({
      allowed: false,
      reason: 'cap_reached',
    });
    expect(
      evaluatePublishGate({ ...base, mode: 'auto', todayCounted: 15, priority: 'p0' }),
    ).toEqual({
      allowed: true,
      bypass: true,
      p0: true,
    });
    expect(
      evaluatePublishGate({ ...base, mode: 'auto', eventActive: true, todayCounted: 99 }),
    ).toEqual({ allowed: true, bypass: false, p0: false });
  });

  it('resolves the mandatory event end: 6h timeout beats the 2h idle rule', () => {
    const record = {
      active: true,
      startedAtMs: NOW,
      startedBy: OWNER_ID,
      trigger: 'manual' as const,
      lastP0AtMs: NOW,
    };
    expect(resolveEventState(record, NOW + HOUR_MS)).toEqual({ active: true });
    expect(resolveEventState(record, NOW + 2 * HOUR_MS)).toEqual({ active: false, ended: 'idle' });
    const freshP0 = { ...record, lastP0AtMs: NOW + 5 * HOUR_MS };
    expect(resolveEventState(freshP0, NOW + 6 * HOUR_MS)).toEqual({
      active: false,
      ended: 'timeout',
    });
    expect(resolveEventState(null, NOW)).toEqual({ active: false, ended: 'off' });
    expect(resolveEventState({ ...record, active: false }, NOW)).toEqual({
      active: false,
      ended: 'off',
    });
  });

  it('shortens the min gap in an event (8–15 min) and keeps 25 min otherwise', () => {
    expect(minGapMinutes({ eventActive: false, priority: 'normal' })).toBe(25);
    expect(minGapMinutes({ eventActive: true, priority: 'normal' })).toBe(15);
    expect(minGapMinutes({ eventActive: false, priority: 'p1' })).toBe(8);
    expect(minGapMinutes({ eventActive: true, priority: 'p1' })).toBe(8);
  });
});

describe('the /menu router (flag-off and RBAC)', () => {
  it('keeps the exact unknown-command noop while the flag is OFF', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: false, botApi: bot.client });
    const outcome = await harness.ingress.processUpdate(privateMessage(101, OWNER_ID, '/menu'));
    expect(outcome).toBe('processed');
    expect(bot.sends).toHaveLength(0);
    const help = await harness.ingress.processUpdate(privateMessage(102, OWNER_ID, '/help'));
    expect(help).toBe('processed');
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]?.text).not.toContain('/menu');
  });

  it('denies unauthorized senders with the fixed minimal text', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(111, UNKNOWN_ID, '/menu'));
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]?.text).toBe('Access denied.');
  });

  it('ignores /menu in groups and on edited messages (stable noop, no feedback)', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(
      privateMessage(121, OWNER_ID, '/menu', { chatType: 'group', chatId: -100 }),
    );
    await harness.ingress.processUpdate(
      privateMessage(122, OWNER_ID, '/menu', { kind: 'edited_message' }),
    );
    expect(bot.sends).toHaveLength(0);
  });

  it('answers invalid arguments with the honest usage text, before any read', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(131, OWNER_ID, '/menu bogus'));
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]?.text).toContain('/menu mode');
  });

  it('advertises /menu in /help while the flag is ON', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(141, OWNER_ID, '/help'));
    expect(bot.sends).toHaveLength(1);
    expect(bot.sends[0]?.text).toContain('/menu');
  });

  it('a missing panel service is a retryable wiring failure — never a silent skip', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({
      panelEnabled: true,
      omitAdminPanelService: true,
      botApi: bot.client,
    });
    const outcome = await harness.ingress
      .processUpdate(privateMessage(151, OWNER_ID, '/menu'))
      .catch((error: unknown) => {
        expect((error as { code?: string }).code).toBe('service_unavailable');
        return 'failed' as const;
      });
    expect(outcome).toBe('failed');
    expect(bot.sends).toHaveLength(0);
  });
});

describe('the /menu screens over the real ingress', () => {
  it('shows the defaults on the main panel: auto, cap 15, 0 of 15, event off', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(201, OWNER_ID, '/menu'));
    expect(bot.sends).toHaveLength(1);
    const main = bot.sends[0]!;
    expect(main.text).toContain('auto');
    expect(main.text).toContain('0 of 15');
    expect(main.text).toContain('off');
    expect(main.keyboardTokens).toHaveLength(3);
  });

  it('opens the mode screen with four modes and the current one marked', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(211, OWNER_ID, '/menu mode'));
    expect(bot.sends).toHaveLength(1);
    const screen = bot.sends[0]!;
    expect(screen.text).toContain('auto — scheduled + direct, no preview');
    expect(screen.text).toContain('paused — nothing publishes');
    expect(screen.text).toContain('● current');
    expect(screen.keyboardTokens).toHaveLength(4);
  });

  it('a viewer may view the panel but may not change the mode', async () => {
    await seedAdmin(VIEWER_ID, 'viewer');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(221, VIEWER_ID, '/menu mode'));
    expect(bot.sends).toHaveLength(1);
    const modeToken = bot.sends[0]!.keyboardTokens[3]!;
    await harness.ingress.processUpdate(callbackUpdate(222, VIEWER_ID, modeToken.slice(2)));
    expect(bot.answers).toEqual([ADMIN_PANEL_STRINGS.en.callbackPermissionDenied]);
    expect(await tokenConsumed(modeToken.slice(2))).toBe(true);
    const settings = await readPublishingSettings(createDbExecutor(env.DB));
    expect(settings.mode).toBe('auto');
    expect((await auditRows()).length).toBe(0);
  });

  it('the owner sets paused from the mode screen: D1 write + audit + single-use token', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(231, OWNER_ID, '/menu mode'));
    const pausedToken = bot.sends[0]!.keyboardTokens[3]!;
    const outcome = await harness.ingress.processUpdate(
      callbackUpdate(232, OWNER_ID, pausedToken.slice(2)),
    );
    expect(outcome).toBe('processed');
    expect(bot.answers).toEqual([ADMIN_PANEL_STRINGS.en.callbackModeSet.paused]);
    expect(await tokenConsumed(pausedToken.slice(2))).toBe(true);
    const modeJson = await settingsRow('publishing.mode');
    expect(modeJson).not.toBeNull();
    expect(JSON.parse(modeJson!).mode).toBe('paused');
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('settings.mode_changed');
    expect(audits[0]?.actor_id).toBe(String(OWNER_ID));
    expect(JSON.parse(audits[0]!.metadata_json).mode).toBe('paused');
    // A replayed click answers invalid and writes nothing more.
    await harness.ingress.processUpdate(callbackUpdate(233, OWNER_ID, pausedToken.slice(2)));
    expect(bot.answers).toEqual([
      ADMIN_PANEL_STRINGS.en.callbackModeSet.paused,
      ADMIN_PANEL_STRINGS.en.callbackInvalidToken,
    ]);
    expect((await auditRows()).length).toBe(1);
  });

  it('a Mode button opens a fresh mode screen message (show callbacks re-render)', async () => {
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(241, OWNER_ID, '/menu'));
    const modeToken = bot.sends[0]!.keyboardTokens[0]!;
    await harness.ingress.processUpdate(callbackUpdate(242, OWNER_ID, modeToken.slice(2)));
    expect(bot.sends).toHaveLength(2);
    expect(bot.sends[1]?.text).toContain('Publishing mode');
    expect(bot.sends[1]?.keyboardTokens).toHaveLength(4);
  });

  it('the chief editor may change the cap; an editor may not', async () => {
    await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
    await seedAdmin(EDITOR_ID, 'editor');
    const bot = createCapturingBotApi();
    const harness = buildReviewHarness({ panelEnabled: true, botApi: bot.client });
    await harness.ingress.processUpdate(privateMessage(251, CHIEF_EDITOR_ID, '/menu cap'));
    const capToken = bot.sends[0]!.keyboardTokens[0]!;
    await harness.ingress.processUpdate(callbackUpdate(252, CHIEF_EDITOR_ID, capToken.slice(2)));
    expect(bot.answers).toEqual([ADMIN_PANEL_STRINGS.en.callbackCapSet(12, TOMORROW_TEHRAN)]);
    const capJson = await settingsRow('publishing.daily_cap');
    expect(JSON.parse(capJson!).cap).toBe(12);
    // The editor's own cap screen mints editor-bound tokens; the click is denied.
    await harness.ingress.processUpdate(privateMessage(253, EDITOR_ID, '/menu cap'));
    const editorToken = bot.sends[1]!.keyboardTokens[0]!;
    await harness.ingress.processUpdate(callbackUpdate(254, EDITOR_ID, editorToken.slice(2)));
    expect(bot.answers).toEqual([
      ADMIN_PANEL_STRINGS.en.callbackCapSet(12, TOMORROW_TEHRAN),
      ADMIN_PANEL_STRINGS.en.callbackPermissionDenied,
    ]);
    expect(JSON.parse((await settingsRow('publishing.daily_cap'))!).cap).toBe(12);
    expect((await auditRows()).filter((row) => row.action === 'settings.cap_changed')).toHaveLength(
      1,
    );
  });
});

describe('the daily cap: next-day rule, D1 counter, Tehran-midnight reset, P0 bypass', () => {
  it('rejects out-of-range caps at the store boundary', async () => {
    const executor = createDbExecutor(env.DB);
    expect(await setDailyCap(executor, { cap: 11, actorId: OWNER_ID, nowMs: NOW })).toEqual({
      kind: 'invalid',
    });
    expect(await setDailyCap(executor, { cap: 19, actorId: OWNER_ID, nowMs: NOW })).toEqual({
      kind: 'invalid',
    });
    expect(await settingsRow('publishing.daily_cap')).toBeNull();
  });

  it('a cap change keeps today’s cap and applies from the next Tehran day', async () => {
    const clock = fixedClock(NOW);
    const harness = buildReviewHarness({ panelEnabled: true });
    const panel = createAdminPanelService({
      executor: harness.executor,
      clock,
      ownerTelegramId: OWNER_ID,
    });
    const capScreen = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'cap',
    });
    expect(capScreen.text).toContain('Cap in force today: 15');
    const token12 = capScreen.buttons![0]![0]!.callbackData.slice(2);
    const changed = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: token12,
    });
    expect(changed).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackCapSet(12, TOMORROW_TEHRAN),
    });
    const mainToday = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(mainToday.text).toContain('Daily cap: 15');
    expect(mainToday.text).toContain('New cap from tomorrow: 12');
    clock.advance(DAY_MS);
    const mainTomorrow = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(mainTomorrow.text).toContain('Daily cap: 12');
    expect(mainTomorrow.text).not.toContain('New cap from tomorrow');
  });

  it('counts publications on D1 and resets at 00:00 Tehran', async () => {
    const executor = createDbExecutor(env.DB);
    expect(await readTodayCounts(executor, { nowMs: NOW })).toEqual({
      tehranDate: TODAY_TEHRAN,
      counted: 0,
      p0Bypass: 0,
      owner: 0,
      published: 0,
    });
    await recordPublication(executor, { isP0: false, nowMs: NOW });
    await recordPublication(executor, { isP0: false, nowMs: NOW });
    await recordPublication(executor, { isP0: true, nowMs: NOW });
    expect(await readTodayCounts(executor, { nowMs: NOW })).toEqual({
      tehranDate: TODAY_TEHRAN,
      counted: 2,
      p0Bypass: 1,
      owner: 0,
      published: 3,
    });
    expect(await readTodayCounts(executor, { nowMs: NOW + DAY_MS })).toEqual({
      tehranDate: TOMORROW_TEHRAN,
      counted: 0,
      p0Bypass: 0,
      owner: 0,
      published: 0,
    });
  });

  it('counts owner-sent inbound posts separately: visible in stats, never consuming the cap', async () => {
    const executor = createDbExecutor(env.DB);
    await recordOwnerPublication(executor, { nowMs: NOW });
    await recordOwnerPublication(executor, { nowMs: NOW });
    const counts = await readTodayCounts(executor, { nowMs: NOW });
    expect(counts).toEqual({
      tehranDate: TODAY_TEHRAN,
      counted: 0,
      p0Bypass: 0,
      owner: 2,
      published: 2,
    });
    // The gate still sees an empty cap: owner posts never consume it.
    const gate = await checkPublishGate(executor, { priority: 'normal', nowMs: NOW });
    expect(gate.decision).toEqual({ allowed: true, bypass: false, p0: false });
    expect(gate.counted).toBe(0);
  });

  it('the cap binds at 15, a P0 still publishes past it and is marked', async () => {
    const executor = createDbExecutor(env.DB);
    for (let i = 0; i < DEFAULT_DAILY_CAP; i++) {
      await recordPublication(executor, { isP0: false, nowMs: NOW });
    }
    const atCap = await checkPublishGate(executor, { priority: 'normal', nowMs: NOW });
    expect(atCap.decision).toEqual({ allowed: false, reason: 'cap_reached' });
    expect(atCap.counted).toBe(15);
    expect(atCap.published).toBe(15);
    const p0 = await checkPublishGate(executor, { priority: 'p0', nowMs: NOW });
    expect(p0.decision).toEqual({ allowed: true, bypass: true, p0: true });
    await recordPublication(executor, { isP0: true, nowMs: NOW });
    const after = await readTodayCounts(executor, { nowMs: NOW });
    expect(after).toEqual({
      tehranDate: TODAY_TEHRAN,
      counted: 15,
      p0Bypass: 1,
      owner: 0,
      published: 16,
    });
  });
});

describe('event mode: manual toggle, P0 trigger, mandatory end', () => {
  it('the owner turns event mode on: the cap is lifted while it is active', async () => {
    const clock = fixedClock(NOW);
    const harness = buildReviewHarness({ panelEnabled: true });
    const panel = createAdminPanelService({
      executor: harness.executor,
      clock,
      ownerTelegramId: OWNER_ID,
    });
    const eventScreen = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'event',
    });
    expect(eventScreen.text).toContain('Event mode is off.');
    const onToken = eventScreen.buttons![0]![0]!.callbackData.slice(2);
    const turned = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: onToken,
    });
    expect(turned).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackEventOn,
    });
    const main = await panel.main({ telegramUserId: OWNER_ID, role: 'owner', uiLanguage: 'en' });
    expect(main.text).toContain('Event mode: ON');
    expect(main.text).toContain('the daily cap is lifted');
    const executor = createDbExecutor(env.DB);
    for (let i = 0; i < DEFAULT_DAILY_CAP; i++) {
      await recordPublication(executor, { isP0: false, nowMs: NOW });
    }
    const gate = await checkPublishGate(executor, { priority: 'normal', nowMs: NOW });
    expect(gate.decision).toEqual({ allowed: true, bypass: false, p0: false });
    expect(gate.eventActive).toBe(true);
    expect((await auditRows()).map((row) => row.action)).toContain('settings.event_changed');
  });

  it('auto-offs after 6 hours even with a fresh P0 at hour 5', async () => {
    const clock = fixedClock(NOW);
    const harness = buildReviewHarness({ panelEnabled: true });
    const panel = createAdminPanelService({
      executor: harness.executor,
      clock,
      ownerTelegramId: OWNER_ID,
    });
    expect(await panel.noteP0({ nowMs: NOW })).toEqual({ kind: 'activated' });
    expect((await auditRows()).map((row) => row.action)).toContain('settings.event_auto_triggered');
    // Fresh P0s keep the idle clock restarted, so the event survives to
    // the 6-hour deadline instead of idling off at hour 2 (refreshes land
    // 100 minutes apart — inside the 2-hour idle window).
    clock.advance(100 * 60 * 1000);
    expect(await panel.noteP0({ nowMs: clock.now() })).toEqual({ kind: 'refreshed' });
    clock.advance(100 * 60 * 1000);
    expect(await panel.noteP0({ nowMs: clock.now() })).toEqual({ kind: 'refreshed' });
    clock.advance(100 * 60 * 1000);
    expect(await panel.noteP0({ nowMs: clock.now() })).toEqual({ kind: 'refreshed' });
    clock.advance(HOUR_MS);
    const main = await panel.main({ telegramUserId: OWNER_ID, role: 'owner', uiLanguage: 'en' });
    expect(main.text).toContain('Event mode: off');
    const audits = await auditRows();
    const autoOff = audits.find((row) => row.action === 'settings.event_auto_off');
    expect(autoOff).toBeDefined();
    expect(JSON.parse(autoOff!.metadata_json).reason).toBe('timeout');
  });

  it('auto-offs after 2 hours with no fresh P0, and a fresh P0 restarts the idle clock', async () => {
    const clock = fixedClock(NOW);
    const harness = buildReviewHarness({ panelEnabled: true });
    const panel = createAdminPanelService({
      executor: harness.executor,
      clock,
      ownerTelegramId: OWNER_ID,
    });
    const eventScreen = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'event',
    });
    const onToken = eventScreen.buttons![0]![0]!.callbackData.slice(2);
    await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: onToken,
    });
    clock.advance(119 * 60 * 1000);
    const stillOn = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(stillOn.text).toContain('Event mode: ON');
    expect(await panel.noteP0({ nowMs: clock.now() })).toEqual({ kind: 'refreshed' });
    clock.advance(119 * 60 * 1000);
    const stillOnAgain = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(stillOnAgain.text).toContain('Event mode: ON');
    clock.advance(2 * 60 * 1000);
    const off = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(off.text).toContain('Event mode: off');
    const autoOff = (await auditRows()).find((row) => row.action === 'settings.event_auto_off');
    expect(autoOff).toBeDefined();
    expect(JSON.parse(autoOff!.metadata_json).reason).toBe('idle');
  });

  it('the owner turns event mode off by hand before either deadline', async () => {
    const clock = fixedClock(NOW);
    const harness = buildReviewHarness({ panelEnabled: true });
    const panel = createAdminPanelService({
      executor: harness.executor,
      clock,
      ownerTelegramId: OWNER_ID,
    });
    await panel.noteP0({ nowMs: NOW });
    const eventScreen = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'event',
    });
    expect(eventScreen.text).toContain('Event mode is ON');
    const offToken = eventScreen.buttons![0]![0]!.callbackData.slice(2);
    const turned = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: offToken,
    });
    expect(turned).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackEventOff,
    });
    const settings = await readPublishingSettings(createDbExecutor(env.DB));
    expect(settings.event?.active).toBe(false);
  });
});

describe('paused mode rejects inbound posts (not queued)', () => {
  it('startSession answers “bot is off” and opens no session', async () => {
    const executor = createDbExecutor(env.DB);
    await setPublishMode(executor, { mode: 'paused', actorId: OWNER_ID, nowMs: NOW });
    const { logger } = captureLogger();
    const adminPost = createAdminPostService({
      executor,
      clock: fixedClock(NOW),
      logger,
      config: { livePublishEnabled: false, destination: '@pixellores' },
    });
    const result = await adminPost.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9001,
    });
    expect(result.kind).toBe('reply');
    if (result.kind === 'reply') {
      expect(result.text).toContain('The bot is off (paused)');
    }
    expect(await sessionCountFor(OWNER_ID)).toBe(0);
  });

  it('capture inside an open session is rejected and saves no draft', async () => {
    const executor = createDbExecutor(env.DB);
    const { logger } = captureLogger();
    const adminPost = createAdminPostService({
      executor,
      clock: fixedClock(NOW),
      logger,
      config: { livePublishEnabled: false, destination: '@pixellores' },
    });
    await adminPost.startSession({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9011,
    });
    expect(await sessionCountFor(OWNER_ID)).toBe(1);
    await setPublishMode(executor, { mode: 'paused', actorId: OWNER_ID, nowMs: NOW });
    const result = await adminPost.capture({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      updateId: 9012,
      kind: 'message',
      text: 'a raw post',
      hasText: true,
      richText: undefined,
      media: undefined,
      richCaption: undefined,
      inMediaGroup: false,
      hasMediaAttachment: false,
    });
    expect(result.kind).toBe('reply');
    if (result.kind === 'reply') {
      expect(result.text).toContain('The bot is off (paused)');
    }
    expect(await adminPostDraftCountFor(OWNER_ID)).toBe(0);
  });

  it('the gate denies even a P0 while paused', async () => {
    const executor = createDbExecutor(env.DB);
    await setPublishMode(executor, { mode: 'paused', actorId: OWNER_ID, nowMs: NOW });
    const gate = await checkPublishGate(executor, { priority: 'p0', nowMs: NOW });
    expect(gate.decision).toEqual({ allowed: false, reason: 'paused' });
    expect(await triggerEventOnP0(executor, { nowMs: NOW })).toEqual({ kind: 'activated' });
    const stillPaused = await checkPublishGate(executor, { priority: 'p0', nowMs: NOW });
    expect(stillPaused.decision).toEqual({ allowed: false, reason: 'paused' });
  });
});
