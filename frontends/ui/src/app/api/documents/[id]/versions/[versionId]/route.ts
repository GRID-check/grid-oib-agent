/** One version of a document. Read-only; every mutation has its own verb. */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentVersionView } from '@/lib/documents/lifecycle'

type Params = { id: string; versionId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    version: await getDocumentVersionView(session, params.id, params.versionId),
  }),
  { authz: { enforcedBy: 'getDocumentVersionView -> getAccessibleDocument (project:view | org membership | conversation viewer)' } }
)
