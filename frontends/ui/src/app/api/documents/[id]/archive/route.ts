/**
 * Archivieren — the item leaves the working set.
 *
 * Item-level, not a version state: „archiviert" is a statement about the FILE,
 * and putting it on a version would leave it ambiguous which version was
 * archived. The bytes and every version stay — this is not a delete, and there
 * is no soft delete on this table.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { archiveDocument } from '@/lib/documents/lifecycle'
import { archiveRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    await parseJsonBody(request, archiveRequestSchema)
    return archiveDocument(session, params.id, request)
  },
  { authz: { enforcedBy: 'archiveDocument -> getAccessibleDocument + requireProjectAccess (project:documents:write | project:edit)' } }
)
