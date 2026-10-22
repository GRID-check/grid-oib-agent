/**
 * A project's mail address (ADR-0135).
 *
 * GET    — read it. Whoever reviews the project's E-Mail-Eingang
 *          (`project:documents:write`) may; a read never mints an address, it
 *          answers `none` until a manager created one.
 * POST   — give the project its address (`project:manage`). Idempotent.
 * DELETE — switch it off (`project:manage`): mail to it bounces from now on,
 *          and every follow on the project ends.
 *
 * With the office's `inbound-mail` entitlement off, every method is a 404.
 * Thin handlers; the logic is `@/lib/inbound-mail/address-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import {
  createInboundMailAddress,
  deleteInboundMailAddress,
  getInboundMailAddress,
} from '@/lib/inbound-mail/address-service'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getInboundMailAddress(session, params.id), {
  authz: { enforcedBy: 'getInboundMailAddress -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' },
})

export const POST = apiRoute<Params>(async ({ session, params }) => createInboundMailAddress(session, params.id), {
  authz: { enforcedBy: 'createInboundMailAddress -> requireAddressManager (inbound-mail entitlement; project:manage)' },
})

export const DELETE = apiRoute<Params>(async ({ session, params }) => deleteInboundMailAddress(session, params.id), {
  authz: { enforcedBy: 'deleteInboundMailAddress -> requireAddressManager (inbound-mail entitlement; project:manage)' },
})
