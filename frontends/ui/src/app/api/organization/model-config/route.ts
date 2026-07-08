/**
 * Org model configuration (runtime model per agent group).
 *
 * GET — `org:models:manage` holders only; the active version + agent-group
 *       registry.
 * PUT — validates every chosen model against the live OpenRouter catalog +
 *       the group's capability requirements, then writes a new immutable
 *       version and activates it.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ServiceUnavailableError, UnprocessableError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { AGENT_GROUPS, AGENT_GROUP_IDS, OPENROUTER_MODEL_ID_PATTERN } from '@/lib/model-config/agent-groups'
import { getGroupDefaults } from '@/lib/model-config/backend-defaults'
import { fetchModelCatalog, validateOverrides } from '@/lib/model-config/openrouter'
import { createAndActivateVersion, getOrgModelConfig } from '@/lib/model-config/service'
import { recordAuditEvent } from '@/lib/audit/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const [config, defaults] = await Promise.all([
      getOrgModelConfig(session.organizationId),
      // Workflow-default model per group, from the backend's loaded YAML
      // (best-effort — nulls when the backend is unreachable).
      getGroupDefaults(),
    ])
    return {
      agentGroups: AGENT_GROUPS,
      defaults,
      activeVersion: config.activeVersion,
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    }
  },
  { permission: ORG_PERMISSIONS.modelsManage },
)

const putSchema = z.object({
  overrides: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    z.object({ model: z.string().regex(OPENROUTER_MODEL_ID_PATTERN, 'not an OpenRouter model id') }),
  ),
  comment: z.string().trim().max(500).nullable().optional(),
})

export const PUT = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated

    const input = await parseJsonBody(request, putSchema)

    // Server-side revalidation against the live catalog — the picker UI is
    // never trusted. A catalog outage rejects the save (503) rather than
    // accepting unvalidated model ids.
    let catalog
    try {
      catalog = await fetchModelCatalog()
    } catch (error) {
      console.error('[Model Config API] OpenRouter catalog unavailable:', error)
      throw new ServiceUnavailableError('OpenRouter model catalog is unavailable; try again later')
    }
    const flat = Object.fromEntries(Object.entries(input.overrides).map(([g, v]) => [g, v.model]))
    const validation = validateOverrides(catalog, flat)
    if (!validation.ok) {
      throw new UnprocessableError('Model validation failed', validation.errors)
    }

    const version = await createAndActivateVersion({
      organizationId: session.organizationId,
      overrides: input.overrides,
      modelSnapshot: validation.snapshot,
      comment: input.comment ?? null,
      actorUserId: session.userId,
    })
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'model_config.version.activated',
      targetType: 'model_config_version',
      targetId: version.id,
      metadata: flat,
      request,
    })
    return { activeVersion: version }
  },
  { permission: ORG_PERMISSIONS.modelsManage, status: 201 },
)
