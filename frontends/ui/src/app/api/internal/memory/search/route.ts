import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import {
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  searchProjectMemory,
  type MemorySearchResult,
} from '@/lib/projects/memory-service'

/**
 * INTERNAL service endpoint — the READ path the memory store never had
 * (ADR-0055): the `search_memory` tool's half of the seam.
 *
 * The digest is a working set. It carries at most twenty notes chosen for this
 * turn's question, and a project with two hundred findings therefore has a
 * hundred and eighty that no question could reach — the digest's own text told
 * the model how many it dropped and offered no way to ask for them. This is
 * that way: a bounded, question-driven read over the SAME candidates, the SAME
 * scope rule and the SAME hybrid ranking the digest uses
 * (`lib/projects/memory-repository.ts` owns both statements), so "ask for one
 * of the omitted notes" resolves against the same store the digest was
 * describing rather than against a second opinion about relevance.
 *
 * Server-authoritative and token-guarded exactly like the digest route beside
 * it, and tenancy is stated the same way: the caller names the organization and
 * this route enters that organization's scope before reading anything. Unlike
 * the digest route it does not have to resolve the tenant from a project row,
 * because `organizationId` is required — a recall tool with an optional tenant
 * would be a recall tool that can be asked to read without one.
 *
 * ## The scope rule
 *
 * With `projectId`: that project's notes plus the organization's. Without one:
 * organization-scoped notes ONLY. Never another project's, in either
 * direction. The condition is `memoryScopeCondition`, shared with the digest,
 * and the project branch is additionally pinned to the organization — so a
 * project id belonging to another tenant matches nothing rather than matching
 * its own row. `route.spec.ts` asserts all three cases.
 *
 * ## Unknown organization
 *
 * `{ items: [], total: 0, returned: 0 }`, not a 404. It falls out of the scope
 * condition rather than being special-cased: an organization nothing has ever
 * written notes for is indistinguishable from one with no notes, and a
 * misconfigured org id should degrade the answer rather than break the turn.
 */

const searchQuerySchema = z
  .object({
    organizationId: z.string(),
    projectId: z.string().optional(),
    /**
     * The question. Bounded because it becomes an embedding call; never stored.
     * Empty is a 400 rather than "return everything": an unbounded read wearing
     * a search's clothes is how a cap gets bypassed by accident.
     */
    q: z.string().trim().max(2000),
    limit: z.coerce.number().int().optional(),
  })
  // Empty strings behave like absent params, matching the digest routes.
  .transform((query) => ({
    organizationId: query.organizationId.trim(),
    projectId: query.projectId || undefined,
    q: query.q,
    limit: Math.min(
      Math.max(query.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT, 1),
      MEMORY_SEARCH_MAX_LIMIT
    ),
  }))
  .refine((query) => query.organizationId.length > 0, {
    message: 'organizationId is required',
  })
  .refine((query) => query.q.length > 0, { message: 'q is required and must not be empty' })

export const GET = internalApiRoute(
  'Internal Memory Search',
  async ({ request }): Promise<MemorySearchResult> => {
    const { organizationId, projectId, q, limit } = parseQuery(request, searchQuerySchema)

    return withTenant({ organizationId }, () =>
      searchProjectMemory({ organizationId, projectId, query: q, limit })
    )
  },
  { tenancy: { fromPayload: '?organizationId' } }
)
