/**
 * Release a quarantined document for indexing (ADR-0085). Re-dispatches it with
 * screening skipped for exactly the bytes the reviewer saw, and audits who did.
 * Deleting instead is the shelf's ordinary delete.
 */

import { apiRoute } from '@/lib/api/handler'
import { releaseQuarantinedDocument } from '@/lib/upload-screening/review'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => releaseQuarantinedDocument(session, params.id, request),
  {
    authz: {
      enforcedBy:
        'releaseQuarantinedDocument -> mayReviewQuarantine (org:projects:administer | project:manage on the project | org:archiv:manage for the Büroablage)',
    },
  }
)
