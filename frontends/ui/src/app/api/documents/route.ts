/**
 * Documents API — list a project's documents.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listDocuments } from '@/lib/documents/service'
import { DOCUMENT_AUTHORS } from '@/lib/db/schema'

const listDocumentsQuerySchema = z.object({
  projectId: z.string().min(1),
  /**
   * Narrow the listing to what one kind of author wrote — the parameter behind
   * the „Von Piloti" filter chip.
   *
   * Validated against `DOCUMENT_AUTHORS` rather than accepted as a free string,
   * so a value the column cannot hold is a 400 here instead of a silently empty
   * result the caller reads as "Piloti has written nothing". The enum widens
   * with the tuple, which is the point of the tuple.
   */
  authoredBy: z.enum(DOCUMENT_AUTHORS).optional(),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const { projectId, authoredBy } = parseQuery(request, listDocumentsQuerySchema)
    return { documents: await listDocuments(session, projectId, { authoredBy }) }
  },
  { authz: { enforcedBy: 'listDocuments (requireProjectAccess project:view)' } }
)
