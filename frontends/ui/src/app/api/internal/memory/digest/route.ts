import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { buildProjectMemoryDigest, resolveProjectOrganization } from '@/lib/projects/memory-service'

/**
 * INTERNAL service endpoint — the per-turn READ path for the agent's core
 * memory digest. The digest is normally injected as the `x-grid-project-memory`
 * header on the WebSocket upgrade, but that header is frozen for the life of the
 * connection: memory written mid-session (the `remember` tool and the async
 * reflection stage) would not reach the agent until a reconnect. The backend
 * calls this route at the start of each turn to serve the CURRENT digest.
 *
 * Server-authoritative (the client never supplies memory text) and token-guarded
 * exactly like `POST /api/internal/memory`. Tenancy is derived the same way as
 * the WS-scope route: `buildProjectMemoryDigest` pins the project branch to the
 * organization when both are known, so a foreign projectId cannot surface
 * another tenant's memory.
 */

const digestQuerySchema = z
  .object({
    projectId: z.string().optional(),
    organizationId: z.string().optional(),
    /**
     * This turn's question, for relevance-ranked recall. Bounded because it
     * becomes an embedding call; never stored.
     */
    query: z.string().trim().max(2000).optional(),
  })
  // Empty strings behave like absent params (previous `|| undefined` behavior).
  .transform((query) => ({
    projectId: query.projectId || undefined,
    organizationId: query.organizationId || undefined,
    query: query.query || undefined,
  }))
  .refine((query) => !!(query.projectId || query.organizationId), {
    message: 'projectId or organizationId is required',
  })

export const GET = internalApiRoute(
  'Internal Memory Digest',
  async ({ request }) => {
    const { projectId, organizationId, query } = parseQuery(request, digestQuerySchema)

    // The schema accepts a projectId on its own, so the organization is not
    // always known here. It has to be RESOLVED rather than skipped: reading the
    // digest without a tenant meant platform scope — a full RLS bypass — while
    // the query filtered on projectId alone, so any project id returned that
    // project's memory. An internal token is not a licence to read every
    // tenant, and "the project row names the tenant" is only true if something
    // actually goes and asks the project row.
    const tenant = organizationId ?? (projectId ? await withPlatformAccess(
      'resolving the project row that names the tenant for a project-only digest',
      () => resolveProjectOrganization(projectId)
    ) : null)

    // No such project, so no tenant to enter and nothing that could be read.
    // Same shape as an empty digest, which is what the backend already handles.
    if (!tenant) return { digest: null }

    return withTenant({ organizationId: tenant }, async () => {
      // `digest` is null when there is no active memory — a valid empty result,
      // not an error. The backend treats null as "no memory this turn".
      // `query` is this turn's question. With it, recall is relevance-ranked
      // rather than recency-ordered; without it the digest is what it always
      // was. Optional on purpose — a caller that has no question (the WS
      // handshake) must still get a digest.
      const digest = await buildProjectMemoryDigest(projectId, tenant, { query })
      return { digest }
    })
  },
  { tenancy: { fromPayload: '?organizationId, else resolved from the project row' } }
)
