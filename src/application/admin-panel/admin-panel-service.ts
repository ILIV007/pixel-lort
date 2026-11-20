/**
 * Slice 3 — the Telegram admin panel service (`/menu`): the composition
 * the ingress executes for the `panel_main` / `panel_screen` router
 * actions and for the `panel.*` token callbacks (the Phase 9C shape: the
 * router NEVER queries D1; the injected service does).
 *
 * SCREENS (one job per screen, max 3–4 buttons per screen):
 * - main: current mode, daily cap, "today X of Y published", event status
 *   + 3 buttons (Mode / Daily cap / Event mode). Event mode is ALWAYS
 *   visible here while active.
 * - mode: the four modes with a one-line description each; the current
 *   mode is marked. 4 buttons, no back button (the text points to /menu).
 * - cap: the cap in force today, "today X of Y", the pending next-day cap
 *   when one exists + 3 preset buttons (12/15/18) and Back.
 * - event: the event status + the ON/OFF toggle and Back.
 *
 * VIEWING is open to every authorized admin (all roles hold
 * `dashboard.view`); CHANGING mode/cap/event is owner + chief_editor
 * ONLY (the slice-3 contract — enforced here at callback time, defense
 * in depth behind the router; other roles get the clear denial toast and
 * NOTHING is written).
 *
 * CALLBACKS: every button carries a single-use, user-bound, expiring
 * token (10 min) through the Phase 2A machinery; the intent lives in
 * the token's server-side payload (never trusted from the callback).
 * Show buttons answer with a FRESH screen message (new tokens); set
 * buttons apply immediately and answer with a toast — the same shape as
 * the admin-manage confirm flow, minus the confirm step (a mode/cap/
 * event change is a reversible setting, and every change is audited).
 *
 * EVENT LAZY EXPIRY: there is no cron that owns event auto-off. Every
 * panel read (and every callback) settles the event first: a stored-
 * active event past either deadline is persisted as off WITH its
 * `settings.event_auto_off` audit event, and renders as off.
 *
 * The service NEVER sends anything itself and NEVER publishes: it only
 * returns typed reply/answer results for the ingress to deliver. No
 * posts are sent by this slice.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import {
  checkPublishGate,
  expireEventMode,
  readPublishingSettings,
  readTodayCounts,
  setDailyCap,
  setEventMode,
  setPublishMode,
  triggerEventOnP0,
  type PublishGateCheck,
  type TodayCounts,
} from '../../adapters/db/publishing-settings-store';
import { consumeActionToken, issueActionToken } from '../../adapters/telegram/action-tokens';
import { ensureOwnerRow } from '../../adapters/db/admin-manage-store';
import { formatCallbackData } from '../../admin/callback-tokens';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import { ADMIN_PANEL_STRINGS, type PanelScreen } from '../../admin/panel-strings';
import {
  DEFAULT_DAILY_CAP,
  PUBLISH_MODES,
  canChangePublishingSettings,
  effectiveDailyCap,
  isPublishMode,
  isValidDailyCap,
  nextTehranDate,
  resolveEventState,
  tehranDateOf,
  type PublishMode,
} from '../../domain/publishing/publishing-settings';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import type { AdminUiLanguage } from '../../admin/ui-language';
import { randomToken } from '../../domain/admin-post/fingerprint';
import type { ChannelPinRow, ChannelPostListRow } from '../../adapters/db/post-management-store';
import type { PostManagementService } from '../publishing/post-management-service';
import type { ChannelPostRefType } from '../../domain/publishing/post-management';

/** The permission every panel token carries (held by every admin role). */
export const ADMIN_PANEL_TOKEN_PERMISSION = 'dashboard.view';

/** Stable action descriptors stored in admin_action_tokens rows. */
export const ADMIN_PANEL_TOKEN_ACTIONS = {
  showMain: 'panel.show_main',
  showMode: 'panel.show_mode',
  showCap: 'panel.show_cap',
  showEvent: 'panel.show_event',
  showPosts: 'panel.show_posts',
  showPost: 'panel.show_post',
  setMode: 'panel.set_mode',
  setCap: 'panel.set_cap',
  setEvent: 'panel.set_event',
  pinPost: 'panel.pin_post',
  unpinPost: 'panel.unpin_post',
  deleteRequest: 'panel.delete_request',
  deleteConfirm: 'panel.delete_confirm',
  setAutoPin: 'panel.set_auto_pin',
  setRetention: 'panel.set_retention',
  startEdit: 'panel.start_edit',
} as const;

