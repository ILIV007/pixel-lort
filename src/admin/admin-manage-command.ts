/**
 * Issue #8 — the owner-only `/admins` argument parser (the R1.18.1
 * grammar discipline).
 *
 * Grammar (exactly one of):
 *   `/admins`                        list admins
 *   `/admins add <userId> <role>`    add (or reactivate) an admin
 *   `/admins remove <userId>`        deactivate an admin
 *   `/admins role <userId> <role>`   change an admin's role
 *
 * Validation happens BEFORE any store access and BEFORE any token is
 * minted:
 * - The remainder must be a single space/tab-separated token sequence —
 *   newlines, control characters and extra tokens are `invalid`.
 * - `<userId>` is a canonical Telegram NUMERIC user ID (the same shape as
 *   OWNER_TELEGRAM_ID: decimal digits, no leading zero, safe integer).
 *   Usernames are never accepted.
 * - `<role>` is one of the five assignable non-owner roles. The `owner`
 *   role is NEVER assignable here (bootstrap-owner protection, issue #8);
 *   `owner` as a role argument is `invalid`, not a special case.
 *
 * The parser is pure: it never touches D1, never logs, and never echoes
 * the rejected input (the caller renders the static invalid-usage text).
 */
import { isAdminRole, type AdminRole } from './roles';

/** Canonical numeric Telegram user ID (OWNER_TELEGRAM_ID shape). */
export const ADMIN_MANAGE_USER_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/** Roles the owner may assign through `/admins` (never `owner`). */
export const ASSIGNABLE_ROLES: readonly AdminRole[] = [
  'chief_editor',
  'editor',
  'reviewer',
  'source_manager',
  'viewer',
];

export type AdminManageArgumentParse =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly targetUserId: number; readonly role: AdminRole }
  | { readonly kind: 'remove'; readonly targetUserId: number }
  | { readonly kind: 'role'; readonly targetUserId: number; readonly role: AdminRole }
  | { readonly kind: 'invalid' };

function parseUserId(token: string | undefined): number | null {
  if (token === undefined || !ADMIN_MANAGE_USER_ID_PATTERN.test(token)) {
    return null;
  }
  const parsed = Number(token);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAssignableRole(token: string | undefined): AdminRole | null {
  if (token === undefined || !isAdminRole(token)) {
    return null;
  }
  // The owner role is never assignable through this surface.
  return token === 'owner' ? null : token;
}

/**
 * Parse the WHOLE remainder of `/admins` (the router already stripped the
 * command token and its separator). `undefined` is the documented
 * no-argument list form.
 */
export function parseAdminManageArgument(remainder: string | undefined): AdminManageArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'list' };
  }
  // Newlines / control characters can never be part of a valid argument —
  // they are a grammar failure, never a separator. (Checked by code point,
  // not by a control-character regex — the lint rule forbids the latter.)
  if (
    [...remainder].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return { kind: 'invalid' };
  }
  const tokens = remainder.split(/[ \t]+/u);
  const [subcommand, ...rest] = tokens as [string | undefined, ...string[]];
  if (subcommand === 'add' && rest.length === 2) {
    const targetUserId = parseUserId(rest[0]);
    const role = parseAssignableRole(rest[1]);
    if (targetUserId === null || role === null) {
      return { kind: 'invalid' };
    }
    return { kind: 'add', targetUserId, role };
  }
  if (subcommand === 'remove' && rest.length === 1) {
    const targetUserId = parseUserId(rest[0]);
    if (targetUserId === null) {
      return { kind: 'invalid' };
    }
    return { kind: 'remove', targetUserId };
  }
  if (subcommand === 'role' && rest.length === 2) {
    const targetUserId = parseUserId(rest[0]);
    const role = parseAssignableRole(rest[1]);
    if (targetUserId === null || role === null) {
      return { kind: 'invalid' };
    }
    return { kind: 'role', targetUserId, role };
  }
  return { kind: 'invalid' };
}
