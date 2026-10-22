/**
 * Replace a project's mail address with a new one (ADR-0135), `project:manage`.
 *
 * POST — the old address stops resolving at once (mail to it bounces), the
 *        new one is answered, and every follow on the project ends (D31).
 *        A project without an address gets its first.
 *
 * Thin handler; the logic is `@/lib/inbound-mail/address-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { rotateInboundMailAddress } from '@/lib/inbound-mail/address-service'

type Params = { id: string }

export const POST = apiRoute<Params>(async ({ session, params }) => rotateInboundMailAddress(session, params.id), {
  authz: { enforcedBy: 'rotateInboundMailAddress -> requireAddressManager (inbound-mail entitlement; project:manage)' },
})
