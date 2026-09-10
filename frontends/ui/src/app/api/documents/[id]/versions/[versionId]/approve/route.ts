/**
 * Freigeben — the office asserting the content of this version.
 *
 * `actor: 'human'` in the transition table, so the agent's internal route
 * cannot reach it: the whole point of the publish door is that a machine may
 * write and submit and may never approve. The submitter cannot approve their
 * own version either — an assertion nobody but the author has read is not one.
 *
 * Distinct from publish on purpose: approving a Befund on Tuesday and issuing it
 * with the Einreichung on Friday are two acts.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { toDocumentVersionView, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { approveRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { comment } = await parseJsonBody(request, approveRequestSchema)
    const version = await transitionDocumentVersion(session, params.id, params.versionId, 'approve', {
      comment,
      request,
    })
    return { version: toDocumentVersionView(version) }
  },
  { authz: { enforcedBy: 'transitionDocumentVersion(approve) -> getAccessibleDocument + requireProjectAccess (project:edit | project:documents:write)' } }
)
