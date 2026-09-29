/**
 * Document re-ingest API — send a document back through the backend ingest
 * pipeline under its own id: a retry for a failed or lost one, a re-read for
 * an indexed one. Thin handler; all logic (access checks, status guard, the
 * 409 codes, dispatch) lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { reingestDocument } from '@/lib/documents/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => reingestDocument(session, params.id),
  { authz: { enforcedBy: 'reingestDocument -> getAccessibleDocument (project:documents:write)' } }
)
