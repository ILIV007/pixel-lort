/**
 * Phase 9C — the write-capable queue disposition service: the composition
 * the ingress executes for the `queue_detail` router action and for the
 * `queue.cancel_publication` token callbacks (the R1.18 shape: the router
 * NEVER queries D1; the injected service does).
 *
 * DETAIL: exactly ONE bounded read (`findPublicationById`) through the
 * typed store; the pure qd1 verdict decides the honest disposition state
 * line; the cancel button is minted ONLY when BOTH the verdict is
 * `cancellable` AND the caller holds `publication.cancel` (the minted
 * token is the Phase 2A machinery: opaque, single-use, bound to ONE
 * telegram user, 15-minute expiry, issued DURABLY before the message
 * carrying it is sent). A missing row is the honest not-found — never a
 * fabricated detail.
 *
 * CALLBACK: the admin-post confirm shape — guarded single-use consume
 * (bound to ONE user), the permission RE-CHECKED at callback time (a
 * mint-time holder whose role was revoked is refused), the fenced store
 * write (the rowcount is the authority — a row claimed by a worker
 * between view and click answers the honest not-cancellable with ZERO
 * effect), the deterministic audit event on the applied path. The
 * disposition NEVER sends anything and NEVER touches the delivery
 * evidence.
 */

import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import {
  findPublicationById,
  cancelPublicationById,
} from '../../adapters/db/publication-outbox-store';
import { consumeActionToken, issueActionToken } from '../../adapters/telegram/action-tokens';
import {
  QUEUE_CANCEL_TOKEN_ACTION,
  QUEUE_CANCEL_TOKEN_TARGET_TYPE,
  evaluateQueueDisposition,
} from '../../domain/publishing/queue-disposition';
import { randomToken } from '../../domain/admin-post/fingerprint';
import { formatCallbackData } from '../../admin/callback-tokens';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import { renderQueueDetail } from '../../admin/queue-detail-command';
import { ADMIN_QUEUE_STRINGS } from '../../admin/queue-strings';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import type { AdminUiLanguage } from '../../admin/ui-language';

/** Structurally the admin-post button shape (the ingress render seam). */
export type QueueDispositionButtons = readonly (readonly {
  readonly text: string;
  readonly callbackData: string;
}[])[];

export interface QueueDispositionDetailResult {
  readonly text: TelegramSafeHtml;
  readonly buttons?: QueueDispositionButtons;
}

export interface QueueDispositionCallbackResult {
  readonly kind: 'answer';
  readonly callbackText: string;
}

/** The bounded token TTL of the disposition button (the single-use window). */
export const QUEUE_DISPOSITION_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface AdminQueueDispositionService {
  queueDetail(input: {
    readonly telegramUserId: number;
    readonly publicationId: string;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<QueueDispositionDetailResult>;

  handleCallback(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly token: string;
  }): Promise<QueueDispositionCallbackResult>;
}

/** The honest not-found view (the reserved title + the honest line). */
function renderQueueNotFound(uiLanguage: AdminUiLanguage): TelegramSafeHtml {
  const s = ADMIN_QUEUE_STRINGS[uiLanguage];
  return composeTelegramHtml([telegramBold(s.detailTitle), escapeTelegramHtml(s.detailNotFound)]);
}

export function createAdminQueueDispositionService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
}): AdminQueueDispositionService {
  const { executor, clock } = deps;

  async function mintCancelButton(input: {
    readonly telegramUserId: number;
    readonly publicationId: string;
    readonly nowMs: number;
  }): Promise<string> {
    const token = randomToken();
    // AWAITED: the token must be durable BEFORE the message carrying it is
    // sent — a fast click can otherwise hit a missing token row.
    await issueActionToken(executor, {
      token,
      telegramUserId: input.telegramUserId,
      permission: 'publication.cancel',
      action: QUEUE_CANCEL_TOKEN_ACTION,
      targetType: QUEUE_CANCEL_TOKEN_TARGET_TYPE,
      targetId: input.publicationId,
      payloadJson: '{}',
      expiresAtMs: input.nowMs + QUEUE_DISPOSITION_TOKEN_TTL_MS,
      nowMs: input.nowMs,
    });
    return token;
  }

  return {
    async queueDetail({ telegramUserId, publicationId, role, uiLanguage }) {
      const s = ADMIN_QUEUE_STRINGS[uiLanguage];
      // Defense in depth: the router gated `publication.view` before
      // emitting the action; the service refuses BEFORE any read if the
      // caller's role does not hold it.
      if (!roleHasPermission(role, 'publication.view')) {
        return { text: escapeTelegramHtml(s.permissionDenied) };
      }
      const row = await findPublicationById(executor, publicationId);
      if (row === null) {
        return { text: renderQueueNotFound(uiLanguage) };
      }
      const disposition = evaluateQueueDisposition(row.status);
      let buttons: QueueDispositionButtons | undefined;
      if (disposition.kind === 'cancellable' && roleHasPermission(role, 'publication.cancel')) {
        const token = await mintCancelButton({
          telegramUserId,
          publicationId,
          nowMs: clock.now(),
        });
        buttons = [[{ text: s.cancelButton, callbackData: formatCallbackData(token) }]];
      }
      return {
        text: renderQueueDetail({ uiLanguage, row, disposition }),
        ...(buttons !== undefined ? { buttons } : {}),
      };
    },

    async handleCallback({ telegramUserId, role, uiLanguage, token }) {
      const s = ADMIN_QUEUE_STRINGS[uiLanguage];
      const nowMs = clock.now();
      const consumed = await consumeActionToken(executor, { token, telegramUserId, nowMs });
      if (consumed.kind === 'invalid') {
        return { kind: 'answer', callbackText: s.callbackInvalidToken };
      }
      const record = consumed.record;
      // Defense in depth: the dispatcher routed by this exact action; a
      // foreign record can never ride the queue disposition.
      if (record.action !== QUEUE_CANCEL_TOKEN_ACTION) {
        return { kind: 'answer', callbackText: s.callbackInvalidToken };
      }
      // The permission is RE-CHECKED at callback time: a mint-time holder
      // whose role was revoked is refused — the token burns, the row does
      // not move, the audit stays silent.
      if (!roleHasPermission(role, 'publication.cancel')) {
        return { kind: 'answer', callbackText: s.callbackPermissionDenied };
      }
      // The token's target binding is the disposition intent; the FENCE is
      // the truth (the row's current state is re-read fresh by the store).
      if (record.targetType !== QUEUE_CANCEL_TOKEN_TARGET_TYPE || record.targetId === undefined) {
        return { kind: 'answer', callbackText: s.callbackInvalidToken };
      }
      const outcome = await cancelPublicationById(executor, {
        publicationId: record.targetId,
        actorId: String(telegramUserId),
        nowMs,
      });
      switch (outcome.kind) {
        case 'applied':
          return { kind: 'answer', callbackText: s.callbackCancelled };
        case 'not_cancellable':
          return { kind: 'answer', callbackText: s.callbackNotCancellable };
        case 'not_found':
          return { kind: 'answer', callbackText: s.callbackNotFound };
      }
    },
  };
}
