/**
 * Phase 9C — the write-capable `/queue <publicationId>` detail surface
 * helpers: the grammar is owned by the pure disposition module (qd1); this
 * module is the budget-first renderer of the bounded detail view.
 *
 * - The rendered rows carry identity/status/counters/schedule facts/stable
 *   codes — never draft content, never destinations (the R1.18/9A/9B
 *   projection discipline).
 * - Every section is RESERVED before the variable content (the R1.18.1 S1
 *   discipline: the mandatory distinctions never drop).
 * - The disposition state line is ALWAYS present, honest for every verdict
 *   of the pure table. The cancel BUTTON is the service's decision (the
 *   permission + verdict must both hold) — the renderer only carries the
 *   state line; the buttons arrive separately (the control/content
 *   separation).
 */
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from './telegram-html';
import { ADMIN_QUEUE_STRINGS } from './queue-strings';
import type { AdminUiLanguage } from './ui-language';
import type { PublicationRow } from '../adapters/db/publication-outbox-store';
import type { QueueDispositionVerdict } from '../domain/publishing/queue-disposition';

function dispositionLine(uiLanguage: AdminUiLanguage, verdict: QueueDispositionVerdict): string {
  const s = ADMIN_QUEUE_STRINGS[uiLanguage];
  switch (verdict.kind) {
    case 'cancellable':
      return s.detailDispositionCancellable;
    case 'refused':
      switch (verdict.reason) {
        case 'in_flight':
          return s.detailDispositionInFlight;
        case 'already_published':
          return s.detailDispositionAlreadyPublished;
        case 'terminal':
          return s.detailDispositionTerminal;
      }
      break;
    case 'invalid_status':
      // Unreachable through the service (the row comes from the typed
      // reader) — the honest terminal line keeps the skeleton reserved.
      return s.detailDispositionTerminal;
  }
}

/**
 * The bounded detail renderer. The schedule facts use the machine's raw
 * ISO-8601 rendering of the epoch values (machine data, never localized);
 * a NULL stays the honest `—`.
 */
export function renderQueueDetail(input: {
  readonly uiLanguage: AdminUiLanguage;
  readonly row: PublicationRow;
  readonly disposition: QueueDispositionVerdict;
}): TelegramSafeHtml {
  const s = ADMIN_QUEUE_STRINGS[input.uiLanguage];
  const row = input.row;
  const parts: TelegramSafeHtml[] = [
    telegramBold(s.detailTitle),
    escapeTelegramHtml(`${s.detailIdentityLabel} ${row.id}`),
    escapeTelegramHtml(`${s.detailStatusLabel} ${row.status}`),
    escapeTelegramHtml(`${s.detailPriorityLabel} P${row.priority}`),
    escapeTelegramHtml(`${s.detailAttemptsLabel} ${row.attempts}/${row.max_attempts}`),
    escapeTelegramHtml(
      `${s.detailScheduleLabel} ${new Date(row.run_after).toISOString()}${
        row.published_at === null ? '' : ` · published ${new Date(row.published_at).toISOString()}`
      }`,
    ),
    escapeTelegramHtml(`${s.detailErrorLabel} ${row.last_error === null ? '—' : row.last_error}`),
    escapeTelegramHtml(
      `${s.detailDispositionLabel} ${dispositionLine(input.uiLanguage, input.disposition)}`,
    ),
  ];
  return composeTelegramHtml(parts);
}
