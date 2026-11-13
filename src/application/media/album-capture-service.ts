/**
 * Phase 9D — the album CAPTURE service: the composition the ingress
 * executes for the `album_capture_command` and `album_capture_media`
 * router actions (the R1.18 shape: the router NEVER queries D1; the
 * injected service does).
 *
 * THE HONEST BOUNDARY (OD-010, pinned by the suite): the capture is
 * evidence gathering. Every finished item is a `media_assets` row with
 * status 'candidate' + rights_status 'unknown' — the machine invents NO
 * permission, the producer refuses such rows typed, and NOTHING on this
 * surface can send. The route from captured evidence to an affirmative
 * rights status is the owner's OD-010 decision.
 *
 * RBAC: `draft.create` (the capture creates draft-adjacent evidence).
 * Private chat only; edited messages never reach here (the router).
 */

import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import {
  endAlbumCaptureSession,
  finishAlbumCapture,
  getActiveCaptureSession,
  recordAlbumCaptureAudit,
  startAlbumCaptureSession,
  appendAlbumCaptureItem,
} from '../../adapters/db/album-capture-store';
import {
  ALBUM_CAPTURE_MAX_ITEMS,
  appendCaptureItem,
  type AlbumCaptureKind,
  type AlbumCaptureState,
} from '../../domain/media/album-capture';
import { randomToken } from '../../domain/admin-post/fingerprint';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import { ADMIN_ALBUM_CAPTURE_STRINGS } from '../../admin/album-capture-strings';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import type { AdminUiLanguage } from '../../admin/ui-language';

export interface AlbumCaptureView {
  readonly text: TelegramSafeHtml;
}

export interface AlbumCaptureNotice {
  readonly kind: 'answer';
  readonly callbackText: string;
}

