/**
 * Admin action-token repository boundary (Phase 2A) — `admin_action_tokens`.
 *
 * Implements the repository BOUNDARY for the callback-token contract: tokens
 * are issued server-side, bound to ONE telegram user, carry a permission +
 * action descriptor, expire, and are consumed exactly once. The full admin
 * menu that creates/uses these tokens is a later-phase feature (Phase 9);
 * Phase 2A proves the contract and the single-use consumption semantics.
 *
 * Input validation (Phase 2A correction): EVERY input is validated BEFORE
 * any database access — a malformed argument fails fast at the boundary and
 * can never reach D1. Validation covers:
 * - `telegramUserId`: positive safe integer;
 * - timestamps (`nowMs`, `expiresAtMs`): positive safe integers, with
 *   `expiresAtMs` strictly AFTER `nowMs`;
 * - token: the approved callback contract shape (`a:`-stripped base64url,
 *   16..43 chars — CALLBACK_TOKEN_PATTERN);
 * - `permission`: one of the approved admin-map permissions (owner wildcard
 *   included);
 * - `action`: conservative shape and size bound;
 * - `payloadJson`: bounded AND valid JSON of the expected object shape
 *   (a plain JSON object — never arrays, scalars, or malformed JSON).
 *
 * Security properties:
 * - Resolution is bound to (token id, telegram_user_id) — a token never
 *   resolves for a different user.
 * - Consumption is a single guarded UPDATE (consumed_at IS NULL AND not
 *   expired): concurrent consumers produce exactly one winner.
 * - payload_json is author-generated state for the future menu workflow;
 *   it is bounded and is NEVER user-controlled in Phase 2A.
 * - Validation failures never echo the rejected input values — error
 *   messages are stable constants only.
 * - Parameterized SQL only; no rows or payload contents are logged.
 */
import type { DbExecutor } from '../db/db-executor';
import { CALLBACK_TOKEN_PATTERN } from '../../admin/callback-tokens';
import { OWNER_WILDCARD_PERMISSION, ROLE_PERMISSIONS } from '../../admin/roles';

const MAX_PAYLOAD_JSON_LENGTH = 1024;
/** Conservative action-descriptor bound (`draft.approve` style names). */
const MAX_ACTION_LENGTH = 64;
const ACTION_PATTERN = /^[a-z][a-z0-9_.]*$/;
/** Conservative target-descriptor bounds. */
const MAX_TARGET_LENGTH = 128;

/** Approved permission values, derived verbatim from the admin-map mirror. */
const APPROVED_PERMISSIONS: ReadonlySet<string> = new Set([
  OWNER_WILDCARD_PERMISSION,
  ...Object.values(ROLE_PERMISSIONS).flat(),
]);

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function reject(reason: string): never {
  // Stable constant messages ONLY — the offending value is never echoed.
  throw new Error(`action token rejected: ${reason}`);
}

function validateCommonInput(input: {
  readonly token: string;
  readonly telegramUserId: number;
  readonly nowMs: number;
}): void {
  if (!isPositiveSafeInteger(input.telegramUserId)) {
    reject('invalid telegram user id');
  }
  if (!isPositiveSafeInteger(input.nowMs)) {
    reject('invalid timestamp');
  }
  if (typeof input.token !== 'string' || !CALLBACK_TOKEN_PATTERN.test(input.token)) {
    reject('invalid token format');
  }
}

function validateIssuedAt(expiresAtMs: number, nowMs: number): void {
  if (!isPositiveSafeInteger(expiresAtMs)) {
    reject('invalid expiry timestamp');
  }
  if (expiresAtMs <= nowMs) {
    reject('expiry must be after the current time');
  }
}

function validatePermission(permission: string): void {
  if (typeof permission !== 'string' || !APPROVED_PERMISSIONS.has(permission)) {
    reject('unknown permission');
  }
}

function validateAction(action: string): void {
  if (
    typeof action !== 'string' ||
    action.length === 0 ||
    action.length > MAX_ACTION_LENGTH ||
    !ACTION_PATTERN.test(action)
  ) {
    reject('invalid action descriptor');
  }
}

function validateTargetDescriptor(value: string | undefined, field: 'target'): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TARGET_LENGTH) {
    reject(`invalid ${field} descriptor`);
  }
}

function validatePayloadJson(payloadJson: string): void {
  if (payloadJson.length > MAX_PAYLOAD_JSON_LENGTH) {
    reject('payload too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    reject('payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reject('payload must be a JSON object');
  }
}

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
  // Boundary validation FIRST — a rejected input never reaches D1.
  validateCommonInput(input);
  validateIssuedAt(input.expiresAtMs, input.nowMs);
  validatePermission(input.permission);
  validateAction(input.action);
  validateTargetDescriptor(input.targetType, 'target');
  validateTargetDescriptor(input.targetId, 'target');
  const payloadJson = input.payloadJson ?? '{}';
  validatePayloadJson(payloadJson);

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
  // Boundary validation FIRST — a rejected input never reaches D1.
  validateCommonInput(input);

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
