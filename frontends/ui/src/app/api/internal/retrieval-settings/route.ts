/**
 * Internal retrieval-settings pull — the channel the Python backend resolves
 * the platform owner's retrieval counts through
 * (`aiq_agent.common.retrieval_settings`, TTL-cached and fail-open there).
 * Token-guarded like `/api/internal/model-overrides`; the payload is global,
 * never org-scoped (retrieval depth is a platform decision, not a tenant one).
 */

import { internalApiRoute } from '@/lib/api/handler'
import { getPlatformRetrievalSettings } from '@/lib/retrieval-settings/service'

export const GET = internalApiRoute('retrieval-settings', async () => {
  return { settings: await getPlatformRetrievalSettings() }
})
