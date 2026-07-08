/**
 * Documents API — list a project's documents.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listDocuments } from '@/lib/documents/service'

const listDocumentsQuerySchema = z.object({
  projectId: z.string().min(1),
})

export const GET = apiRoute(async ({ session, request }) => {
  const { projectId } = parseQuery(request, listDocumentsQuerySchema)
  return { documents: await listDocuments(session, projectId) }
})
