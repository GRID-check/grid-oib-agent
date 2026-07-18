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
import { searchModelsForGroup } from '@/lib/model-config/openrouter'
import { getCatalogForOrg } from '@/lib/model-config/org-catalog'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'

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

    // With a BYOK credential the catalog is the org's own provider listing
    // (relaxed capability checks) — otherwise the OpenRouter catalog (ADR-0022).
    // The org's ZDR policy narrows an OpenRouter catalog to ZDR models.
    const zdrOnly = await isZdrOnlyForOrg(session.organizationId)
    let catalog
    try {
      catalog = await getCatalogForOrg(session.organizationId, { zdrOnly })
    } catch (error) {
      console.error('[Model Search API] Model catalog unavailable:', error)
      throw new ServiceUnavailableError('The model catalog is unavailable')
    }
    return {
      group: group.id,
      catalogSource: {
        source: catalog.source,
        provider: catalog.provider,
        validation: catalog.validation,
        zdrOnly: catalog.zdrOnly,
      },
      models: searchModelsForGroup(catalog.models, groupId, query, 30, catalog.validation === 'full'),
    }
  },
  { permission: ORG_PERMISSIONS.modelsManage },
)
