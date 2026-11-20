/**
 * Publishing-settings store boundary (slice 3: mode + daily cap + event
 * mode) over the EXISTING `settings`, `budgets`, and `audit_events`
 * tables (schema 1) — ZERO DDL, no migration: the panel is a workflow
 * over tables the schema already carries, the same discipline as the
 * admin UI language store (settings keys) and the AI/ingestion budget
 * stores (budgets rows per Tehran day).
 *
 * State layout:
 * - `settings` key `publishing.mode` — {mode, updated_by, updated_at_ms}.
 * - `settings` key `publishing.daily_cap` — {cap, previous_cap,
 *   changed_tehran_date}: a mid-day change keeps today's cap and takes
 *   effect from the next Tehran day (DESIGN §9.2).
 * - `settings` key `publishing.event_mode` — {active, started_at_ms,
 *   started_by, trigger, last_p0_at_ms}.
 * - `budgets` scope `publication`, bucket_date = Tehran day:
 *   `daily_posts` counts publications that consume the cap (non-P0);
 *   `daily_posts_p0` counts P0 bypass publications (marked in stats).
 *   A new Tehran day is a new bucket — the counter resets at 00:00
 *   Tehran by construction, never by a sweep.
 * - `audit_events`: EVERY applied change carries one deterministic audit
 *   event (setting + audit apply in ONE atomic batch — a change without
 *   its audit never lands). P0 refreshes of an active event update only
 *   `last_p0_at_ms` (no audit spam); the activation and auto-off audits
 *   bracket them.
 *
 * Corrupt settings rows behave as "no preference" (the defaults) — a
 * presentation/settings row must never become permanently stuck; the
 * next valid save repairs it (the ui-language-store discipline).
 *
 * Parameterized SQL only; no rows, ids, or payload contents are logged
 * (ADR-0022).
 */
import type { DbExecutor } from './db-executor';
import { randomToken } from '../../domain/admin-post/fingerprint';
import {
  DEFAULT_PUBLISH_MODE,
  defaultDailyCapRecord,
  effectiveDailyCap,
  evaluatePublishGate,
  inactiveEventRecord,
  isPublishMode,
  isValidDailyCap,
  nextDailyCapRecord,
  nextTehranDate,
  resolveEventState,
  tehranDateOf,
  type DailyCapRecord,
  type EventModeRecord,
  type EventTrigger,
  type PublishGateDecision,
  type PublishMode,
  type PublishPriority,
} from '../../domain/publishing/publishing-settings';
import { tehranBudgetDay } from '../../shared/time/tehran-day';

/** Settings-table keys for the three publishing settings. */
export const PUBLISHING_MODE_SETTINGS_KEY = 'publishing.mode';
export const PUBLISHING_CAP_SETTINGS_KEY = 'publishing.daily_cap';
export const PUBLISHING_EVENT_SETTINGS_KEY = 'publishing.event_mode';

/** Budgets-table scope/keys for the daily publication counter (D1, not KV). */
export const PUBLICATION_BUDGET_SCOPE = 'publication';
export const PUBLICATION_BUDGET_KEY = 'daily_posts';
export const PUBLICATION_P0_BUDGET_KEY = 'daily_posts_p0';
/**
 * Slice 4 — owner-sent inbound posts are EXEMPT from the daily cap (DESIGN
 * §9.2 proposal) but VISIBLE in stats: they count in their own bucket, never
 * in `daily_posts`, so they can never consume the automatic cap.
 */
export const PUBLICATION_OWNER_BUDGET_KEY = 'daily_posts_owner';

/** Deterministic audit actions (one per applied change). */
export const PUBLISHING_AUDIT_ACTIONS = {
  modeChanged: 'settings.mode_changed',
  capChanged: 'settings.cap_changed',
  eventChanged: 'settings.event_changed',
  eventAutoOff: 'settings.event_auto_off',
  eventAutoTriggered: 'settings.event_auto_triggered',
} as const;

/** The permission recorded on every publishing-settings audit event. */
export const PUBLISHING_SETTINGS_AUDIT_PERMISSION = 'settings.publishing';

