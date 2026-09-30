/**
 * A session for somebody who is not here.
 *
 * Unattended work — a scheduled task filing its report at 03:00 — has to act
 * as a person, because everything downstream reads a person: the permission
 * check, `documents.created_by`, the audit actor. The design that introduced
 * agent-authored documents refused the shortcut (a service token that files as
 * nobody) and named the alternative: "the requester's permission, resolved at
 * task creation and pinned on the row" (agent-authored-documents design,
 * decision 10). This is the resolution half of that.
 *
 * It is built from the STORED requester only — a WorkOS user id the task row
 * pinned when the person set the work up — and from what WorkOS says about
 * that person NOW: their membership, their role, the organization's flags. A
 * requester who left the organization resolves to nothing, and the caller
 * refuses rather than files. No access token: nothing on the filing path
 * forwards one, and a session that carried a fabricated one would be a
 * credential this module has no business minting.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { TransientAuthzError, type AuthzLookupOptions } from '@/lib/authz/errors'
import { enforcementOn } from '@/lib/authz/feature-flags'
import { tenantRolePermissions } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledSlugsForOrg } from '@/lib/workos/feature-flags'

export interface PinnedRequester {
  userId: string
  email: string | null
  organizationId: string
}

/**
 * The session the requester would have if they were signed in right now, or
 * `null` when they are no longer a member of the organization.
 *
 * Permissions: what WorkOS says the requester's role holds, unioned with the
 * catalog, the same answer `hasPermission` gives a signed-in session. Reading
 * the catalog alone denied every custom role.
 *
 * Feature flags: under enforcement, EVERY flag enabled for the organization
 * (the JWT claim a live session carries is per user+org, and the org-level
 * answer is what the fleet-wide kill switch means). Resolving only the one flag
 * the first caller needed left every other gate on the path shut. Without
 * enforcement the gates read the environment and ignore the session, so `null`
 * there is the same thing a live session without the claim reports.
 *
 * A WorkOS lookup that could not complete fails closed by default: no
 * membership reads as "left", no flags read as "all off". An unattended caller
 * that can retry passes `{ onError: 'throw' }` and gets a
 * {@link TransientAuthzError} instead, so a blip never reads as a definite no.
 */
export async function resolvePinnedRequesterSession(
  requester: PinnedRequester,
  options: AuthzLookupOptions = {},
): Promise<AuthorizedSession | null> {
  const { organizationId, userId } = requester
  const membership = await resolveSubjectMembership(organizationId, userId, options)
  // No membership, or a membership without a role, is a person who holds
  // nothing here today; the caller refuses rather than guesses a role.
  if (!membership || !membership.role) return null

  const [permissions, featureFlags] = await Promise.all([
    tenantRolePermissions(organizationId, membership.role),
    enforcementOn() ? enabledFlagsForOrg(organizationId, options) : Promise.resolve(null),
  ])

  return {
    userId,
    email: requester.email ?? '',
    name: null,
    accessToken: '',
    organizationId,
    organizationMembershipId: membership.organizationMembershipId,
    role: membership.role,
    permissions: [...permissions],
    featureFlags,
  }
}

/** Every flag enabled for the organization, as a session's claim carries them. */
async function enabledFlagsForOrg(
  organizationId: string,
  options: AuthzLookupOptions,
): Promise<string[]> {
  try {
    return [...(await enabledSlugsForOrg(organizationId))]
  } catch (error) {
    if (options.onError === 'throw') {
      throw new TransientAuthzError('feature-flags', { cause: error })
    }
    // Fail closed: a flag lookup that broke is every flag off.
    console.warn('[pinned-session] organization flag lookup failed; resolving no flags')
    return []
  }
}
