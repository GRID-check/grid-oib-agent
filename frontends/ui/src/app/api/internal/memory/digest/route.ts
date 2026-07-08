import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'

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
  })
  // Empty strings behave like absent params (previous `|| undefined` behavior).
  .transform((query) => ({
    projectId: query.projectId || undefined,
    organizationId: query.organizationId || undefined,
  }))
  .refine((query) => !!(query.projectId || query.organizationId), {
    message: 'projectId or organizationId is required',
  })

export const GET = internalApiRoute('Internal Memory Digest', async ({ request }) => {
  const { projectId, organizationId } = parseQuery(request, digestQuerySchema)

  // `digest` is null when there is no active memory — a valid empty result,
  // not an error. The backend treats null as "no memory this turn".
  const digest = await buildProjectMemoryDigest(projectId, organizationId)
  return { digest }
})
