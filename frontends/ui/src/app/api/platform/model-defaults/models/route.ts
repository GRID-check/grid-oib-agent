/**
 * Model search for the platform default picker. Platform owners only.
 *
 * `?group=<agentGroupId>&q=<search>` over the PLATFORM OpenRouter catalog,
 * filtered to models that satisfy the group's capability requirements. Never
 * the org-aware catalog (`getCatalogForOrg`): a platform default is served to
 * every tenant, so it must come from the catalog they all share — a BYOK
 * tenant's provider-native listing is not a valid source for it.
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { getAgentGroup } from '@/lib/model-config/agent-groups'
import {
  baseModelId,
  fetchModelCatalog,
  fetchZdrModelIds,
  searchModelsForGroup,
} from '@/lib/model-config/openrouter'

export const GET = tenantSlotRoute(async function GET(request: Request): Promise<Response> {
  try {
    await requirePlatformOwner(await getGridSession())

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

    let catalog
    try {
      catalog = await fetchModelCatalog()
    } catch (error) {
      console.error('[Platform Model Search] Model catalog unavailable:', error)
      return NextResponse.json(
        { error: 'The model catalog is unavailable', code: 'SERVICE_UNAVAILABLE' },
        { status: 503 }
      )
    }

    // Advisory only — the owner may still pick a non-ZDR model; the flag tells
    // them which choices Zero-Data-Retention tenants cannot inherit.
    let zdrModelIds: Set<string> | null = null
    try {
      zdrModelIds = await fetchZdrModelIds()
    } catch {
      zdrModelIds = null
    }

    const models = searchModelsForGroup(catalog, groupId, query, 30, true).map((model) => ({
      ...model,
      zdrSafe: zdrModelIds ? zdrModelIds.has(baseModelId(model.id)) : null,
    }))

    return NextResponse.json({ group: group.id, models })
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
})
