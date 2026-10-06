/**
 * Documents API — the project documents with these filenames, as listing rows.
 *
 * The by-name resolve (`lib/documents/by-name-client.ts` is its client,
 * `by-name-types.ts` its contract): for a reader that wants particular
 * documents — a citation, a surfaced-documents card — rather than the corpus.
 * POST because the names are free text and a batch of them outgrows a query
 * string. Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { resolveProjectDocumentsByName } from '@/lib/documents/service'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { projectByNameRequestSchema } from '@/lib/documents/by-name-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { projectId, names } = await parseJsonBody(request, projectByNameRequestSchema)
    const documents = await resolveProjectDocumentsByName(session, projectId, names)
    // The same row the listing serves, version summary included, so a
    // resolved document and a listed one cannot render differently.
    return { documents: await toDocumentWireRows(session.organizationId, documents) }
  },
  { authz: { enforcedBy: 'resolveProjectDocumentsByName (requireProjectAccess project:view)' } }
)
