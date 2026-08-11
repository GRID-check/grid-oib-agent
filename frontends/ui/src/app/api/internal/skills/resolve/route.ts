/**
 * INTERNAL skill resolution endpoint - the backend's /v1/chat/skills path asks
 * the BFF which skills apply to an organization/agent. Shared-token guarded
 * (GRID_INTERNAL_API_TOKEN); the organization comes from the query string, so
 * tenancy is declared from the payload/query rather than a session.
 */

import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { resolveSkillsForAgent } from '@/lib/skills/service'
import { resolveQuerySchema } from '@/lib/skills/types'

export const GET = internalApiRoute(
  'Skill Resolve',
  async ({ request }) => {
    const { organization_id, agent } = parseQuery(request, resolveQuerySchema)
    return withTenant({ organizationId: organization_id }, () =>
      resolveSkillsForAgent(organization_id, agent ?? undefined)
    )
  },
  { tenancy: { fromPayload: 'the organization id from query.organization_id' } }
)
