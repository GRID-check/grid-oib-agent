/**
 * Document upload API — store a file and hand it to the backend for
 * ingestion. Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute, parseFormData } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { uploadDocument } from '@/lib/documents/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const formData = await parseFormData(request)
    const projectId = formData.get('projectId')
    const folderId = formData.get('folderId')
    const file = formData.get('file')
    // Where the file sat before it was uploaded, when the browser knows. Only a
    // folder upload sends it; the service sanitizes and bounds it.
    const originPath = formData.get('originPath')

    if (typeof projectId !== 'string' || !projectId || !(file instanceof File)) {
      throw new BadRequestError('projectId and file are required')
    }

    return uploadDocument(
      session,
      {
        projectId,
        folderId: typeof folderId === 'string' && folderId ? folderId : null,
        file,
        originPath: typeof originPath === 'string' ? originPath : null,
      },
      request
    )
  },
  { authz: { enforcedBy: 'uploadDocument (requireProjectAccess project:documents:write)' } }
)
