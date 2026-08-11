/**
 * BIM query API — run one structured query against one model.
 *
 * POST rather than GET because the request is a nested object (filters,
 * property predicates, grouping) that would be unreadable as a query string,
 * and long enough to hit URL limits on a real filter set. It is a read: nothing
 * here mutates.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BIM_QUERY_LIMIT } from '@/lib/limits'
import { bimQuerySchema } from '@/lib/bim/query'
import { queryAccessibleModel } from '@/lib/bim/model-service'

type Params = { modelId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = await parseJsonBody(request, bimQuerySchema)
    return queryAccessibleModel(session, params.modelId, query)
  },
  {
    // A READ that has to travel as POST (see the header). The factory's default
    // charges every POST against `api-mutation`, which put a viewer's paging
    // walk in the same bucket as document UPLOADS — reading a model then made
    // uploading one fail with "Too many requests". Its own rule, sized for a
    // full-model walk.
    limits: { rule: BIM_QUERY_LIMIT },
    authz: {
      enforcedBy:
        'queryAccessibleModel -> getAccessibleModel (ifc-models flag + requireProjectAccess project:view, or org membership for Archiv models)',
    },
  }
)
