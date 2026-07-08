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
  canManagePlatform: boolean
}

export async function getNavFlags(session: GridSession | null): Promise<NavFlags> {
  if (!session) {
    return { canManageOrganization: false, canManagePlatform: false }
  }
  return {
    canManageOrganization: isOrgAdmin(session),
    canManagePlatform: await isPlatformOwner(session),
  }
}
