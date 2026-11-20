/**
 * Issue #8 — the owner-only admin-management service: the composition the
 * ingress executes for the `admin_manage_*` router actions and for the
 * `admins.*` token callbacks (the Phase 9C shape: the router NEVER
 * queries D1; the injected service does).
 *
 * LIST: the owner row is ensured first (so the bootstrap owner is always
 * listed), then ONE bounded read renders every admin.
 *
 * ADD / REMOVE / ROLE: the command NEVER writes. It validates (owner
 * role, bootstrap-owner protection, current state) and mints TWO
 * single-use, user-bound, expiring confirm tokens — Confirm and Cancel —
 * through the Phase 2A machinery (opaque, 10-minute expiry, issued
 * DURABLY before the message carrying them is sent). The confirm token
 * carries the intent in its server-side payload ({op, targetUserId,
 * role}); the callback carries only the opaque token.
 *
 * CALLBACK: the admin-post confirm shape — guarded single-use consume
 * (bound to ONE user), the owner role RE-CHECKED at callback time, the
 * intent RE-VALIDATED against the token's server-side payload (never
 * trusted from the callback), the fenced store write (the rowcount is
 * the authority — a row that moved between screen and click answers the
 * honest no-change with ZERO effect), the deterministic audit event on
 * the applied path. A Cancel token consumes and answers "cancelled"
 * with ZERO writes. A foreign action can never ride this service.
 *
 * The service NEVER logs user ids, command text, callback payloads, or
 * tokens — only the typed outcomes it returns.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import {
  applyAdminAdd,
  applyAdminDeactivate,
  applyAdminRoleChange,
  ensureOwnerRow,
  findAdmin,
  listAdmins,
} from '../../adapters/db/admin-manage-store';
import { consumeActionToken, issueActionToken } from '../../adapters/telegram/action-tokens';
import { formatCallbackData } from '../../admin/callback-tokens';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import { ADMIN_MANAGE_STRINGS } from '../../admin/admin-manage-strings';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import type { AdminUiLanguage } from '../../admin/ui-language';
import { randomToken } from '../../domain/admin-post/fingerprint';

/** The permission every admin-manage token carries (owner-only, blueprint). */
export const ADMIN_MANAGE_TOKEN_PERMISSION = 'admin.manage';

/** Stable action descriptors stored in admin_action_tokens rows. */
export const ADMIN_MANAGE_TOKEN_ACTIONS = {
  confirmAdd: 'admins.confirm_add',
  confirmRole: 'admins.confirm_role',
  confirmRemove: 'admins.confirm_remove',
  confirmCancel: 'admins.confirm_cancel',
} as const;

/** The bounded token TTL of the confirm/cancel buttons. */
export const ADMIN_MANAGE_TOKEN_TTL_MS = 10 * 60 * 1000;

export type AdminManageButtons = readonly (readonly {
  readonly text: string;
  readonly callbackData: string;
}[])[];

export interface AdminManageReplyResult {
  readonly kind: 'reply';
  readonly text: TelegramSafeHtml;
  readonly buttons?: AdminManageButtons;
}

export interface AdminManageCallbackResult {
  readonly kind: 'answer';
  readonly callbackText: string;
}

export interface AdminManageService {
  list(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AdminManageReplyResult>;

  requestAdd(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly targetUserId: number;
    readonly targetRole: AdminRole;
  }): Promise<AdminManageReplyResult>;

  requestRemove(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly targetUserId: number;
  }): Promise<AdminManageReplyResult>;

  requestRole(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly targetUserId: number;
    readonly targetRole: AdminRole;
  }): Promise<AdminManageReplyResult>;

  handleCallback(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly token: string;
  }): Promise<AdminManageCallbackResult>;
}

type AdminManagePayload =
  | { readonly op: 'add'; readonly targetUserId: number; readonly role: AdminRole }
  | { readonly op: 'role'; readonly targetUserId: number; readonly role: AdminRole }
  | { readonly op: 'remove'; readonly targetUserId: number }
  | { readonly op: 'cancel' };

const ASSIGNABLE_ROLES: readonly string[] = [
  'chief_editor',
  'editor',
  'reviewer',
  'source_manager',
  'viewer',
];

