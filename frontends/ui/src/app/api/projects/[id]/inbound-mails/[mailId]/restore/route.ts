/**
 * Restore a held mail's dismissed or expired parts within their seven days
 * (ADR-0134, D8).
 *
 * POST — the parts wait again, and an expired mail waits seven more days.
 *        Idempotent; 409 `not_restorable` when nothing can come back. Whoever
 *        may add documents to the project may restore.
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { restoreInboundMail } from '@/lib/inbound-mail/service'

type Params = { id: string; mailId: string }

export const POST = apiRoute<Params>(async ({ session, params }) => restoreInboundMail(session, params.id, params.mailId), {
  authz: { enforcedBy: 'restoreInboundMail -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' },
})
