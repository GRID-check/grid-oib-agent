/**
 * Internal BYOK credential resolution (ADR-0022) — the single decryption
 * point for tenant LLM keys.
 *
 * Called just-in-time by the Python backend (chat rebuilds and Dask workers)
 * with the org id it already carries; guarded by `GRID_INTERNAL_API_TOKEN`.
 * Returns `{ credential: null }` when the org runs on the platform key (no
 * active credential, or the `byok-llm` flag is off under enforcement).
 *
 * The response contains the PLAINTEXT key: it must never be cached in the
 * shared cache, logged, or proxied beyond the internal network. The backend
 * holds it in process memory for at most its 60 s TTL.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { resolveActiveCredentialForBackend } from '@/lib/llm-credentials/service'

const querySchema = z.object({
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/, 'not a WorkOS organization id'),
})

export const GET = internalApiRoute(
  'llm-credential',
  async ({ request }) => {
    const { organizationId } = parseQuery(request, querySchema)
    // The org's own encrypted credential row and nothing else: row-level
    // security now backs the service's scoping rather than trusting it alone.
    return withTenant({ organizationId }, async () => ({
      credential: await resolveActiveCredentialForBackend(organizationId),
    }))
  },
  { tenancy: { fromPayload: '?organizationId' } }
)
