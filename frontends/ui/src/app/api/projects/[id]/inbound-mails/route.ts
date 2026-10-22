/**
 * The project's E-Mail-Eingang (ADR-0134): the mail held for a person.
 *
 * GET — one page, newest first: `status=waiting` (a part still waits, the
 *       default) or `status=handled` (nothing waits any more), the handled
 *       list narrowed by `outcome`. Metadata only: masked subjects, senders,
 *       labels and counts, never a mail's text or bytes. Whoever may add
 *       documents to the project reads it (`project:documents:write`).
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { inboundMailListQuerySchema } from '@/lib/inbound-mail/inbound-mail-wire'
import { listInboundMails } from '@/lib/inbound-mail/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => listInboundMails(session, params.id, parseQuery(request, inboundMailListQuerySchema)),
  { authz: { enforcedBy: 'listInboundMails -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' } },
)
