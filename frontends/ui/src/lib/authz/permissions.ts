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
  /**
   * Reach every project in the organization without a per-project role — the
   * org-admin bypass, expressed as a permission (ADR-0038). Checking a
   * permission rather than the role slug `admin` is what makes a restricted
   * admin, or a custom owner role, constructible for the project tier too.
   */
  projectsAdminister: 'org:projects:administer',
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
  /** Read platform configuration. The read half of {@link settingsManage}. */
  settingsView: 'platform:settings:view',
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
export type AnyPermission = KnownPermission | ProjectPermission | SkillPermission

const EMPTY_PERMISSIONS: ReadonlySet<string> = new Set()

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
 * The same table for PLATFORM-ORG roles, kept separate on purpose.
 *
 * `hasPermission` must never consult this one — that is the invariant the
 * comment above rests on. It exists for `./platform`, which has already
 * established real platform-org membership before it asks what that membership's
 * role holds, and which therefore needs the bounded implication for the same
 * reason the org tier does: a session minted before `platform:settings:view` was
 * provisioned carries the role slug without the claim.
 */
const PLATFORM_ROLE_PERMISSIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ROLES.filter((role) => role.scope === 'platform-org').map((role) => [
    role.slug,
    new Set(role.permissions),
  ])
)

/**
 * Every permission the catalog says an ENVIRONMENT-SCOPED org role holds.
 *
 * Exported so the two places that must reason about a THIRD PARTY's org role —
 * `./project-membership` mirroring the project bypass for an invitee, and the
 * provisioning check — derive it from the same table `hasPermission` uses
 * instead of re-deriving "which roles are admin-ish" by hand.
 */
export function permissionsForOrgRole(roleSlug: string | null | undefined): ReadonlySet<string> {
  if (!roleSlug) return EMPTY_PERMISSIONS
  return ORG_ROLE_PERMISSIONS.get(roleSlug) ?? EMPTY_PERMISSIONS
}

/** Every permission the catalog says a PLATFORM-ORG role holds. */
export function permissionsForPlatformRole(
  roleSlug: string | null | undefined
): ReadonlySet<string> {
  if (!roleSlug) return EMPTY_PERMISSIONS
  return PLATFORM_ROLE_PERMISSIONS.get(roleSlug) ?? EMPTY_PERMISSIONS
}

/**
 * Whether the session holds a permission for its ACTIVE organization.
 *
 * Two ways to hold one:
 *
 *  1. The JWT `permissions` claim names it. This is the normal path.
 *  2. **Bounded legacy implication.** Sessions minted before the permission
 *     rollout — or in an environment whose provisioning has not been replayed —
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
 * ## Why the implication applies even to a session that HAS claims
 *
 * Because the catalog routinely ships ahead of provisioning, and this fallback
 * is the only thing that keeps that gap invisible to users. Restricting it to
 * claims-less sessions was tried here and reverted: both live environments hold
 * an Admin role WITHOUT `org:skills:manage` — the catalog has it, the
 * provisioner has not been re-run — so every admin carrying claims would have
 * lost the org skills toolbox the moment the narrower rule shipped. Turning
 * every catalog/WorkOS gap into a silent permission removal is a worse failure
 * than the one the narrowing fixes.
 *
 * The cost, stated plainly: a WorkOS role whose slug happens to be `admin` is
 * handed the whole Admin bundle whatever it actually holds, so a restricted
 * admin must be built as a NEW role rather than by editing Admin. That is
 * bounded (the catalog decides the set), visible (the `provision:authz --check`
 * drift job compares the two), and it retires when the implication does.
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
