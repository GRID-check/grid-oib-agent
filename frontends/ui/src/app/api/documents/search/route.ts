/**
 * Documents API — document-centric semantic search over a project's corpus.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { searchProjectDocuments } from '@/lib/documents/service'

const searchBodySchema = z.object({
  projectId: z.string().min(1),
  q: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(100).optional(),
})

export const POST = apiRoute(async ({ session, request }) => {
  const { projectId, q, topK } = await parseJsonBody(request, searchBodySchema)
  return searchProjectDocuments(session, projectId, q, topK)
})