export interface PublishingSettingsSnapshot {
  readonly mode: PublishMode;
  readonly cap: DailyCapRecord;
  readonly event: EventModeRecord | null;
}

export interface TodayCounts {
  readonly tehranDate: string;
  /** Publications counted against today's cap (non-P0 only). */
  readonly counted: number;
  /** P0 publications that bypassed the cap. */
  readonly p0Bypass: number;
  /** Owner-sent inbound publications (cap-exempt, slice 4). */
  readonly owner: number;
  /** All publications today (counted + P0 bypass + owner). */
  readonly published: number;
}

interface StoredMode {
  readonly mode: string;
  readonly updated_by?: unknown;
  readonly updated_at_ms?: unknown;
}

interface StoredCap {
  readonly cap?: unknown;
  readonly previous_cap?: unknown;
  readonly changed_tehran_date?: unknown;
}

interface StoredEvent {
  readonly active?: unknown;
  readonly started_at_ms?: unknown;
  readonly started_by?: unknown;
  readonly trigger?: unknown;
  readonly last_p0_at_ms?: unknown;
}

function parseStoredJson<T>(valueJson: string): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as T;
}

function parseMode(valueJson: string | null): PublishMode {
  if (valueJson === null) {
    return DEFAULT_PUBLISH_MODE;
  }
  const stored = parseStoredJson<StoredMode>(valueJson);
  if (stored === null || !isPublishMode(stored.mode)) {
    return DEFAULT_PUBLISH_MODE;
  }
  return stored.mode;
}

function parseCap(valueJson: string | null): DailyCapRecord {
  const fallback = defaultDailyCapRecord();
  if (valueJson === null) {
    return fallback;
  }
  const stored = parseStoredJson<StoredCap>(valueJson);
  if (stored === null) {
    return fallback;
  }
  const cap = typeof stored.cap === 'number' && isValidDailyCap(stored.cap) ? stored.cap : null;
  const previousCap =
    typeof stored.previous_cap === 'number' && isValidDailyCap(stored.previous_cap)
      ? stored.previous_cap
      : null;
  const changedTehranDate =
    typeof stored.changed_tehran_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(stored.changed_tehran_date)
      ? stored.changed_tehran_date
      : null;
  if (cap === null || previousCap === null || changedTehranDate === null) {
    return fallback;
  }
  return { cap, previousCap, changedTehranDate };
}

function parseEvent(valueJson: string | null): EventModeRecord | null {
  if (valueJson === null) {
    return null;
  }
  const stored = parseStoredJson<StoredEvent>(valueJson);
  if (stored === null || typeof stored.active !== 'boolean') {
    return null;
  }
  const startedAtMs =
    typeof stored.started_at_ms === 'number' && Number.isSafeInteger(stored.started_at_ms)
      ? stored.started_at_ms
      : 0;
  const startedBy =
    typeof stored.started_by === 'number' &&
    Number.isSafeInteger(stored.started_by) &&
    stored.started_by >= 0
      ? stored.started_by
      : 0;
  const trigger = stored.trigger === 'manual' || stored.trigger === 'auto' ? stored.trigger : null;
  const lastP0AtMs =
    typeof stored.last_p0_at_ms === 'number' && Number.isSafeInteger(stored.last_p0_at_ms)
      ? stored.last_p0_at_ms
      : startedAtMs;
  if (trigger === null) {
    return null;
  }
  return { active: stored.active, startedAtMs, startedBy, trigger, lastP0AtMs };
}

async function readSettingsRows(executor: DbExecutor): Promise<Readonly<Record<string, string>>> {
  const { rows } = await executor.query<{ key: string; value_json: string }>({
    sql: `SELECT key, value_json FROM settings
          WHERE key IN (?, ?, ?)`,
    params: [
      PUBLISHING_MODE_SETTINGS_KEY,
      PUBLISHING_CAP_SETTINGS_KEY,
      PUBLISHING_EVENT_SETTINGS_KEY,
    ],
  });
  const byKey: Record<string, string> = {};
  for (const row of rows) {
    byKey[row.key] = row.value_json;
  }
  return byKey;
}

