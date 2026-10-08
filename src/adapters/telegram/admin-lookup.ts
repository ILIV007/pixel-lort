/**
 * Admin lookup repository (Phase 2A) — the ONLY database access for
 * authorization decisions, over the `admins` table.
 *
 * Behavior:
 * - Unknown users resolve to null (unauthorized downstream).
 * - Disabled admins resolve to null — status is checked IN SQL and again in
 *   code; either way no privileged access is possible.
 * - Unknown role strings resolve to null (fail closed on schema surprises).
 * - Authorization decisions use the numeric telegram_user_id only.
 * - Parameterized SQL only; no rows are logged (ADR-0022).
 */
import type { DbExecutor } from '../db/db-executor';
import { isAdminRole, type AdminRole } from '../../admin/roles';
import type { AdminRoleLookup } from '../../admin/authorization';

export function createAdminRoleLookup(executor: DbExecutor): AdminRoleLookup {
  async function findActiveRole(telegramUserId: number): Promise<AdminRole | null> {
    const row = await executor.first<{ role: string; status: string }>({
      sql: 'SELECT role, status FROM admins WHERE telegram_user_id = ? LIMIT 1',
      params: [telegramUserId],
    });
    if (row === null || row.status !== 'active') {
      return null;
    }
    return isAdminRole(row.role) ? row.role : null;
  }

  return { findActiveRole };
}
