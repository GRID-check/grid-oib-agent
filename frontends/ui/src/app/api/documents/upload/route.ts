/**
 * Document upload API — store a file and hand it to the backend for
 * ingestion. Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { uploadDocument } from '@/lib/documents/service'

export const POST = apiRoute(async ({ session, request }) => {
  const formData = await request.formData()
  const projectId = formData.get('projectId')
  const folderId = formData.get('folderId')
  const file = formData.get('file')

  if (typeof projectId !== 'string' || !projectId || !(file instanceof File)) {
    throw new BadRequestError('projectId and file are required')
  }

  return uploadDocument(
    session,
    { projectId, folderId: typeof folderId === 'string' && folderId ? folderId : null, file },
    request,
  )
})
