/**
 * Archiv upload API — store a file in the org-wide Archiv and hand it to the
 * backend for ingestion into the shared `archiv_<orgId>` collection. Thin
 * handler; all logic (incl. `org:archiv:manage` authorization) lives in
 * `@/lib/archiv/service`. Feature-gated by the dark-launch `organization-archiv`
 * flag (ADR-0024).
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { requireOrgArchivEnabled } from '@/lib/authz/feature-flags'
import { uploadArchivDocument } from '@/lib/archiv/service'

export const POST = apiRoute(async ({ session, request }) => {
  const gated = requireOrgArchivEnabled(session)
  if (gated) return gated

  const formData = await request.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) {
    throw new BadRequestError('file is required')
  }

  return uploadArchivDocument(session, file, request)
})
