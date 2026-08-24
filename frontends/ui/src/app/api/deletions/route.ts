/**
 * Lists pending/failed deletions for the current organization (org admins).
 * Powers the "Recently deleted" UI; failed rows surface stuck purges.
 *
 * Thin handler; all logic lives in `@/lib/compliance/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { listPendingDeletions } from '@/lib/compliance/service'

export const GET = apiRoute(async ({ session }) => listPendingDeletions(session), {
  authz: { permission: ORG_PERMISSIONS.complianceManage },
})
