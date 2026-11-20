/**
 * Slice 4 — approval-preview lifetime for the inbound pipeline (DESIGN
 * §10.2): an approval preview expires 24 hours after the owner sends the
 * post. The expiry is enforced on callback (state -> 'expired') and by
 * the partial unique index (only one pending approval per source message).
 */
export const INBOUND_APPROVAL_EXPIRY_MS = 24 * 3_600_000;

/** The same lifetime, in hours, for user-facing strings. */
export const INBOUND_APPROVAL_TTL_HOURS = 24;
