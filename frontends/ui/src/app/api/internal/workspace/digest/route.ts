/**
 * INTERNAL service endpoint — the per-turn READ path for a Büro turn's context
 * (ADR-0054, spec PR-10, PR-11, PR-16).
 *
 * The office turn needs two things at its start: the organization's memory
 * digest, and the Steckbriefe of the projects this question is about. They are
 * served in ONE round trip because they are read at the same instant by the
 * same caller, and a second hop would put another timeout on the critical path
 * for no independent failure mode.
 *
 * Token-guarded and shaped exactly like `GET /api/internal/memory/digest`,
 * which serves the project half of the same seam. Cross-tenant like it: the
 * caller names the organization, and this route enters that organization's
 * scope before reading anything.
 *
 * ## Readability needs a MEMBERSHIP, not a user
 *
 * `checkResourcePermission` keys on `organizationMembershipId`, so that is
 * what the signed request envelope carries and what this route requires. With
 * no membership the projects half is EMPTY and the digest is still served: an
 * unattributable caller must not be shown a project list, and "we could not
 * tell" is a denial for the register (spec PR-16) rather than a reason to fail
 * the whole turn.
 *
 * ## Unknown organization
 *
 * `{ digest: null, projects: [] }`. The same shape as an empty office, which
 * the backend already handles, rather than a 404 that would turn a
 * misconfigured deployment into a broken turn.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { buildProjectMemoryDigest, organizationExists } from '@/lib/projects/memory-service'
import {
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  recallSteckbriefe,
  type SteckbriefHit,
} from '@/lib/workspace/register-service'

const digestQuerySchema = z
  .object({
    organizationId: z.string(),
    /**
     * The WorkOS organization membership id the readable-project filter runs
     * against. Optional because a caller may legitimately have none (an
     * anonymous single-tenant deployment); the projects half is then empty.
     */
    membershipId: z.string().optional(),
    /**
     * This turn's question, for relevance-ranked recall. Bounded because it
     * becomes an embedding call; never stored.
     */
    q: z.string().trim().max(2000).optional(),
    limit: z.coerce.number().int().optional(),
  })
  // Empty strings behave like absent params, matching the memory digest route.
  .transform((query) => ({
    organizationId: query.organizationId.trim(),
    membershipId: query.membershipId || undefined,
    q: query.q || undefined,
    limit: Math.min(Math.max(query.limit ?? RECALL_DEFAULT_LIMIT, 1), RECALL_MAX_LIMIT),
  }))
  .refine((query) => query.organizationId.length > 0, {
    message: 'organizationId is required',
  })

export const GET = internalApiRoute(
  'Internal Workspace Digest',
  async ({ request }): Promise<{ digest: string | null; projects: SteckbriefHit[] }> => {
    const { organizationId, membershipId, q, limit } = parseQuery(request, digestQuerySchema)

    return withTenant({ organizationId }, async () => {
      // An organization this deployment has never heard of gets the empty
      // shape rather than a 404: the backend already handles "no memory, no
      // projects", and a misconfigured org id should degrade the answer, not
      // break the turn. Asked INSIDE the tenant scope, because the question is
      // itself a tenant read (there is no organizations table — "known" means
      // "owns at least one project", see `organizationExists`).
      if (!(await organizationExists(organizationId))) return { digest: null, projects: [] }

      // The office half. `undefined` for the project id is what makes this the
      // ORGANIZATION digest — the same call the memory digest route makes for a
      // project-less caller, so the Büro and the project chat read organization
      // memory through one implementation.
      const digest = await buildProjectMemoryDigest(undefined, organizationId, { query: q })

      // The register half. Fails to an EMPTY list rather than to an error: a
      // slow or unavailable register degrades the answer, never the turn
      // (spec PR-11 — the backend also fails open, this is the near side of
      // the same contract).
      const projects = await recallSteckbriefe(
        { organizationId, organizationMembershipId: membershipId ?? null },
        q ?? null,
        limit
      ).catch((error) => {
        console.warn('[workspace digest] register recall failed (non-fatal):', error)
        return [] as SteckbriefHit[]
      })

      return { digest, projects }
    })
  },
  { tenancy: { fromPayload: '?organizationId' } }
)
