/**
 * Org model configuration (runtime model per agent group).
 *
 * GET — org admins only; the active version + agent-group registry.
 * PUT — org admins only; validates every chosen model against the live
 *       OpenRouter catalog + the group's capability requirements, then writes
 *       a new immutable version and activates it.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { AGENT_GROUPS, AGENT_GROUP_IDS, OPENROUTER_MODEL_ID_PATTERN } from '@/lib/model-config/agent-groups'
import { fetchModelCatalog, validateOverrides } from '@/lib/model-config/openrouter'
import { createAndActivateVersion, getOrgModelConfig } from '@/lib/model-config/service'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!isOrgAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const config = await getOrgModelConfig(session.organizationId)
    return NextResponse.json({
      agentGroups: AGENT_GROUPS,
      activeVersion: config.activeVersion,
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

const putSchema = z.object({
  overrides: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    z.object({ model: z.string().regex(OPENROUTER_MODEL_ID_PATTERN, 'not an OpenRouter model id') }),
  ),
  comment: z.string().trim().max(500).nullable().optional(),
})

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!isOrgAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const parsed = putSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid model configuration payload' }, { status: 400 })
    }

    // Server-side revalidation against the live catalog — the picker UI is
    // never trusted. A catalog outage rejects the save (503) rather than
    // accepting unvalidated model ids.
    let catalog
    try {
      catalog = await fetchModelCatalog()
    } catch (error) {
      console.error('[Model Config API] OpenRouter catalog unavailable:', error)
      return NextResponse.json(
        { error: 'OpenRouter model catalog is unavailable; try again later' },
        { status: 503 },
      )
    }
    const flat = Object.fromEntries(Object.entries(parsed.data.overrides).map(([g, v]) => [g, v.model]))
    const validation = validateOverrides(catalog, flat)
    if (!validation.ok) {
      return NextResponse.json({ error: 'Model validation failed', details: validation.errors }, { status: 422 })
    }

    const version = await createAndActivateVersion({
      organizationId: session.organizationId,
      overrides: parsed.data.overrides,
      modelSnapshot: validation.snapshot,
      comment: parsed.data.comment ?? null,
      actorUserId: session.userId,
    })
    return NextResponse.json({ activeVersion: version }, { status: 201 })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
