/**
 * INTERNAL service endpoint — one presigned PUT for a base-corpus PDF
 * (ADR-0082). The backend holds only a read credential for SeaweedFS, so when
 * an admin uploads a norm it asks here for the slot and PUTs the bytes itself,
 * the way it stores a raster (`document-image-upload-url`). The object lands in
 * the platform bucket at `base-corpus/<fileName>`; the delete side is
 * `DELETE /api/internal/base-corpus/[fileName]`.
 *
 * Service-to-service only: `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`,
 * fail-closed when unconfigured. 400 for a name that is not a plain `.pdf`
 * basename.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { presignBaseCorpusUpload } from '@/lib/knowledge/base-corpus-storage'

const bodySchema = z.object({ fileName: z.string() })

export const POST = internalApiRoute(
  'base-corpus-upload-url',
  async ({ request }) => {
    const { fileName } = await parseJsonBody(request, bodySchema)
    return presignBaseCorpusUpload(fileName)
  },
  { tenancy: { crossTenant: 'the platform base corpus — reads no tenant rows' } }
)
