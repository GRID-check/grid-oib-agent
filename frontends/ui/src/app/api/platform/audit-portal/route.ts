/**
 * Native audit-log viewer for the PLATFORM trail: an Admin Portal link
 * (`intent: audit_logs`) scoped to the GRID Platform organization — where
 * platform-level events (e.g. break-glass access) land. Platform owner only.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { generateAuditPortalLink, trustedAppOrigin } from '@/lib/audit/service'

// `tenantSlotRoute` is a tenancy wrapper, not an authorization declaration, and
// pairing it with a hand-rolled owner gate re-implemented what
// `platformApiRoute` already does: the slot, `requirePlatformPermission`, the
// platform scope and the 403 mapping, in one place that cannot be edited out of
// the handler body.
export const POST = platformApiRoute(
  async ({ request }) => {
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
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