/** The bounded token TTL of the panel buttons. */
export const ADMIN_PANEL_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The three cap presets on the cap screen (12 / 15 / 18). */
export const ADMIN_PANEL_CAP_PRESETS: readonly number[] = [12, 15, 18];

export type AdminPanelButtons = readonly (readonly {
  readonly text: string;
  readonly callbackData: string;
}[])[];

export interface AdminPanelReplyResult {
  readonly kind: 'reply';
  readonly text: TelegramSafeHtml;
  readonly buttons?: AdminPanelButtons;
}

export interface AdminPanelCallbackResult {
  readonly kind: 'answer';
  readonly callbackText: string;
}

export interface AdminPanelService {
  main(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AdminPanelReplyResult>;

  screen(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly screen: Exclude<PanelScreen, 'main'>;
  }): Promise<AdminPanelReplyResult>;

  handleCallback(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly token: string;
  }): Promise<AdminPanelCallbackResult | AdminPanelReplyResult>;

  /**
   * The auto-trigger seam for a REAL P0 (a game reveal, a surprise
   * release): the future P0 detector calls this, never the panel. It
   * activates an inactive event (trigger `auto`) or refreshes the idle
   * clock of an active one. No post is sent here.
   */
  noteP0(input: { readonly nowMs: number }): Promise<{ readonly kind: 'activated' | 'refreshed' }>;

  /**
   * The read-only gate check for a publish path (no write): settings +
   * today's counts + the RESOLVED event state. The future publish path
   * asks this before sending; the panel itself never publishes.
   */
  gate(input: {
    readonly priority: 'normal' | 'p1' | 'p0';
    readonly nowMs: number;
  }): Promise<PublishGateCheck>;
}

/** One post reference, as carried by the panel's post tokens. */
export interface PanelPostRef {
  readonly refType: ChannelPostRefType;
  readonly refId: string;
  readonly channelMessageId: number;
}

/** The posts-screen filter (all vs expired-only). */
export type PanelPostsFilter = 'all' | 'expired';

type AdminPanelPayload =
  | { readonly op: 'show'; readonly screen: PanelScreen; readonly filter?: PanelPostsFilter }
  | ({ readonly op: 'show_post' } & PanelPostRef)
  | ({ readonly op: 'pin_post' } & PanelPostRef)
  | { readonly op: 'unpin_post'; readonly channelMessageId: number }
  | ({ readonly op: 'delete_request' } & PanelPostRef)
  | ({ readonly op: 'delete_confirm' } & PanelPostRef)
  | { readonly op: 'set_auto_pin'; readonly enabled: boolean }
  | { readonly op: 'set_retention'; readonly enabled: boolean }
  | ({ readonly op: 'start_edit' } & PanelPostRef)
  | { readonly op: 'set_mode'; readonly mode: PublishMode }
  | { readonly op: 'set_cap'; readonly cap: number }
  | { readonly op: 'set_event'; readonly active: boolean };

interface PanelState {
  readonly mode: PublishMode;
  readonly capInForce: number;
  readonly pendingCap: number | null;
  readonly pendingEffectiveFrom: string | null;
  readonly eventActive: boolean;
  readonly counts: TodayCounts;
  readonly tehranDate: string;
  readonly activePin: ChannelPinRow | null;
}

function parsePostRef(record: Record<string, unknown>): PanelPostRef | null {
  const refType = record['refType'];
  const refId = record['refId'];
  const channelMessageId = record['channelMessageId'];
  if (
    (refType !== 'publication' && refType !== 'inbound') ||
    typeof refId !== 'string' ||
    refId.length === 0 ||
    typeof channelMessageId !== 'number' ||
    !Number.isSafeInteger(channelMessageId) ||
    channelMessageId <= 0
  ) {
    return null;
  }
  return { refType, refId, channelMessageId };
}

