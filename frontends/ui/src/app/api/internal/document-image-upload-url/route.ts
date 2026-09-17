/**
 * INTERNAL service endpoint — issues one presigned PUT slot for a raster the
 * ingest pipeline cut out of a document, so the backend (which holds only a
 * read credential for SeaweedFS) can store it beside the file as
 * `<doc dir>/_img/<index>.jpg`. Called by the pipeline once per extracted
 * image; the read side is `GET /api/internal/document-file?imageIndex=`, and
 * the delete side is the `_img/` sweep in `lib/documents/object-cleanup.ts`.
 *
 * Service-to-service only: `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`,
 * fail-closed when unconfigured. The row is addressed by the `documentId` the
 * dispatch sent AND the collection it was sent for — both unguessable, and
 * requiring both means one document's id cannot mint objects under it from
 * another shelf's ingest. The backend sends an `organizationId` only for an
 * Archiv collection (derived from its `archiv_<orgId>` prefix), which narrows
 * the lookup to that tenant; for `proj_<uuid>` it has none, exactly as on the
 * read route. The key is built from the row's own storage key
 * (`buildImageStorageKey`), so the only free variable is a bounded integer:
 * `MAX_STORED_IMAGES_PER_DOCUMENT` is enforced here, as a 404 the backend
 * treats as "stop asking".
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withOptionalTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { presignDocumentImageUpload } from '@/lib/documents/service'

const bodySchema = z.object({
  documentId: z.string().uuid(),
  collection: z.string().min(1),
  imageIndex: z.number().int().min(0),
  organizationId: z.string().min(1).optional(),
})

export const POST = internalApiRoute(
  'document-image-upload-url',
  async ({ request }) => {
    const { documentId, collection, imageIndex, organizationId } = await parseJsonBody(request, bodySchema)
    return withOptionalTenant(
      organizationId,
      'document addressed by unguessable id and collection name, with no organization supplied',
      async () => {
        const slot = await presignDocumentImageUpload(documentId, collection, imageIndex, organizationId)
        if (!slot) throw new NotFoundError('Document not found, or image index past the per-document ceiling')
        return slot
      }
    )
  },
  { tenancy: { fromPayload: 'body.organizationId when the collection is an Archiv' } }
)
