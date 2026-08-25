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
 * **Unions WorkOS with the catalog, and never defaults to "yes".** WorkOS is
 * consulted first; every miss — the call failed, the slug is unknown, or the
 * slug is known and does not list the permission — falls back to what
 * `lib/authz/catalog.ts` says the role holds. That union is deliberate and
 * mirrors `hasPermission`: the catalog routinely ships ahead of provisioning,
 * and answering the same question two different ways for a session and for a
 * third party is precisely the divergence this module exists to prevent.
 *
 * A role slug NEITHER side knows resolves to the empty set, so a custom role
 * nobody has heard of denies rather than defaults — the same fail-closed
 * posture as `./resource-check`.
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
    if (map[roleSlug]?.includes(permission)) return true
    // Falls through to the catalog on every miss, not only on an unknown slug.
    //
    // Returning `map[roleSlug].includes(permission)` directly was wrong in the
    // one case that matters: WorkOS knows the role but not the permission —
    // which is exactly what a catalog that has shipped ahead of provisioning
    // looks like. `hasPermission` unions the two for a SESSION (that union is
    // what keeps a lagging environment usable), so answering the same question
    // about a THIRD PARTY with a hard deny made the two disagree in the very
    // situation this module's header says it exists to prevent: an org admin
    // reaching every project through `requireProjectAccess` while
    // `canUserAccessProject` refused to let anyone invite them to one.
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
    if (map[roleSlug]?.includes(permission)) return true
    // Same union as above, for the same reason.
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
    // Union, not replace: the catalog covers what provisioning has not caught
    // up to, and WorkOS covers the custom roles the catalog has never heard of.
    if (held) return new Set([...held, ...permissionsForPlatformRole(roleSlug)])
  } catch (error) {
    console.warn(`[authz] organization role lookup failed for ${roleSlug}:`, error)
  }
  return permissionsForPlatformRole(roleSlug)
}
