/**
 * Platform-owner control of one organization's storage quota (ADR-0042).
 *
 * The quota lives here rather than in Organization settings because it is a
 * commercial constraint the operator imposes: a tenant able to raise its own
 * limit is not limited. Same placement, and the same reasoning, as
 * `platform_model_defaults`.
 *
 * `platformApiRoute` runs `requirePlatformOwner` BEFORE the handler, so the gate
 * cannot be lost by editing the body.
 */

import { z } from 'zod'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { getOrganizationStorage, setStorageQuota } from '@/lib/storage/service'

const putSchema = z.object({
  /** Bytes, or null to make the organization unlimited. */
  quotaBytes: z.number().int().positive().nullable(),
})

interface Params {
  organizationId: string
}

export const GET = platformApiRoute<Params>(async ({ params }) =>
  getOrganizationStorage(params.organizationId)
)

export const PUT = platformApiRoute<Params>(async ({ session, request, params }) => {
  const body = await request.json()
  const { quotaBytes } = putSchema.parse(body)
  return setStorageQuota(session, params.organizationId, quotaBytes, request)
})
