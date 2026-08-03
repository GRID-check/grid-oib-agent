/**
 * INTERNAL service endpoint — resolves a document's SeaweedFS storage key from
 * the `(collectionName, filename)` pair the Python backend carries. Called
 * just-in-time by the backend's `view_knowledge_image` tool (ADR-0039) so it
 * can fetch the raw bytes for a project/Archiv document that lives only in
 * SeaweedFS (never on the backend's disk).
 *
 * Service-to-service only: guarded by `GRID_INTERNAL_API_TOKEN` via
 * `internalApiRoute` (fail-closed when the token is unconfigured). The
 * collection name is the tenancy boundary (`proj_<uuid>` / `archiv_<orgId>` are
 * unguessable), so no per-org FGA applies — mirroring the internal
 * llm-credential and memory endpoints. The backend may additionally send an
 * optional `organizationId` (derived from an `archiv_` collection prefix),
 * which narrows the row lookup to that org when present. Read-only: returns the
 * storage key, not the bytes (the backend fetches those itself from SeaweedFS).
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import { findDocumentStorageKey } from '@/lib/documents/service'

const querySchema = z.object({
  collection: z.string().min(1),
  filename: z.string().min(1),
  organizationId: z.string().min(1).optional(),
})

export const GET = internalApiRoute('document-file', async ({ request }) => {
  const { collection, filename, organizationId } = parseQuery(request, querySchema)
  const document = await findDocumentStorageKey(collection, filename, organizationId)
  if (!document) throw new NotFoundError('Document not found')
  return { storageKey: document.storageKey, contentType: document.contentType }
})
