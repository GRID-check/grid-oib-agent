/**
 * Internal model-override resolution (ADR-0014).
 *
 * Called just-in-time by the Python backend for invocations whose request
 * context carries no `x-grid-model-overrides` header — endpoints the BFF does
 * not front (direct HTTP), or turns where the best-effort WebSocket-scope
 * injection failed. Guarded by `GRID_INTERNAL_API_TOKEN`, same as the BYOK
 * credential route.
 *
 * Returns `{ overrides: null }` when the org runs on workflow defaults.
 * `zdrOnly` reports the org's Zero-Data-Retention policy so the backend can add
 * `provider.zdr` to its OpenRouter requests. Both reuse write-invalidated
 * caches, so a config save/toggle is visible on the next backend fetch.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { getActiveModelOverrides } from '@/lib/model-config/service'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'

const querySchema = z.object({
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/, 'not a WorkOS organization id'),
})

export const GET = internalApiRoute('model-overrides', async ({ request }) => {
  const { organizationId } = parseQuery(request, querySchema)
  const [overrides, zdrOnly] = await Promise.all([
    getActiveModelOverrides(organizationId),
    isZdrOnlyForOrg(organizationId),
  ])
  return { overrides, zdrOnly }
})
