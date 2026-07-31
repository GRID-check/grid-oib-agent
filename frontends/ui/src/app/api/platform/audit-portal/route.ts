/**
 * Native audit-log viewer for the PLATFORM trail: an Admin Portal link
 * (`intent: audit_logs`) scoped to the GRID Platform organization — where
 * platform-level events (e.g. break-glass access) land. Platform owner only.
 */

import { NextResponse } from 'next/server'
import { getGridSession } from '@/lib/auth/session'
import {
  getPlatformOrganizationId,
  PlatformAccessDeniedError,
  requirePlatformOwner,
} from '@/lib/authz/platform'
import { generateAuditPortalLink, trustedAppOrigin } from '@/lib/audit/service'

export async function POST(request: Request): Promise<Response> {
  const session = await getGridSession()
  try {
    await requirePlatformOwner(session)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: error.status })
    }
    throw error
  }
  const platformOrgId = await getPlatformOrganizationId()
  if (!platformOrgId) {
    // Break-glass owner before provisioning — nothing to link to yet.
    return NextResponse.json({ error: 'platform-org-missing' }, { status: 404 })
  }
  const returnUrl = `${trustedAppOrigin(request)}/app/platform`
  try {
    const link = await generateAuditPortalLink(platformOrgId, returnUrl)
    return NextResponse.json({ link })
  } catch (error) {
    console.error('[Platform Audit Portal] WorkOS link generation failed:', error)
    return NextResponse.json({ error: 'portal-unavailable' }, { status: 502 })
  }
}
