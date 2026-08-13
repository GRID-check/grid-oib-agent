/**
 * Session document item API — delete one chat attachment (purges the RAG
 * chunks, the SeaweedFS objects, and the DB row). Thin handler; authorization
 * (`collaborator` on the owning conversation) lives in
 * `@/lib/session-documents/service`.
 *
 * Read/preview/download/reingest/tags reuse the shared, scope-aware item routes
 * under `/api/documents/[id]/*` — no per-scope duplication, exactly as the
 * Archiv does.
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteSessionDocument } from '@/lib/session-documents/service'

export const DELETE = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    await deleteSessionDocument(session, params.id, request)
    return null
  },
  {
    authz: {
      enforcedBy: 'deleteSessionDocument (requireResourceAccess conversation:collaborator)',
    },
  },
)
