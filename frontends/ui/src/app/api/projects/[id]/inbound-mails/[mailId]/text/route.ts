/**
 * The text of one held mail (ADR-0134, D7).
 *
 * GET — the sender's own text and the quoted earlier messages, with every
 *       finding of the office's content check masked, for every reader.
 *       Whoever may add documents to the project reads it; no model of
 *       Piloti's does before a person filed it (the exposure config).
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getInboundMailText } from '@/lib/inbound-mail/service'

type Params = { id: string; mailId: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getInboundMailText(session, params.id, params.mailId), {
  authz: { enforcedBy: 'getInboundMailText -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' },
})
