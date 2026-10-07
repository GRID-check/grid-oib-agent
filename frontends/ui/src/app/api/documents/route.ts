/**
 * Documents API — list a project's documents, one keyset page at a time
 * (`?cursor=` from the previous page's `nextCursor`, `null` on the last page).
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listDocumentsPage } from '@/lib/documents/service'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { documentListFilterSchema, documentListOptions } from '@/lib/documents/list-query'

const listDocumentsQuerySchema = documentListFilterSchema.extend({ projectId: z.string().min(1) })

export const GET = apiRoute(
  async ({ session, request }) => {
    const { projectId, ...filter } = parseQuery(request, listDocumentsQuerySchema)
    const { documents, nextCursor } = await listDocumentsPage(session, projectId, documentListOptions(filter))
    return { documents: await toDocumentWireRows(session.organizationId, documents), nextCursor }
  },
  { authz: { enforcedBy: 'listDocumentsPage (requireProjectAccess project:view)' } }
)
