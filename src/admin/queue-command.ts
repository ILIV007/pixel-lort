/**
 * Phase 9A — the read-only `/queue` surface helpers: the argument parser
 * (the R1.18.1 grammar discipline) and the budget-first renderer.
 *
 * - The parser: `/queue` documents the NO-ARGUMENT form ONLY — any
 *   remainder is `invalid` (there is no id argument to validate). The raw
 *   text is never echoed back.
 * - The renderer: composeTelegramHtml + escapeTelegramHtml ONLY; the
 *   rendered rows carry identity/status/counters/stable codes — never
 *   draft content, never destinations; every section is RESERVED before
 *   the variable content (the R1.18.1 S1 discipline: mandatory
 *   distinctions never drop). The result is a bounded safe HTML value.
 */
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from './telegram-html';
import { ADMIN_QUEUE_STRINGS } from './queue-strings';
import type { AdminUiLanguage } from './ui-language';
import type {
  PublicationQueueRow,
  PublicationStatusCounts,
} from '../adapters/db/publication-outbox-store';
import { PUBLICATION_STATUSES } from '../domain/publishing/outbox-lifecycle';

export type QueueArgumentParse = { readonly kind: 'list' } | { readonly kind: 'invalid' };

/** `/queue` takes NO argument — any remainder is invalid usage. */
export function parseQueueArgument(remainder: string | undefined): QueueArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'list' };
  }
  return { kind: 'invalid' };
}

/** The bounded recent-rows cap of the screen (the renderer's contract). */
export const QUEUE_RECENT_LIMIT = 8;

function countsLines(counts: PublicationStatusCounts): string[] {
  // The TOTAL status vocabulary is ALWAYS listed — a zero is information
  // (the S1 discipline: the fixed skeleton never drops a status).
  return PUBLICATION_STATUSES.map((status) => `${status}: ${counts[status]}`);
}

function recentLine(row: PublicationQueueRow): string {
  const errorSuffix = row.lastError !== null ? ` · ${row.lastError}` : '';
  return `${row.id.slice(0, 18)} · ${row.status} · P${row.priority} · ${row.attempts}/${row.maxAttempts}${errorSuffix}`;
}

export function renderQueueView(input: {
  readonly uiLanguage: AdminUiLanguage;
  readonly counts: PublicationStatusCounts;
  readonly recent: readonly PublicationQueueRow[];
  readonly sendGateEnabled: boolean;
}): TelegramSafeHtml {
  const s = ADMIN_QUEUE_STRINGS[input.uiLanguage];
  const parts: TelegramSafeHtml[] = [
    telegramBold(s.emptyTitle),
    escapeTelegramHtml(input.sendGateEnabled ? s.sendGateOn : s.sendGateOff),
    escapeTelegramHtml(s.countsTitle),
  ];
  for (const line of countsLines(input.counts)) {
    parts.push(escapeTelegramHtml(line));
  }
  if (input.recent.length === 0) {
    parts.push(escapeTelegramHtml(s.emptyQueue));
  } else {
    parts.push(escapeTelegramHtml(s.recentTitle));
    for (const row of input.recent.slice(0, QUEUE_RECENT_LIMIT)) {
      parts.push(escapeTelegramHtml(recentLine(row)));
    }
  }
  return composeTelegramHtml(parts);
}
