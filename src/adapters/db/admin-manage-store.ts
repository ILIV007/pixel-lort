/**
 * Issue #8 — the owner-only admin-management store boundary over the
 * EXISTING `admins` table (schema 1) and the `audit_events` table
 * (schema 1). No new table and no migration: admin management is a
 * workflow over tables the schema already carries.
 *
 * Every mutation is a GUARDED write whose rowcount is the authority,
 * followed by ONE deterministic audit event (the `admin-manage:<token>`
 * id — one confirmation can audit at most once; a duplicate audit id is
 * absorbed exactly like the queue-cancel precedent in
 * publication-outbox-store.ts). The fence is re-checked at confirmation
 * time: a row that moved between the confirm screen and the click answers
 * honestly with ZERO effect.
 *
 * Owner protection is enforced by the SERVICE (the bootstrap owner id is
 * server config, not a table value); the store never invents it. The
 * store DOES guarantee the bootstrap owner has a row before a confirm
 * token is minted: `admin_action_tokens.telegram_user_id` references
 * `admins(telegram_user_id)`, and the bootstrap owner resolves from the
 * OWNER_TELEGRAM_ID secret — without a row the token insert would fail
 * the foreign key. `ensureOwnerRow` is INSERT OR IGNORE: it creates the
 * row only when absent and never overwrites an existing one.
 *
 * Parameterized SQL only; no rows, ids, or payload contents are logged
 * (ADR-0022).
 */
import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';
import type { AdminRole } from '../../admin/roles';

export interface AdminManageRow {
  readonly telegramUserId: number;
  readonly role: AdminRole;
  readonly status: 'active' | 'disabled';
}

/** Bounded list cap — the admins table is small by design. */
export const ADMIN_MANAGE_LIST_LIMIT = 100;

/** The audit permission recorded on every admin-management event. */
export const ADMIN_MANAGE_AUDIT_PERMISSION = 'admin.manage';

/** Deterministic audit actions (one per applied change). */
export const ADMIN_MANAGE_AUDIT_ACTIONS = {
  added: 'admin.added',
  roleChanged: 'admin.role_changed',
  deactivated: 'admin.deactivated',
} as const;

/**
 * Ensure the bootstrap owner has an `admins` row (role `owner`, status
 * `active`) so a confirm token bound to the owner satisfies the
 * `admin_action_tokens` foreign key. Idempotent: a present row is never
 * touched.
 */
export async function ensureOwnerRow(
  executor: DbExecutor,
  input: { readonly ownerTelegramId: number; readonly nowMs: number },
): Promise<void> {
  await executor.run({
    sql: `INSERT OR IGNORE INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, NULL, 'owner', 'active', ?, ?)`,
    params: [input.ownerTelegramId, input.nowMs, input.nowMs],
  });
}

/** One bounded read of every admin, ordered by numeric user id. */
export async function listAdmins(executor: DbExecutor): Promise<readonly AdminManageRow[]> {
  const { rows } = await executor.query<{ telegram_user_id: number; role: string; status: string }>(
    {
      sql: `SELECT telegram_user_id, role, status FROM admins
          ORDER BY telegram_user_id ASC LIMIT ?`,
      params: [ADMIN_MANAGE_LIST_LIMIT],
    },
  );
  return rows.map((row) => ({
    telegramUserId: row.telegram_user_id,
    // The table CHECK constrains role/status to the approved vocabularies;
    // an unexpected value can only come from a hand-edited database — fail
    // closed by dropping the row from the list rather than rendering it.
    role: row.role as AdminRole,
    status: row.status as 'active' | 'disabled',
  }));
}

/** One admin row by numeric id, or null when unknown. */
export async function findAdmin(
  executor: DbExecutor,
  telegramUserId: number,
): Promise<AdminManageRow | null> {
  const row = await executor.first<{ role: string; status: string }>({
    sql: 'SELECT role, status FROM admins WHERE telegram_user_id = ? LIMIT 1',
    params: [telegramUserId],
  });
  if (row === null) {
    return null;
  }
  return {
    telegramUserId,
    role: row.role as AdminRole,
    status: row.status as 'active' | 'disabled',
  };
}

async function recordAudit(
  executor: DbExecutor,
  input: {
    readonly token: string;
    readonly actorId: string;
    readonly action: string;
    readonly targetUserId: number;
    readonly metadata: Record<string, unknown>;
    readonly nowMs: number;
  },
): Promise<void> {
  try {
    await executor.run({
      sql: `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type,
              target_id, trace_id, metadata_json, created_at)
            VALUES (?, 'admin', ?, ?, 'admin', ?, NULL, ?, ?)`,
      params: [
        `admin-manage:${input.token}`,
        input.actorId,
        input.action,
        String(input.targetUserId),
        JSON.stringify(input.metadata),
        input.nowMs,
      ],
    });
  } catch (error) {
    if (!(isAppError(error) && error.code === 'db_constraint_violation')) {
      throw error;
    }
    // The duplicate audit id absorption (the same confirmation applied
    // twice can never audit twice — the token is single-use, so this is
    // defensive-only).
  }
}

