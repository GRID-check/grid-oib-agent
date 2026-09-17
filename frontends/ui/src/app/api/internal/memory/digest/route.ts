import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { buildProjectMemoryDigest, resolveProjectOrganization } from '@/lib/projects/memory-service'
import { buildProposalDecisionsBlock, composeMemoryContext } from '@/lib/projects/proposal-decisions'
import { buildReviewDecisionsBlock } from '@/lib/documents/review-decisions'

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
    /**
     * The turn's conversation, for the `REVIEW_DECISIONS v1` block. Optional:
     * a caller with none (the WS handshake, a background run) gets the digest
     * and the proposal decisions exactly as before.
     *
     * It is not an authorization input — nothing below reads a row this id
     * names without also pinning the organization — so an unknown id is an
     * empty block rather than a refusal, which is what a conversation that has
     * filed nothing looks like anyway.
     */
    conversationId: z.string().trim().max(200).optional(),
  })
  // Empty strings behave like absent params (previous `|| undefined` behavior).
  .transform((query) => ({
    projectId: query.projectId || undefined,
    organizationId: query.organizationId || undefined,
    query: query.query || undefined,
    conversationId: query.conversationId || undefined,
  }))
  .refine((query) => !!(query.projectId || query.organizationId), {
    message: 'projectId or organizationId is required',
  })

export const GET = internalApiRoute(
  'Internal Memory Digest',
  async ({ request }) => {
    const { projectId, organizationId, query, conversationId } = parseQuery(request, digestQuerySchema)

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
      // The decisions the project made about the agent's own proposals ride
      // the same channel, so a declined patch is not proposed again. Best
      // effort: a failure here must not cost the turn its memory.
      const decisions = projectId
        ? await buildProposalDecisionsBlock(projectId, tenant).catch(() => null)
        : null
      // What a reviewer decided about the drafts THIS conversation filed. Same
      // channel, same failure posture: a scan that breaks costs the block, never
      // the turn's memory.
      const reviewDecisions = conversationId
        ? await buildReviewDecisionsBlock(conversationId, tenant).catch(() => null)
        : null
      return { digest: composeMemoryContext(digest, decisions, reviewDecisions) }
    })
  },
  { tenancy: { fromPayload: '?organizationId, else resolved from the project row' } }
)
