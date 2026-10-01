/**
 * Archiv upload API — store a file in the org-wide Archiv and hand it to the
 * backend for ingestion into the shared `archiv_<orgId>` collection. Thin
 * handler; all logic (incl. `org:archiv:manage` authorization) lives in
 * `@/lib/archiv/service`. Feature-gated by the dark-launch `organization-archiv`
 * flag (ADR-0024).
 */

import { apiRoute, parseFormData } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { uploadArchivDocument } from '@/lib/archiv/service'
import { DOCUMENT_UPLOAD_LIMIT } from '@/lib/limits'
import { readScreeningRelease } from '@/lib/upload-screening/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
    if (gated) return gated

    const formData = await parseFormData(request)
    const file = formData.get('file')
    if (!(file instanceof File)) {
      throw new BadRequestError('file is required')
    }

    const originPath = formData.get('originPath')
    return uploadArchivDocument(session, file, request, {
      screeningRelease: readScreeningRelease(formData.get('screeningRelease')),
      originPath: typeof originPath === 'string' ? originPath.slice(0, 1024) : null,
    })
  },
  { authz: { enforcedBy: 'uploadArchivDocument (canManageArchiv)' }, limits: { rule: DOCUMENT_UPLOAD_LIMIT } }
)
