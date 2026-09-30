/**
 * Rotate the project's mail inbox address (ADR-0074): the old one stops
 * resolving at once, and a new one is minted. Thin handler; authorization and
 * logic live in `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { rotateInboundAddress } from '@/lib/inbound-mail/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => rotateInboundAddress(session, params.id),
  { authz: { enforcedBy: 'rotateInboundAddress (requireProjectAccess project:manage)' } }
)
