import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import {
  buildProjectMemoryDigest,
  PROJECT_MEMORY_MAX_RESTRICTED_FOLDERS,
  resolveProjectOrganization,
} from '@/lib/projects/memory-service'
import { ANY_MEMBER, clearanceOfMember, readableFolderIdsFor } from '@/lib/authz/folder-access'
import { buildProposalDecisionsBlock, composeMemoryContext } from '@/lib/projects/proposal-decisions'
import { buildReviewDecisionsBlock } from '@/lib/documents/review-decisions'
import { admitSourceFolders } from '@/lib/conversations/restricted-use'

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
    /**
     * The restricted-folder collections this turn may draw on (ADR-0080,
     * ADR-0081), comma-separated: the agent sends them only for an interactive
     * chat turn, the one scope the BFF ever puts them in, and their presence is
     * what makes the turn eligible for restricted memory at all. A restricted
     * note is then served when its asker (`userId`) may read every one of its
     * source folders NOW, and the conversation admits them
     * (`admitSourceFolders`, which needs `conversationId`): a restricted note in
     * the prompt is use of its folders. Absent (deep research, scheduled runs,
     * the handshake): only notes whose folders every member may read now.
     */
    restrictedCollections: z.string().trim().max(5000).optional(),
    /** The turn's asker, as the BFF signed it; the admission checks them with the conversation's audience. */
    userId: z.string().trim().max(128).optional(),
  })
  // Empty strings behave like absent params (previous `|| undefined` behavior).
  .transform((query) => ({
    projectId: query.projectId || undefined,
    organizationId: query.organizationId || undefined,
    query: query.query || undefined,
    conversationId: query.conversationId || undefined,
    userId: query.userId || undefined,
    restrictedCollections: (query.restrictedCollections ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, PROJECT_MEMORY_MAX_RESTRICTED_FOLDERS),
  }))
  .refine((query) => !!(query.projectId || query.organizationId), {
    message: 'projectId or organizationId is required',
  })

export const GET = internalApiRoute(
  'Internal Memory Digest',
  async ({ request }) => {
    const { projectId, organizationId, query, conversationId, userId, restrictedCollections } = parseQuery(
      request,
      digestQuerySchema
    )

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
      // Restricted notes need a conversation to record their use in, and the
      // asker to check with its audience. Without either, a note is served only
      // when every member may read all of its folders now (a loosened folder
      // has opened it), and needs no record.
      const eligible = Boolean(projectId && conversationId && userId && restrictedCollections.length > 0)
      const open = projectId ? new Set(await readableFolderIdsFor(tenant, projectId, ANY_MEMBER)) : new Set<string>()
      const readable =
        projectId && eligible && userId
          ? await readableFolderIdsFor(tenant, projectId, await clearanceOfMember(tenant, userId))
          : [...open]
      let restrictedFoldersServed: string[] = []
      const digest = await buildProjectMemoryDigest(projectId, tenant, {
        query,
        readableFolderIds: readable,
        admitRestricted: async (folderIds) => {
          if (!eligible || !conversationId || !userId) return new Set(folderIds.filter((id) => open.has(id)))
          const admission = await admitSourceFolders(
            { organizationId: tenant, conversationId, userId, projectId: projectId ?? null },
            folderIds
          )
          restrictedFoldersServed = admission.admitted.filter((id) => !open.has(id))
          return new Set(admission.admitted)
        },
      })
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
      // Which restricted folders the served notes drew on: the agent counts them
      // as this turn's use (memory restriction, ADR-0080); ids, opaque to it.
      return { digest: composeMemoryContext(digest, decisions, reviewDecisions), restrictedFoldersServed }
    })
  },
  { tenancy: { fromPayload: '?organizationId, else resolved from the project row' } }
)
