/**
 * The project's mail inbox address (ADR-0074). Minted on first read.
 * Thin handler; authorization and logic live in `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getInboundAddress } from '@/lib/inbound-mail/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getInboundAddress(session, params.id),
  {
    authz: {
      enforcedBy: 'getInboundAddress (requireProjectAccess project:documents:write any-of project:edit)',
    },
  }
)
