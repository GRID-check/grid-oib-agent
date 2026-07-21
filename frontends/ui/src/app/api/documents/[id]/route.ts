/**
 * Project document item API — delete a project document (purges the RAG chunks,
 * the SeaweedFS object, and the DB row). Thin handler; authorization
 * (`project:edit` FGA on the owning project) and all logic live in
 * `@/lib/documents/service`.
 *
 * The sibling item routes (download/preview/status/reingest/tags) live in
 * subroutes under this `[id]` folder and are scope-aware; org-wide Archiv
 * documents are deleted through `/api/archiv/documents/[id]` instead.
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteDocument } from '@/lib/documents/service'

export const DELETE = apiRoute<{ id: string }>(async ({ session, params, request }) => {
  await deleteDocument(session, params.id, request)
  return null
})