function parsePayload(payloadJson: string): AdminPanelPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.op === 'show' && typeof record.screen === 'string') {
    const screen = record.screen;
    if (
      screen === 'main' ||
      screen === 'mode' ||
      screen === 'cap' ||
      screen === 'event' ||
      screen === 'posts'
    ) {
      const filter = record['filter'];
      if (filter !== undefined && filter !== 'all' && filter !== 'expired') {
        return null;
      }
      return {
        op: 'show',
        screen,
        ...(filter !== undefined ? { filter: filter as PanelPostsFilter } : {}),
      };
    }
    return null;
  }
  if (
    record.op === 'show_post' ||
    record.op === 'pin_post' ||
    record.op === 'delete_request' ||
    record.op === 'delete_confirm' ||
    record.op === 'start_edit'
  ) {
    const ref = parsePostRef(record);
    return ref === null ? null : { op: record.op, ...ref };
  }
  if (record.op === 'unpin_post' && typeof record['channelMessageId'] === 'number') {
    const channelMessageId = record['channelMessageId'];
    if (!Number.isSafeInteger(channelMessageId) || channelMessageId <= 0) {
      return null;
    }
    return { op: 'unpin_post', channelMessageId };
  }
  if (record.op === 'set_auto_pin' && typeof record['enabled'] === 'boolean') {
    return { op: 'set_auto_pin', enabled: record['enabled'] };
  }
  if (record.op === 'set_retention' && typeof record['enabled'] === 'boolean') {
    return { op: 'set_retention', enabled: record['enabled'] };
  }
  if (record.op === 'set_mode' && typeof record.mode === 'string' && isPublishMode(record.mode)) {
    return { op: 'set_mode', mode: record.mode };
  }
  if (record.op === 'set_cap' && typeof record.cap === 'number' && isValidDailyCap(record.cap)) {
    return { op: 'set_cap', cap: record.cap };
  }
  if (record.op === 'set_event' && typeof record.active === 'boolean') {
    return { op: 'set_event', active: record.active };
  }
  return null;
}

