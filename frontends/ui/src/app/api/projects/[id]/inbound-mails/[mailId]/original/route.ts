/**
 * The original `.eml` of one held mail (ADR-0134, D6): evidence.
 *
 * GET — scanned whole on this request; served only on a clean answer (409
 *       `original_not_clean` otherwise), never sniffed or run, and audited
 *       (`inbound_mail.original_read`). Whoever may add documents to the
 *       project downloads it; no agent door offers it (withheld, `evidence`).
 *       The scanning is bounded per person (`MAIL_ORIGINAL_DOWNLOAD_LIMIT`,
 *       shared with a filed message's original).
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { readInboundMailOriginal } from '@/lib/inbound-mail/service'
import { MAIL_ORIGINAL_DOWNLOAD_LIMIT } from '@/lib/limits/catalog'

type Params = { id: string; mailId: string }

export const GET = apiRoute<Params>(async ({ session, params }) => readInboundMailOriginal(session, params.id, params.mailId), {
  authz: {
    enforcedBy: 'readInboundMailOriginal -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)',
  },
  limits: { rule: MAIL_ORIGINAL_DOWNLOAD_LIMIT },
})