/** One bounded read of all three publishing settings (defaults on absence). */
export async function readPublishingSettings(
  executor: DbExecutor,
): Promise<PublishingSettingsSnapshot> {
  const byKey = await readSettingsRows(executor);
  return {
    mode: parseMode(byKey[PUBLISHING_MODE_SETTINGS_KEY] ?? null),
    cap: parseCap(byKey[PUBLISHING_CAP_SETTINGS_KEY] ?? null),
    event: parseEvent(byKey[PUBLISHING_EVENT_SETTINGS_KEY] ?? null),
  };
}

function recordAudit(input: {
  readonly actorType: 'admin' | 'system';
  readonly actorId: string | null;
  readonly action: string;
  readonly targetId: string;
  readonly metadata: Record<string, unknown>;
  readonly nowMs: number;
}): { readonly sql: string; readonly params: readonly unknown[] } {
  return {
    sql: `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type,
            target_id, trace_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, 'settings', ?, NULL, ?, ?)`,
    params: [
      `panel:${randomToken()}`,
      input.actorType,
      input.actorId,
      input.action,
      input.targetId,
      JSON.stringify(input.metadata),
      input.nowMs,
    ],
  };
}

function upsertSettingStatement(
  key: string,
  valueJson: string,
  nowMs: number,
): { readonly sql: string; readonly params: readonly unknown[] } {
  // updated_by stays NULL: the column references admins(telegram_user_id)
  // and the bootstrap owner is authorized WITHOUT an admins row (the
  // ui-language-store discipline).
  return {
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES (?, ?, 1, NULL, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    params: [key, valueJson, nowMs],
  };
}

export type SetPublishModeOutcome =
  | { readonly kind: 'applied'; readonly priorMode: PublishMode }
  | { readonly kind: 'no_change'; readonly mode: PublishMode };

/** Change the publishing mode. The setting + its audit apply atomically. */
export async function setPublishMode(
  executor: DbExecutor,
  input: { readonly mode: PublishMode; readonly actorId: number; readonly nowMs: number },
): Promise<SetPublishModeOutcome> {
  const current = await readPublishingSettings(executor);
  if (current.mode === input.mode) {
    return { kind: 'no_change', mode: input.mode };
  }
  const valueJson = JSON.stringify({
    mode: input.mode,
    updated_by: input.actorId,
    updated_at_ms: input.nowMs,
  });
  await executor.batch([
    upsertSettingStatement(PUBLISHING_MODE_SETTINGS_KEY, valueJson, input.nowMs),
    recordAudit({
      actorType: 'admin',
      actorId: String(input.actorId),
      action: PUBLISHING_AUDIT_ACTIONS.modeChanged,
      targetId: PUBLISHING_MODE_SETTINGS_KEY,
      metadata: {
        permission: PUBLISHING_SETTINGS_AUDIT_PERMISSION,
        mode: input.mode,
        priorMode: current.mode,
      },
      nowMs: input.nowMs,
    }),
  ]);
  return { kind: 'applied', priorMode: current.mode };
}

export type SetDailyCapOutcome =
  | {
      readonly kind: 'applied';
      readonly priorEffectiveCap: number;
      /** First Tehran date the new cap is in force (tomorrow at the earliest). */
      readonly effectiveFrom: string;
    }
  | { readonly kind: 'no_change'; readonly cap: number }
  | { readonly kind: 'invalid' };

/**
 * Change the daily cap (12–18). The change NEVER rewrites today: today's
 * effective cap stays the old one and the new cap applies from the next
 * Tehran day. The setting + its audit apply atomically.
 */
export async function setDailyCap(
  executor: DbExecutor,
  input: { readonly cap: number; readonly actorId: number; readonly nowMs: number },
): Promise<SetDailyCapOutcome> {
  if (!isValidDailyCap(input.cap)) {
    return { kind: 'invalid' };
  }
  const today = tehranDateOf(input.nowMs);
  const current = await readPublishingSettings(executor);
  if (current.cap.cap === input.cap) {
    return { kind: 'no_change', cap: input.cap };
  }
  const priorEffectiveCap = effectiveDailyCap(current.cap, today);
  const next = nextDailyCapRecord(current.cap, input.cap, today);
  const valueJson = JSON.stringify({
    cap: next.cap,
    previous_cap: next.previousCap,
    changed_tehran_date: next.changedTehranDate,
  });
  await executor.batch([
    upsertSettingStatement(PUBLISHING_CAP_SETTINGS_KEY, valueJson, input.nowMs),
    recordAudit({
      actorType: 'admin',
      actorId: String(input.actorId),
      action: PUBLISHING_AUDIT_ACTIONS.capChanged,
      targetId: PUBLISHING_CAP_SETTINGS_KEY,
      metadata: {
        permission: PUBLISHING_SETTINGS_AUDIT_PERMISSION,
        cap: input.cap,
        priorEffectiveCap,
        effectiveFrom: nextTehranDate(today),
      },
      nowMs: input.nowMs,
    }),
  ]);
  return { kind: 'applied', priorEffectiveCap, effectiveFrom: nextTehranDate(today) };
}

export type SetEventModeOutcome =
  | { readonly kind: 'applied'; readonly active: boolean; readonly priorActive: boolean }
  | { readonly kind: 'no_change'; readonly active: boolean };

/**
 * Turn event mode on/off by hand from the panel. Turning ON starts the
 * clock (6-hour deadline) with `lastP0AtMs = now` — a manual event with
 * no P0 at all still ends after 2 idle hours. The setting + its audit
 * apply atomically.
 */
export async function setEventMode(
  executor: DbExecutor,
  input: {
    readonly active: boolean;
    readonly trigger: EventTrigger;
    readonly actorId: number;
    readonly nowMs: number;
  },
): Promise<SetEventModeOutcome> {
  const current = await readPublishingSettings(executor);
  const resolved = resolveEventState(current.event, input.nowMs);
  if (resolved.active === input.active) {
    return { kind: 'no_change', active: input.active };
  }
  const next: EventModeRecord = input.active
    ? {
        active: true,
        startedAtMs: input.nowMs,
        startedBy: input.actorId,
        trigger: input.trigger,
        lastP0AtMs: input.nowMs,
      }
    : {
        ...(current.event ?? inactiveEventRecord()),
        active: false,
      };
  const valueJson = JSON.stringify({
    active: next.active,
    started_at_ms: next.startedAtMs,
    started_by: next.startedBy,
    trigger: next.trigger,
    last_p0_at_ms: next.lastP0AtMs,
  });
  await executor.batch([
    upsertSettingStatement(PUBLISHING_EVENT_SETTINGS_KEY, valueJson, input.nowMs),
    recordAudit({
      actorType: 'admin',
      actorId: String(input.actorId),
      action: PUBLISHING_AUDIT_ACTIONS.eventChanged,
      targetId: PUBLISHING_EVENT_SETTINGS_KEY,
      metadata: {
        permission: PUBLISHING_SETTINGS_AUDIT_PERMISSION,
        active: input.active,
        trigger: input.trigger,
        priorActive: resolved.active,
      },
      nowMs: input.nowMs,
    }),
  ]);
  return { kind: 'applied', active: input.active, priorActive: resolved.active };
}

export type TriggerEventOnP0Outcome =
  { readonly kind: 'activated' } | { readonly kind: 'refreshed' };

/**
 * The auto-trigger seam for a REAL P0 (a game reveal, a surprise
 * release): the future P0 detector calls this, never the panel. An
 * inactive event ACTIVATES (trigger `auto`, audited as a system action);
 * an active event only refreshes `lastP0AtMs` — the 2-hour idle clock
 * restarts with every fresh P0, with no audit spam.
 */
export async function triggerEventOnP0(
  executor: DbExecutor,
  input: { readonly nowMs: number },
): Promise<TriggerEventOnP0Outcome> {
  const current = await readPublishingSettings(executor);
  const resolved = resolveEventState(current.event, input.nowMs);
  if (!resolved.active) {
    const next: EventModeRecord = {
      active: true,
      startedAtMs: input.nowMs,
      startedBy: 0,
      trigger: 'auto',
      lastP0AtMs: input.nowMs,
    };
    const valueJson = JSON.stringify({
      active: next.active,
      started_at_ms: next.startedAtMs,
      started_by: next.startedBy,
      trigger: next.trigger,
      last_p0_at_ms: next.lastP0AtMs,
    });
    await executor.batch([
      upsertSettingStatement(PUBLISHING_EVENT_SETTINGS_KEY, valueJson, input.nowMs),
      recordAudit({
        actorType: 'system',
        actorId: null,
        action: PUBLISHING_AUDIT_ACTIONS.eventAutoTriggered,
        targetId: PUBLISHING_EVENT_SETTINGS_KEY,
        metadata: { permission: PUBLISHING_SETTINGS_AUDIT_PERMISSION, trigger: 'auto' },
        nowMs: input.nowMs,
      }),
    ]);
    return { kind: 'activated' };
  }
  const refreshed: EventModeRecord = {
    ...(current.event ?? inactiveEventRecord()),
    active: true,
    lastP0AtMs: input.nowMs,
  };
  const valueJson = JSON.stringify({
    active: refreshed.active,
    started_at_ms: refreshed.startedAtMs,
    started_by: refreshed.startedBy,
    trigger: refreshed.trigger,
    last_p0_at_ms: refreshed.lastP0AtMs,
  });
  await executor.run(upsertSettingStatement(PUBLISHING_EVENT_SETTINGS_KEY, valueJson, input.nowMs));
  return { kind: 'refreshed' };
}

export type ExpireEventModeOutcome =
  | { readonly kind: 'applied'; readonly reason: 'timeout' | 'idle' }
  | { readonly kind: 'no_change' };

/**
 * Persist an observed event auto-off (the lazy expiry: callers resolve
 * the state, then persist it here so the stored record and the audit log
 * agree the event ended). The setting + its audit apply atomically.
 */
export async function expireEventMode(
  executor: DbExecutor,
  input: { readonly reason: 'timeout' | 'idle'; readonly nowMs: number },
): Promise<ExpireEventModeOutcome> {
  const current = await readPublishingSettings(executor);
  const resolved = resolveEventState(current.event, input.nowMs);
  if (resolved.active) {
    return { kind: 'no_change' };
  }
  if (current.event === null || !current.event.active) {
    return { kind: 'no_change' };
  }
  const next: EventModeRecord = { ...current.event, active: false };
  const valueJson = JSON.stringify({
    active: next.active,
    started_at_ms: next.startedAtMs,
    started_by: next.startedBy,
    trigger: next.trigger,
    last_p0_at_ms: next.lastP0AtMs,
  });
  await executor.batch([
    upsertSettingStatement(PUBLISHING_EVENT_SETTINGS_KEY, valueJson, input.nowMs),
    recordAudit({
      actorType: 'system',
      actorId: null,
      action: PUBLISHING_AUDIT_ACTIONS.eventAutoOff,
      targetId: PUBLISHING_EVENT_SETTINGS_KEY,
      metadata: { permission: PUBLISHING_SETTINGS_AUDIT_PERMISSION, reason: input.reason },
      nowMs: input.nowMs,
    }),
  ]);
  return { kind: 'applied', reason: input.reason };
}

async function readBudgetRow(
  executor: DbExecutor,
  budgetKey: string,
  bucketDate: string,
): Promise<number> {
  const row = await executor.first<{ requests: number }>({
    sql: `SELECT requests FROM budgets
          WHERE scope = ? AND budget_key = ? AND bucket_date = ?`,
    params: [PUBLICATION_BUDGET_SCOPE, budgetKey, bucketDate],
  });
  return row === null ? 0 : row.requests;
}

/** Today's publication counts for a Tehran date (0 when nothing published). */
export async function readTodayCounts(
  executor: DbExecutor,
  input: { readonly nowMs: number },
): Promise<TodayCounts> {
  const tehranDate = tehranBudgetDay(input.nowMs);
  const counted = await readBudgetRow(executor, PUBLICATION_BUDGET_KEY, tehranDate);
  const p0Bypass = await readBudgetRow(executor, PUBLICATION_P0_BUDGET_KEY, tehranDate);
  const owner = await readBudgetRow(executor, PUBLICATION_OWNER_BUDGET_KEY, tehranDate);
  return { tehranDate, counted, p0Bypass, owner, published: counted + p0Bypass + owner };
}

/**
 * Record one successful channel publication in today's Tehran bucket. A
 * P0 publication increments ONLY the bypass counter (it never consumes
 * the cap); every other publication increments the counted counter. The
 * UPDATE + INSERT pair is the ai-budget-store pattern: a new day's row
 * and its first charge are atomic.
 */
export async function recordPublication(
  executor: DbExecutor,
  input: { readonly isP0: boolean; readonly nowMs: number },
): Promise<TodayCounts> {
  const tehranDate = tehranBudgetDay(input.nowMs);
  const budgetKey = input.isP0 ? PUBLICATION_P0_BUDGET_KEY : PUBLICATION_BUDGET_KEY;
  await executor.batch([
    {
      sql: `UPDATE budgets
              SET requests = requests + 1, updated_at = ?
            WHERE scope = ? AND budget_key = ? AND bucket_date = ?`,
      params: [input.nowMs, PUBLICATION_BUDGET_SCOPE, budgetKey, tehranDate],
    },
    {
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            SELECT ?, ?, ?, 1, 0, 0, 0, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM budgets
                WHERE scope = ? AND budget_key = ? AND bucket_date = ?
             )`,
      params: [
        PUBLICATION_BUDGET_SCOPE,
        budgetKey,
        tehranDate,
        input.nowMs,
        PUBLICATION_BUDGET_SCOPE,
        budgetKey,
        tehranDate,
      ],
    },
  ]);
  return readTodayCounts(executor, input);
}

/**
 * Slice 4 — record one successful OWNER-sent inbound publication in
 * today's Tehran bucket. It increments ONLY the owner bucket: the post is
 * visible in stats (`published`) but never consumes the automatic daily
 * cap. Same UPDATE + INSERT atomic pair as `recordPublication`.
 */
export async function recordOwnerPublication(
  executor: DbExecutor,
  input: { readonly nowMs: number },
): Promise<TodayCounts> {
  const tehranDate = tehranBudgetDay(input.nowMs);
  await executor.batch([
    {
      sql: `UPDATE budgets
              SET requests = requests + 1, updated_at = ?
            WHERE scope = ? AND budget_key = ? AND bucket_date = ?`,
      params: [input.nowMs, PUBLICATION_BUDGET_SCOPE, PUBLICATION_OWNER_BUDGET_KEY, tehranDate],
    },
    {
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            SELECT ?, ?, ?, 1, 0, 0, 0, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM budgets
                WHERE scope = ? AND budget_key = ? AND bucket_date = ?
             )`,
      params: [
        PUBLICATION_BUDGET_SCOPE,
        PUBLICATION_OWNER_BUDGET_KEY,
        tehranDate,
        input.nowMs,
        PUBLICATION_BUDGET_SCOPE,
        PUBLICATION_OWNER_BUDGET_KEY,
        tehranDate,
      ],
    },
  ]);
  return readTodayCounts(executor, input);
}

