/**
 * Archiv API — document-centric semantic search over the org's shared Archiv.
 * Thin handler; all logic lives in `@/lib/archiv/service`. Feature-gated by the
 * dark-launch `organization-archiv` flag (ADR-0024), same as the Archiv list.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { searchArchivDocuments } from '@/lib/archiv/service'

const searchBodySchema = z.object({
  q: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(100).optional(),
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
    if (gated) return gated
    const { q, topK } = await parseJsonBody(request, searchBodySchema)
    return searchArchivDocuments(session, q, topK)
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only search over the caller's own org Archiv collection; scoped by session.organizationId",
    },
  }
)
