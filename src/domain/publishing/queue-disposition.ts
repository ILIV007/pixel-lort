/**
 * Phase 9C — the queue DISPOSITION decision module (qd1).
 *
 * The write-capable queue surface offers exactly ONE human disposition over
 * the outbox machine (pol1): CANCEL — legal from the waiting/parked states
 * whose pol1 rows say `cancel -> cancelled` (pending / retry_wait / failed).
 * The decision is DATA (the 7.2/8.1 house pattern: TOTAL, typed, no prose):
 * the service refuses BEFORE any effect and the store's fence repeats the
 * same set as the last line of defense (the rowcount is the authority).
 *
 * THE HONEST BOUNDARY (the continuation plan slice 4): the ambiguous
 * outcome rows are STOPPED here, never blind-auto-resent — there is NO
 * "retry now" disposition on this surface. The only re-send paths in the
 * whole product remain the ADR-0032 recorded-evidence heal (machine,
 * proof-backed) and the 8.4 correction supersede flow (engine-owned).
 *
 * In-flight rows (claimed / publishing) are refused `in_flight`: a worker
 * may hold the lease, and a racing disposition would either collide with
 * the fenced terminal writes or mislead the operator about what actually
 * happened. The published row is refused `already_published` (the 8.4
 * supersede flow owns it); the terminal rows are refused `terminal` (pol1:
 * they have NO exits).
 *
 * Pure: no I/O, no clock, no SQL, no randomness.
 */

import {
  PUBLICATION_STATUSES,
  isPublicationStatus,
  type PublicationStatus,
} from './outbox-lifecycle';

export const QUEUE_DISPOSITION_VERSION = 'qd1' as const;

export { isPublicationStatus };

/** The one disposition this surface offers (the pol1 `cancel` reason). */
export const QUEUE_CANCEL_DISPOSITION = 'cancel' as const;

/** The admin_action_tokens action descriptor minted for the disposition. */
export const QUEUE_CANCEL_TOKEN_ACTION = 'queue.cancel_publication' as const;

/** The admin_action_tokens targetType descriptor bound to the token. */
export const QUEUE_CANCEL_TOKEN_TARGET_TYPE = 'queue_publication' as const;

export type QueueDispositionVerdict =
  | { readonly kind: 'cancellable'; readonly status: PublicationStatus }
  | {
      readonly kind: 'refused';
      readonly status: PublicationStatus;
      readonly reason: 'in_flight' | 'already_published' | 'terminal';
    }
  | { readonly kind: 'invalid_status' };

const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'retry_wait', 'failed']);
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['claimed', 'publishing']);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['dead_letter', 'cancelled', 'superseded']);

/**
 * The TOTAL disposition decision over the REAL pol1 vocabulary. Unknown
 * status strings fail typed (`invalid_status`) — never guessed.
 */
export function evaluateQueueDisposition(status: string): QueueDispositionVerdict {
  if (!isPublicationStatus(status)) {
    return { kind: 'invalid_status' };
  }
  if (CANCELLABLE_STATUSES.has(status)) {
    return { kind: 'cancellable', status };
  }
  if (IN_FLIGHT_STATUSES.has(status)) {
    return { kind: 'refused', status, reason: 'in_flight' };
  }
  if (status === 'published') {
    return { kind: 'refused', status, reason: 'already_published' };
  }
  // The remaining members of the closed vocabulary are the terminal rows.
  if (!TERMINAL_STATUSES.has(status)) {
    // Unreachable while the vocabulary guard above is in sync with the
    // machine's PUBLICATION_STATUSES — fail loudly, never guess.
    return { kind: 'invalid_status' };
  }
  return { kind: 'refused', status, reason: 'terminal' };
}

/**
 * The whole-token argument grammar of `/queue <publicationId>` (the exact
 * R1.18.1/9B discipline): the forbidden-whitespace pattern, the UTF-8 byte
 * bound, the C0 control-character and DEL scan. A grammar failure happens
 * BEFORE any query could exist; the raw text is never echoed back.
 */
const PUBLICATION_ID_FORBIDDEN_WHITESPACE = /\s/u;
/** The bounded publication-id byte cap (the story-id grammar precedent). */
export const QUEUE_PUBLICATION_ID_MAX_BYTES = 128;

export type QueueDispositionArgumentParse =
  { readonly kind: 'valid'; readonly publicationId: string } | { readonly kind: 'invalid' };

export function parseQueueDispositionArgument(
  remainder: string | undefined,
): QueueDispositionArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'invalid' };
  }
  if (PUBLICATION_ID_FORBIDDEN_WHITESPACE.test(remainder)) {
    return { kind: 'invalid' };
  }
  const bytes = new TextEncoder().encode(remainder);
  if (bytes.length === 0 || bytes.length > QUEUE_PUBLICATION_ID_MAX_BYTES) {
    return { kind: 'invalid' };
  }
  for (const character of remainder) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'valid', publicationId: remainder };
}

/**
 * The vocabulary guard for the suites: the disposition module stays TOTAL
 * over the machine's vocabulary — a vocabulary change fails the suite
 * loudly (the no-strangers/no-gaps pin).
 */
export const QUEUE_DISPOSITION_KNOWN_STATUSES: readonly PublicationStatus[] = PUBLICATION_STATUSES;
