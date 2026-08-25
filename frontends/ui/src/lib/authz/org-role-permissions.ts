/**
 * What an ORGANIZATION ROLE holds, for the paths that have a role slug and no
 * session to read claims from (ADR-0038).
 *
 * A session answers "do I hold this permission?" from its JWT `permissions`
 * claim with no I/O — that is `hasPermission`, and it is the fast path used
 * everywhere. But two paths reason about a THIRD PARTY:
 *
 *   - `./project-membership`, deciding whether somebody else may be invited to
 *     a project, and
 *   - `./platform`, resolving a platform-org membership held by a session whose
 *     ACTIVE organization is some tenant.
 *
 * Neither has that person's claims. Both used to answer by comparing the role
 * SLUG against a hardcoded name (`'admin'`, `'org-platform-owner'`), which is
 * precisely the role-name coupling ADR-0016 and ADR-0038 exist to remove: a
 * custom role holding the right permission was invisible to them.
 *
 * So ask the identity provider. WorkOS returns every environment role with its
 * permission list in one call, and every organization role likewise, so this is
 * one cached lookup per environment — not one per subject.
 *
 * **Falls back to the catalog, never to "yes".** If WorkOS cannot be reached the
 * answer degrades to what `lib/authz/catalog.ts` says the role holds, which is
 * what the provisioner puts there. An unknown role slug resolves to the empty
 * set, so a custom role the catalog has never heard of denies rather than
 * defaults — the same fail-closed posture as `./resource-check`.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import { permissionsForOrgRole, permissionsForPlatformRole } from './permissions'

/** Matches the membership cache TTL in `./project-membership`. */
const ROLE_CACHE_TTL_MS = 10 * 60 * 1000

type RolePermissionMap = Record<string, string[]>

/**
 * Every environment-scoped role's permission list, keyed by slug.
 *
 * Cached as a whole map rather than per slug: WorkOS returns all of them in one
 * response (the provisioning script relies on the same thing), so a per-slug
 * cache would multiply calls for no benefit.
 */
async function environmentRolePermissionMap(): Promise<RolePermissionMap> {
  return getCached('authz:env-role-permissions', ROLE_CACHE_TTL_MS, async () => {
    const roles = await getWorkOS().authorization.listEnvironmentRoles()
    return Object.fromEntries(roles.data.map((role) => [role.slug, [...role.permissions]]))
  })
}

/** The same, for the roles that exist only inside one organization. */
async function organizationRolePermissionMap(organizationId: string): Promise<RolePermissionMap> {
  return getCached(`authz:org-role-permissions:${organizationId}`, ROLE_CACHE_TTL_MS, async () => {
    const roles = await getWorkOS().authorization.listOrganizationRoles(organizationId)
    return Object.fromEntries(roles.data.map((role) => [role.slug, [...role.permissions]]))
  })
}

/**
 * Does the environment role `roleSlug` hold `permission`?
 *
 * Use for a subject in a TENANT organization whose claims are not in hand.
 */
export async function orgRoleHoldsPermission(
  roleSlug: string | null | undefined,
  permission: string
): Promise<boolean> {
  if (!roleSlug) return false
  try {
    const map = await environmentRolePermissionMap()
    const held = map[roleSlug]
    if (held) return held.includes(permission)
    // WorkOS answered and does not know this slug — fall through to the catalog
    // rather than deny outright, so a role that exists only in the catalog
    // (mid-provisioning) still resolves.
  } catch (error) {
    console.warn(`[authz] environment role lookup failed for ${roleSlug}:`, error)
  }
  return permissionsForOrgRole(roleSlug).has(permission)
}

/**
 * Does the role `roleSlug`, inside organization `organizationId`, hold
 * `permission`? Used for platform-org memberships.
 */
export async function organizationRoleHoldsPermission(
  organizationId: string,
  roleSlug: string | null | undefined,
  permission: string
): Promise<boolean> {
  if (!roleSlug) return false
  try {
    const map = await organizationRolePermissionMap(organizationId)
    const held = map[roleSlug]
    if (held) return held.includes(permission)
  } catch (error) {
    console.warn(`[authz] organization role lookup failed for ${roleSlug}:`, error)
  }
  return permissionsForPlatformRole(roleSlug).has(permission)
}

/**
 * Every permission the role `roleSlug` holds inside `organizationId`.
 *
 * The platform tier needs the whole set rather than one answer, because a single
 * cross-org session is asked about several `platform:*` permissions across a
 * request.
 */
export async function organizationRolePermissions(
  organizationId: string,
  roleSlug: string | null | undefined
): Promise<ReadonlySet<string>> {
  if (!roleSlug) return new Set()
  try {
    const map = await organizationRolePermissionMap(organizationId)
    const held = map[roleSlug]
    if (held) return new Set(held)
  } catch (error) {
    console.warn(`[authz] organization role lookup failed for ${roleSlug}:`, error)
  }
  return permissionsForPlatformRole(roleSlug)
}
