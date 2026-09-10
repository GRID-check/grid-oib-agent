/**
 * Änderungen anfordern — a refusal that expects another version.
 *
 * The comment is REQUIRED, by a CHECK on the row as well as by the schema here:
 * it is quoted to the next turn and to the revision task, and a refusal with
 * nothing in it is a decision the next attempt cannot act on (ADR-0051's
 * `review_reason`, one level down).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { toDocumentVersionView, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { refuseRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { comment } = await parseJsonBody(request, refuseRequestSchema)
    const version = await transitionDocumentVersion(
      session,
      params.id,
      params.versionId,
      'request_changes',
      { comment, request }
    )
    return { version: toDocumentVersionView(version) }
  },
  { authz: { enforcedBy: 'transitionDocumentVersion(request_changes) -> getAccessibleDocument + requireProjectAccess (project:edit | project:documents:write)' } }
)