export interface AdminAlbumCaptureService {
  albumCaptureCommand(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly storyId: string | undefined;
    readonly disposition: 'start' | 'finish' | 'cancel' | 'status';
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AlbumCaptureView>;

  albumCaptureMedia(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly mediaKind: AlbumCaptureKind;
    readonly fileId: string;
    readonly captionText: string | undefined;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AlbumCaptureView>;
}

/** The bounded status view (the story + the gathered ordinals — never file content). */
function renderStatus(
  uiLanguage: AdminUiLanguage,
  state: AlbumCaptureState | undefined,
): TelegramSafeHtml {
  const s = ADMIN_ALBUM_CAPTURE_STRINGS[uiLanguage];
  if (state === undefined) {
    return composeTelegramHtml([
      telegramBold(s.statusTitle),
      escapeTelegramHtml(s.statusEmpty),
      escapeTelegramHtml(s.rightsNote),
    ]);
  }
  const parts: TelegramSafeHtml[] = [
    telegramBold(s.statusTitle),
    escapeTelegramHtml(`${s.statusItems} ${state.items.length}/${ALBUM_CAPTURE_MAX_ITEMS}`),
    escapeTelegramHtml(`${state.items.map((item) => `${item.ordinal}:${item.kind}`).join(' ')}`),
    escapeTelegramHtml(s.rightsNote),
  ];
  return composeTelegramHtml(parts);
}

export function createAdminAlbumCaptureService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
}): AdminAlbumCaptureService {
  const { executor, clock, logger } = deps;

  async function guardPermission(
    role: AdminRole,
    uiLanguage: AdminUiLanguage,
  ): Promise<AlbumCaptureView | undefined> {
    if (!roleHasPermission(role, 'draft.create')) {
      return { text: escapeTelegramHtml(ADMIN_ALBUM_CAPTURE_STRINGS[uiLanguage].permissionDenied) };
    }
    return undefined;
  }

  return {
    async albumCaptureCommand({ telegramUserId, role, storyId, disposition, uiLanguage }) {
      const denied = await guardPermission(role, uiLanguage);
      if (denied !== undefined) return denied;
      const s = ADMIN_ALBUM_CAPTURE_STRINGS[uiLanguage];
      const nowMs = clock.now();
      if (disposition === 'start') {
        if (storyId === undefined) {
          return { text: escapeTelegramHtml(s.invalidUsage) };
        }
        // ONE bounded read: the story must exist (the album draft FK needs
        // it — the honest early refusal, never the mechanics).
        const story = await executor.first<{ readonly id: string }>({
          sql: `SELECT id FROM stories WHERE id = ?`,
          params: [storyId],
        });
        if (story === null) {
          return { text: escapeTelegramHtml(s.storyNotFound) };
        }
        const state: AlbumCaptureState = { version: 'ac1', storyId, items: [] };
        const started = await startAlbumCaptureSession(executor, {
          telegramUserId,
          sessionId: randomToken(),
          state,
          nowMs,
        });
        if (started.kind !== 'started') {
          logger.warn('album_capture.start_write_failed', {});
          return { text: escapeTelegramHtml(s.finishUnavailable) };
        }
        return {
          text: composeTelegramHtml([
            telegramBold(s.startedTitle),
            escapeTelegramHtml(s.startedBody),
            escapeTelegramHtml(s.rightsNote),
          ]),
        };
      }
      if (disposition === 'status') {
        const active = await getActiveCaptureSession(executor, { telegramUserId, nowMs });
        return {
          text: renderStatus(uiLanguage, active.ok ? active.session.state : undefined),
        };
      }
      if (disposition === 'cancel') {
        const ended = await endAlbumCaptureSession(executor, {
          telegramUserId,
          nextStep: 'cancelled',
          nowMs,
        });
        if (ended.kind !== 'ended') {
          return { text: escapeTelegramHtml(s.captureNoSession) };
        }
        return { text: escapeTelegramHtml(s.finishCancelled) };
      }
      // finish
      const finished = await finishAlbumCapture(executor, { telegramUserId, nowMs });
      if (finished.kind === 'refused') {
        return {
          text: escapeTelegramHtml(
            finished.reason === 'no_active_session' || finished.reason === 'state_corrupt'
              ? s.captureNoSession
              : finished.reason === 'too_few_items'
                ? s.finishTooFew
                : s.finishUnavailable,
          ),
        };
      }
      const items = finished.state.items;
      // The ONE audit row (the deterministic id — the durable record of the
      // finished capture; never file content).
      await recordAlbumCaptureAudit(executor, {
        sessionId: finished.sessionId,
        actorId: String(telegramUserId),
        storyId: finished.state.storyId,
        itemCount: items.length,
        nowMs,
      });
      logger.info('album_capture.finished', {
        storyId: finished.state.storyId,
        itemCount: items.length,
      });
      return { text: escapeTelegramHtml(s.finishDone) };
    },

    async albumCaptureMedia({ telegramUserId, role, mediaKind, fileId, captionText, uiLanguage }) {
      const denied = await guardPermission(role, uiLanguage);
      if (denied !== undefined) return denied;
      const s = ADMIN_ALBUM_CAPTURE_STRINGS[uiLanguage];
      const nowMs = clock.now();
      const active = await getActiveCaptureSession(executor, { telegramUserId, nowMs });
      if (!active.ok) {
        return { text: escapeTelegramHtml(s.captureNoSession) };
      }
      const appended = appendCaptureItem(
        active.session.state,
        { kind: mediaKind, fileId },
        captionText,
      );
      if (!appended.ok) {
        return {
          text: escapeTelegramHtml(
            appended.reason === 'kind_unsupported'
              ? s.captureKindUnsupported
              : appended.reason === 'album_full'
                ? s.captureAlbumFull
                : appended.reason === 'duplicate_item'
                  ? s.captureDuplicate
                  : s.finishUnavailable,
          ),
        };
      }
      const written = await appendAlbumCaptureItem(executor, {
        telegramUserId,
        nextState: appended.state,
        nowMs,
      });
      if (written.kind !== 'appended') {
        return {
          text: escapeTelegramHtml(
            written.reason === 'no_active_session' || written.reason === 'state_corrupt'
              ? s.captureNoSession
              : s.finishUnavailable,
          ),
        };
      }
      const captionSuffix =
        captionText !== undefined && appended.state.captionText === captionText
          ? ` · ${s.captureCaptionStored}`
          : '';
      return {
        text: escapeTelegramHtml(
          `${s.captureAppend} ${appended.state.items.length}/${ALBUM_CAPTURE_MAX_ITEMS})${captionSuffix}`,
        ),
      };
    },
  };
}
