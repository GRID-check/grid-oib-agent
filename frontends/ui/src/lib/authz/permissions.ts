/**
 * Permission registry — the slugs the app checks, derived from the catalog
 * (`./catalog`, ADR-0038) so code and WorkOS provisioning can never disagree.
 *
 * Authorization is PERMISSION-driven, not role-driven: routes ask "does this
 * session hold `org:models:manage`?", never "is the role called admin?".
 * Roles are permission bundles managed in WorkOS — creating a new one there
 * (say a billing admin holding only `org:budgets:manage`) works with no code
 * change. That is the extensibility contract, and the catalog now ships four
 * such roles so the contract is exercised rather than merely asserted.
 *
 * Org- and platform-tier permissions arrive in the AuthKit JWT `permissions`
 * claim for the active organization and are checked with zero I/O. Project- and
 * skill-tier permissions are per-resource and go through WorkOS FGA — see
 * `./decide` for the single entry point across all four tiers.
 */

import type { GridSession } from '@/lib/auth/types'
import {
  ORG_PERMISSION_SPECS,
  PLATFORM_PERMISSION_SPECS,
  PROJECT_PERMISSION_SPECS,
  ROLES,
  SKILL_PERMISSION_SPECS,
} from './catalog'

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
  /** View the org's audit trail (native WorkOS Audit Logs viewer/exports). */
  auditView: 'org:audit:view',
  /** Manage the org-wide document Archiv (upload/delete/reingest/retag). */
  archivManage: 'org:archiv:manage',
  /** Author/edit/delete skills in the org toolbox (Agent Skills). */
  skillsManage: 'org:skills:manage',
  /** Create new projects in the organization. */
  projectsCreate: 'org:projects:create',
  /** See and manage who is in the organization and what role they hold. */
  membersManage: 'org:members:manage',
} as const

/**
 * Platform-tier permissions. Only ever attached to roles of the dedicated
 * GRID Platform organization, so no tenant admin can grant them. The binding
 * guarantee is the platform-org membership check in `./platform` — WorkOS
 * cannot express "attachable only to one organization's roles".
 */
export const PLATFORM_PERMISSIONS = {
  organizationsView: 'platform:organizations:view',
  organizationsManage: 'platform:organizations:manage',
  usageView: 'platform:usage:view',
  settingsManage: 'platform:settings:manage',
} as const

/** Project-tier permissions, checked per project via WorkOS FGA. */
export const PROJECT_PERMISSIONS = {
  view: 'project:view',
  chat: 'project:chat',
  /** @deprecated Umbrella write kept for existing grants; prefer the specific ones. */
  edit: 'project:edit',
  documentsWrite: 'project:documents:write',
  /**
   * Machine authorship. Required IN ADDITION to `documentsWrite` at the
   * generated-document seam (`lib/documents/generated.ts`), so an organization
   * can stop the agent filing without stopping its own people uploading.
   */
  documentsGenerate: 'project:documents:generate',
  memoryWrite: 'project:memory:write',
  manage: 'project:manage',
  membersManage: 'project:members:manage',
  skillsManage: 'project:skills:manage',
} as const

/** Skill-tier permissions, checked per skill schedule via WorkOS FGA. */
export const SKILL_PERMISSIONS = {
  view: 'skill:view',
  run: 'skill:run',
  manage: 'skill:manage',
} as const

export type OrgPermission = (typeof ORG_PERMISSIONS)[keyof typeof ORG_PERMISSIONS]
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS]
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[keyof typeof PROJECT_PERMISSIONS]
export type SkillPermission = (typeof SKILL_PERMISSIONS)[keyof typeof SKILL_PERMISSIONS]

/**
 * A permission answerable from the JWT alone — no resource id, no I/O.
 * These are the only ones a route factory can gate on by itself; per-resource
 * tiers need the resource in hand and go through `./decide`.
 */
export type KnownPermission = OrgPermission | PlatformPermission

/** Any permission in the catalog, across all four tiers. */
export type AnyPermission =
  | KnownPermission
  | ProjectPermission
  | SkillPermission

/**
 * Permissions each ENVIRONMENT-SCOPED ORG role holds, straight from the catalog.
 *
 * This table is what bounds the legacy role implication below. Platform-org
 * roles are excluded on purpose: a `platform:*` permission must never be
 * reachable by implication, only by real platform-org membership.
 */
const ORG_ROLE_PERMISSIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ROLES.filter((role) => role.tier === 'org' && role.scope === 'environment').map((role) => [
    role.slug,
    new Set(role.permissions),
  ])
)

/**
 * Whether the session holds a permission for its ACTIVE organization.
 *
 * Two ways to hold one:
 *
 *  1. The JWT `permissions` claim names it. This is the normal path.
 *  2. **Bounded legacy implication.** Sessions minted before the permission
 *     rollout (or in an environment whose provisioning has not been replayed)
 *     carry a role slug without the granular claims. Such a session holds
 *     exactly the permissions the CATALOG says that role holds.
 *
 * Rule 2 replaces a former wildcard — `role === 'admin'` used to imply every
 * `org:*` permission, including ones that did not exist yet. That made a
 * restricted admin impossible to build and silently pre-granted each new
 * permission to every admin the moment it was defined. Deriving the implication
 * from the catalog keeps existing admins working while making the grant finite,
 * reviewable, and identical to what WorkOS would return once provisioned.
 *
 * `platform:*` is never implied, by construction: the map above only contains
 * environment-scoped org-tier roles.
 */
export function hasPermission(
  session: Pick<GridSession, 'role' | 'permissions'>,
  permission: KnownPermission
): boolean {
  if (session.permissions.includes(permission)) return true
  if (!session.role) return false
  return ORG_ROLE_PERMISSIONS.get(session.role)?.has(permission) ?? false
}

/** Every permission slug the catalog defines, for provisioning and tests. */
export const ALL_ORG_PERMISSION_SLUGS: readonly string[] = ORG_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
export const ALL_PLATFORM_PERMISSION_SLUGS: readonly string[] = PLATFORM_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
export const ALL_PROJECT_PERMISSION_SLUGS: readonly string[] = PROJECT_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
export const ALL_SKILL_PERMISSION_SLUGS: readonly string[] = SKILL_PERMISSION_SPECS.map(
  (permission) => permission.slug
)
