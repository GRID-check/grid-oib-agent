/**
 * Project BIM models API — the models in scope for a project: its own uploads
 * plus the org-wide Archiv's, the same scope rule retrieval uses.
 */

import { apiRoute } from '@/lib/api/handler'
import { listAccessibleModels } from '@/lib/bim/model-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({ models: await listAccessibleModels(session, params.id) }),
  {
    authz: {
      enforcedBy: 'listAccessibleModels (ifc-models flag + requireProjectAccess project:view)',
    },
  }
)
