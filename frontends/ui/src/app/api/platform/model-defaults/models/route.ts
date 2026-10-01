/**
 * Model search for the platform default picker. Platform owners only.
 *
 * `?group=<agentGroupId>&q=<search>` over the PLATFORM OpenRouter catalog,
 * filtered to models that satisfy the group's capability requirements. Never
 * the org-aware catalog (`getCatalogForOrg`): a platform default is served to
 * every tenant, so it must come from the catalog they all share — a BYOK
 * tenant's provider-native listing is not a valid source for it.
 *
 * Only models with a zero-data-retention endpoint that serves the group are
 * listed: every organization is ZDR unless it opted out, so a default without
 * one would have its requests refused for all of them. A ZDR-list outage is a
 * 503 (`details.reason: 'zdr_list_unavailable'`), never the unfiltered catalog.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getAgentGroup } from '@/lib/model-config/agent-groups'
import {
  catalogUnavailableError,
  fetchModelCatalog,
  fetchZdrEndpoints,
  searchModelsForGroup,
} from '@/lib/model-config/openrouter'

// The owner gate belongs in the factory, not in the body: `platformApiRoute`
// runs it before the handler and maps PlatformAccessDeniedError to 403 once,
// for every platform route (ADR-0016).
export const GET = platformApiRoute(
  async ({ request }) => {
    const url = new URL(request.url)
    const groupId = url.searchParams.get('group') ?? ''
    const query = url.searchParams.get('q') ?? ''
    const group = getAgentGroup(groupId)
    if (!group) {
      return NextResponse.json(
        { error: 'Unknown agent group', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const [catalog, zdr] = await Promise.all([fetchModelCatalog(), fetchZdrEndpoints()]).catch((error: unknown) => {
      console.error('[Platform Model Search] Model catalog or ZDR list unavailable:', error)
      throw catalogUnavailableError(error)
    })

    const models = searchModelsForGroup(catalog, groupId, query, 30, true, zdr)

    return NextResponse.json({ group: group.id, models })
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)
