/**
 * One held mail (ADR-0134).
 *
 * GET — its headers (the subject masked), the sender's trust label and flags,
 *       its parts (names, states, scans, flags, Piloti's suggestion), the
 *       threads and documents it matched as the caller may see them, and the
 *       `ifMatch` a decision sends back. Never its text: that is `…/text`.
 *       Whoever may add documents to the project reads it.
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getInboundMail } from '@/lib/inbound-mail/service'

type Params = { id: string; mailId: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getInboundMail(session, params.id, params.mailId), {
  authz: { enforcedBy: 'getInboundMail -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' },
})
