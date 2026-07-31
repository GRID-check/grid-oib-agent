/**
 * Legal holds: preserve data and block purge (GDPR Art. 18 restriction).
 * Org-admin only. No management UI yet by design — holds are rare,
 * deliberate legal events driven via API.
 *
 * Thin handlers; all logic lives in `@/lib/compliance/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { createHold, listOpenHolds } from '@/lib/compliance/service'

const createHoldSchema = z.object({
  entityType: z.enum(['project', 'document', 'conversation', 'organization', 'user']),
  entityId: z.string().min(1),
  reason: z.string().min(1).max(2000),
})

export const GET = apiRoute(async ({ session }) => listOpenHolds(session), {
  authz: { permission: ORG_PERMISSIONS.complianceManage },
})

export const POST = apiRoute(
  async ({ session, request }) =>
    createHold(session, await parseJsonBody(request, createHoldSchema), request),
  { status: 201, authz: { permission: ORG_PERMISSIONS.complianceManage } }
)
