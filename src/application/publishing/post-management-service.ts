/**
 * Slice 6 — the post-management service (DESIGN §10.7: pin/unpin any
 * published post, P0 auto-pin with a panel toggle, housekeeping with
 * filters, in-place edit, delete with confirmation).
 *
 * The service NEVER sends anything itself and NEVER publishes: it only
 * performs the typed post-management effects (pin/unpin/delete/edit
 * through the injected Bot API transport + the durable ledger/settings
 * writes) and returns typed outcomes for the panel to render. No posts
 * are sent by this slice.
 *
 * ORDERING (the honest two-sided rule): the Bot API call goes FIRST and
 * the ledger write SECOND. A failed API call writes nothing (the panel
 * never claims a pin/delete/edit that did not happen); a failed ledger
 * write after a successful API call is compensated best-effort (an
 * unpin re-pin attempt) and reported as failed — the channel and the
 * ledger agree in every common path. A pin/delete/edit failure NEVER
 * fails a publication: auto-pin runs after the publish terminal and a
 * pin failure only logs.
 *
 * VIEWING is open to every authorized admin (all roles hold
 * `dashboard.view`); MUTATIONS are owner + chief_editor ONLY (the
 * slice-3 contract — enforced here at call time, defense in depth
 * behind the panel router; other roles get a denial outcome and NOTHING
 * is written or sent).
 *
 * The transport is OPTIONAL: without it, lists and settings still work
 * and every pin/delete/edit reports `transport_unavailable` honestly
 * instead of pretending to act.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import { contentTextHash } from '../../domain/publishing/publication-identity';
import {
  clearEditCapture,
  getActivePin,
  getEditCapture,
  listChannelPosts,
  pinChannelPost,
  readPostManagementSettings,
  recordChannelPostDelete,
  recordPostEdited,
  setAutoPinP0,
  setRetentionRule,
  startEditCapture,
  touchPublishedPost,
  unpinChannelPost,
  updateEditorialPostTextHash,
  type ChannelPinRow,
  type ChannelPostListRow,
  type EditCapture,
  type ListChannelPostsInput,
} from '../../adapters/db/post-management-store';
import { canChangePublishingSettings } from '../../domain/publishing/publishing-settings';
import type { ChannelPostRefType, RetentionRule } from '../../domain/publishing/post-management';
import { randomToken } from '../../domain/admin-post/fingerprint';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import type { TelegramApiError } from '../../adapters/telegram/bot-api-client';
import type { Logger } from '../../observability/logger';

/** The Bot API surface the post-management effects need (injected). */
export interface PostManagementTransport {
  pinChatMessage(input: {
    readonly chatId: number | string;
    readonly messageId: number;
  }): Promise<boolean>;
  unpinChatMessage(input: {
    readonly chatId: number | string;
    readonly messageId: number;
  }): Promise<boolean>;
  deleteMessage(input: {
    readonly chatId: number | string;
    readonly messageId: number;
  }): Promise<boolean>;
  editMessageText(input: {
    readonly chatId: number | string;
    readonly messageId: number;
    readonly text: TelegramSafeHtml;
  }): Promise<boolean>;
}

export type PinPostOutcome =
  | { readonly kind: 'pinned'; readonly releasedPrevious: boolean }
  | { readonly kind: 'already_pinned' }
  | { readonly kind: 'pin_failed' }
  | { readonly kind: 'transport_unavailable' }
  | { readonly kind: 'denied' };

export type UnpinPostOutcome =
  | { readonly kind: 'unpinned' }
  | { readonly kind: 'not_pinned' }
  | { readonly kind: 'unpin_failed' }
  | { readonly kind: 'transport_unavailable' }
  | { readonly kind: 'denied' };

export type DeletePostOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'delete_failed' }
  | { readonly kind: 'transport_unavailable' }
  | { readonly kind: 'denied' };

export type StartEditOutcome = { readonly kind: 'capture_open' } | { readonly kind: 'denied' };

