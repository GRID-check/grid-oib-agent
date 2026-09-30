/**
 * Model search for the organization's configuration picker. Org admins only.
 *
 * `?group=<agentGroupId>&q=<search>` — returns only models that satisfy the
 * group's capability requirements ("appropriate models for the task").
 *
 * What a model costs is shown as `≈ N credits per request` — the platform's
 * reference request priced at the active price list (ADR-0053) — for a
 * platform-billed organization; an organization on its own key gets no hint.
 * The catalog's per-token USD prices are the platform's purchase price and
 * are stripped here; they never reach a tenant.
 *
 * Zero data retention (on unless the org opted out): the list holds ONLY
 * models with a ZDR endpoint that serves the group, and a ZDR-list outage is a
 * 503 (`details.reason: 'zdr_list_unavailable'`), never the unfiltered catalog.
 * An org that turned ZDR off sees the whole catalog, each model marked with
 * `zdrSafe` (null when the list could not be read, or for a BYOK provider that
 * OpenRouter's ZDR does not reach).
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { getAgentGroup } from '@/lib/model-config/agent-groups'
import {
  catalogUnavailableError,
  fetchZdrEndpoints,
  hasZdrEndpoint,
  searchModelsForGroup,
  type ZdrIndex,
} from '@/lib/model-config/openrouter'
import { getCatalogForOrg } from '@/lib/model-config/org-catalog'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'
import { estimateCreditsPerRequest, getEffectivePricing } from '@/lib/pricing/service'
import { getOrgBudgetUnit } from '@/lib/budgets/service'

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
    const [zdrOnly, pricing, unit] = await Promise.all([
      isZdrOnlyForOrg(session.organizationId),
      getEffectivePricing(),
      getOrgBudgetUnit(session.organizationId),
    ])
    let catalog
    try {
      catalog = await getCatalogForOrg(session.organizationId, { zdrOnly })
    } catch (error) {
      console.error('[Model Search API] Model catalog unavailable:', error)
      throw catalogUnavailableError(error)
    }
    const marking = catalog.zdr ?? (catalog.zdrApplicable ? await zdrIndexForMarking() : null)
    return {
      group: group.id,
      catalogSource: {
        source: catalog.source,
        provider: catalog.provider,
        validation: catalog.validation,
        zdrOnly: catalog.zdrOnly,
        zdrApplicable: catalog.zdrApplicable,
      },
      models: searchModelsForGroup(catalog.models, groupId, query, 30, catalog.validation === 'full', catalog.zdr).map(
        // `promptPrice`/`completionPrice` are deliberately not spread through.
        // An organization on its own key pays its provider, not Piloti: no
        // credits hint at all (null), rather than a number that means nothing.
        ({ id, name, contextLength, promptPrice, completionPrice }) => ({
          id,
          name,
          contextLength,
          zdrSafe: marking ? hasZdrEndpoint(id, marking, group) : null,
          creditsPerRequest:
            unit === 'credit' ? estimateCreditsPerRequest({ promptPrice, completionPrice }, pricing) : null,
        })
      ),
    }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)

/**
 * The ZDR list for marking an opted-out org's picker. Best-effort: nothing is
 * filtered by it, so an outage only leaves every mark unknown (null).
 */
async function zdrIndexForMarking(): Promise<ZdrIndex | null> {
  try {
    return await fetchZdrEndpoints()
  } catch (error) {
    console.warn('[Model Search API] ZDR list unavailable; models are shown unmarked:', error)
    return null
  }
}
