/**
 * Phase 9A — the read-only publication-queue view service: the composition
 * the ingress executes for the `queue_view` router action (the R1.18
 * shape: the router NEVER queries D1; the injected service does).
 *
 * Exactly TWO bounded read-only SELECTs (the histogram + the capped
 * recent list) through the typed store — ZERO writes, zero editorial
 * reads, zero provider calls. The send-gate state is passed BY THE CALLER
 * (the ingress holds the parsed config) so the screen can say honestly
 * whether the scheduler is decision-only — the observation NEVER pretends
 * a live scheduler exists.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  countPublicationsByStatus,
  listRecentPublications,
} from '../../adapters/db/publication-outbox-store';
import { QUEUE_RECENT_LIMIT, renderQueueView } from '../../admin/queue-command';
import type { AdminUiLanguage } from '../../admin/ui-language';
import type { TelegramSafeHtml } from '../../admin/telegram-html';

export interface AdminQueueViewService {
  queueView(uiLanguage: AdminUiLanguage): Promise<TelegramSafeHtml>;
}

export function createAdminQueueViewService(deps: {
  readonly executor: DbExecutor;
  /** The parsed scheduler send gate (the honest screen note). */
  readonly sendGateEnabled: boolean;
}): AdminQueueViewService {
  return {
    async queueView(uiLanguage) {
      const [counts, recent] = await Promise.all([
        countPublicationsByStatus(deps.executor),
        listRecentPublications(deps.executor, { limit: QUEUE_RECENT_LIMIT }),
      ]);
      return renderQueueView({
        uiLanguage,
        counts,
        recent,
        sendGateEnabled: deps.sendGateEnabled,
      });
    },
  };
}
