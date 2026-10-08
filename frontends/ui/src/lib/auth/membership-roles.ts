/**
 * The roles a person holds in an organization, as WorkOS says NOW (ADR-0085).
 *
 * A folder's access list names roles, so the roles that decide it must follow
 * WorkOS within a minute: a role taken away in the People tab stops opening a
 * folder before the person's token is refreshed. The token's `roles` claim is
 * the fallback for a lookup that could not be made, never the first answer.
 *
 * Cached for {@link MEMBERSHIP_ROLES_TTL_MS}. "Could not ask" is not cached: the
 * error is caught outside `getCached`, so the next request asks again.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'

/** How stale the roles behind an access decision may be. */
export const MEMBERSHIP_ROLES_TTL_MS = 60_000

/** Every role slug the membership holds (several with WorkOS's "multiple roles"), else its one role. */
export function rolesOfMembership(membership: {
  role?: { slug?: string | null } | null
  roles?: ReadonlyArray<{ slug?: string | null }> | null
}): string[] {
  const listed = (membership.roles ?? []).map((role) => role.slug).filter((slug): slug is string => Boolean(slug))
  if (listed.length > 0) return [...new Set(listed)]
  return membership.role?.slug ? [membership.role.slug] : []
}

/**
 * The person's roles in the organization: `[]` when they are not an active
 * member, `null` when WorkOS could not be asked (the caller decides its fallback).
 */
export async function resolveMembershipRoles(organizationId: string, userId: string): Promise<string[] | null> {
  try {
    return await getCached(`membership-roles:${organizationId}:${userId}`, MEMBERSHIP_ROLES_TTL_MS, async () => {
      const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
        userId,
        organizationId,
        // A deactivated membership holds no role an access decision may use.
        statuses: ['active'],
        limit: 1,
      })
      const membership = memberships.data[0]
      return membership ? rolesOfMembership(membership) : []
    })
  } catch (error) {
    console.warn(`[membership-roles] lookup failed for ${userId}:`, error)
    return null
  }
}
