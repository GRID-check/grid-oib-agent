/**
 * Activate (roll back to) an existing configuration version, or deactivate
 * all overrides with the special id 'none'. Org admins only.
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { activateVersion } from '@/lib/model-config/service'
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
  { permission: ORG_PERMISSIONS.modelsManage },
)
