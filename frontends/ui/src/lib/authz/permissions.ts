/**
 * Permission registry — the single source of truth for what the app checks
 * (ADR-0016, docs/architecture/platform-and-authorization.md).
 *
 * Authorization is PERMISSION-driven, not role-driven: routes ask "does this
 * session hold `org:models:manage`?", never "is the role called admin?".
 * Roles are just permission bundles managed in WorkOS — creating a new role
 * there (e.g. a billing admin holding only `org:budgets:manage`) works
 * without any code change. That is the extensibility contract.
 *
 * The slugs here are provisioned in WorkOS (see
 * docs/deployment/workos-provisioning.md) and arrive in the session via the
 * AuthKit JWT `permissions` claim for the active organization.
 */

import type { GridSession } from '@/lib/auth/types'

/** Organization-tier permissions (attached to org roles, e.g. Admin). */
export const ORG_PERMISSIONS = {
  /** Manage org settings: name, locale, defaults; see the org page. */
  settingsManage: 'org:settings:manage',
  /** Manage runtime AI model configuration (ADR-0014). */
  modelsManage: 'org:models:manage',
  /** Manage LLM budgets and view org-wide usage (ADR-0015). */
  budgetsManage: 'org:budgets:manage',
  /** Manage legal holds and the deletion queue. */
  complianceManage: 'org:compliance:manage',
} as const

/**
 * Platform-tier permissions. Only ever attached to roles of the dedicated
 * GRID Platform organization (org-scoped role `org-platform-owner`), so no
 * tenant admin can grant them.
 */
export const PLATFORM_PERMISSIONS = {
  organizationsView: 'platform:organizations:view',
  organizationsManage: 'platform:organizations:manage',
  usageView: 'platform:usage:view',
  settingsManage: 'platform:settings:manage',
} as const

export type OrgPermission = (typeof ORG_PERMISSIONS)[keyof typeof ORG_PERMISSIONS]
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS]
export type KnownPermission = OrgPermission | PlatformPermission

/**
 * Whether the session holds a permission for its ACTIVE organization.
 *
 * Back-compat rule: sessions minted before the permission rollout (or in a
 * WorkOS environment that hasn't been provisioned yet) carry the legacy
 * `admin` role without the granular `org:*` claims. The `admin` role
 * therefore implies every `org:*` permission — never `platform:*`.
 */
export function hasPermission(
  session: Pick<GridSession, 'role' | 'permissions'>,
  permission: KnownPermission,
): boolean {
  if (session.permissions.includes(permission)) return true
  if (permission.startsWith('org:') && session.role === 'admin') return true
  return false
}
