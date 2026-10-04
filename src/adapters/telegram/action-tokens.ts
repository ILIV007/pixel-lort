/**
 * Admin action-token repository boundary (Phase 2A) — `admin_action_tokens`.
 *
 * Implements the repository BOUNDARY for the callback-token contract: tokens
 * are issued server-side, bound to ONE telegram user, carry a permission +
 * action descriptor, expire, and are consumed exactly once. The full admin
 * menu that creates/uses these tokens is a later-phase feature (Phase 9);
 * Phase 2A proves the contract and the single-use consumption semantics.
 *
 * Security properties:
 * - Resolution is bound to (token id, telegram_user_id) — a token never
 *   resolves for a different user.
 * - Consumption is a single guarded UPDATE (consumed_at IS NULL AND not
 *   expired): concurrent consumers produce exactly one winner.
 * - payload_json is author-generated state for the future menu workflow;
 *   it is bounded and is NEVER user-controlled in Phase 2A.
 * - Parameterized SQL only; no rows or payload contents are logged.
 */
import type { DbExecutor } from '../db/db-executor';
import { CALLBACK_TOKEN_PATTERN } from '../../admin/callback-tokens';

const MAX_PAYLOAD_JSON_LENGTH = 1024;

export interface IssueActionTokenInput {
  /** Opaque token (the part after the `a:` callback prefix) — primary key. */
  readonly token: string;
  readonly telegramUserId: number;
  readonly permission: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly payloadJson?: string;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}

export interface ActionTokenRecord {
  readonly permission: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly payloadJson: string;
}

export type ConsumeActionTokenResult =
  { readonly kind: 'consumed'; readonly record: ActionTokenRecord } | { readonly kind: 'invalid' };

export async function issueActionToken(
  executor: DbExecutor,
  input: IssueActionTokenInput,
): Promise<void> {
  if (!CALLBACK_TOKEN_PATTERN.test(input.token)) {
    throw new Error('action token rejected: invalid format');
  }
  const payloadJson = input.payloadJson ?? '{}';
  if (payloadJson.length > MAX_PAYLOAD_JSON_LENGTH) {
    throw new Error('action token rejected: payload too large');
  }
  await executor.run({
    sql: `INSERT INTO admin_action_tokens
          (id, telegram_user_id, permission, action, target_type, target_id, payload_json, expires_at, consumed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    params: [
      input.token,
      input.telegramUserId,
      input.permission,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      payloadJson,
      input.expiresAtMs,
      input.nowMs,
    ],
  });
}

export async function consumeActionToken(
  executor: DbExecutor,
  input: { readonly token: string; readonly telegramUserId: number; readonly nowMs: number },
): Promise<ConsumeActionTokenResult> {
  const claimed = await executor.run({
    sql: `UPDATE admin_action_tokens SET consumed_at = ?
          WHERE id = ? AND telegram_user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    params: [input.nowMs, input.token, input.telegramUserId, input.nowMs],
  });
  if (claimed.changes === 0) {
    // Unknown token, wrong user, already consumed, or expired — one stable
    // invalid outcome for all of them (no information leak).
    return { kind: 'invalid' };
  }

  const row = await executor.first<{
    permission: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    payload_json: string;
  }>({
    sql: 'SELECT permission, action, target_type, target_id, payload_json FROM admin_action_tokens WHERE id = ?',
    params: [input.token],
  });
  if (row === null) {
    // Unreachable: the guarded UPDATE just matched this row. Fail closed.
    return { kind: 'invalid' };
  }

  return {
    kind: 'consumed',
    record: {
      permission: row.permission,
      action: row.action,
      targetType: row.target_type ?? undefined,
      targetId: row.target_id ?? undefined,
      payloadJson: row.payload_json,
    },
  };
}
