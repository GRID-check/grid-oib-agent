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
 * storage key AND its bucket, not the bytes (the backend fetches those itself
 * from SeaweedFS).
 *
 * With `imageIndex`, the key returned is that of the `_img/<index>.jpg` raster
 * the ingest pipeline stored beside the document, built from the row's own
 * storage key (`buildImageStorageKey`). The backend never names a derived key
 * itself: the only thing it can vary is a bounded integer, so a derived read
 * can only ever land under the owning document's prefix.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withOptionalTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { findDocumentImageStorageKey, findDocumentStorageKey } from '@/lib/documents/service'

const querySchema = z.object({
  collection: z.string().min(1),
  filename: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  imageIndex: z.coerce.number().int().min(0).optional(),
})

export const GET = internalApiRoute(
  'document-file',
  async ({ request }) => {
    const { collection, filename, organizationId, imageIndex } = parseQuery(request, querySchema)
    // The backend derives an organization only from an `archiv_<orgId>`
    // collection; for `proj_<uuid>` it has none to send, and the unguessable
    // collection name is the boundary the route has always relied on.
    return withOptionalTenant(
      organizationId,
      'document addressed by unguessable collection name, with no organization supplied',
      async () => {
        if (imageIndex !== undefined) {
          const image = await findDocumentImageStorageKey(collection, filename, imageIndex, organizationId)
          if (!image) throw new NotFoundError('Document image not found')
          return { storageKey: image.storageKey, storageBucket: image.storageBucket, contentType: image.contentType }
        }
        const document = await findDocumentStorageKey(collection, filename, organizationId)
        if (!document) throw new NotFoundError('Document not found')
        return {
          storageKey: document.storageKey,
          // The bucket, not just the key (ADR-0043). Per-organization buckets
          // mean the key alone no longer locates an object, and the agent tier
          // calls get_object directly rather than through a presigned URL — so
          // it must be TOLD where the object is. Deriving it there would put a
          // second implementation of the naming rule in a third language, in
          // the one place a mismatch surfaces as a silent 404 rather than an
          // error. NULL means the shared bucket, exactly as the column does.
          storageBucket: document.storageBucket,
          contentType: document.contentType,
        }
      }
    )
  },
  { tenancy: { fromPayload: '?organizationId when the collection is an Archiv' } }
)
