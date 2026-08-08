/**
 * Document file stream — serves a stored document's bytes from this origin so
 * the in-app PDF viewer can FETCH it (the presigned preview URL is cross-origin
 * and the object store publishes no CORS policy). See `streamDocumentFile`.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { streamDocumentFile } from '@/lib/documents/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => streamDocumentFile(session, params.id),
  { authz: { enforcedBy: 'streamDocumentFile -> getAccessibleDocument (project:view)' } }
)
