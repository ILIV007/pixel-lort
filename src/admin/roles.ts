/**
 * Admin roles and the role-to-permission map (Phase 2A).
 *
 * The roles and every permission list below are derived VERBATIM from the
 * approved admin map blueprint (docs/blueprint/v1/pixel_admin_map_v1.json,
 * schemaVersion 1). The blueprint file remains the authoritative reference;
 * this constant is the typed mirror used by the authorization service. Any
 * change to roles or permissions must change the blueprint FIRST and then
 * this map (recorded via ADR).
 *
 * Authorization decisions use Telegram NUMERIC user IDs only — never
 * usernames (docs/SECURITY_MODEL.md).
 */

export const ADMIN_ROLES = [
  'owner',
  'chief_editor',
  'editor',
  'reviewer',
  'source_manager',
  'viewer',
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/**
 * Permissions per non-owner role, verbatim from the approved admin map.
 * The owner role holds the wildcard permission `*` (everything), including
 * the owner-only permissions the map expresses through commands/actions
 * (e.g. admin.manage, emergency.control, backup.export).
 */
export const ROLE_PERMISSIONS: Readonly<Record<Exclude<AdminRole, 'owner'>, readonly string[]>> = {
  chief_editor: [
    'dashboard.view',
    'inbox.view',
    'story.view',
    'story.merge',
    'story.split',
    'story.close',
    'draft.view',
    'draft.create',
    'draft.edit',
    'draft.regenerate',
    'draft.approve',
    'draft.reject',
    'media.select',
    'publication.view',
    'publication.publish',
    'publication.edit',
    'publication.delete',
    'publication.schedule',
    'publication.cancel',
    'correction.create',
    'source.view',
    'style.view',
    'style.manage',
    'settings.editorial',
    'audit.view',
    'system.view',
    'budget.view',
  ],
  editor: [
    'dashboard.view',
    'inbox.view',
    'story.view',
    'draft.view',
    'draft.create',
    'draft.edit',
    'draft.regenerate',
    'media.select',
    'publication.view',
    'publication.schedule',
    'budget.view',
  ],
  reviewer: [
    'dashboard.view',
    'inbox.view',
    'story.view',
    'draft.view',
    'draft.approve',
    'draft.reject',
    'publication.view',
  ],
  source_manager: [
    'dashboard.view',
    'story.view',
    'source.view',
    'source.manage',
    'source.run',
    'source.watchlist',
    'budget.view',
    'system.view',
  ],
  viewer: [
    'dashboard.view',
    'inbox.view',
    'story.view',
    'draft.view',
    'publication.view',
    'source.view',
    'budget.view',
  ],
};

/** Permission wildcard held by the owner role only. */
export const OWNER_WILDCARD_PERMISSION = '*';

/** Decide whether a role holds a permission. Fail-closed: unknown => false. */
export function roleHasPermission(role: AdminRole, permission: string): boolean {
  if (role === 'owner') {
    return true;
  }
  return ROLE_PERMISSIONS[role]?.includes(permission) === true;
}
