/**
 * Single BYOK credential (ADR-0022): DELETE revokes the active credential —
 * traffic falls back to the platform key within one backend cache TTL.
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { revokeOrgCredential } from '@/lib/llm-credentials/service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const DELETE = apiRoute<{ id: string }>(
  async ({ session, request, params }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.byokLlm)
    if (gated) return gated
    if (!UUID_RE.test(params.id)) throw new BadRequestError('Invalid credential id')
    return { credential: await revokeOrgCredential(session, params.id, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)
