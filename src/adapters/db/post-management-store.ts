/**
 * Slice 6 — the post-management store (`channel_pins` +
 * `channel_post_deletes`, migration 0009; the auto-pin toggle, the
 * retention rule and the edit capture live in `settings`, slice-3
 * pattern).
 *
 * Durable records for post management (DESIGN §10.7):
 * - `channel_pins`: ONE row per pin action. At most ONE active pin in
 *   the whole channel — the service releases the previous pin BEFORE
 *   inserting the new one in the SAME atomic batch, and the database's
 *   expression unique index refuses a second active pin outright.
 * - `channel_post_deletes`: the durable record of a housekeeping
 *   deletion (the channel message itself is deleted through the Bot API;
 *   the row is the audit trail AND the exclusion from the housekeeping
 *   list).
 * - `settings` keys `post_management.auto_pin_p0` (the P0 auto-pin
 *   toggle, default OFF), `post_management.retention` (the expiry rule,
 *   default 90 days / 7 for free games) and
 *   `post_management.edit_capture` (the open in-place-edit capture:
 *   one admin, one post, 30 minutes).
 *
 * BOUNDARY (ADR-0022): all D1 access for these tables goes through this
 * module. Never log SQL text or bind parameters; never log full rows.
 */
import type { DbExecutor } from './db-executor';
import { randomToken } from '../../domain/admin-post/fingerprint';
import {
  POST_MANAGEMENT_AUTO_PIN_SETTINGS_KEY,
  POST_MANAGEMENT_EDIT_CAPTURE_SETTINGS_KEY,
  POST_MANAGEMENT_RETENTION_SETTINGS_KEY,
  defaultRetentionRule,
  isPostExpired,
  isValidRetentionDays,
  type ChannelPostRefType,
  type RetentionRule,
} from '../../domain/publishing/post-management';

/** The edit-capture TTL: an unanswered capture expires after 30 minutes. */
export const EDIT_CAPTURE_TTL_MS = 30 * 60 * 1000;

/** Deterministic audit actions (one per applied change). */
export const POST_MANAGEMENT_AUDIT_ACTIONS = {
  pinChanged: 'post_management.pin_changed',
  autoPinChanged: 'post_management.auto_pin_changed',
  retentionChanged: 'post_management.retention_changed',
  postDeleted: 'post_management.post_deleted',
  postEdited: 'post_management.post_edited',
} as const;

/** The permission recorded on every post-management audit event. */
export const POST_MANAGEMENT_AUDIT_PERMISSION = 'post_management';

export interface ChannelPinRow {
  readonly id: string;
  readonly channelMessageId: number;
  readonly postRefType: ChannelPostRefType;
  readonly postRefId: string;
  readonly status: 'active' | 'released';
  readonly pinnedBy: number;
  readonly pinnedAtMs: number;
  readonly unpinnedAtMs: number | null;
  readonly unpinnedBy: number | null;
}

interface ChannelPinDbRow {
  readonly id: string;
  readonly channel_message_id: number;
  readonly post_ref_type: string;
  readonly post_ref_id: string;
  readonly status: string;
  readonly pinned_by: number;
  readonly pinned_at_ms: number;
  readonly unpinned_at_ms: number | null;
  readonly unpinned_by: number | null;
}

function toChannelPinRow(row: ChannelPinDbRow): ChannelPinRow | null {
  if (row.post_ref_type !== 'publication' && row.post_ref_type !== 'inbound') {
    return null;
  }
  if (row.status !== 'active' && row.status !== 'released') {
    return null;
  }
  return {
    id: row.id,
    channelMessageId: row.channel_message_id,
    postRefType: row.post_ref_type,
    postRefId: row.post_ref_id,
    status: row.status,
    pinnedBy: row.pinned_by,
    pinnedAtMs: row.pinned_at_ms,
    unpinnedAtMs: row.unpinned_at_ms,
    unpinnedBy: row.unpinned_by,
  };
}

const PIN_COLUMNS = `id, channel_message_id, post_ref_type, post_ref_id,
  status, pinned_by, pinned_at_ms, unpinned_at_ms, unpinned_by`;

