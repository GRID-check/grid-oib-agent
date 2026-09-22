/**
 * Who this document's next version can be sent to for release.
 *
 * The reviewer picker's list, and the one the agent's `submit_draft` resolves a
 * NAME against (`POST /api/internal/document-versions`). Both read
 * `listReviewCandidates`, so „wen kann ich fragen" has one answer whichever side
 * asks it.
 *
 * `project:edit`, not `project:view`, and the difference is the whole point:
 * being able to open a project does not make somebody able to release a
 * Brandschutzkonzept. A picker built on the assignment candidates — which are
 * `project:view` — would offer people whose Freigabe the approve transition then
 * refuses, which reads as a bug at the worst possible moment.
 */

import { apiRoute } from '@/lib/api/handler'
import { getAccessibleDocument } from '@/lib/documents/access'
import { listReviewCandidates } from '@/lib/documents/reviewers'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const document = await getAccessibleDocument(session, params.id, 'read')
    return { candidates: await listReviewCandidates(session, document) }
  },
  {
    authz: {
      enforcedBy:
        'getAccessibleDocument (project:view | org membership | conversation viewer); the list itself is filtered to project:edit holders',
    },
  },
)
