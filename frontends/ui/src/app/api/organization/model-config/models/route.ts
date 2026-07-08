/**
 * OpenRouter model search for the configuration picker. Org admins only.
 *
 * `?group=<agentGroupId>&q=<search>` — returns only models that satisfy the
 * group's capability requirements ("appropriate models for the task").
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { BadRequestError, ServiceUnavailableError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { getAgentGroup } from '@/lib/model-config/agent-groups'
import { fetchModelCatalog, searchModelsForGroup } from '@/lib/model-config/openrouter'

const querySchema = z.object({
  group: z.string().default(''),
  q: z.string().default(''),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const { group: groupId, q: query } = parseQuery(request, querySchema)
    const group = getAgentGroup(groupId)
    if (!group) {
      throw new BadRequestError('Unknown agent group')
    }

    let catalog
    try {
      catalog = await fetchModelCatalog()
    } catch (error) {
      console.error('[Model Search API] OpenRouter catalog unavailable:', error)
      throw new ServiceUnavailableError('OpenRouter model catalog is unavailable')
    }
    return { group: group.id, models: searchModelsForGroup(catalog, groupId, query) }
  },
  { permission: ORG_PERMISSIONS.modelsManage },
)