export async function getActivePin(executor: DbExecutor): Promise<ChannelPinRow | null> {
  const row = await executor.first<ChannelPinDbRow>({
    sql: `SELECT ${PIN_COLUMNS} FROM channel_pins
           WHERE status = 'active'
           ORDER BY pinned_at_ms DESC LIMIT 1`,
  });
  return row === null ? null : toChannelPinRow(row);
}

export type PinChannelPostOutcome =
  | { readonly kind: 'pinned'; readonly releasedPrevious: boolean }
  | { readonly kind: 'already_pinned' };

/**
 * Pin a channel message. The previous active pin (if any) is RELEASED
 * first and the new pin inserted in the SAME atomic batch — the channel
 * never carries two active pins, and the database's expression unique
 * index is the backstop. A message that is already the active pin is a
 * no-op (no second row, no audit spam).
 */
export async function pinChannelPost(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly channelMessageId: number;
    readonly postRefType: ChannelPostRefType;
    readonly postRefId: string;
    readonly pinnedBy: number;
    readonly nowMs: number;
  },
): Promise<PinChannelPostOutcome> {
  const active = await getActivePin(executor);
  if (active !== null && active.channelMessageId === input.channelMessageId) {
    return { kind: 'already_pinned' };
  }
  const metas = await executor.batch([
    {
      sql: `UPDATE channel_pins
               SET status = 'released', unpinned_at_ms = ?, unpinned_by = ?,
                   updated_at_ms = ?
             WHERE status = 'active'`,
      params: [input.nowMs, input.pinnedBy, input.nowMs],
    },
    {
      sql: `INSERT INTO channel_pins
                   (id, channel_message_id, post_ref_type, post_ref_id,
                    status, pinned_by, pinned_at_ms, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      params: [
        input.id,
        input.channelMessageId,
        input.postRefType,
        input.postRefId,
        input.pinnedBy,
        input.nowMs,
        input.nowMs,
        input.nowMs,
      ],
    },
    recordAudit({
      actorType: 'admin',
      actorId: String(input.pinnedBy),
      action: POST_MANAGEMENT_AUDIT_ACTIONS.pinChanged,
      targetId: String(input.channelMessageId),
      metadata: {
        permission: POST_MANAGEMENT_AUDIT_PERMISSION,
        postRefType: input.postRefType,
        postRefId: input.postRefId,
        releasedPrevious: active !== null,
      },
      nowMs: input.nowMs,
    }),
  ]);
  const releasedPrevious = (metas[0]?.changes ?? 0) > 0;
  return { kind: 'pinned', releasedPrevious };
}

/**
 * Unpin a channel message. Guarded: only the ACTIVE pin for THIS message
 * moves — an already-released pin (or a foreign message) changes
 * nothing, writes nothing, and reports false.
 */
export async function unpinChannelPost(
  executor: DbExecutor,
  input: { readonly channelMessageId: number; readonly unpinnedBy: number; readonly nowMs: number },
): Promise<boolean> {
  const active = await getActivePin(executor);
  if (active === null || active.channelMessageId !== input.channelMessageId) {
    return false;
  }
  const metas = await executor.batch([
    {
      sql: `UPDATE channel_pins
               SET status = 'released', unpinned_at_ms = ?, unpinned_by = ?,
                   updated_at_ms = ?
             WHERE channel_message_id = ? AND status = 'active'`,
      params: [input.nowMs, input.unpinnedBy, input.nowMs, input.channelMessageId],
    },
    recordAudit({
      actorType: 'admin',
      actorId: String(input.unpinnedBy),
      action: POST_MANAGEMENT_AUDIT_ACTIONS.pinChanged,
      targetId: String(input.channelMessageId),
      metadata: { permission: POST_MANAGEMENT_AUDIT_PERMISSION, unpinned: true },
      nowMs: input.nowMs,
    }),
  ]);
  return (metas[0]?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Settings: auto-pin toggle, retention rule, edit capture (slice-3 pattern)
// ---------------------------------------------------------------------------

export interface PostManagementSettings {
  readonly autoPinP0Enabled: boolean;
  readonly retention: RetentionRule;
}

export interface EditCapture {
  readonly adminId: number;
  readonly postRefType: ChannelPostRefType;
  readonly postRefId: string;
  readonly channelMessageId: number;
  readonly startedAtMs: number;
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
      `postmgmt:${randomToken()}`,
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
  return {
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES (?, ?, 1, NULL, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    params: [key, valueJson, nowMs],
  };
}

async function readSettingsRows(executor: DbExecutor): Promise<Readonly<Record<string, string>>> {
  const { rows } = await executor.query<{ key: string; value_json: string }>({
    sql: `SELECT key, value_json FROM settings
          WHERE key IN (?, ?, ?)`,
    params: [
      POST_MANAGEMENT_AUTO_PIN_SETTINGS_KEY,
      POST_MANAGEMENT_RETENTION_SETTINGS_KEY,
      POST_MANAGEMENT_EDIT_CAPTURE_SETTINGS_KEY,
    ],
  });
  const byKey: Record<string, string> = {};
  for (const row of rows) {
    byKey[row.key] = row.value_json;
  }
  return byKey;
}

/** One bounded read of the auto-pin toggle + the retention rule. */
export async function readPostManagementSettings(
  executor: DbExecutor,
): Promise<PostManagementSettings> {
  const byKey = await readSettingsRows(executor);
  const autoPin = parseStoredJson<{ enabled?: unknown }>(
    byKey[POST_MANAGEMENT_AUTO_PIN_SETTINGS_KEY] ?? '',
  );
  const retention = parseStoredJson<{
    enabled?: unknown;
    default_days?: unknown;
    free_game_days?: unknown;
  }>(byKey[POST_MANAGEMENT_RETENTION_SETTINGS_KEY] ?? '');
  const fallback = defaultRetentionRule();
  return {
    autoPinP0Enabled: autoPin !== null && autoPin.enabled === true,
    retention: {
      enabled: retention === null || retention.enabled !== false,
      defaultDays:
        retention !== null &&
        typeof retention.default_days === 'number' &&
        isValidRetentionDays(retention.default_days)
          ? retention.default_days
          : fallback.defaultDays,
      freeGameDays:
        retention !== null &&
        typeof retention.free_game_days === 'number' &&
        isValidRetentionDays(retention.free_game_days)
          ? retention.free_game_days
          : fallback.freeGameDays,
    },
  };
}

export type SetAutoPinOutcome =
  | { readonly kind: 'applied'; readonly enabled: boolean }
  | { readonly kind: 'no_change'; readonly enabled: boolean };

/** Flip the P0 auto-pin toggle. The setting + its audit apply atomically. */
export async function setAutoPinP0(
  executor: DbExecutor,
  input: { readonly enabled: boolean; readonly actorId: number; readonly nowMs: number },
): Promise<SetAutoPinOutcome> {
  const current = await readPostManagementSettings(executor);
  if (current.autoPinP0Enabled === input.enabled) {
    return { kind: 'no_change', enabled: input.enabled };
  }
  const valueJson = JSON.stringify({
    enabled: input.enabled,
    updated_by: input.actorId,
    updated_at_ms: input.nowMs,
  });
  await executor.batch([
    upsertSettingStatement(POST_MANAGEMENT_AUTO_PIN_SETTINGS_KEY, valueJson, input.nowMs),
    recordAudit({
      actorType: 'admin',
      actorId: String(input.actorId),
      action: POST_MANAGEMENT_AUDIT_ACTIONS.autoPinChanged,
      targetId: POST_MANAGEMENT_AUTO_PIN_SETTINGS_KEY,
      metadata: {
        permission: POST_MANAGEMENT_AUDIT_PERMISSION,
        enabled: input.enabled,
      },
      nowMs: input.nowMs,
    }),
  ]);
  return { kind: 'applied', enabled: input.enabled };
}

export type SetRetentionOutcome =
  | { readonly kind: 'applied'; readonly rule: RetentionRule }
  | { readonly kind: 'no_change'; readonly rule: RetentionRule }
  | { readonly kind: 'invalid' };

/** Change the retention rule (1..365 days per leg). Setting + audit atomically. */
export async function setRetentionRule(
  executor: DbExecutor,
  input: {
    readonly rule: RetentionRule;
    readonly actorId: number;
    readonly nowMs: number;
  },
): Promise<SetRetentionOutcome> {
  if (
    !isValidRetentionDays(input.rule.defaultDays) ||
    !isValidRetentionDays(input.rule.freeGameDays)
  ) {
    return { kind: 'invalid' };
  }
  const current = await readPostManagementSettings(executor);
  const prior = current.retention;
  if (
    prior.enabled === input.rule.enabled &&
    prior.defaultDays === input.rule.defaultDays &&
    prior.freeGameDays === input.rule.freeGameDays
  ) {
    return { kind: 'no_change', rule: prior };
  }
  const valueJson = JSON.stringify({
    enabled: input.rule.enabled,
    default_days: input.rule.defaultDays,
    free_game_days: input.rule.freeGameDays,
    updated_by: input.actorId,
    updated_at_ms: input.nowMs,
  });
  await executor.batch([
    upsertSettingStatement(POST_MANAGEMENT_RETENTION_SETTINGS_KEY, valueJson, input.nowMs),
    recordAudit({
      actorType: 'admin',
      actorId: String(input.actorId),
      action: POST_MANAGEMENT_AUDIT_ACTIONS.retentionChanged,
      targetId: POST_MANAGEMENT_RETENTION_SETTINGS_KEY,
      metadata: {
        permission: POST_MANAGEMENT_AUDIT_PERMISSION,
        enabled: input.rule.enabled,
        defaultDays: input.rule.defaultDays,
        freeGameDays: input.rule.freeGameDays,
      },
      nowMs: input.nowMs,
    }),
  ]);
  return { kind: 'applied', rule: input.rule };
}

/** Read the open edit capture for one admin (null when none or expired). */
export async function getEditCapture(
  executor: DbExecutor,
  input: { readonly adminId: number; readonly nowMs: number },
): Promise<EditCapture | null> {
  const byKey = await readSettingsRows(executor);
  const stored = parseStoredJson<{
    admin_id?: unknown;
    post_ref_type?: unknown;
    post_ref_id?: unknown;
    channel_message_id?: unknown;
    started_at_ms?: unknown;
  }>(byKey[POST_MANAGEMENT_EDIT_CAPTURE_SETTINGS_KEY] ?? '');
  if (stored === null) {
    return null;
  }
  if (
    stored.admin_id !== input.adminId ||
    (stored.post_ref_type !== 'publication' && stored.post_ref_type !== 'inbound') ||
    typeof stored.post_ref_id !== 'string' ||
    stored.post_ref_id.length === 0 ||
    typeof stored.channel_message_id !== 'number' ||
    !Number.isSafeInteger(stored.channel_message_id) ||
    stored.channel_message_id <= 0 ||
    typeof stored.started_at_ms !== 'number' ||
    !Number.isSafeInteger(stored.started_at_ms)
  ) {
    return null;
  }
  if (input.nowMs - stored.started_at_ms > EDIT_CAPTURE_TTL_MS) {
    return null;
  }
  return {
    adminId: stored.admin_id as number,
    postRefType: stored.post_ref_type,
    postRefId: stored.post_ref_id,
    channelMessageId: stored.channel_message_id,
    startedAtMs: stored.started_at_ms,
  };
}

/** Open an edit capture (one admin, one post — a new capture replaces the old). */
export async function startEditCapture(
  executor: DbExecutor,
  input: { readonly capture: EditCapture },
): Promise<void> {
  const valueJson = JSON.stringify({
    admin_id: input.capture.adminId,
    post_ref_type: input.capture.postRefType,
    post_ref_id: input.capture.postRefId,
    channel_message_id: input.capture.channelMessageId,
    started_at_ms: input.capture.startedAtMs,
  });
  await executor.run(
    upsertSettingStatement(
      POST_MANAGEMENT_EDIT_CAPTURE_SETTINGS_KEY,
      valueJson,
      input.capture.startedAtMs,
    ),
  );
}

/** Clear the edit capture (after a completed/cancelled edit). The row is
 *  overwritten with an empty capture (never deleted — the settings table
 *  carries no DELETE anywhere in this codebase). */
export async function clearEditCapture(
  executor: DbExecutor,
  input: { readonly adminId: number; readonly nowMs: number },
): Promise<void> {
  const current = await getEditCapture(executor, input);
  if (current === null) {
    return;
  }
  await executor.run(
    upsertSettingStatement(POST_MANAGEMENT_EDIT_CAPTURE_SETTINGS_KEY, '{}', input.nowMs),
  );
}

// ---------------------------------------------------------------------------
// Housekeeping: the unified published-post list + deletion records
// ---------------------------------------------------------------------------

export interface ChannelPostListRow {
  readonly refType: ChannelPostRefType;
  readonly refId: string;
  readonly channelMessageId: number;
  readonly category: string;
  readonly title: string | null;
  readonly publishedAtMs: number;
  readonly expired: boolean;
  readonly pinned: boolean;
}

export interface ListChannelPostsInput {
  /** Inclusive lower bound on the publication time (epoch ms). */
  readonly fromMs?: number;
  /** Inclusive upper bound on the publication time (epoch ms). */
  readonly toMs?: number;
  /** Category filter (each side's own vocabulary). */
  readonly category?: string;
  /** Status filter: all | published (fresh) | expired. */
  readonly status?: 'all' | 'published' | 'expired';
  /** Per-side row cap (the merged list is capped at the same bound). */
  readonly limit: number;
  /** The evaluation clock (injected — the store never reads the wall clock). */
  readonly nowMs: number;
}

interface EditorialListDbRow {
  readonly ref_id: string;
  readonly channel_message_id: number;
  readonly category: string;
  readonly title: string | null;
  readonly published_at_ms: number;
}

interface InboundListDbRow {
  readonly ref_id: string;
  readonly channel_message_ids: string;
  readonly category: string;
  readonly published_at_ms: number;
}

function parseFirstChannelMessageId(json: string): number | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const first = parsed[0];
    return typeof first === 'number' && Number.isSafeInteger(first) && first > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * The unified housekeeping list: editorial publications (the outbox
 * ledger, ordinal-0 message) + inbound published posts, newest first,
 * deleted posts excluded (the `channel_post_deletes` exclusion is IN
 * the SQL — a deleted post never reappears). Bounded on both sides;
 * the `expired` filter is derived from the retention rule in memory
 * (the rule is a setting, not a column).
 */
export async function listChannelPosts(
  executor: DbExecutor,
  input: ListChannelPostsInput,
): Promise<readonly ChannelPostListRow[]> {
  const settings = await readPostManagementSettings(executor);
  const activePin = await getActivePin(executor);
  const nowMs = input.nowMs;
  const fromMs = input.fromMs ?? null;
  const toMs = input.toMs ?? null;
  const category = input.category ?? null;
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));

  const editorial = await executor.query<EditorialListDbRow>({
    sql: `SELECT p.id AS ref_id, pm.message_id AS channel_message_id,
                 s.content_type AS category, s.working_headline AS title,
                 p.published_at AS published_at_ms
            FROM publications p
            JOIN publication_messages pm
              ON pm.publication_id = p.id AND pm.ordinal = 0
            JOIN stories s ON s.id = p.story_id
           WHERE p.status = 'published' AND p.published_at IS NOT NULL
             AND (? IS NULL OR p.published_at >= ?)
             AND (? IS NULL OR p.published_at <= ?)
             AND (? IS NULL OR s.content_type = ?)
             AND NOT EXISTS (
                   SELECT 1 FROM channel_post_deletes d
                    WHERE d.post_ref_type = 'publication' AND d.post_ref_id = p.id
                 )
           ORDER BY p.published_at DESC
           LIMIT ?`,
    params: [fromMs, fromMs, toMs, toMs, category, category, limit],
  });
  const inbound = await executor.query<InboundListDbRow>({
    sql: `SELECT pp.id AS ref_id, pp.channel_message_ids AS channel_message_ids,
                 pp.category AS category, pp.created_at_ms AS published_at_ms
            FROM published_posts pp
           WHERE (? IS NULL OR pp.created_at_ms >= ?)
             AND (? IS NULL OR pp.created_at_ms <= ?)
             AND (? IS NULL OR pp.category = ?)
             AND NOT EXISTS (
                   SELECT 1 FROM channel_post_deletes d
                    WHERE d.post_ref_type = 'inbound' AND d.post_ref_id = pp.id
                 )
           ORDER BY pp.created_at_ms DESC
           LIMIT ?`,
    params: [fromMs, fromMs, toMs, toMs, category, category, limit],
  });

  const merged: ChannelPostListRow[] = [];
  for (const row of editorial.rows) {
    merged.push({
      refType: 'publication',
      refId: row.ref_id,
      channelMessageId: row.channel_message_id,
      category: row.category,
      title: row.title,
      publishedAtMs: row.published_at_ms,
      expired: isPostExpired({
        rule: settings.retention,
        category: row.category,
        publishedAtMs: row.published_at_ms,
        nowMs,
      }),
      pinned: activePin !== null && activePin.channelMessageId === row.channel_message_id,
    });
  }
  for (const row of inbound.rows) {
    const channelMessageId = parseFirstChannelMessageId(row.channel_message_ids);
    if (channelMessageId === null) {
      continue;
    }
    merged.push({
      refType: 'inbound',
      refId: row.ref_id,
      channelMessageId,
      category: row.category,
      title: null,
      publishedAtMs: row.published_at_ms,
      expired: isPostExpired({
        rule: settings.retention,
        category: row.category,
        publishedAtMs: row.published_at_ms,
        nowMs,
      }),
      pinned: activePin !== null && activePin.channelMessageId === channelMessageId,
    });
  }
  merged.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  const wanted = input.status ?? 'all';
  const filtered =
    wanted === 'all'
      ? merged
      : merged.filter((row) => (wanted === 'expired' ? row.expired : !row.expired));
  return filtered.slice(0, limit);
}

/**
 * Record a housekeeping deletion (the durable audit row). The channel
 * message itself is deleted by the caller through the Bot API BEFORE
 * this record lands — a failed Bot API delete never creates a delete
 * row (the post stays listed, honestly).
 */
export async function recordChannelPostDelete(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly postRefType: ChannelPostRefType;
    readonly postRefId: string;
    readonly channelMessageId: number;
    readonly deletedBy: number;
    readonly reason: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await executor.batch([
    {
      sql: `INSERT INTO channel_post_deletes
                   (id, post_ref_type, post_ref_id, channel_message_id,
                    deleted_by, reason, deleted_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(post_ref_type, post_ref_id, channel_message_id) DO NOTHING`,
      params: [
        input.id,
        input.postRefType,
        input.postRefId,
        input.channelMessageId,
        input.deletedBy,
        input.reason,
        input.nowMs,
      ],
    },
    recordAudit({
      actorType: 'admin',
      actorId: String(input.deletedBy),
      action: POST_MANAGEMENT_AUDIT_ACTIONS.postDeleted,
      targetId: String(input.channelMessageId),
      metadata: {
        permission: POST_MANAGEMENT_AUDIT_PERMISSION,
        postRefType: input.postRefType,
        postRefId: input.postRefId,
        reason: input.reason,
      },
      nowMs: input.nowMs,
    }),
  ]);
}

/** Update the stored text hash of an edited editorial post (ordinal 0). */
export async function updateEditorialPostTextHash(
  executor: DbExecutor,
  input: { readonly publicationId: string; readonly textHash: string; readonly nowMs: number },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE publication_messages
             SET text_hash = ?
           WHERE publication_id = ? AND ordinal = 0`,
    params: [input.textHash, input.publicationId],
  });
  return (meta.changes ?? 0) > 0;
}

/** Touch an edited inbound post (its updated clock moves; content lives in the channel). */
export async function touchPublishedPost(
  executor: DbExecutor,
  input: { readonly id: string; readonly nowMs: number },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE published_posts SET updated_at_ms = ? WHERE id = ?`,
    params: [input.nowMs, input.id],
  });
  return (meta.changes ?? 0) > 0;
}

/** Record a completed in-place edit in the audit log. */
export async function recordPostEdited(
  executor: DbExecutor,
  input: {
    readonly postRefType: ChannelPostRefType;
    readonly postRefId: string;
    readonly channelMessageId: number;
    readonly editedBy: number;
    readonly nowMs: number;
  },
): Promise<void> {
  await executor.run(
    recordAudit({
      actorType: 'admin',
      actorId: String(input.editedBy),
      action: POST_MANAGEMENT_AUDIT_ACTIONS.postEdited,
      targetId: String(input.channelMessageId),
      metadata: {
        permission: POST_MANAGEMENT_AUDIT_PERMISSION,
        postRefType: input.postRefType,
        postRefId: input.postRefId,
      },
      nowMs: input.nowMs,
    }),
  );
}
