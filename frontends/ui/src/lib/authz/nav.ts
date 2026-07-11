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
}

export async function getNavFlags(session: GridSession | null): Promise<NavFlags> {
  if (!session) {
    return { canManageOrganization: false, canViewOrganization: false, canManagePlatform: false }
  }
  return {
    canManageOrganization: isOrgAdmin(session),
    canViewOrganization: true,
    canManagePlatform: await isPlatformOwner(session),
  }
}
