/**
 * Steam watchlist rotation cursor (Round 1.7 — R04).
 *
 * BOUNDED, VERSIONED, OPAQUE cursor JSON persisted to
 * `source_state.cursor` through the REAL poll handler's atomic
 * items/state commit (ADR-0038 §5). Pure functions only — no network,
 * no storage, no clocks (AGENTS.md §4).
 *
 * Cursor shape (exactly four keys, strict — unknown keys are rejected):
 *   {"v":1,"fp":"<8 hex>","n":<length>,"start":<index>}
 *
 * Design invariants (docs/reviews/PIXEL_ROUND1_7_STEAM_ROTATION.md):
 * - The cursor NEVER carries an app ID, URL or host. The only positional
 *   fact it carries is `start`, and every request is derived from the
 *   CURRENT strictly validated owner watchlist and the PINNED official
 *   endpoint. Even a forged or fingerprint-colliding cursor can at worst
 *   select a different start index WITHIN the current watchlist — it can
 *   never introduce a new app ID or endpoint.
 * - The watchlist fingerprint binds the cursor to the exact ordered
 *   owner list (duplicates preserved — owner configuration is never
 *   silently deduplicated or rewritten). FNV-1a 32-bit is sufficient
 *   HERE precisely because a collision is not a security boundary: it
 *   only affects WHERE a rotation window begins, never WHAT can be
 *   requested.
 * - Deterministic reset policy: null/empty starts at index 0; malformed,
 *   oversized, wrong-version, structurally invalid, watchlist-mismatched
 *   (grow/shrink via `n`, reorder/exact-change via `fp`) and
 *   out-of-range cursors reset to index 0. Rotation restarts from the
 *   head of the CURRENT watchlist — conservative and deterministic.
 *   Coverage requires a stable watchlist and successful polls (see connector).
 * - No unbounded storage/parsing: serialized cursors are ~60 bytes and
 *   any input longer than STEAM_CURSOR_MAX_CHARS is reset without
 *   parsing.
 */
import { z } from 'zod';

/** Cursor contract version — bumped only by a documented policy change. */
export const STEAM_CURSOR_VERSION = 1;

/** Any persisted cursor longer than this is reset WITHOUT parsing. */
export const STEAM_CURSOR_MAX_CHARS = 512;

/** Watchlist upper bound mirrored from the runtime config schema (max 50). */
const MAX_WATCHLIST = 50;

const SteamCursorSchema = z
  .object({
    v: z.literal(STEAM_CURSOR_VERSION),
    fp: z.string().regex(/^[0-9a-f]{8}$/),
    n: z.number().int().min(1).max(MAX_WATCHLIST),
    start: z
      .number()
      .int()
      .min(0)
      .max(MAX_WATCHLIST - 1),
  })
  .strict();

export interface SteamCursorPlacement {
  /** Index in the CURRENT watchlist where the next window begins. */
  readonly start: number;
  /** True when a NON-EMPTY raw cursor was unusable and was reset. */
  readonly reset: boolean;
}

/**
 * FNV-1a 32-bit over the canonical JSON of the validated ordered
 * watchlist (order-sensitive, duplicates preserved). Returns 8 lowercase
 * hex chars. Deterministic across processes and restarts.
 */
export function steamWatchlistFingerprint(apps: readonly number[]): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(apps);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Normalize a persisted cursor against the CURRENT validated watchlist.
 * Total function: never throws, whatever the stored bytes are. See the
 * documented reset policy in the module header.
 */
export function normalizeSteamCursor(
  raw: string | null,
  apps: readonly number[],
): SteamCursorPlacement {
  if (apps.length === 0) {
    return { start: 0, reset: false };
  }
  if (raw === null || raw.length === 0) {
    return { start: 0, reset: false }; // fresh rotation — the normal initial state
  }
  if (raw.length > STEAM_CURSOR_MAX_CHARS) {
    return { start: 0, reset: true }; // oversized: reset WITHOUT parsing
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { start: 0, reset: true }; // malformed JSON
  }
  const candidate = SteamCursorSchema.safeParse(parsed);
  if (!candidate.success) {
    return { start: 0, reset: true }; // wrong version / unknown keys / wrong types / out of range
  }
  const cursor = candidate.data;
  if (cursor.n !== apps.length) {
    return { start: 0, reset: true }; // watchlist grew or shrank
  }
  if (cursor.fp !== steamWatchlistFingerprint(apps)) {
    return { start: 0, reset: true }; // watchlist reordered or otherwise changed
  }
  if (cursor.start < 0 || cursor.start >= apps.length) {
    return { start: 0, reset: true }; // defense in depth (already implied by n + schema)
  }
  return { start: cursor.start, reset: false };
}

/**
 * Serialize the opaque cursor for a validated watchlist and window start.
 * Bounded output (~60 bytes; well under STEAM_CURSOR_MAX_CHARS).
 */
export function buildSteamCursor(apps: readonly number[], start: number): string {
  return JSON.stringify({
    v: STEAM_CURSOR_VERSION,
    fp: steamWatchlistFingerprint(apps),
    n: apps.length,
    start,
  });
}

/**
 * Proposed next window start after a SUCCESSFUL complete-batch poll:
 * `(start + selectedCount) mod currentLength` (Round 1.7 scope, point 3).
 */
export function nextSteamCursorStart(
  start: number,
  selectedCount: number,
  currentLength: number,
): number {
  return (start + selectedCount) % currentLength;
}
