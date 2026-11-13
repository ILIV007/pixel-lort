/**
 * Phase 9B — the read-only story view service: the composition the ingress
 * executes for the `story_view` router action (the R1.18 shape: the router
 * NEVER queries D1; the injected service does).
 *
 * Exactly TWO bounded read-only SELECTs (the story identity PK lookup + the
 * capped per-story publications list) through the typed story-view store —
 * ZERO writes, zero editorial draft reads, zero provider calls. The
 * send-gate state is passed BY THE CALLER (the ingress holds the parsed
 * config) so the screen can say honestly whether the scheduler is
 * decision-only — the observation NEVER pretends a live scheduler exists.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import { createStoryViewStore } from '../../adapters/db/story-view-store';
import { renderStoryView } from '../../admin/story-command';
import type { AdminUiLanguage } from '../../admin/ui-language';
import type { TelegramSafeHtml } from '../../admin/telegram-html';

export interface AdminStoryViewService {
  storyView(storyId: string, uiLanguage: AdminUiLanguage): Promise<TelegramSafeHtml>;
}

export function createAdminStoryViewService(deps: {
  readonly executor: DbExecutor;
  /** The parsed scheduler send gate (the honest screen note). */
  readonly sendGateEnabled: boolean;
}): AdminStoryViewService {
  const store = createStoryViewStore(deps.executor);
  return {
    async storyView(storyId, uiLanguage) {
      const [story, publications] = await Promise.all([
        store.findStoryViewRow(storyId),
        store.listStoryPublications(storyId),
      ]);
      return renderStoryView({
        uiLanguage,
        story,
        publications: publications.rows,
        morePublications: publications.moreAvailable,
        sendGateEnabled: deps.sendGateEnabled,
      });
    },
  };
}
