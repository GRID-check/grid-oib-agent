/**
 * Archiv API — list the organization's Archiv documents, one keyset page at a
 * time (`?cursor=` from the previous page's `nextCursor`), with the same filters
 * and the same rows as a project's `GET /api/documents`: `?includeArchived=true`
 * and `?authoredBy=agent|user` (`@/lib/documents/list-query`), each row through
 * `toDocumentWireRows` — folder, origin path, author, lifecycle and version
 * state included (ADR-0078).
 * Thin handler; all logic lives in `@/lib/archiv/service`. Feature-gated by the
 * dark-launch `organization-archiv` flag (ADR-0024).
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireArchivFeature } from '@/lib/archiv/feature-gate'
import { listArchiv } from '@/lib/archiv/service'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { documentListFilterSchema, documentListOptions } from '@/lib/documents/list-query'

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireArchivFeature(session)
    if (gated) return gated
    const filter = parseQuery(request, documentListFilterSchema)
    const { documents, ...page } = await listArchiv(session, documentListOptions(filter))
    return { ...page, documents: await toDocumentWireRows(session.organizationId, documents) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'the Archiv is org-wide shared knowledge; listArchiv scopes to session.organizationId and reports canManage for the UI',
    },
  }
)
