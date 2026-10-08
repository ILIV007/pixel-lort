/**
 * Fail-closed authorization service (Phase 2A).
 *
 * Resolves an actor from:
 *   - the OWNER_TELEGRAM_ID bootstrap identity (development/ops continuity;
 *     requires the secret to be present AND valid — a missing or invalid
 *     owner configuration can NEVER resolve to the owner role), and
 *   - active admins stored in D1 (admins.status = 'active').
 *
 * Rules (docs/SECURITY_MODEL.md):
 * - Authorization decisions use the Telegram NUMERIC user ID only.
 * - Disabled admins receive no privileged access (lookup returns null).
 * - Unknown users are unauthorized; there is no automatic promotion.
 * - A database failure during lookup THROWS (a mapped AppError) — it is a
 *   transient internal failure, not an authorization denial: the update is
 *   marked failed by the ingress pipeline instead of answered with a denial.
 */
import type { AdminRole } from './roles';

export type ActorResolution =
  { readonly kind: 'authorized'; readonly role: AdminRole } | { readonly kind: 'unauthorized' };

export interface AdminRoleLookup {
  /** Active role for the user, or null when unknown/disabled/invalid. */
  findActiveRole(telegramUserId: number): Promise<AdminRole | null>;
}

export interface AuthorizationService {
  resolveActor(telegramUserId: number | undefined): Promise<ActorResolution>;
}

export interface AuthorizationServiceOptions {
  /** Parsed OWNER_TELEGRAM_ID; absent/invalid means owner never resolves. */
  readonly ownerTelegramId?: number;
  readonly lookup: AdminRoleLookup;
}

export const UNAUTHORIZED: ActorResolution = { kind: 'unauthorized' };

export function createAuthorizationService(
  options: AuthorizationServiceOptions,
): AuthorizationService {
  const { ownerTelegramId, lookup } = options;

  async function resolveActor(telegramUserId: number | undefined): Promise<ActorResolution> {
    if (telegramUserId === undefined) {
      return UNAUTHORIZED;
    }
    if (ownerTelegramId !== undefined && telegramUserId === ownerTelegramId) {
      return { kind: 'authorized', role: 'owner' };
    }
    const role = await lookup.findActiveRole(telegramUserId);
    return role === null ? UNAUTHORIZED : { kind: 'authorized', role };
  }

  return { resolveActor };
}
