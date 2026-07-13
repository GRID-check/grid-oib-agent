/**
 * On-demand re-verification of the active BYOK credential against its
 * provider (`GET {baseUrl}/models`). Updates `last_verified_at` and emits an
 * audit event (ADR-0022).
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { verifyOrgCredential } from '@/lib/llm-credentials/service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const POST = apiRoute<{ id: string }>(
  async ({ session, request, params }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.byokLlm)
    if (gated) return gated
    if (!UUID_RE.test(params.id)) throw new BadRequestError('Invalid credential id')
    return verifyOrgCredential(session, params.id, request)
  },
  { permission: ORG_PERMISSIONS.modelsManage },
)
