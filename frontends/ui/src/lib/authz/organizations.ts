/**
 * Organization-level authorization helpers.
 *
 * Org admins are identified by the WorkOS `admin` role (the same role
 * `requireProjectAccess` treats as a project-wide bypass) or by explicitly
 * holding the users-table management permission that the admin role grants.
 * Checking both keeps us correct whether the JWT surfaces the role slug, the
 * permission list, or both.
 */

import type { GridSession } from '@/lib/auth/types'

/** The WorkOS widget permission that gates member management. */
export const USERS_TABLE_MANAGE = 'widgets:users-table:manage'

/** True when the session may administer its organization. */
export function isOrgAdmin(session: Pick<GridSession, 'role' | 'permissions'>): boolean {
  return session.role === 'admin' || session.permissions.includes(USERS_TABLE_MANAGE)
}

/** Widget permissions we allow the UI to request a token for, when held. */
export const ORG_WIDGET_PERMISSIONS = [
  'widgets:users-table:manage',
  'widgets:sso:manage',
  'widgets:dsync:manage',
  'widgets:domain-verification:manage',
  'widgets:audit-log-streaming:manage',
] as const

export type OrgWidgetPermission = (typeof ORG_WIDGET_PERMISSIONS)[number]