export function createAdminPanelService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  /** The bootstrap owner id (server config) — the protected identity. */
  readonly ownerTelegramId?: number;
  /**
   * Slice 6 — the post-management service behind the posts screens.
   * OPTIONAL: without it the posts screens answer "unavailable"
   * honestly and the mode/cap/event screens keep working untouched.
   */
  readonly postManagement?: PostManagementService;
}): AdminPanelService {
  const { executor, clock, ownerTelegramId, postManagement } = deps;

  /**
   * Settle the event's lazy expiry BEFORE any read or callback: a
   * stored-active event past either deadline is persisted as off (with
   * its audit event) so the stored record, the render, and the gate all
   * agree the event ended.
   */
  async function settleEvent(nowMs: number): Promise<void> {
    const settings = await readPublishingSettings(executor);
    const resolved = resolveEventState(settings.event, nowMs);
    if (!resolved.active && resolved.ended !== 'off') {
      await expireEventMode(executor, { reason: resolved.ended, nowMs });
    }
  }

  async function loadState(nowMs: number): Promise<PanelState> {
    await settleEvent(nowMs);
    const settings = await readPublishingSettings(executor);
    const counts = await readTodayCounts(executor, { nowMs });
    const tehranDate = tehranDateOf(nowMs);
    const eventActive = resolveEventState(settings.event, nowMs).active;
    const capInForce = effectiveDailyCap(settings.cap, tehranDate);
    const pending =
      settings.cap.changedTehranDate === tehranDate && settings.cap.cap !== capInForce;
    const activePin = postManagement === undefined ? null : await postManagement.activePin();
    return {
      mode: settings.mode,
      capInForce,
      pendingCap: pending ? settings.cap.cap : null,
      pendingEffectiveFrom: pending ? nextTehranDate(tehranDate) : null,
      eventActive,
      counts,
      tehranDate,
      activePin,
    };
  }

  async function mintToken(input: {
    readonly telegramUserId: number;
    readonly action: string;
    readonly payload: AdminPanelPayload;
    readonly nowMs: number;
  }): Promise<string> {
    // The owner row must exist BEFORE any token bound to the owner is
    // issued (the admin_action_tokens foreign key). Idempotent — the
    // admin-manage-service discipline.
    if (ownerTelegramId !== undefined) {
      await ensureOwnerRow(executor, { ownerTelegramId, nowMs: input.nowMs });
    }
    const token = randomToken();
    await issueActionToken(executor, {
      token,
      telegramUserId: input.telegramUserId,
      permission: ADMIN_PANEL_TOKEN_PERMISSION,
      action: input.action,
      targetType: 'panel',
      targetId: input.payload.op === 'show' ? input.payload.screen : input.payload.op,
      payloadJson: JSON.stringify(input.payload),
      expiresAtMs: input.nowMs + ADMIN_PANEL_TOKEN_TTL_MS,
      nowMs: input.nowMs,
    });
    return token;
  }

  async function showButtons(input: {
    readonly telegramUserId: number;
    readonly screen: PanelScreen;
    readonly nowMs: number;
  }): Promise<string> {
    const action =
      input.screen === 'main'
        ? ADMIN_PANEL_TOKEN_ACTIONS.showMain
        : input.screen === 'mode'
          ? ADMIN_PANEL_TOKEN_ACTIONS.showMode
          : input.screen === 'cap'
            ? ADMIN_PANEL_TOKEN_ACTIONS.showCap
            : input.screen === 'posts'
              ? ADMIN_PANEL_TOKEN_ACTIONS.showPosts
              : ADMIN_PANEL_TOKEN_ACTIONS.showEvent;
    return mintToken({
      telegramUserId: input.telegramUserId,
      action,
      payload: { op: 'show', screen: input.screen },
      nowMs: input.nowMs,
    });
  }

  function button(
    token: string,
    text: string,
  ): { readonly text: string; readonly callbackData: string } {
    return { text, callbackData: formatCallbackData(token) };
  }

  async function renderMain(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    // The "of cap" line counts CAP-CONSUMING publications only: owner-sent
    // inbound posts are visible in `published` but exempt from the cap
    // (slice 4), so they must never inflate the cap-usage display.
    const todayLine = state.eventActive
      ? `${s.mainTodayLabel} ${state.counts.published} published (cap lifted)`
      : `${s.mainTodayLabel} ${state.counts.counted} of ${state.capInForce} published`;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.mainTitle),
      escapeTelegramHtml(`${s.mainModeLabel} ${state.mode}`),
      escapeTelegramHtml(`${s.mainCapLabel} ${state.capInForce}`),
      escapeTelegramHtml(todayLine),
      escapeTelegramHtml(
        `${s.mainEventLabel} ${state.eventActive ? s.mainEventOn : s.mainEventOff}`,
      ),
      escapeTelegramHtml(
        `${s.mainPinLabel} ${state.activePin === null ? s.mainPinNone : `#${state.activePin.channelMessageId}`}`,
      ),
    ];
    if (state.eventActive) {
      parts.push(escapeTelegramHtml(s.eventActiveLine));
    }
    if (state.pendingCap !== null && state.pendingEffectiveFrom !== null) {
      parts.push(
        escapeTelegramHtml(
          `${s.capPendingLabel} ${state.pendingCap} (${state.pendingEffectiveFrom})`,
        ),
      );
    }
    const [modeToken, capToken, eventToken, postsToken] = await Promise.all([
      showButtons({ telegramUserId: input.telegramUserId, screen: 'mode', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'cap', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'event', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'posts', nowMs: input.nowMs }),
    ]);
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [
          button(modeToken, s.modeButton),
          button(capToken, s.capButton),
          button(eventToken, s.eventButton),
        ],
        [button(postsToken, s.postsButton)],
      ],
    };
  }

  async function renderMode(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const descriptions: Readonly<Record<PublishMode, string>> = {
      auto: s.modeAutoDesc,
      'safe-auto': s.modeSafeAutoDesc,
      approval: s.modeApprovalDesc,
      paused: s.modePausedDesc,
    };
    const parts: TelegramSafeHtml[] = [telegramBold(s.modeTitle)];
    for (const mode of PUBLISH_MODES) {
      const marker = mode === state.mode ? ` ${s.modeCurrentMarker}` : '';
      parts.push(escapeTelegramHtml(`${descriptions[mode]}${marker}`));
    }
    parts.push(escapeTelegramHtml(s.modeHint));
    const tokens = await Promise.all(
      PUBLISH_MODES.map((mode) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.setMode,
          payload: { op: 'set_mode', mode },
          nowMs: input.nowMs,
        }),
      ),
    );
    const labels: Readonly<Record<PublishMode, string>> = {
      auto: 'auto',
      'safe-auto': 'safe-auto',
      approval: 'approval',
      paused: 'paused',
    };
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [button(tokens[0]!, labels.auto), button(tokens[1]!, labels['safe-auto'])],
        [button(tokens[2]!, labels.approval), button(tokens[3]!, labels.paused)],
      ],
    };
  }

  async function renderCap(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.capTitle),
      escapeTelegramHtml(`${s.capCurrentLabel} ${state.capInForce}`),
      escapeTelegramHtml(`${s.capTodayLabel} ${state.counts.counted} of ${state.capInForce}`),
    ];
    if (state.pendingCap !== null && state.pendingEffectiveFrom !== null) {
      parts.push(
        escapeTelegramHtml(
          `${s.capPendingLabel} ${state.pendingCap} (${state.pendingEffectiveFrom})`,
        ),
      );
    }
    parts.push(escapeTelegramHtml(s.capHint));
    const presetTokens = await Promise.all(
      ADMIN_PANEL_CAP_PRESETS.map((cap) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.setCap,
          payload: { op: 'set_cap', cap },
          nowMs: input.nowMs,
        }),
      ),
    );
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        presetTokens.map((token, index) =>
          button(token, String(ADMIN_PANEL_CAP_PRESETS[index] ?? DEFAULT_DAILY_CAP)),
        ),
        [button(backToken, s.backButton)],
      ],
    };
  }

  async function renderEvent(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.eventTitle),
      escapeTelegramHtml(state.eventActive ? s.eventActiveLine : s.eventInactiveLine),
      escapeTelegramHtml(s.eventEndsLine),
      escapeTelegramHtml(s.eventHint),
    ];
    const toggleToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setEvent,
      payload: { op: 'set_event', active: !state.eventActive },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [button(toggleToken, state.eventActive ? s.eventOffButton : s.eventOnButton)],
        [button(backToken, s.backButton)],
      ],
    };
  }

  /**
   * Slice 6 — the housekeeping list screen. A LIST screen by nature: one
   * open-button per listed post (capped at 5), one filter toggle, the
   * auto-pin toggle, the retention toggle, and Back. The toggles live
   * here because they ARE the housekeeping screen's job — the mode/cap/
   * event screens keep their own 3–4-button shape untouched.
   */
  async function renderPosts(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly filter: PanelPostsFilter;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    if (postManagement === undefined) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.callbackPostMgmtUnavailable),
      };
    }
    const [posts, autoPinEnabled, retention] = await Promise.all([
      postManagement.listPosts({
        telegramUserId: input.telegramUserId,
        role: input.role,
        filters: { status: input.filter, limit: 5 },
      }),
      postManagement.autoPinEnabled(),
      postManagement.retentionRule(),
    ]);
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.postsTitle),
      escapeTelegramHtml(s.postsRetentionLine(retention)),
    ];
    if (posts.length === 0) {
      parts.push(escapeTelegramHtml(s.postsEmpty));
    }
    for (const post of posts) {
      parts.push(escapeTelegramHtml(formatPostLine(post)));
    }
    parts.push(escapeTelegramHtml(s.postsHint));
    const postTokens = await Promise.all(
      posts.map((post) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.showPost,
          payload: {
            op: 'show_post',
            refType: post.refType,
            refId: post.refId,
            channelMessageId: post.channelMessageId,
          },
          nowMs: input.nowMs,
        }),
      ),
    );
    const filterToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.showPosts,
      payload: {
        op: 'show',
        screen: 'posts',
        filter: input.filter === 'all' ? 'expired' : 'all',
      },
      nowMs: input.nowMs,
    });
    const autoPinToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setAutoPin,
      payload: { op: 'set_auto_pin', enabled: !autoPinEnabled },
      nowMs: input.nowMs,
    });
    const retentionToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setRetention,
      payload: { op: 'set_retention', enabled: !retention.enabled },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    const buttons: AdminPanelButtons = [
      ...postTokens.map((token, index) => [button(token, `#${posts[index]!.channelMessageId}`)]),
      [
        button(filterToken, input.filter === 'all' ? s.postsFilterExpired : s.postsFilterAll),
        button(autoPinToken, autoPinEnabled ? s.postsAutoPinOnButton : s.postsAutoPinOffButton),
      ],
      [
        button(
          retentionToken,
          retention.enabled ? s.postsRetentionOnButton : s.postsRetentionOffButton,
        ),
        button(backToken, s.backButton),
      ],
    ];
    return { kind: 'reply', text: composeTelegramHtml(parts), buttons };
  }

  /** One housekeeping list line: pin mark, message id, category, date, expiry. */
  function formatPostLine(post: ChannelPostListRow): string {
    const date = new Date(post.publishedAtMs).toISOString().slice(0, 10);
    const pin = post.pinned ? '📌 ' : '';
    const expired = post.expired ? ' · expired' : '';
    const title =
      post.title === null
        ? ''
        : ` · ${post.title.length > 40 ? `${post.title.slice(0, 40)}…` : post.title}`;
    return `${pin}#${post.channelMessageId} · ${post.category} · ${date}${expired}${title}`;
  }

  async function renderPostDetail(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly ref: PanelPostRef;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    if (postManagement === undefined) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.callbackPostMgmtUnavailable),
      };
    }
    const posts = await postManagement.listPosts({
      telegramUserId: input.telegramUserId,
      role: input.role,
      filters: { status: 'all', limit: 50 },
    });
    const post = posts.find((row) => row.channelMessageId === input.ref.channelMessageId);
    if (post === undefined) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.postsEmpty),
      };
    }
    const parts: TelegramSafeHtml[] = [
      telegramBold(`${s.postDetailTitle} #${post.channelMessageId}`),
      escapeTelegramHtml(`${s.postDetailCategoryLabel} ${post.category}`),
      escapeTelegramHtml(
        `${s.postDetailPublishedLabel} ${new Date(post.publishedAtMs).toISOString()}`,
      ),
      escapeTelegramHtml(`${s.postDetailPinnedLabel} ${post.pinned ? '📌' : '—'}`),
      escapeTelegramHtml(`${s.postDetailExpiredLabel} ${post.expired ? 'yes' : 'no'}`),
    ];
    if (post.title !== null) {
      parts.push(escapeTelegramHtml(post.title));
    }
    const pinToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: post.pinned ? ADMIN_PANEL_TOKEN_ACTIONS.unpinPost : ADMIN_PANEL_TOKEN_ACTIONS.pinPost,
      payload: post.pinned
        ? { op: 'unpin_post', channelMessageId: post.channelMessageId }
        : {
            op: 'pin_post',
            refType: post.refType,
            refId: post.refId,
            channelMessageId: post.channelMessageId,
          },
      nowMs: input.nowMs,
    });
    const editToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.startEdit,
      payload: {
        op: 'start_edit',
        refType: post.refType,
        refId: post.refId,
        channelMessageId: post.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    const deleteToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.deleteRequest,
      payload: {
        op: 'delete_request',
        refType: post.refType,
        refId: post.refId,
        channelMessageId: post.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'posts',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [
          button(pinToken, post.pinned ? s.postDetailUnpinButton : s.postDetailPinButton),
          button(editToken, s.postDetailEditButton),
          button(deleteToken, s.postDetailDeleteButton),
        ],
        [button(backToken, s.backButton)],
      ],
    };
  }

  async function renderDeleteConfirm(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly ref: PanelPostRef;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const confirmToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.deleteConfirm,
      payload: {
        op: 'delete_confirm',
        refType: input.ref.refType,
        refId: input.ref.refId,
        channelMessageId: input.ref.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    const cancelToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.showPost,
      payload: {
        op: 'show_post',
        refType: input.ref.refType,
        refId: input.ref.refId,
        channelMessageId: input.ref.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml([
        telegramBold(s.deleteConfirmTitle),
        escapeTelegramHtml(`#${input.ref.channelMessageId}`),
      ]),
      buttons: [
        [button(confirmToken, s.deleteConfirmButton)],
        [button(cancelToken, s.deleteCancelButton)],
      ],
    };
  }

  async function renderScreen(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly screen: PanelScreen;
    readonly nowMs: number;
    readonly postsFilter?: PanelPostsFilter;
  }): Promise<AdminPanelReplyResult> {
    const state = await loadState(input.nowMs);
    switch (input.screen) {
      case 'main':
        return renderMain({ ...input, state });
      case 'mode':
        return renderMode({ ...input, state });
      case 'cap':
        return renderCap({ ...input, state });
      case 'event':
        return renderEvent({ ...input, state });
      case 'posts':
        return renderPosts({
          telegramUserId: input.telegramUserId,
          role: input.role,
          uiLanguage: input.uiLanguage,
          filter: input.postsFilter ?? 'all',
          nowMs: input.nowMs,
        });
    }
  }

  function answer(callbackText: string): AdminPanelCallbackResult {
    return { kind: 'answer', callbackText };
  }

  return {
    async main({ telegramUserId, role, uiLanguage }) {
      // Viewing is open to every authorized admin (dashboard.view is held
      // by all six roles); the role is re-checked only for mutations.
      if (!roleHasPermission(role, 'dashboard.view')) {
        return {
          kind: 'reply',
          text: escapeTelegramHtml(ADMIN_PANEL_STRINGS[uiLanguage].permissionDenied),
        };
      }
      return renderScreen({
        telegramUserId,
        role,
        uiLanguage,
        screen: 'main',
        nowMs: clock.now(),
      });
    },

    async screen({ telegramUserId, role, uiLanguage, screen }) {
      if (!roleHasPermission(role, 'dashboard.view')) {
        return {
          kind: 'reply',
          text: escapeTelegramHtml(ADMIN_PANEL_STRINGS[uiLanguage].permissionDenied),
        };
      }
      return renderScreen({ telegramUserId, role, uiLanguage, screen, nowMs: clock.now() });
    },

    async handleCallback({ telegramUserId, role, uiLanguage, token }) {
      const s = ADMIN_PANEL_STRINGS[uiLanguage];
      const nowMs = clock.now();
      const consumed = await consumeActionToken(executor, { token, telegramUserId, nowMs });
      if (consumed.kind === 'invalid') {
        return answer(s.callbackInvalidToken);
      }
      const record = consumed.record;
      // Defense in depth: the dispatcher routed by this exact action
      // family; a foreign record can never ride the panel.
      if (!record.action.startsWith('panel.')) {
        return answer(s.callbackInvalidToken);
      }
      const payload = parsePayload(record.payloadJson);
      if (payload === null) {
        return answer(s.callbackInvalidToken);
      }
      // A panel read settles the lazy event expiry first, so a stale
      // stored-active event can never be toggled or rendered as active.
      await settleEvent(nowMs);
      if (payload.op === 'show') {
        return renderScreen({
          telegramUserId,
          role,
          uiLanguage,
          screen: payload.screen,
          nowMs,
          postsFilter: payload.filter,
        });
      }
      if (payload.op === 'show_post') {
        return renderPostDetail({
          telegramUserId,
          role,
          uiLanguage,
          ref: payload,
          nowMs,
        });
      }
      if (payload.op === 'delete_request') {
        return renderDeleteConfirm({
          telegramUserId,
          uiLanguage,
          ref: payload,
          nowMs,
        });
      }
      // Mutations: owner + chief_editor ONLY. The token burns and nothing
      // moves for any other role — the denial is the toast, never a write.
      if (!canChangePublishingSettings(role)) {
        return answer(s.callbackPermissionDenied);
      }
      // Slice 6 — post-management mutations delegate to the injected
      // service (which re-checks the role — defense in depth). Without
      // the service the toast is honest, never a pretend success.
      if (payload.op === 'pin_post' || payload.op === 'unpin_post') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        if (payload.op === 'pin_post') {
          const outcome = await postManagement.pinPost({
            telegramUserId,
            role,
            refType: payload.refType,
            refId: payload.refId,
            channelMessageId: payload.channelMessageId,
          });
          switch (outcome.kind) {
            case 'pinned':
              return answer(s.callbackPinned);
            case 'already_pinned':
              return answer(s.callbackAlreadyPinned);
            case 'denied':
              return answer(s.callbackPermissionDenied);
            case 'transport_unavailable':
              return answer(s.callbackPostMgmtUnavailable);
            case 'pin_failed':
              return answer(s.callbackPinFailed);
          }
        } else {
          const outcome = await postManagement.unpinPost({
            telegramUserId,
            role,
            channelMessageId: payload.channelMessageId,
          });
          switch (outcome.kind) {
            case 'unpinned':
              return answer(s.callbackUnpinned);
            case 'not_pinned':
              return answer(s.callbackNotPinned);
            case 'denied':
              return answer(s.callbackPermissionDenied);
            case 'transport_unavailable':
              return answer(s.callbackPostMgmtUnavailable);
            case 'unpin_failed':
              return answer(s.callbackPinFailed);
          }
        }
      }
      if (payload.op === 'delete_confirm') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const outcome = await postManagement.deletePost({
          telegramUserId,
          role,
          refType: payload.refType,
          refId: payload.refId,
          channelMessageId: payload.channelMessageId,
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        if (outcome.kind === 'transport_unavailable') {
          return answer(s.callbackPostMgmtUnavailable);
        }
        if (outcome.kind === 'delete_failed') {
          return answer(s.callbackDeleteFailed);
        }
        // Deleted: the fresh posts list IS the confirmation (the post
        // is gone from it). The toast text is lost on the reply path —
        // the list carries the proof instead.
        return renderPosts({
          telegramUserId,
          role,
          uiLanguage,
          filter: 'all',
          nowMs,
        });
      }
      if (payload.op === 'set_auto_pin') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const outcome = await postManagement.setAutoPin({
          telegramUserId,
          role,
          enabled: payload.enabled,
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        if (outcome.kind === 'no_change') {
          return answer(s.callbackNoChange);
        }
        return answer(payload.enabled ? s.callbackAutoPinOn : s.callbackAutoPinOff);
      }
      if (payload.op === 'set_retention') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const current = await postManagement.retentionRule();
        const outcome = await postManagement.setRetention({
          telegramUserId,
          role,
          rule: { ...current, enabled: payload.enabled },
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        if (outcome.kind === 'invalid') {
          return answer(s.callbackInvalidToken);
        }
        if (outcome.kind === 'no_change') {
          return answer(s.callbackNoChange);
        }
        return answer(payload.enabled ? s.callbackRetentionOn : s.callbackRetentionOff);
      }
      if (payload.op === 'start_edit') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const outcome = await postManagement.startEdit({
          telegramUserId,
          role,
          refType: payload.refType,
          refId: payload.refId,
          channelMessageId: payload.channelMessageId,
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        return {
          kind: 'reply',
          text: escapeTelegramHtml(s.editPrompt),
        };
      }
      if (payload.op === 'set_mode') {
        const outcome = await setPublishMode(executor, {
          mode: payload.mode,
          actorId: telegramUserId,
          nowMs,
        });
        return answer(
          outcome.kind === 'applied' ? s.callbackModeSet[payload.mode] : s.callbackNoChange,
        );
      }
      if (payload.op === 'set_cap') {
        const outcome = await setDailyCap(executor, {
          cap: payload.cap,
          actorId: telegramUserId,
          nowMs,
        });
        if (outcome.kind === 'invalid') {
          return answer(s.callbackInvalidToken);
        }
        return answer(
          outcome.kind === 'applied'
            ? s.callbackCapSet(payload.cap, outcome.effectiveFrom)
            : s.callbackCapNoChange(payload.cap),
        );
      }
      if (payload.op !== 'set_event') {
        return answer(s.callbackInvalidToken);
      }
      const outcome = await setEventMode(executor, {
        active: payload.active,
        trigger: 'manual',
        actorId: telegramUserId,
        nowMs,
      });
      if (outcome.kind === 'no_change') {
        return answer(s.callbackNoChange);
      }
      return answer(payload.active ? s.callbackEventOn : s.callbackEventOff);
    },

    async noteP0({ nowMs }) {
      return triggerEventOnP0(executor, { nowMs });
    },

    async gate(input) {
      return checkPublishGate(executor, input);
    },
  };
}
