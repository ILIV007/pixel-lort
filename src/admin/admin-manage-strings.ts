/**
 * Admin MANAGE UI strings (issue #8 — the owner-only `/admins` surface) —
 * presentation strings for admin management, one table per
 * AdminUiLanguage. The SAME strict separation as `queue-strings.ts`: the
 * labels localize; the managed DATA (numeric Telegram user IDs, role
 * names, status names, stable error codes) is never translated or
 * re-cased.
 */
import type { AdminUiLanguage } from './ui-language';

/** The allowlisted admin-management command word (the issue #8 screen). */
export const ADMINS_COMMAND = 'admins' as const;

/** Non-owner roles assignable through `/admins` (the owner role is never
 *  assigned here — the bootstrap owner is protected, issue #8). */
export const ASSIGNABLE_ADMIN_ROLES = [
  'chief_editor',
  'editor',
  'reviewer',
  'source_manager',
  'viewer',
] as const;

export interface AdminManageUiStrings {
  /** /help line advertising the owner-only admins surface (gated). */
  readonly helpAdminsLine: string;
  /** Denial text for an AUTHORIZED actor who is not the owner. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text (owner only). */
  readonly invalidUsage: string;
  readonly listTitle: string;
  readonly listEmpty: string;
  readonly listRoleLabel: string;
  readonly listStatusLabel: string;
  /** The confirmation screen title. */
  readonly confirmTitle: string;
  readonly confirmTargetLabel: string;
  readonly confirmRoleLabel: string;
  readonly confirmCurrentRoleLabel: string;
  readonly confirmAddLine: string;
  readonly confirmRemoveLine: string;
  readonly confirmRoleLine: string;
  /** The confirmation buttons (single-use, user-bound, expiring tokens). */
  readonly confirmButton: string;
  readonly cancelButton: string;
  /** Outcome replies after a command (no write happened yet). */
  readonly alreadyAdminSameRole: string;
  readonly alreadyAdminOtherRole: string;
  readonly notAnAdmin: string;
  readonly alreadyDisabled: string;
  readonly ownerProtected: string;
  /** Outcome replies after a confirmed change. */
  readonly confirmedAdd: string;
  readonly confirmedReactivated: string;
  readonly confirmedRoleChanged: string;
  readonly confirmedDeactivated: string;
  readonly confirmedCancelled: string;
  /** Callback answers (the single-use confirmation flow). */
  readonly callbackInvalidToken: string;
  readonly callbackPermissionDenied: string;
  readonly callbackNoChange: string;
}

export const ADMIN_MANAGE_STRINGS: Readonly<Record<AdminUiLanguage, AdminManageUiStrings>> = {
  en: {
    helpAdminsLine: '/admins — Manage admins (owner only)',
    permissionDenied: 'Access denied: admin management is owner-only.',
    invalidUsage:
      'Invalid argument. Usage: /admins (list) — /admins add [userId] [role] — /admins remove [userId] — /admins role [userId] [role]. Roles: chief_editor, editor, reviewer, source_manager, viewer. The owner role is never assigned here.',
    listTitle: 'Admins (owner only)',
    listEmpty: 'No admins are registered yet.',
    listRoleLabel: 'Role:',
    listStatusLabel: 'Status:',
    confirmTitle: 'Confirm admin change',
    confirmTargetLabel: 'User ID:',
    confirmRoleLabel: 'Role:',
    confirmCurrentRoleLabel: 'Current role:',
    confirmAddLine: 'Add this user as an admin?',
    confirmRemoveLine: 'Deactivate this admin?',
    confirmRoleLine: 'Change this admin’s role?',
    confirmButton: 'Confirm',
    cancelButton: 'Cancel',
    alreadyAdminSameRole: 'This user is already an active admin with this role.',
    alreadyAdminOtherRole:
      'This user is already an active admin. Use /admins role to change the role.',
    notAnAdmin: 'No admin found under that user ID.',
    alreadyDisabled: 'This admin is already deactivated.',
    ownerProtected: 'The bootstrap owner cannot be changed here.',
    confirmedAdd: 'Admin added.',
    confirmedReactivated: 'Admin reactivated.',
    confirmedRoleChanged: 'Admin role changed.',
    confirmedDeactivated: 'Admin deactivated.',
    confirmedCancelled: 'Cancelled — nothing changed.',
    callbackInvalidToken: 'This button is no longer valid.',
    callbackPermissionDenied: 'Access denied: admin management is owner-only.',
    callbackNoChange: 'Nothing changed — the admin state already changed.',
  },
  fa: {
    helpAdminsLine: '/admins — مدیریت ادمین‌ها (فقط مالک)',
    permissionDenied: 'دسترسی رد شد: مدیریت ادمین‌ها فقط برای مالک است.',
    invalidUsage:
      'پارامتر نامعتبر است. کاربرد: /admins (فهرست) — /admins add [userId] [role] — /admins remove [userId] — /admins role [userId] [role]. نقش‌ها: chief_editor, editor, reviewer, source_manager, viewer. نقش مالک اینجا داده نمی‌شود.',
    listTitle: 'ادمین‌ها (فقط مالک)',
    listEmpty: 'هنوز ادمینی ثبت نشده است.',
    listRoleLabel: 'نقش:',
    listStatusLabel: 'وضعیت:',
    confirmTitle: 'تأیید تغییر ادمین',
    confirmTargetLabel: 'شناسهٔ کاربر:',
    confirmRoleLabel: 'نقش:',
    confirmCurrentRoleLabel: 'نقش فعلی:',
    confirmAddLine: 'این کاربر به‌عنوان ادمین اضافه شود؟',
    confirmRemoveLine: 'این ادمین غیرفعال شود؟',
    confirmRoleLine: 'نقش این ادمین تغییر کند؟',
    confirmButton: 'تأیید',
    cancelButton: 'لغو',
    alreadyAdminSameRole: 'این کاربر همین حالا ادمین فعال با همین نقش است.',
    alreadyAdminOtherRole:
      'این کاربر همین حالا ادمین فعال است. برای تغییر نقش از /admins role استفاده کنید.',
    notAnAdmin: 'ادمینی با این شناسهٔ کاربر یافت نشد.',
    alreadyDisabled: 'این ادمین همین حالا غیرفعال است.',
    ownerProtected: 'مالک اصلی را نمی‌توان اینجا تغییر داد.',
    confirmedAdd: 'ادمین اضافه شد.',
    confirmedReactivated: 'ادمین دوباره فعال شد.',
    confirmedRoleChanged: 'نقش ادمین تغییر کرد.',
    confirmedDeactivated: 'ادمین غیرفعال شد.',
    confirmedCancelled: 'لغو شد — چیزی تغییر نکرد.',
    callbackInvalidToken: 'این دکمه دیگر معتبر نیست.',
    callbackPermissionDenied: 'دسترسی رد شد: مدیریت ادمین‌ها فقط برای مالک است.',
    callbackNoChange: 'چیزی تغییر نکرد — وضعیت ادمین همین حالا عوض شده بود.',
  },
};
