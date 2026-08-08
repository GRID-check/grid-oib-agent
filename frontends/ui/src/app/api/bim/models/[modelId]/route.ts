/**
 * BIM model API — one model's header and summary (spatial tree, storeys, type
 * counts, totals). Thin handler; all logic lives in `@/lib/bim/model-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getAccessibleModel } from '@/lib/bim/model-service'

type Params = { modelId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getAccessibleModel(session, params.modelId),
  {
    authz: {
      enforcedBy:
        'getAccessibleModel (ifc-models flag + requireProjectAccess project:view, or org membership for Archiv models)',
    },
  }
)
