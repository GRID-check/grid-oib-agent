/**
 * Organization storage usage and quota (ADR-0042).
 *
 * GET is open to every member: a member who cannot upload needs to be able to
 * see why, and "how full is the shared drive" is not privileged. The quota
 * WRITE is gated on `org:settings:manage` by the factory, before the handler
 * runs.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { getStorageOverview, setStorageQuota } from '@/lib/storage/service'

const putSchema = z.object({
  /** Bytes, or null to make the organization unlimited. */
  quotaBytes: z.number().int().positive().nullable(),
})

export const GET = apiRoute(async ({ session }) => getStorageOverview(session), {
  authz: {
    sessionOnly: true,
    why: "every member may read their own organization's storage usage; the read is keyed by session.organizationId and the quota write below requires org:settings:manage",
  },
})

export const PUT = apiRoute(
  async ({ session, request }) => {
    const { quotaBytes } = await parseJsonBody(request, putSchema)
    return setStorageQuota(session, quotaBytes, request)
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
