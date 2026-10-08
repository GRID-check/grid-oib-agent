/**
 * Org model configuration (runtime model per agent group).
 *
 * GET — `org:models:manage` holders only; the active version + agent-group
 *       registry, the org's zero-data-retention state (`zdrOnly`, on unless
 *       the org opted out), whether Piloti can enforce it for this org's
 *       credential (`zdrApplicable`), and — while it is in force — which
 *       groups' effective models have no usable ZDR endpoint (`zdrCoverage`).
 * PUT — validates every chosen model against the live OpenRouter catalog +
 *       the group's capability requirements (+ a ZDR endpoint that serves the
 *       group, while ZDR is in force), then writes a new immutable version and
 *       activates it.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { UnprocessableError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { AGENT_GROUPS, AGENT_GROUP_IDS, MODEL_ID_PATTERN, isAgentGroupId } from '@/lib/model-config/agent-groups'
import { getGroupDefaults } from '@/lib/model-config/backend-defaults'
import { catalogUnavailableError, validateOverrides } from '@/lib/model-config/openrouter'
import { getCatalogForOrg, isZdrApplicableForOrg } from '@/lib/model-config/org-catalog'
import { getZdrCoverage, UNKNOWN_COVERAGE } from '@/lib/model-config/zdr-coverage'
import { createAndActivateVersion, getOrgModelConfig } from '@/lib/model-config/service'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'
import { recordAuditEvent } from '@/lib/audit/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const [config, defaults, zdrOnly] = await Promise.all([
      getOrgModelConfig(session.organizationId),
      // Workflow-default model per group, from the backend's loaded YAML
      // (best-effort — nulls when the backend is unreachable).
      getGroupDefaults(),
      isZdrOnlyForOrg(session.organizationId),
    ])
    // Best-effort and concurrent: none of these may keep the config from
    // rendering. Where the picker's models come from (ADR-0022) — asked WITHOUT
    // the ZDR filter, so a ZDR-list outage does not also hide it; whether ZDR
    // can apply to this org's credential (read without revealing the key); and,
    // while ZDR is on, which groups it blocks. A failure reads as unknown
    // (`catalogSource`/`zdrApplicable` null, coverage `status: 'unknown'`).
    const [catalog, applicable, coverage] = await Promise.allSettled([
      getCatalogForOrg(session.organizationId),
      isZdrApplicableForOrg(session.organizationId),
      zdrOnly ? getZdrCoverage(session.organizationId) : Promise.resolve(null),
    ])
    for (const failed of [catalog, applicable, coverage]) {
      if (failed.status === 'rejected') {
        console.warn('[Model Config API] Part of the model configuration is unknown:', failed.reason)
      }
    }
    const catalogSource =
      catalog.status === 'fulfilled'
        ? { source: catalog.value.source, provider: catalog.value.provider, validation: catalog.value.validation }
        : null
    const zdrApplicable = applicable.status === 'fulfilled' ? applicable.value : null
    const zdrCoverage =
      !zdrOnly || zdrApplicable === false
        ? null
        : coverage.status === 'fulfilled'
          ? coverage.value
          : UNKNOWN_COVERAGE
    return {
      agentGroups: AGENT_GROUPS,
      defaults,
      catalogSource,
      zdrOnly,
      zdrApplicable,
      zdrCoverage,
      activeVersion: withoutRetiredGroups(config.activeVersion),
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)

const putSchema = z.object({
  overrides: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    // BYOK-aware shape (`author/slug` OR provider-native id, ADR-0022);
    // catalog membership below is the real gate.
    z.object({ model: z.string().regex(MODEL_ID_PATTERN, 'not a plausible model id') })
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
    // accepting unvalidated model ids. With a BYOK credential the catalog is
    // the ORG's provider listing (relaxed capability checks, ADR-0022).
    // While the org enforces ZDR, every model must also have a ZDR endpoint
    // that serves its group (`not_zdr` / `zdr_endpoint_lacks_capability`), and
    // a ZDR-list outage rejects the save rather than skipping that check.
    const zdrOnly = await isZdrOnlyForOrg(session.organizationId)
    let catalog
    try {
      catalog = await getCatalogForOrg(session.organizationId, { zdrOnly })
    } catch (error) {
      console.error('[Model Config API] Model catalog unavailable:', error)
      throw catalogUnavailableError(error)
    }
    const flat = Object.fromEntries(Object.entries(input.overrides).map(([g, v]) => [g, v.model]))
    const validation = validateOverrides(catalog.models, flat, catalog.validation === 'full', catalog.zdr)
    if (!validation.ok) {
      throw new UnprocessableError('Model validation failed', validation.errors)
    }

    const version = await createAndActivateVersion({
      organizationId: session.organizationId,
      overrides: input.overrides,
      modelSnapshot: {
        ...validation.snapshot,
        _catalog: {
          source: catalog.source,
          provider: catalog.provider,
          validation: catalog.validation,
          zdrOnly: catalog.zdrOnly,
        },
      },
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
  { status: 201, authz: { permission: ORG_PERMISSIONS.modelsManage } }
)

/**
 * The active version with any retired agent group left out of its overrides.
 * Versions are immutable history, so the stored row keeps the group; the card
 * sends back what it loads, and the PUT would reject it with a 400.
 */
function withoutRetiredGroups<T extends { overrides: unknown }>(version: T | null): T | null {
  if (!version || !version.overrides || typeof version.overrides !== 'object') return version
  const overrides = Object.fromEntries(
    Object.entries(version.overrides as Record<string, unknown>).filter(([group]) => isAgentGroupId(group))
  )
  return { ...version, overrides }
}
