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
import type { AuthzLookupOptions } from '@/lib/authz/errors'
import { enforcementOn } from '@/lib/authz/feature-flags'
import { tenantRolePermissions } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'

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
 * answer is what the fleet-wide kill switch means); without enforcement the
 * gates read the environment and ignore the session, so `null` there is the
 * same thing a live session without the claim reports.
 *
 * EVERY flag the organization has, not the one the first caller needed. This
 * resolved only `agent-authored-documents`, and asked for it with the slug and
 * the organization swapped, so under enforcement every pinned session carried
 * no flags at all. A scheduled report could then never file
 * (`isAgentAuthoredDocumentsEnabled` read the empty set), and the mail import
 * (ADR-0085), which files through the upload path's `image-upload` gate, would
 * have refused every picture. A flag lookup that fails throws, so the
 * background work retries instead of acting with none.
 *
 * A membership lookup that could not complete fails closed by default (no
 * membership reads as "left"). An unattended caller that can retry passes
 * `{ onError: 'throw' }` and gets a `TransientAuthzError` instead, so a blip
 * never reads as a definite no.
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
    enforcementOn() ? enabledFlagsForOrganization(organizationId) : Promise.resolve(null),
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
