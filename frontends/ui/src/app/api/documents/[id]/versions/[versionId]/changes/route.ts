/**
 * Änderungen anfordern — a refusal that expects another version.
 *
 * The comment is REQUIRED, by a CHECK on the row as well as by the schema here:
 * it is quoted to the next turn and to the revision task, and a refusal with
 * nothing in it is a decision the next attempt cannot act on (ADR-0051's
 * `review_reason`, one level down).
 *
 * `delegateRevision` is the reviewer's THIRD action and not a third route.
 * „Änderungen anfordern" leaves the work with whoever wrote it; „Piloti
 * überarbeiten lassen" additionally opens a `revision` task. The version makes
 * the same move either way — `changes_requested`, comment on the row, review
 * inbox resolved — so a second op would have been a row of the transition table
 * identical to this one in every column that decides anything. What the flag
 * changes is one effect's condition, and the effect explains it
 * (`openRevisionTask`).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { toDocumentVersionView, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { refuseRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { comment, delegateRevision } = await parseJsonBody(request, refuseRequestSchema)
    const version = await transitionDocumentVersion(
      session,
      params.id,
      params.versionId,
      'request_changes',
      { comment, delegateRevision, request }
    )
    return { version: toDocumentVersionView(version) }
  },
  { authz: { enforcedBy: 'transitionDocumentVersion(request_changes) -> getAccessibleDocument + requireProjectAccess (project:edit | project:documents:write)' } }
)
