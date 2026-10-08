/**
 * Seal an upload (ADR-0085): the browser has sent its last file. `unchanged`
 * and `failed` are the files that, for those reasons, wrote no row.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { sealOwnUploadBatch, UPLOAD_BATCH_MAX_FILES } from '@/lib/upload-batches/service'

type Params = { id: string }

const bodySchema = z
  .object({
    unchanged: z.number().int().min(0).max(UPLOAD_BATCH_MAX_FILES),
    failed: z.number().int().min(0).max(UPLOAD_BATCH_MAX_FILES),
  })
  .strict()

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const counts = await parseJsonBody(request, bodySchema)
    await sealOwnUploadBatch(session, params.id, counts)
    return { id: params.id }
  },
  { authz: { enforcedBy: 'sealOwnUploadBatch -> findOwnUploadBatch (the uploader only)' } }
)
