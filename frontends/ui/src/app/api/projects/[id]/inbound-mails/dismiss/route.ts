/**
 * Dismiss held mail (ADR-0134): every waiting part of up to 20 mails,
 * restorable for seven days.
 *
 * POST — answers the mails as they stand. Possible in a closed project. A mail
 *        with nothing waiting is left as it is. Whoever may add documents to
 *        the project may dismiss (`project:documents:write`).
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { dismissInboundMailsBodySchema } from '@/lib/inbound-mail/inbound-mail-wire'
import { dismissInboundMails } from '@/lib/inbound-mail/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) =>
    dismissInboundMails(session, params.id, await parseJsonBody(request, dismissInboundMailsBodySchema)),
  { authz: { enforcedBy: 'dismissInboundMails -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' } },
)
