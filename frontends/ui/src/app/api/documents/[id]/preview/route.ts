/**
 * Document preview API — presign a browser-facing inline preview URL
 * (415 for non-previewable content types).
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentPreview } from '@/lib/documents/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getDocumentPreview(session, params.id),
  { authz: { enforcedBy: 'getDocumentPreview -> getAccessibleDocument (project:view)' } }
)
