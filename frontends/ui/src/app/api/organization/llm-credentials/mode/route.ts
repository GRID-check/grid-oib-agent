/**
 * LLM provider mode (ADR-0022) — the org owner's explicit choice between
 * the platform service and their own key, WITHOUT deleting the stored
 * credential.
 *
 * PUT { mode: 'byok' | 'platform' } — takes effect on new conversations
 * within the backend's resolution-cache TTL (≤ 60 s). Audited.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { setLlmProviderMode } from '@/lib/llm-credentials/service'

const putSchema = z.object({
  mode: z.enum(['byok', 'platform']),
})

export const PUT = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.byokLlm)
    if (gated) return gated
    const { mode } = await parseJsonBody(request, putSchema)
    return { mode: await setLlmProviderMode(session, mode, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)
