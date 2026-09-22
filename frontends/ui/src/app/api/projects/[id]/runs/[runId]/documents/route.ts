/**
 * Add a document to a running run's Grundlage: an adapter over
 * `addRunDocument`, the way the write-now route is over `writeNowRun`. The
 * ids in the path reach the service unchanged; the body is one
 * `PlanDocument`; the view comes back as the body.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { planDocumentSchema } from '@/lib/runs/plan-documents'
import { addRunDocument } from '@/lib/runs/service'

type Params = { id: string; runId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const document = await parseJsonBody(request, planDocumentSchema)
    return addRunDocument(session, params.id, params.runId, document)
  },
  {
    authz: {
      enforcedBy: 'addRunDocument (requireProjectAccess project:view + CHAT_PERMISSIONS)',
    },
  }
)