function parsePayload(payloadJson: string): AdminManagePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.op === 'cancel') {
    return { op: 'cancel' };
  }
  if (
    typeof record.targetUserId !== 'number' ||
    !Number.isSafeInteger(record.targetUserId) ||
    record.targetUserId <= 0
  ) {
    return null;
  }
  if (record.op === 'remove') {
    return { op: 'remove', targetUserId: record.targetUserId };
  }
  if (
    (record.op === 'add' || record.op === 'role') &&
    typeof record.role === 'string' &&
    ASSIGNABLE_ROLES.includes(record.role)
  ) {
    return { op: record.op, targetUserId: record.targetUserId, role: record.role as AdminRole };
  }
  return null;
}

export function createAdminManageService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  /** The bootstrap owner id (server config) — the protected identity. */
  readonly ownerTelegramId?: number;
}): AdminManageService {
  const { executor, clock, ownerTelegramId } = deps;

  function isOwnerRole(role: AdminRole): boolean {
    return roleHasPermission(role, ADMIN_MANAGE_TOKEN_PERMISSION);
  }

  function isBootstrapOwner(targetUserId: number): boolean {
    return ownerTelegramId !== undefined && targetUserId === ownerTelegramId;
  }

  async function mintTokenPair(input: {
    readonly telegramUserId: number;
    readonly action: string;
    readonly payload: Exclude<AdminManagePayload, { readonly op: 'cancel' }>;
    readonly nowMs: number;
  }): Promise<{ readonly confirmToken: string; readonly cancelToken: string }> {
    // The owner row must exist BEFORE any token bound to the owner is
    // issued (the admin_action_tokens foreign key). Idempotent.
    if (ownerTelegramId !== undefined) {
      await ensureOwnerRow(executor, { ownerTelegramId, nowMs: input.nowMs });
    }
    const confirmToken = randomToken();
    await issueActionToken(executor, {
      token: confirmToken,
      telegramUserId: input.telegramUserId,
      permission: ADMIN_MANAGE_TOKEN_PERMISSION,
      action: input.action,
      targetType: 'admin',
      targetId: String(input.payload.targetUserId),
      payloadJson: JSON.stringify(input.payload),
      expiresAtMs: input.nowMs + ADMIN_MANAGE_TOKEN_TTL_MS,
      nowMs: input.nowMs,
    });
    const cancelToken = randomToken();
    await issueActionToken(executor, {
      token: cancelToken,
      telegramUserId: input.telegramUserId,
      permission: ADMIN_MANAGE_TOKEN_PERMISSION,
      action: ADMIN_MANAGE_TOKEN_ACTIONS.confirmCancel,
      targetType: 'admin',
      payloadJson: JSON.stringify({ op: 'cancel' } satisfies AdminManagePayload),
      expiresAtMs: input.nowMs + ADMIN_MANAGE_TOKEN_TTL_MS,
      nowMs: input.nowMs,
    });
    return { confirmToken, cancelToken };
  }

  function confirmScreen(input: {
    readonly uiLanguage: AdminUiLanguage;
    readonly line: string;
    readonly targetUserId: number;
    readonly role?: AdminRole;
    readonly currentRole?: AdminRole;
    readonly confirmToken: string;
    readonly cancelToken: string;
  }): AdminManageReplyResult {
    const s = ADMIN_MANAGE_STRINGS[input.uiLanguage];
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.confirmTitle),
      escapeTelegramHtml(input.line),
      escapeTelegramHtml(`${s.confirmTargetLabel} ${input.targetUserId}`),
    ];
    if (input.currentRole !== undefined) {
      parts.push(escapeTelegramHtml(`${s.confirmCurrentRoleLabel} ${input.currentRole}`));
    }
    if (input.role !== undefined) {
      parts.push(escapeTelegramHtml(`${s.confirmRoleLabel} ${input.role}`));
    }
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [
          { text: s.confirmButton, callbackData: formatCallbackData(input.confirmToken) },
          { text: s.cancelButton, callbackData: formatCallbackData(input.cancelToken) },
        ],
      ],
    };
  }

  return {
    async list({ role, uiLanguage }) {
      const s = ADMIN_MANAGE_STRINGS[uiLanguage];
      // Defense in depth: the router gated the owner role before emitting
      // the action; the service refuses BEFORE any read otherwise.
      if (!isOwnerRole(role)) {
        return { kind: 'reply', text: escapeTelegramHtml(s.permissionDenied) };
      }
      if (ownerTelegramId !== undefined) {
        await ensureOwnerRow(executor, { ownerTelegramId, nowMs: clock.now() });
      }
      const rows = await listAdmins(executor);
      const parts: TelegramSafeHtml[] = [telegramBold(s.listTitle)];
      if (rows.length === 0) {
        parts.push(escapeTelegramHtml(s.listEmpty));
      }
      for (const row of rows) {
        parts.push(
          escapeTelegramHtml(
            `${row.telegramUserId} · ${s.listRoleLabel} ${row.role} · ${s.listStatusLabel} ${row.status}`,
          ),
        );
      }
      return { kind: 'reply', text: composeTelegramHtml(parts) };
    },

    async requestAdd({ telegramUserId, role, uiLanguage, targetUserId, targetRole }) {
      const s = ADMIN_MANAGE_STRINGS[uiLanguage];
      if (!isOwnerRole(role)) {
        return { kind: 'reply', text: escapeTelegramHtml(s.permissionDenied) };
      }
      if (isBootstrapOwner(targetUserId) || targetRole === 'owner') {
        return { kind: 'reply', text: escapeTelegramHtml(s.ownerProtected) };
      }
      const current = await findAdmin(executor, targetUserId);
      if (current !== null && current.status === 'active') {
        if (current.role === targetRole) {
          return { kind: 'reply', text: escapeTelegramHtml(s.alreadyAdminSameRole) };
        }
        return { kind: 'reply', text: escapeTelegramHtml(s.alreadyAdminOtherRole) };
      }
      const { confirmToken, cancelToken } = await mintTokenPair({
        telegramUserId,
        action: ADMIN_MANAGE_TOKEN_ACTIONS.confirmAdd,
        payload: { op: 'add', targetUserId, role: targetRole },
        nowMs: clock.now(),
      });
      return confirmScreen({
        uiLanguage,
        line: s.confirmAddLine,
        targetUserId,
        role: targetRole,
        confirmToken,
        cancelToken,
      });
    },

    async requestRemove({ telegramUserId, role, uiLanguage, targetUserId }) {
      const s = ADMIN_MANAGE_STRINGS[uiLanguage];
      if (!isOwnerRole(role)) {
        return { kind: 'reply', text: escapeTelegramHtml(s.permissionDenied) };
      }
      if (isBootstrapOwner(targetUserId)) {
        return { kind: 'reply', text: escapeTelegramHtml(s.ownerProtected) };
      }
      const current = await findAdmin(executor, targetUserId);
      if (current === null) {
        return { kind: 'reply', text: escapeTelegramHtml(s.notAnAdmin) };
      }
      if (current.status !== 'active') {
        return { kind: 'reply', text: escapeTelegramHtml(s.alreadyDisabled) };
      }
      const { confirmToken, cancelToken } = await mintTokenPair({
        telegramUserId,
        action: ADMIN_MANAGE_TOKEN_ACTIONS.confirmRemove,
        payload: { op: 'remove', targetUserId },
        nowMs: clock.now(),
      });
      return confirmScreen({
        uiLanguage,
        line: s.confirmRemoveLine,
        targetUserId,
        currentRole: current.role,
        confirmToken,
        cancelToken,
      });
    },

    async requestRole({ telegramUserId, role, uiLanguage, targetUserId, targetRole }) {
      const s = ADMIN_MANAGE_STRINGS[uiLanguage];
      if (!isOwnerRole(role)) {
        return { kind: 'reply', text: escapeTelegramHtml(s.permissionDenied) };
      }
      if (isBootstrapOwner(targetUserId) || targetRole === 'owner') {
        return { kind: 'reply', text: escapeTelegramHtml(s.ownerProtected) };
      }
      const current = await findAdmin(executor, targetUserId);
      if (current === null) {
        return { kind: 'reply', text: escapeTelegramHtml(s.notAnAdmin) };
      }
      if (current.status !== 'active') {
        return { kind: 'reply', text: escapeTelegramHtml(s.alreadyDisabled) };
      }
      if (current.role === targetRole) {
        return { kind: 'reply', text: escapeTelegramHtml(s.alreadyAdminSameRole) };
      }
      const { confirmToken, cancelToken } = await mintTokenPair({
        telegramUserId,
        action: ADMIN_MANAGE_TOKEN_ACTIONS.confirmRole,
        payload: { op: 'role', targetUserId, role: targetRole },
        nowMs: clock.now(),
      });
      return confirmScreen({
        uiLanguage,
        line: s.confirmRoleLine,
        targetUserId,
        currentRole: current.role,
        role: targetRole,
        confirmToken,
        cancelToken,
      });
    },

    async handleCallback({ telegramUserId, role, uiLanguage, token }) {
      const s = ADMIN_MANAGE_STRINGS[uiLanguage];
      const nowMs = clock.now();
      const consumed = await consumeActionToken(executor, { token, telegramUserId, nowMs });
      if (consumed.kind === 'invalid') {
        return { kind: 'answer', callbackText: s.callbackInvalidToken };
      }
      const record = consumed.record;
      // Defense in depth: the dispatcher routed by this exact action
      // family; a foreign record can never ride admin management.
      if (!record.action.startsWith('admins.')) {
        return { kind: 'answer', callbackText: s.callbackInvalidToken };
      }
      // The owner role is RE-CHECKED at callback time: a mint-time owner
      // whose bootstrap changed is refused — the token burns, nothing
      // moves, the audit stays silent.
      if (!isOwnerRole(role)) {
        return { kind: 'answer', callbackText: s.callbackPermissionDenied };
      }
      const payload = parsePayload(record.payloadJson);
      if (payload === null) {
        return { kind: 'answer', callbackText: s.callbackInvalidToken };
      }
      if (payload.op === 'cancel') {
        return { kind: 'answer', callbackText: s.confirmedCancelled };
      }
      // The intent is re-validated against the SERVER-SIDE payload: the
      // bootstrap owner can never be touched through a confirmation, and
      // the owner role can never be assigned — no matter what the screen
      // showed when the token was minted.
      if (isBootstrapOwner(payload.targetUserId)) {
        return { kind: 'answer', callbackText: s.ownerProtected };
      }
      const actorId = String(telegramUserId);
      if (payload.op === 'add') {
        if (payload.role === 'owner') {
          return { kind: 'answer', callbackText: s.ownerProtected };
        }
        const outcome = await applyAdminAdd(executor, {
          targetUserId: payload.targetUserId,
          role: payload.role,
          actorId,
          token,
          nowMs,
        });
        if (outcome.kind === 'already_active') {
          return { kind: 'answer', callbackText: s.callbackNoChange };
        }
        return {
          kind: 'answer',
          callbackText: outcome.reactivated ? s.confirmedReactivated : s.confirmedAdd,
        };
      }
      if (payload.op === 'role') {
        if (payload.role === 'owner') {
          return { kind: 'answer', callbackText: s.ownerProtected };
        }
        const outcome = await applyAdminRoleChange(executor, {
          targetUserId: payload.targetUserId,
          role: payload.role,
          actorId,
          token,
          nowMs,
        });
        switch (outcome.kind) {
          case 'applied':
            return { kind: 'answer', callbackText: s.confirmedRoleChanged };
          case 'not_found':
            return { kind: 'answer', callbackText: s.notAnAdmin };
          case 'already_disabled':
            return { kind: 'answer', callbackText: s.alreadyDisabled };
          case 'no_change':
            return { kind: 'answer', callbackText: s.callbackNoChange };
        }
      }
      const outcome = await applyAdminDeactivate(executor, {
        targetUserId: payload.targetUserId,
        actorId,
        token,
        nowMs,
      });
      switch (outcome.kind) {
        case 'applied':
          return { kind: 'answer', callbackText: s.confirmedDeactivated };
        case 'not_found':
          return { kind: 'answer', callbackText: s.notAnAdmin };
        case 'already_disabled':
          return { kind: 'answer', callbackText: s.alreadyDisabled };
      }
    },
  };
}
