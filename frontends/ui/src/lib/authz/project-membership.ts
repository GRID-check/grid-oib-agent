/**
 * "Can *that other person* reach this project?" — the container precondition
 * behind every invitation (spec SH-5, SH-19).
 *
 * Distinct from `requireProjectAccess`, which answers the question for the
 * CALLER using their own session. Here the subject is a third party: we are
 * deciding whether they may be invited to a resource, and whether they may
 * appear in a mention picker. There is no session to read, so the membership and
 * the fine-grained check are resolved explicitly.
 *
 * The two must agree, or sharing would either offer invitations that resolve to
 * nothing or refuse ones that would have worked. In particular the **org-admin
 * bypass is mirrored deliberately**: `requireProjectAccess` grants org admins
 * every project in their organization, so an org admin is reachable here too.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getWorkOS } from '@/lib/workos/client'

/** Matches the membership cache TTL in `@/lib/auth/session`. */
const MEMBERSHIP_TTL_MS = 10 * 60 * 1000
const MEMBERSHIP_NEGATIVE_TTL_MS = 30 * 1000

interface SubjectMembership {
  organizationMembershipId: string
  /** WorkOS role slug for this membership (e.g. `admin`, `member`). */
  role: string | null
}

/**
 * A user's membership in an organization, with its role.
 *
 * Cached under a key distinct from `membership:` (used by session resolution,
 * which stores only the id) so the two never clobber each other's shape.
 */
async function resolveSubjectMembership(
  organizationId: string,
  userId: string
): Promise<SubjectMembership | null> {
  return getCached(
    `membership-role:${organizationId}:${userId}`,
    MEMBERSHIP_TTL_MS,
    async () => {
      try {
        const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
          userId,
          organizationId,
          limit: 1,
        })
        const membership = memberships.data[0]
        if (!membership) return null
        return {
          organizationMembershipId: membership.id,
          role: membership.role?.slug ?? null,
        } satisfies SubjectMembership
      } catch (error) {
        console.warn(`[project-membership] lookup failed for ${userId}:`, error)
        return null
      }
    },
    { negativeTtlMs: MEMBERSHIP_NEGATIVE_TTL_MS }
  )
}

/**
 * Is `targetUserId` a member of the caller's organization at all?
 *
 * The precondition UNDERNEATH the container one. A resource with no container has
 * no project to gate on, but "no container" is not "no precondition": a grant may
 * still only name somebody inside the tenant. Without this, a grant row could be
 * written for an arbitrary — even foreign — user id, and the notification fan-out
 * would then publish to that foreign user's event channel.
 *
 * **Fails closed**, and deliberately built on the same cached membership lookup
 * `canUserAccessProject` starts from, so the two can never disagree about who
 * exists in the organization.
 */
export async function isUserInOrganization(
  session: AuthorizedSession,
  targetUserId: string
): Promise<boolean> {
  return (await resolveSubjectMembership(session.organizationId, targetUserId)) !== null
}

/**
 * Whether `targetUserId` can reach `projectId` in the caller's organization.
 *
 * **Fails closed**: an unknown user, a user outside the organization, or a failed
 * check all return `false`. A sharing decision must never default to "yes"
 * because a lookup broke.
 */
export async function canUserAccessProject(
  session: AuthorizedSession,
  projectId: string,
  targetUserId: string
): Promise<boolean> {
  const membership = await resolveSubjectMembership(session.organizationId, targetUserId)
  if (!membership) return false

  // Mirror requireProjectAccess: org admins reach every project in their org.
  if (membership.role === 'admin') return true

  try {
    const result = await getWorkOS().authorization.check({
      organizationMembershipId: membership.organizationMembershipId,
      permissionSlug: 'project:view',
      resourceExternalId: projectId,
      resourceTypeSlug: 'project',
    })
    return result.authorized
  } catch (error) {
    console.warn(
      `[project-membership] FGA check failed for ${targetUserId} on ${projectId}:`,
      error
    )
    return false
  }
}

/**
 * Filter a set of candidate users down to those who can reach the project.
 *
 * Used by the mention picker and the invite picker, which must offer ONLY people
 * who satisfy the precondition (spec SH-19) — otherwise the UI invites someone
 * and the invitation is then refused, which reads as a bug.
 *
 * Checks run in parallel; each one independently fails closed.
 */
export async function filterUsersWithProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  candidateUserIds: readonly string[]
): Promise<Set<string>> {
  const results = await Promise.all(
    candidateUserIds.map(async (userId) => ({
      userId,
      allowed: await canUserAccessProject(session, projectId, userId),
    }))
  )
  return new Set(results.filter((result) => result.allowed).map((result) => result.userId))
}
