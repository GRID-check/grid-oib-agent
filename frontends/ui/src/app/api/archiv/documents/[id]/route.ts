/**
 * Archiv document item API — delete an Archiv document (purges MinIO, the RAG
 * chunks, and the DB row). Thin handler; authorization (`org:archiv:manage`)
 * lives in `@/lib/archiv/service`. Feature-gated by the dark-launch
 * `organization-archiv` flag (ADR-0024).
 *
 * Read/preview/download/reingest/tags reuse the shared, scope-aware item routes
 * under `/api/documents/[id]/*` — no per-scope duplication.
 */

import { apiRoute } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { deleteArchivDocument } from '@/lib/archiv/service'

export const DELETE = apiRoute<{ id: string }>(async ({ session, params, request }) => {
  const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
  if (gated) return gated
  await deleteArchivDocument(session, params.id, request)
  return null
})
