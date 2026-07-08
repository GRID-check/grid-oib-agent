/**
 * Native audit-log viewer access (org-scoped).
 *
 * POST returns a short-lived WorkOS Admin Portal link (`intent: audit_logs`)
 * for the caller's OWN organization — the portal itself enforces the org
 * scope, so an org admin can never see another tenant's trail. Gated by
 * `org:audit:view` (ADR-0016 registry; legacy `admin` implies it).
 * POST (not GET) because each call mints a fresh single-use portal session.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { canViewAuditLogs } from '@/lib/authz/organizations'
import { generateAuditPortalLink } from '@/lib/audit/service'

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!canViewAuditLogs(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const returnUrl = new URL('/app/organization', request.url).toString()
    try {
      const link = await generateAuditPortalLink(session.organizationId, returnUrl)
      return NextResponse.json({ link })
    } catch (error) {
      console.error('[Audit Portal] WorkOS link generation failed:', error)
      return NextResponse.json({ error: 'portal-unavailable' }, { status: 502 })
    }
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
