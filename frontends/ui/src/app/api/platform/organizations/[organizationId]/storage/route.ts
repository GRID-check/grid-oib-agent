/**
 * Platform-owner control of one organization's storage quota (ADR-0042).
 *
 * The quota lives here rather than in Organization settings because it is a
 * commercial constraint the operator imposes: a tenant able to raise its own
 * limit is not limited. Same placement, and the same reasoning, as
 * `platform_model_defaults`.
 *
 * `platformApiRoute` runs `requirePlatformPermission` BEFORE the handler, so the gate
 * cannot be lost by editing the body. `setStorageQuota` checks again on its own
 * account — deliberately, and not as ceremony: the service writes a
 * platform-owned setting and an audit row, so its authorization has to be a
 * property of the function rather than of whichever route happens to call it.
 * Neither layer is load-bearing alone, and the predicate is cached.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { storageQuotaPutSchema } from '@/lib/storage/contract'
import { getOrganizationStorage, setStorageQuota } from '@/lib/storage/service'

interface Params {
  organizationId: string
}

export const GET = platformApiRoute<Params>(
  async ({ params }) => getOrganizationStorage(params.organizationId),
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)

/**
 * Set or clear the quota.
 *
 * `parseJsonBody` rather than `request.json()` + `schema.parse`: the hand-rolled
 * pair turned a malformed body and a schema violation into 500s, because neither
 * `SyntaxError` nor `ZodError` is an `ApiError`. The helper maps both to 400 with
 * the failing issues, which is the difference between a client learning what it
 * got wrong and a client learning the server broke.
 *
 * The schema comes from `@/lib/storage/contract`, which the editor imports too —
 * the constraint is stated once for both sides of the request.
 */
export const PUT = platformApiRoute<Params>(
  async ({ session, request, params }) => {
    const { quotaBytes } = await parseJsonBody(request, storageQuotaPutSchema)
    return setStorageQuota(session, params.organizationId, quotaBytes, request)
  },
  { permission: PLATFORM_PERMISSIONS.organizationsManage }
)
