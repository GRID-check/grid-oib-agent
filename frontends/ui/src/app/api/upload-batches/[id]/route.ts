/**
 * The summary of one upload (ADR-0085): what arrived, where it was filed, what
 * each file is, what was held back and why. Its uploader's only; anyone else is
 * answered as if it did not exist.
 */

import { apiRoute } from '@/lib/api/handler'
import { getUploadSummary } from '@/lib/upload-batches/service'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getUploadSummary(session, params.id), {
  authz: { enforcedBy: 'getUploadSummary -> findOwnUploadBatch (the uploader only, within the organization)' },
})
