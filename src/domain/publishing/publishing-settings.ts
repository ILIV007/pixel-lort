/**
 * Publishing settings — the PURE domain for the Telegram admin panel
 * (slice 3: mode toggle + adjustable daily cap + event mode).
 *
 * DESIGN_2026-11-15.md §9.2/§9.3/§10.2/§10.6, MERGE_MAP_FREDY_AIADMIN.md §8:
 * - ONE mode setting with four values; default is direct (`auto`).
 * - Daily cap 12–18 (default 15), adjustable from the panel; a cap change
 *   takes effect from the NEXT Tehran day, never retroactively mid-day.
 * - Event mode lifts the cap and shortens the min gap (8–15 min) with a
 *   MANDATORY end: owner turns it off, or auto-off after 6 hours, or
 *   auto-off after 2 hours with no fresh P0 — whichever comes first.
 * - Only owner and chief_editor may change mode/cap/event.
 *
 * BOUNDARY: pure — no I/O, no clock, no Telegram types. The D1 store
 * (`src/adapters/db/publishing-settings-store.ts`) owns persistence; the
 * panel service owns rendering. The SAME input ALWAYS yields the SAME
 * answer.
 */
import { tehranBudgetDay } from '../../shared/time/tehran-day';
import type { AdminRole } from '../../admin/roles';

/** The four publishing modes (DESIGN §10.2). */
export const PUBLISH_MODES = ['auto', 'safe-auto', 'approval', 'paused'] as const;

export type PublishMode = (typeof PUBLISH_MODES)[number];

export function isPublishMode(value: string): value is PublishMode {
  return (PUBLISH_MODES as readonly string[]).includes(value);
}

/** Default mode is direct (owner decision): scheduled + direct, no preview. */
export const DEFAULT_PUBLISH_MODE: PublishMode = 'auto';

/** Daily cap bounds (DESIGN §9.2): 12–18, default 15. */
export const DEFAULT_DAILY_CAP = 15;
export const MIN_DAILY_CAP = 12;
export const MAX_DAILY_CAP = 18;

export function isValidDailyCap(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_DAILY_CAP && value <= MAX_DAILY_CAP;
}

/**
 * The daily cap record: the configured cap PLUS the cap that was effective
 * when the change was made, so a mid-day change can never rewrite today.
 * `changedTehranDate` is the Asia/Tehran calendar date of the last change
 * ('' when the cap was never changed — the default record).
 */
export interface DailyCapRecord {
  readonly cap: number;
  readonly previousCap: number;
  readonly changedTehranDate: string;
}

export function defaultDailyCapRecord(): DailyCapRecord {
  return { cap: DEFAULT_DAILY_CAP, previousCap: DEFAULT_DAILY_CAP, changedTehranDate: '' };
}

/**
 * The cap in force on a Tehran date: on the day of the change the OLD cap
 * still applies; from the next Tehran day the new cap applies.
 */
export function effectiveDailyCap(record: DailyCapRecord, tehranDate: string): number {
  return record.changedTehranDate === tehranDate ? record.previousCap : record.cap;
}

/**
 * The record after changing the cap on `todayTehranDate`: today's effective
 * cap becomes the new record's `previousCap`, so today keeps its cap and
 * tomorrow picks the new one up. A second change on the same day keeps the
 * same `previousCap` (today's effective cap) — the day is never rewritten.
 */
export function nextDailyCapRecord(
  record: DailyCapRecord,
  newCap: number,
  todayTehranDate: string,
): DailyCapRecord {
  return {
    cap: newCap,
    previousCap: effectiveDailyCap(record, todayTehranDate),
    changedTehranDate: todayTehranDate,
  };
}

