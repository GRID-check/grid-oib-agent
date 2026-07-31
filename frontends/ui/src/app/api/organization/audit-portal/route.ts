/**
 * Native audit-log viewer access (org-scoped).
 *
 * POST returns a short-lived WorkOS Admin Portal link (`intent: audit_logs`)
 * for the caller's OWN organization — the portal itself enforces the org
 * scope, so an org admin can never see another tenant's trail. Gated by
 * `org:audit:view` (ADR-0016 registry; legacy `admin` implies it).
 * POST (not GET) because each call mints a fresh single-use portal session.
 */

import { apiRoute } from '@/lib/api/handler'
import { UpstreamError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { generateAuditPortalLink, trustedAppOrigin } from '@/lib/audit/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const returnUrl = `${trustedAppOrigin(request)}/app/organization`
    try {
      return { link: await generateAuditPortalLink(session.organizationId, returnUrl) }
    } catch (error) {
      console.error('[Audit Portal] WorkOS link generation failed:', error)
      throw new UpstreamError('portal-unavailable')
    }
  },
  { authz: { permission: ORG_PERMISSIONS.auditView } }
)
