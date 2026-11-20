/**
 * Post-management policy (slice 6 — DESIGN §10.7: the bot manages its own
 * channel posts — pin/unpin, housekeeping).
 *
 * PURE, DETERMINISTIC, OFFLINE: no SQL, no network, no clock. The rules:
 *
 *  - MAX ONE ACTIVE PIN: the channel carries at most one pinned post. A
 *    new pin releases the previous one first (the service does both in
 *    ONE atomic batch; the database's expression unique index refuses a
 *    second active pin outright).
 *  - AUTO-PIN (default OFF): when the panel toggle is ON, a P0 publication
 *    (a very big story) pins itself as soon as it is sent, releasing the
 *    previous pin. The toggle is a panel setting — the scheduler never
 *    pins on its own authority.
 *  - RETENTION (default ON): a published post is EXPIRED when its age
 *    passes the retention rule for its category — the default is 90 days;
 *    a free-game announcement expires 7 days after publication (its offer
 *    is over by then). Expired posts surface in the housekeeping list
 *    under the `expired` filter; nothing is ever auto-deleted (OD-009 is
 *    still open — deletion is always an explicit, confirmed admin action).
 *  - DELETE is always a confirmed, audited admin action; the channel
 *    message is deleted through the Bot API and the durable delete row
 *    keeps the audit trail.
 */

/** The post-management settings keys (the `settings` table, slice-3 pattern). */
export const POST_MANAGEMENT_AUTO_PIN_SETTINGS_KEY = 'post_management.auto_pin_p0';
export const POST_MANAGEMENT_RETENTION_SETTINGS_KEY = 'post_management.retention';
export const POST_MANAGEMENT_EDIT_CAPTURE_SETTINGS_KEY = 'post_management.edit_capture';

/** The post references the pin ledger and the housekeeping list know. */
export type ChannelPostRefType = 'publication' | 'inbound';

/** Default retention: a general post expires after 90 days. */
export const DEFAULT_RETENTION_DAYS = 90;
/** A free-game announcement expires 7 days after publication. */
export const FREE_GAME_RETENTION_DAYS = 7;
/** Retention is ON by default (the expired filter works out of the box). */
export const DEFAULT_RETENTION_ENABLED = true;
/** Auto-pin is OFF by default (the panel toggle turns it on). */
export const DEFAULT_AUTO_PIN_P0_ENABLED = false;

/** The retention rule, as stored in `settings` (JSON, slice-3 pattern). */
export interface RetentionRule {
  /** The rule applies at all (off = nothing is ever expired). */
  readonly enabled: boolean;
  /** Expiry age in days for a general post. */
  readonly defaultDays: number;
  /** Expiry age in days for a free-game announcement. */
  readonly freeGameDays: number;
}

export function defaultRetentionRule(): RetentionRule {
  return {
    enabled: DEFAULT_RETENTION_ENABLED,
    defaultDays: DEFAULT_RETENTION_DAYS,
    freeGameDays: FREE_GAME_RETENTION_DAYS,
  };
}

/** The retention bound: 1 day .. 365 days (a corrupt row repairs to default). */
export function isValidRetentionDays(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= 365;
}

/**
 * Is a published post EXPIRED under the rule? A post is expired when its
 * age (now - publishedAt) passes the rule's days for its category. A
 * disabled rule expires nothing; an unknown category uses the default.
 */
export function isPostExpired(input: {
  readonly rule: RetentionRule;
  readonly category: string;
  readonly publishedAtMs: number;
  readonly nowMs: number;
}): boolean {
  if (!input.rule.enabled) {
    return false;
  }
  const days = input.category === 'free_game' ? input.rule.freeGameDays : input.rule.defaultDays;
  return input.nowMs - input.publishedAtMs >= days * 24 * 60 * 60 * 1000;
}