/** 'YYYY-MM-DD' of the Tehran day after the given Tehran date. */
export function nextTehranDate(tehranDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tehranDate);
  if (match === null) {
    throw new Error('invalid Tehran date');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const next = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 'YYYY-MM-DD' Tehran date for an epoch-ms instant. */
export function tehranDateOf(nowMs: number): string {
  return tehranBudgetDay(nowMs);
}

/** How event mode was turned on: by hand from the panel, or by a real P0. */
export type EventTrigger = 'manual' | 'auto';

/**
 * The event-mode record. `lastP0AtMs` is the last fresh-P0 instant (the
 * start instant when the event began with no P0 yet): the 2-hour idle
 * auto-off counts from it, so a manual event with no P0 at all still ends
 * after 2 hours — the mandatory end has no silent exception.
 */
export interface EventModeRecord {
  readonly active: boolean;
  readonly startedAtMs: number;
  /** Telegram user id that started the event; 0 = the system (auto P0). */
  readonly startedBy: number;
  readonly trigger: EventTrigger;
  readonly lastP0AtMs: number;
}

export function inactiveEventRecord(): EventModeRecord {
  return { active: false, startedAtMs: 0, startedBy: 0, trigger: 'manual', lastP0AtMs: 0 };
}

/** Event auto-off: 6 hours after the start, whatever happens. */
export const EVENT_AUTO_OFF_MS = 6 * 60 * 60 * 1000;
/** Event auto-off: 2 hours with no fresh P0. */
export const EVENT_IDLE_OFF_MS = 2 * 60 * 60 * 1000;

export type EventResolution =
  | { readonly active: true }
  | { readonly active: false; readonly ended: 'off' | 'timeout' | 'idle' };

/**
 * Resolve a stored event record at `nowMs`. A stored-active event ends the
 * moment either deadline passes — whichever comes first. The resolution is
 * LAZY (no cron owns it): callers persist the expiry when they observe it.
 */
export function resolveEventState(record: EventModeRecord | null, nowMs: number): EventResolution {
  if (record === null || !record.active) {
    return { active: false, ended: 'off' };
  }
  if (nowMs - record.startedAtMs >= EVENT_AUTO_OFF_MS) {
    return { active: false, ended: 'timeout' };
  }
  if (nowMs - record.lastP0AtMs >= EVENT_IDLE_OFF_MS) {
    return { active: false, ended: 'idle' };
  }
  return { active: true };
}

/** Publishing priority classes (DESIGN §10.2 + blueprint anti-robot rules). */
export type PublishPriority = 'normal' | 'p1' | 'p0';

export type PublishGateDecision =
  | { readonly allowed: true; readonly bypass: boolean; readonly p0: boolean }
  | { readonly allowed: false; readonly reason: 'paused' | 'cap_reached' };

/**
 * The publish gate — the ONE decision every publish path asks BEFORE
 * sending. `todayCounted` counts only publications that consume the cap
 * (non-P0); P0 bypasses the cap and is marked in stats instead.
 *
 * - paused: NOTHING publishes — not even a P0 (DESIGN §10.2).
 * - event active: the cap is lifted for every priority.
 * - P0 outside an event: publishes past the cap (`bypass: true`).
 * - otherwise the cap binds: at the cap, the item waits for tomorrow.
 */
export function evaluatePublishGate(input: {
  readonly mode: PublishMode;
  readonly eventActive: boolean;
  /** Publications already counted against today's cap (non-P0 only). */
  readonly todayCounted: number;
  readonly cap: number;
  readonly priority: PublishPriority;
}): PublishGateDecision {
  if (input.mode === 'paused') {
    return { allowed: false, reason: 'paused' };
  }
  if (input.eventActive) {
    return { allowed: true, bypass: false, p0: input.priority === 'p0' };
  }
  if (input.priority === 'p0') {
    return { allowed: true, bypass: true, p0: true };
  }
  if (input.todayCounted >= input.cap) {
    return { allowed: false, reason: 'cap_reached' };
  }
  return { allowed: true, bypass: false, p0: false };
}

/**
 * Minimum gap between posts, in minutes (blueprint anti-robot rules +
 * DESIGN §9.2: event 8–15 min). The minimum of each range is the gate:
 * normal 25 min, P1 8 min; in an event the normal gap shortens to 15 min.
 */
export function minGapMinutes(input: {
  readonly eventActive: boolean;
  readonly priority: PublishPriority;
}): number {
  if (input.priority !== 'normal') {
    return 8;
  }
  return input.eventActive ? 15 : 25;
}

/**
 * Who may change mode/cap/event: owner and chief_editor ONLY. Enforced in
 * the panel service (defense in depth: router + callback time). This is a
 * ROLE check, not a blueprint permission: `roles.ts` mirrors the approved
 * admin map verbatim and the map carries no publishing-settings permission
 * — the owner/chief_editor rule is the slice-3 contract, not a map change.
 */
export function canChangePublishingSettings(role: AdminRole): boolean {
  return role === 'owner' || role === 'chief_editor';
}
