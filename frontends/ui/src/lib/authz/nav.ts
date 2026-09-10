/**
 * Session → navigation capability flags, computed once per page render and
 * threaded into the shell (topbar / sidebar → user menu). Central so pages
 * don't each re-derive authz, and so new tiers (like the platform tier,
 * ADR-0016) appear everywhere by editing one function.
 */

import 'server-only'
import type { GridSession } from '@/lib/auth/types'
import { isOrgAdmin } from './organizations'
import { isPlatformStaff } from './platform'
import { inboxIsReachable } from '@/lib/inbox/registry'
import { FEATURE_FLAGS, isCollaborationEnabled, isFeatureEnabled } from './feature-flags'
import { hasPermission, ORG_PERMISSIONS } from './permissions'

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
  /**
   * Whether the Büro — the organization-level chat at `/app/chat` — is
   * reachable (ADR-0054). Needs BOTH the `workspace-chat` flag and `org:chat`,
   * the same pair `/app/chat` itself checks before it renders.
   *
   * The permission belongs here and not only on the page for the reason the
   * inbox row below already records: an entry that cannot work is a broken
   * affordance, and this one has two ordinary ways to be withheld. Until
   * `provision:authz --apply` has run, WorkOS holds no `org:chat` for anyone
   * while the flag fails open, so EVERY user would see a rail entry, a palette
   * command and a `g b` jump that bounce to `/app/projects`. And withholding
   * `org:chat` from a role is a supported configuration the catalog names
   * ("Withhold it to keep chat inside projects"), which would leave that door
   * permanently broken for those members.
   *
   * Gates the org header's "Piloti fragen", the rail's "Büro" entry, its `g b`
   * jump and the palette command. The route and the service still check, since
   * a nav flag is an affordance and never an authorization.
   */
  canAccessWorkspaceChat: boolean
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
      canAccessWorkspaceChat: false,
    }
  }
  const collaboration = isCollaborationEnabled(session)
  return {
    canManageOrganization: isOrgAdmin(session),
    canViewOrganization: true,
    canManagePlatform: await isPlatformStaff(session),
    canAccessArchiv: isFeatureEnabled(session, FEATURE_FLAGS.orgArchiv),
    canAccessWorkspaceChat:
      isFeatureEnabled(session, FEATURE_FLAGS.workspaceChat) &&
      hasPermission(session, ORG_PERMISSIONS.chat),
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
