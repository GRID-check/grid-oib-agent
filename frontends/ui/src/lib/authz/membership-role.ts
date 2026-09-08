/**
 * The org role behind a MEMBERSHIP ID — for the paths that have one and no
 * session (ADR-0038, ADR-0054).
 *
 * A session answers "do I hold this permission?" from its JWT claims with no
 * I/O (`hasPermission`), and every user-facing route takes that path. One path
 * cannot: the internal mounts twin (`api/internal/conversations/[id]/mounts`),
 * which authorizes AS THE USER the turn runs for. A turn's signed envelope
 * carries `organizationMembershipId` — the pair WorkOS FGA keys on — and
 * nothing else about the caller's standing in the organization. That is enough
 * for the per-resource checks (`checkResourcePermission`) and it is NOT enough
 * for the org-tier answers a mount needs: `org:chat`, to open an office
 * conversation at all, and `org:projects:administer`, the administrator bypass
 * inside `requireProjectAccess`.
 *
 * Without this, both fell back to "no claims, so no org-tier permission", and
 * the agent's mount was strictly weaker than the same person's own click — the
 * divergence spec MT-2 exists to forbid.
 *
 * Register recall does NOT take this path, deliberately: its readable filter
 * runs per project with no org-admin bypass, because the bypass is a permission
 * that arrives in a session's claim and that path has no session
 * (`workspace/register-service.ts`, spec PR-16).
 *
 * **This is not a role-name check.** It resolves the role SLUG and hands it to
 * `hasPermission({ role, permissions: [] }, …)`, which answers by catalog
 * implication — the same bounded implication that keeps a session minted before
 * a permission was provisioned working. A custom role that holds
 * `org:projects:administer` is an administrator here; a role merely NAMED
 * `admin` that holds nothing is not (ADR-0038).
 *
 * **The membership must belong to the organization it is used in.** The id
 * arrives in a payload, and a membership from another tenant would otherwise be
 * a way to import a role across the boundary. The organization is compared and
 * a mismatch resolves to `null`, which denies.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'

/**
 * Sixty seconds.
 *
 * Deliberately far shorter than the ten minutes `./project-membership` gives a
 * membership lookup, and for a different reason than either of them caches at
 * all: this answer decides an ORG-WIDE bypass, so the window between a
 * demotion and the office noticing is a window in which somebody sees every
 * project. A minute is short enough to be the same order as the WebSocket
 * upgrade cadence that re-authorizes everything else, and long enough that a
 * turn's several internal calls cost one WorkOS round trip between them.
 */
const MEMBERSHIP_ROLE_TTL_MS = 60 * 1000

/**
 * The role slug for `organizationMembershipId` within `organizationId`, or null.
 *
 * Null on every uncertainty — an unknown id, a membership in another
 * organization, an inactive membership, a WorkOS outage — because every caller
 * turns this into a permission answer and "we could not tell" must widen
 * nothing. Cached ORG-KEYED (`frontends/ui/AGENTS.md`: a key without the
 * organization serves whatever the first caller populated).
 */
export async function resolveMembershipRole(
  organizationId: string,
  organizationMembershipId: string | null | undefined
): Promise<string | null> {
  if (!organizationId || !organizationMembershipId) return null

  return getCached(
    `authz:membership-role:${organizationId}:${organizationMembershipId}`,
    MEMBERSHIP_ROLE_TTL_MS,
    async () => {
      try {
        const membership =
          await getWorkOS().userManagement.getOrganizationMembership(organizationMembershipId)
        if (!membership) return null
        // The two facts that make the role usable: it is this organization's,
        // and the membership is live. An `inactive` or `pending` membership is
        // somebody who cannot act in the organization at all.
        if (membership.organizationId !== organizationId) return null
        if (membership.status !== 'active') return null
        return membership.role?.slug ?? null
      } catch (error) {
        console.warn(
          `[authz] membership role lookup failed for ${organizationMembershipId}:`,
          error
        )
        return null
      }
    }
  )
}
