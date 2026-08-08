/**
 * Internal reasoning-effort pull — the channel the Python backend resolves the
 * platform owner's thinking levels through (`aiq_agent.common.reasoning_settings`,
 * TTL-cached and fail-open there). Token-guarded like
 * `/api/internal/retrieval-settings`; the payload is global, never org-scoped
 * (reasoning spend is a platform decision, not a tenant one).
 */

import { internalApiRoute } from '@/lib/api/handler'
import { getPlatformReasoningEfforts } from '@/lib/reasoning-settings/service'

export const GET = internalApiRoute(
  'reasoning-efforts',
  async () => {
    return { efforts: await getPlatformReasoningEfforts() }
  },
  {
    tenancy: {
      crossTenant: 'reasoning effort is platform-wide configuration, identical for every tenant',
    },
  }
)
