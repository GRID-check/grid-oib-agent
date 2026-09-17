/**
 * Hand a version to a reviewer.
 *
 * `reviewerUserIds` is optional and empty falls back to whoever is already on
 * the hook for the file (`resource_assignments`). Both being empty is a 422, not
 * a silent success: „Unvergeben" plus nobody named is genuinely nobody, and a
 * submission that reached no inbox would look identical to one that did.
 *
 * `orderMessage` is the Auftragssatz in one sentence (non-empty ≤500 when
 * present) and `dueAt` the optional Frist as an ISO date string. Both are
 * validated by `submitRequestSchema` and carried into the review round's inbox
 * payload (`orderMessage`, `dueAt`, `previousVersionId`) and the audit event —
 * the request record anchored on this version, not the version row.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { toDocumentVersionView, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { submitRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { reviewerUserIds, orderMessage, dueAt } = await parseJsonBody(
      request,
      submitRequestSchema,
    )
    const version = await transitionDocumentVersion(session, params.id, params.versionId, 'submit', {
      reviewerUserIds,
      orderMessage,
      dueAt,
      request,
    })
    return { version: toDocumentVersionView(version) }
  },
  { authz: { enforcedBy: 'transitionDocumentVersion(submit) -> getAccessibleDocument + requireProjectAccess (project:edit | project:documents:write)' } }
)