export type CompleteEditOutcome =
  | { readonly kind: 'edited' }
  | { readonly kind: 'no_capture' }
  | { readonly kind: 'invalid_text' }
  | { readonly kind: 'edit_failed' }
  | { readonly kind: 'edit_failed_retryable' }
  | { readonly kind: 'transport_unavailable' }
  | { readonly kind: 'denied' };

export type AutoPinOutcome =
  | { readonly kind: 'pinned'; readonly releasedPrevious: boolean }
  | { readonly kind: 'already_pinned' }
  | { readonly kind: 'skipped_disabled' }
  | { readonly kind: 'pin_failed' }
  | { readonly kind: 'transport_unavailable' };

/** The Bot API text limit — an edit longer than this is refused upfront. */
export const POST_EDIT_MAX_CHARS = 4096;

export interface PostManagementService {
  /** Read the admin's open edit capture, if any (expired captures read as none). */
  peekEditCapture(input: { readonly telegramUserId: number }): Promise<EditCapture | null>;
  activePin(): Promise<ChannelPinRow | null>;
  autoPinEnabled(): Promise<boolean>;
  retentionRule(): Promise<RetentionRule>;
  listPosts(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly filters: Omit<ListChannelPostsInput, 'nowMs'>;
  }): Promise<readonly ChannelPostListRow[]>;
  pinPost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
  }): Promise<PinPostOutcome>;
  unpinPost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly channelMessageId: number;
  }): Promise<UnpinPostOutcome>;
  setAutoPin(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly enabled: boolean;
  }): Promise<{ readonly kind: 'applied' | 'no_change' | 'denied'; readonly enabled: boolean }>;
  setRetention(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly rule: RetentionRule;
  }): Promise<
    | { readonly kind: 'applied' | 'no_change' | 'denied'; readonly rule: RetentionRule }
    | { readonly kind: 'invalid' }
  >;
  deletePost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
  }): Promise<DeletePostOutcome>;
  startEdit(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
  }): Promise<StartEditOutcome>;
  completeEdit(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly text: string;
  }): Promise<CompleteEditOutcome>;
  /**
   * The P0 auto-pin seam for the publication scheduler: called AFTER a
   * P0 publication is terminally `sent`. A disabled toggle skips
   * silently; a pin failure is reported, never thrown — the publication
   * stays sent either way.
   */
  autoPinForP0(input: {
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
  }): Promise<AutoPinOutcome>;
}

function isRetryableTransportError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    (error as TelegramApiError).retryable === true
  );
}