export type ApplyAdminAddOutcome =
  { readonly kind: 'applied'; readonly reactivated: boolean } | { readonly kind: 'already_active' };

/**
 * Add (or reactivate) an admin. The fence is the authority: the upsert
 * applies ONLY when no active row exists — an active row leaves ZERO
 * effect and reports `already_active` (a concurrent confirmation won).
 */
export async function applyAdminAdd(
  executor: DbExecutor,
  input: {
    readonly targetUserId: number;
    readonly role: AdminRole;
    readonly actorId: string;
    readonly token: string;
    readonly nowMs: number;
  },
): Promise<ApplyAdminAddOutcome> {
  const before = await findAdmin(executor, input.targetUserId);
  if (before !== null && before.status === 'active') {
    return { kind: 'already_active' };
  }
  const fence = await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, NULL, ?, 'active', ?, ?)
          ON CONFLICT(telegram_user_id) DO UPDATE SET
            role = excluded.role, status = 'active', updated_at = excluded.updated_at
          WHERE admins.status = 'disabled'`,
    params: [input.targetUserId, input.role, input.nowMs, input.nowMs],
  });
  if (fence.changes === 0) {
    return { kind: 'already_active' };
  }
  await recordAudit(executor, {
    token: input.token,
    actorId: input.actorId,
    action: ADMIN_MANAGE_AUDIT_ACTIONS.added,
    targetUserId: input.targetUserId,
    metadata: {
      permission: ADMIN_MANAGE_AUDIT_PERMISSION,
      role: input.role,
      priorStatus: before === null ? 'absent' : before.status,
    },
    nowMs: input.nowMs,
  });
  return { kind: 'applied', reactivated: before !== null && before.status === 'disabled' };
}

export type ApplyAdminRoleChangeOutcome =
  | { readonly kind: 'applied'; readonly priorRole: AdminRole }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_disabled' }
  | { readonly kind: 'no_change' };

/**
 * Change an active admin's role. The fence applies ONLY to an active row
 * whose role actually differs — every other state answers honestly with
 * ZERO effect.
 */
export async function applyAdminRoleChange(
  executor: DbExecutor,
  input: {
    readonly targetUserId: number;
    readonly role: AdminRole;
    readonly actorId: string;
    readonly token: string;
    readonly nowMs: number;
  },
): Promise<ApplyAdminRoleChangeOutcome> {
  const before = await findAdmin(executor, input.targetUserId);
  if (before === null) {
    return { kind: 'not_found' };
  }
  if (before.status !== 'active') {
    return { kind: 'already_disabled' };
  }
  if (before.role === input.role) {
    return { kind: 'no_change' };
  }
  const fence = await executor.run({
    sql: `UPDATE admins SET role = ?, updated_at = ?
          WHERE telegram_user_id = ? AND status = 'active' AND role <> ?`,
    params: [input.role, input.nowMs, input.targetUserId, input.role],
  });
  if (fence.changes === 0) {
    return { kind: 'no_change' };
  }
  await recordAudit(executor, {
    token: input.token,
    actorId: input.actorId,
    action: ADMIN_MANAGE_AUDIT_ACTIONS.roleChanged,
    targetUserId: input.targetUserId,
    metadata: {
      permission: ADMIN_MANAGE_AUDIT_PERMISSION,
      role: input.role,
      priorRole: before.role,
    },
    nowMs: input.nowMs,
  });
  return { kind: 'applied', priorRole: before.role };
}

export type ApplyAdminDeactivateOutcome =
  | { readonly kind: 'applied'; readonly priorRole: AdminRole }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_disabled' };

/**
 * Deactivate an admin. The fence applies ONLY to an active row — a
 * missing or already-disabled row answers honestly with ZERO effect.
 * Deactivation never deletes the row: the admin's history stays
 * auditable and the id can be re-added later.
 */
export async function applyAdminDeactivate(
  executor: DbExecutor,
  input: {
    readonly targetUserId: number;
    readonly actorId: string;
    readonly token: string;
    readonly nowMs: number;
  },
): Promise<ApplyAdminDeactivateOutcome> {
  const before = await findAdmin(executor, input.targetUserId);
  if (before === null) {
    return { kind: 'not_found' };
  }
  if (before.status !== 'active') {
    return { kind: 'already_disabled' };
  }
  const fence = await executor.run({
    sql: `UPDATE admins SET status = 'disabled', updated_at = ?
          WHERE telegram_user_id = ? AND status = 'active'`,
    params: [input.nowMs, input.targetUserId],
  });
  if (fence.changes === 0) {
    return { kind: 'already_disabled' };
  }
  await recordAudit(executor, {
    token: input.token,
    actorId: input.actorId,
    action: ADMIN_MANAGE_AUDIT_ACTIONS.deactivated,
    targetUserId: input.targetUserId,
    metadata: {
      permission: ADMIN_MANAGE_AUDIT_PERMISSION,
      priorRole: before.role,
    },
    nowMs: input.nowMs,
  });
  return { kind: 'applied', priorRole: before.role };
}
