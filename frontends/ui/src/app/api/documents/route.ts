/**
 * Documents API — list a project's documents.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listDocuments } from '@/lib/documents/service'
import { summarizeDocumentVersions } from '@/lib/documents/lifecycle'
import { toDocumentWireRow } from '@/lib/documents/list-projection'
import { DOCUMENT_AUTHORS } from '@/lib/documents/document-authors'

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
    const documents = await listDocuments(session, projectId, { authoredBy })
    // The editorial state rides ALONG with the listing rather than being asked
    // for per card: the badge is on every tile, and the Files workspace re-reads
    // this route on every filter change and settling poll. A listing that
    // carried it once (server render) and not on the re-read would make the
    // badge blink out a second after the page settled.
    const versions = await summarizeDocumentVersions(
      session.organizationId,
      documents.map((row) => row.id),
    )
    // Serialized explicitly rather than left to `JSON.stringify`, because the
    // Files page reads this same listing server-side and hands it across the
    // RSC boundary, which does not stringify a `Date` — see the module header.
    return { documents: documents.map((row) => toDocumentWireRow(row, versions.get(row.id))) }
  },
  { authz: { enforcedBy: 'listDocuments (requireProjectAccess project:view)' } }
)
