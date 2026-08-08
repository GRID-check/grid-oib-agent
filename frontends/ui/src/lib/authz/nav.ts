/**
 * Session → navigation capability flags, computed once per page render and
 * threaded into the shell (topbar / sidebar → user menu). Central so pages
 * don't each re-derive authz, and so new tiers (like the platform tier,
 * ADR-0016) appear everywhere by editing one function.
 */

import 'server-only'
import type { GridSession } from '@/lib/auth/types'
import { isOrgAdmin } from './organizations'
import { isPlatformOwner } from './platform'
import { inboxIsReachable } from '@/lib/inbox/registry'
import { FEATURE_FLAGS, isCollaborationEnabled, isFeatureEnabled } from './feature-flags'

export interface NavFlags {
  canManageOrganization: boolean
  /**
   * Whether the organization page is reachable at all. True for any
   * authenticated org member: the page serves capability subsets
   * (budgets/models/audit) and a member self-usage view, and falls back to a
   * polite card otherwise — so the nav entry is discoverable beyond full
   * admins (UX-16). The page itself still gates each section server-side.
   */
  canViewOrganization: boolean
  canManagePlatform: boolean
  /**
   * Whether the org-wide Archiv is reachable (ADR-0024). True for any org
   * member whose org has the `organization-archiv` feature flag — the Archiv is
   * shared, read-open knowledge; only uploads/deletes gate on
   * `org:archiv:manage`, enforced on the page and its routes.
   */
  canAccessArchiv: boolean
  /**
   * Whether the collaboration surfaces are reachable (ADR-0032…0035): the inbox
   * nav entry + badge, share controls, and the mention picker. Dark-launched, so
   * this is false for every org until the flag (or the env opt-in) is set.
   */
  canCollaborate: boolean
  /**
   * Whether the inbox itself (page, nav entry, badge) is reachable.
   *
   * Deliberately NOT the same flag as `canCollaborate`. The inbox stopped being
   * a collaboration-only surface when it started carrying operational alerts
   * (ADR-0042): gating it on collaboration meant a tenant without that feature
   * could never see the warning that its storage was filling up. Derived from
   * the item-type registry, so it follows what the inbox can actually contain
   * rather than a hardcoded exception.
   */
  canAccessInbox: boolean
}

export async function getNavFlags(session: GridSession | null): Promise<NavFlags> {
  if (!session) {
    return {
      canManageOrganization: false,
      canViewOrganization: false,
      canManagePlatform: false,
      canAccessArchiv: false,
      canCollaborate: false,
      canAccessInbox: false,
    }
  }
  const collaboration = isCollaborationEnabled(session)
  return {
    canManageOrganization: isOrgAdmin(session),
    canViewOrganization: true,
    canManagePlatform: await isPlatformOwner(session),
    canAccessArchiv: isFeatureEnabled(session, FEATURE_FLAGS.orgArchiv),
    canCollaborate: collaboration,
    // Also gated on there BEING an organization. A break-glass session carries a
    // user and no `organizationId`, and the inbox is organization-scoped
    // throughout: `/app/inbox` redirects and `/api/inbox/summary` answers 403.
    // Rendering the entry anyway offered a link that cannot work and fired a
    // badge request that cannot succeed — a broken affordance in exactly the
    // session someone is using to diagnose something else.
    canAccessInbox: Boolean(session.organizationId) && inboxIsReachable(collaboration),
  }
}
