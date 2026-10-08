/**
 * Ask for a quarantined document to be released (ADR-0086, „Freigabe
 * anfragen"). The uploader's half of the quarantine: it notifies the people who
 * may release the file through the inbox and changes nothing about the file.
 */

import { apiRoute } from '@/lib/api/handler'
import { requestQuarantineRelease } from '@/lib/upload-screening/review'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => requestQuarantineRelease(session, params.id),
  {
    authz: {
      enforcedBy:
        'requestQuarantineRelease -> getAccessibleDocument (the shelf rule; a quarantined file only for its uploader or a reviewer) and createdBy = the session',
    },
  }
)
