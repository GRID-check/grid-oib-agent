/**
 * „Jetzt schreiben" for one run: an adapter over `writeNowRun`, the way the
 * cancel route is over `cancelRun`. The ids in the path reach the service
 * unchanged; the view comes back as the body.
 */

import { apiRoute } from '@/lib/api/handler'
import { writeNowRun } from '@/lib/runs/service'

type Params = { id: string; runId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => writeNowRun(session, params.id, params.runId),
  {
    authz: {
      enforcedBy: 'writeNowRun (requireProjectAccess project:view + CHAT_PERMISSIONS)',
    },
  }
)