export function createPostManagementService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  /** The channel the posts live in (phase-2 target channel). */
  readonly channelChatId: number | string;
  readonly transport?: PostManagementTransport;
  readonly logger?: Logger;
}): PostManagementService {
  const { executor, clock, channelChatId, transport, logger } = deps;

  /**
   * The shared pin application: Bot API first, ledger second, with a
   * best-effort compensation when the ledger write fails after a
   * successful API pin. `pinnedBy` 0 is the system actor (auto-pin).
   */
  async function applyPin(input: {
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
    readonly pinnedBy: number;
  }): Promise<
    | { readonly kind: 'pinned'; readonly releasedPrevious: boolean }
    | { readonly kind: 'already_pinned' }
    | { readonly kind: 'pin_failed' }
    | { readonly kind: 'transport_unavailable' }
  > {
    if (transport === undefined) {
      return { kind: 'transport_unavailable' };
    }
    const active = await getActivePin(executor);
    if (active !== null && active.channelMessageId === input.channelMessageId) {
      return { kind: 'already_pinned' };
    }
    const nowMs = clock.now();
    let apiPinned = false;
    try {
      apiPinned = await transport.pinChatMessage({
        chatId: channelChatId,
        messageId: input.channelMessageId,
      });
    } catch (error) {
      logger?.warn('post_management.pin_api_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { kind: 'pin_failed' };
    }
    if (!apiPinned) {
      return { kind: 'pin_failed' };
    }
    try {
      const outcome = await pinChannelPost(executor, {
        id: `pin:${randomToken()}`,
        channelMessageId: input.channelMessageId,
        postRefType: input.refType,
        postRefId: input.refId,
        pinnedBy: input.pinnedBy,
        nowMs,
      });
      if (outcome.kind === 'already_pinned') {
        return { kind: 'already_pinned' };
      }
      return { kind: 'pinned', releasedPrevious: outcome.releasedPrevious };
    } catch (error) {
      // The channel IS pinned but the ledger refused — compensate
      // best-effort (unpin the channel again) and report the failure.
      logger?.warn('post_management.pin_ledger_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      try {
        await transport.unpinChatMessage({
          chatId: channelChatId,
          messageId: input.channelMessageId,
        });
      } catch {
        // Best-effort only: the ledger/operator surface reports the gap.
      }
      return { kind: 'pin_failed' };
    }
  }

  return {
    async activePin() {
      return getActivePin(executor);
    },

    async autoPinEnabled() {
      return (await readPostManagementSettings(executor)).autoPinP0Enabled;
    },

    async retentionRule() {
      return (await readPostManagementSettings(executor)).retention;
    },

    async listPosts({ role, filters }) {
      if (!roleHasPermission(role, 'dashboard.view')) {
        return [];
      }
      return listChannelPosts(executor, { ...filters, nowMs: clock.now() });
    },

    async pinPost({ telegramUserId, role, refType, refId, channelMessageId }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied' };
      }
      return applyPin({
        refType,
        refId,
        channelMessageId,
        pinnedBy: telegramUserId,
      });
    },

    async unpinPost({ telegramUserId, role, channelMessageId }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied' };
      }
      if (transport === undefined) {
        return { kind: 'transport_unavailable' };
      }
      const active = await getActivePin(executor);
      if (active === null || active.channelMessageId !== channelMessageId) {
        return { kind: 'not_pinned' };
      }
      const nowMs = clock.now();
      let apiUnpinned = false;
      try {
        apiUnpinned = await transport.unpinChatMessage({
          chatId: channelChatId,
          messageId: channelMessageId,
        });
      } catch (error) {
        logger?.warn('post_management.unpin_api_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return { kind: 'unpin_failed' };
      }
      if (!apiUnpinned) {
        return { kind: 'unpin_failed' };
      }
      try {
        const moved = await unpinChannelPost(executor, {
          channelMessageId,
          unpinnedBy: telegramUserId,
          nowMs,
        });
        return moved ? { kind: 'unpinned' } : { kind: 'not_pinned' };
      } catch (error) {
        logger?.warn('post_management.unpin_ledger_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return { kind: 'unpin_failed' };
      }
    },

    async setAutoPin({ telegramUserId, role, enabled }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied', enabled: await this.autoPinEnabled() };
      }
      const outcome = await setAutoPinP0(executor, {
        enabled,
        actorId: telegramUserId,
        nowMs: clock.now(),
      });
      return { kind: outcome.kind, enabled: outcome.enabled };
    },

    async setRetention({ telegramUserId, role, rule }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied', rule: await this.retentionRule() };
      }
      const outcome = await setRetentionRule(executor, {
        rule,
        actorId: telegramUserId,
        nowMs: clock.now(),
      });
      if (outcome.kind === 'invalid') {
        return { kind: 'invalid' };
      }
      return { kind: outcome.kind, rule: outcome.rule };
    },

    async deletePost({ telegramUserId, role, refType, refId, channelMessageId }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied' };
      }
      if (transport === undefined) {
        return { kind: 'transport_unavailable' };
      }
      const nowMs = clock.now();
      let apiDeleted = false;
      try {
        apiDeleted = await transport.deleteMessage({
          chatId: channelChatId,
          messageId: channelMessageId,
        });
      } catch (error) {
        logger?.warn('post_management.delete_api_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return { kind: 'delete_failed' };
      }
      if (!apiDeleted) {
        return { kind: 'delete_failed' };
      }
      try {
        await recordChannelPostDelete(executor, {
          id: `del:${randomToken()}`,
          postRefType: refType,
          postRefId: refId,
          channelMessageId,
          deletedBy: telegramUserId,
          reason: 'housekeeping_delete',
          nowMs,
        });
        // A deleted message cannot stay pinned: release the ledger row
        // (no Bot API unpin — the message is gone).
        const active = await getActivePin(executor);
        if (active !== null && active.channelMessageId === channelMessageId) {
          await unpinChannelPost(executor, {
            channelMessageId,
            unpinnedBy: telegramUserId,
            nowMs,
          });
        }
        return { kind: 'deleted' };
      } catch (error) {
        logger?.warn('post_management.delete_ledger_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return { kind: 'delete_failed' };
      }
    },

    /** Read the admin's open edit capture, if any (expired captures read as none). */
    async peekEditCapture({ telegramUserId }: { readonly telegramUserId: number }) {
      return getEditCapture(executor, { adminId: telegramUserId, nowMs: clock.now() });
    },

    async startEdit({ telegramUserId, role, refType, refId, channelMessageId }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied' };
      }
      await startEditCapture(executor, {
        capture: {
          adminId: telegramUserId,
          postRefType: refType,
          postRefId: refId,
          channelMessageId,
          startedAtMs: clock.now(),
        },
      });
      return { kind: 'capture_open' };
    },

    async completeEdit({ telegramUserId, role, text }) {
      if (!canChangePublishingSettings(role)) {
        return { kind: 'denied' };
      }
      if (transport === undefined) {
        return { kind: 'transport_unavailable' };
      }
      const nowMs = clock.now();
      const capture = await getEditCapture(executor, { adminId: telegramUserId, nowMs });
      if (capture === null) {
        return { kind: 'no_capture' };
      }
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > POST_EDIT_MAX_CHARS) {
        return { kind: 'invalid_text' };
      }
      const safeHtml = composeTelegramHtml([escapeTelegramHtml(trimmed)]);
      let apiEdited = false;
      try {
        apiEdited = await transport.editMessageText({
          chatId: channelChatId,
          messageId: capture.channelMessageId,
          text: safeHtml,
        });
      } catch (error) {
        if (isRetryableTransportError(error)) {
          // Transient: the capture stays open for a retry.
          return { kind: 'edit_failed_retryable' };
        }
        await clearEditCapture(executor, { adminId: telegramUserId, nowMs });
        return { kind: 'edit_failed' };
      }
      if (!apiEdited) {
        await clearEditCapture(executor, { adminId: telegramUserId, nowMs });
        return { kind: 'edit_failed' };
      }
      try {
        if (capture.postRefType === 'publication') {
          const hash = await contentTextHash(trimmed);
          if (hash.ok) {
            await updateEditorialPostTextHash(executor, {
              publicationId: capture.postRefId,
              textHash: hash.hash,
              nowMs,
            });
          }
        } else {
          await touchPublishedPost(executor, { id: capture.postRefId, nowMs });
        }
        await recordPostEdited(executor, {
          postRefType: capture.postRefType,
          postRefId: capture.postRefId,
          channelMessageId: capture.channelMessageId,
          editedBy: telegramUserId,
          nowMs,
        });
      } catch (error) {
        logger?.warn('post_management.edit_ledger_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        // The channel text IS edited; the ledger failure is logged and
        // the capture still closes (the edit is not re-applied).
      }
      await clearEditCapture(executor, { adminId: telegramUserId, nowMs });
      return { kind: 'edited' };
    },

    async autoPinForP0({ refType, refId, channelMessageId }) {
      const settings = await readPostManagementSettings(executor);
      if (!settings.autoPinP0Enabled) {
        return { kind: 'skipped_disabled' };
      }
      return applyPin({ refType, refId, channelMessageId, pinnedBy: 0 });
    },
  };
}
