/**
 * Ablehnen — a refusal that expects nothing further of this version.
 *
 * The reason is required for the same reason `changes` needs one, and the two
 * are separate verbs rather than one with a flag because they say different
 * things to whoever wrote it: come back with a revision, or do not.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { toDocumentVersionView, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { refuseRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { comment } = await parseJsonBody(request, refuseRequestSchema)
    const version = await transitionDocumentVersion(session, params.id, params.versionId, 'reject', {
      comment,
      request,
    })
    return { version: toDocumentVersionView(version) }
  },
  { authz: { enforcedBy: 'transitionDocumentVersion(reject) -> getAccessibleDocument + requireProjectAccess (project:edit | project:documents:write)' } }
)