export interface PublishGateCheck {
  readonly decision: PublishGateDecision;
  readonly mode: PublishMode;
  readonly eventActive: boolean;
  readonly cap: number;
  readonly counted: number;
  readonly published: number;
  readonly p0Bypass: number;
  readonly tehranDate: string;
}

/**
 * The read-only gate check for a publish path: settings + today's counts
 * + the RESOLVED event state (an expired stored-active event already
 * counts as off here — the stored record is persisted by the panel's
 * lazy expiry, never by this read).
 */
export async function checkPublishGate(
  executor: DbExecutor,
  input: { readonly priority: PublishPriority; readonly nowMs: number },
): Promise<PublishGateCheck> {
  const settings = await readPublishingSettings(executor);
  const counts = await readTodayCounts(executor, input);
  const tehranDate = tehranDateOf(input.nowMs);
  const eventActive = resolveEventState(settings.event, input.nowMs).active;
  const cap = effectiveDailyCap(settings.cap, tehranDate);
  const decision = evaluatePublishGate({
    mode: settings.mode,
    eventActive,
    todayCounted: counts.counted,
    cap,
    priority: input.priority,
  });
  return {
    decision,
    mode: settings.mode,
    eventActive,
    cap,
    counted: counts.counted,
    published: counts.published,
    p0Bypass: counts.p0Bypass,
    tehranDate,
  };
}
