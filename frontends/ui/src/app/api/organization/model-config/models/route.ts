/**
 * OpenRouter model search for the configuration picker. Org admins only.
 *
 * `?group=<agentGroupId>&q=<search>` — returns only models that satisfy the
 * group's capability requirements ("appropriate models for the task").
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { canManageModels } from '@/lib/authz/organizations'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { getAgentGroup } from '@/lib/model-config/agent-groups'
import { fetchModelCatalog, searchModelsForGroup } from '@/lib/model-config/openrouter'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!canManageModels(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const { searchParams } = new URL(request.url)
    const groupId = searchParams.get('group') ?? ''
    const query = searchParams.get('q') ?? ''
    const group = getAgentGroup(groupId)
    if (!group) {
      return NextResponse.json({ error: 'Unknown agent group' }, { status: 400 })
    }

    let catalog
    try {
      catalog = await fetchModelCatalog()
    } catch (error) {
      console.error('[Model Search API] OpenRouter catalog unavailable:', error)
      return NextResponse.json({ error: 'OpenRouter model catalog is unavailable' }, { status: 503 })
    }
    const models = searchModelsForGroup(catalog, groupId, query)
    return NextResponse.json({ group: group.id, models })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
