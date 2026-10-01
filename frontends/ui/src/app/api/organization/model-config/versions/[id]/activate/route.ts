/**
 * Activate (roll back to) an existing configuration version, or deactivate
 * all overrides with the special id 'none'. Org admins only.
 *
 * While zero data retention is in force for the org, each model the version
 * selects must have a ZDR endpoint that serves its group — the same verdict
 * (`zdrRejection`) the save path applies. A version saved before ZDR was on,
 * or before its model lost its ZDR endpoint, would otherwise put a model back
 * into production that OpenRouter refuses for this org. A refusal is a 422
 * whose `details` carry per-group codes (`not_zdr`,
 * `zdr_endpoint_lacks_capability`); a ZDR list that cannot be read is a 503.
 *
 * Only the ZDR check: catalog membership, context and capability are what a
 * save validates and rollback never did, and a rollback refused for one of
 * those must not read as a ZDR problem. An org whose own key is on another
 * provider (ZDR not applicable) and an org that opted out roll back as before.
 *
 * 'none' is never refused: it returns the org to the defaults it inherits,
 * and whether those have a ZDR endpoint is reported by GET model-config's
 * `zdrCoverage`, not enforced here.
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError, UnprocessableError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import type { OrgModelConfigVersion } from '@/lib/db/schema'
import { getAgentGroup } from '@/lib/model-config/agent-groups'
import { catalogUnavailableError, fetchZdrEndpoints, zdrRejection } from '@/lib/model-config/openrouter'
import { isZdrApplicableForOrg } from '@/lib/model-config/org-catalog'
import type { ModelRejection } from '@/lib/model-config/rejections'
import { activateVersion, versionModelsByGroup } from '@/lib/model-config/service'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'
import { recordAuditEvent } from '@/lib/audit/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const versionId = params.id === 'none' ? null : params.id
    if (versionId !== null && !/^[0-9a-f-]{36}$/i.test(versionId)) {
      throw new BadRequestError('Invalid version id')
    }
    const version = await activateVersion({
      organizationId: session.organizationId,
      versionId,
      actorUserId: session.userId,
      validate: (candidate) => requireZdrCompliantVersion(session.organizationId, candidate),
    })
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'model_config.version.activated',
      targetType: 'model_config_version',
      targetId: versionId,
      metadata: versionId === null ? { reset: true } : { rollback: true },
      request,
    })
    return { activeVersion: version }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)

/** Under ZDR (and only where Piloti can enforce it), refuse a version with a non-ZDR model. */
async function requireZdrCompliantVersion(organizationId: string, version: OrgModelConfigVersion): Promise<void> {
  if (!(await isZdrOnlyForOrg(organizationId))) return
  // Before any listing: an org on its own non-OpenRouter key needs no ZDR list,
  // and no provider catalog, to roll back.
  if (!(await isZdrApplicableForOrg(organizationId))) return
  const zdr = await fetchZdrEndpoints().catch((error: unknown) => {
    console.error('[Model Config API] ZDR list unavailable for a rollback:', error)
    throw catalogUnavailableError(error)
  })
  const errors: Record<string, ModelRejection[]> = {}
  for (const [groupId, modelId] of Object.entries(versionModelsByGroup(version))) {
    // A retired group is dropped: the runtime ignores it, so it cannot leak.
    const group = getAgentGroup(groupId)
    const rejection = group ? zdrRejection({ id: modelId }, group, zdr) : null
    if (rejection) errors[groupId] = [rejection]
  }
  if (Object.keys(errors).length > 0) {
    throw new UnprocessableError('This version selects models that zero data retention does not allow', errors)
  }
}
