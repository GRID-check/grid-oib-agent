/**
 * Document thumbnail API - presign a browser-facing thumbnail URL
 * (null url signals no thumbnail available).
 * `expiresAtMs` is when the URL stops authorizing; the card re-resolves past
 * it instead of replaying a dead URL into the optimizer (#366).
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentThumbnail } from '@/lib/documents/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getDocumentThumbnail(session, params.id),
  { authz: { enforcedBy: 'getDocumentThumbnail -> getAccessibleDocument (project:view)' } }
)
