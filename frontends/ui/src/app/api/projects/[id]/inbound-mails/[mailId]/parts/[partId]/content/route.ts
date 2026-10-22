/**
 * The bytes of one held attachment (ADR-0134), for the person's preview and
 * download before filing.
 *
 * GET — only after a clean scan (409 `scan_not_clean` otherwise), served as a
 *       download that a browser never sniffs or runs, and audited
 *       (`inbound_mail.part_read`). Whoever may add documents to the project
 *       reads it; Piloti does not (the exposure config).
 *
 * Thin handler; the logic is `@/lib/inbound-mail/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { readInboundMailPart } from '@/lib/inbound-mail/service'

type Params = { id: string; mailId: string; partId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => readInboundMailPart(session, params.id, params.mailId, params.partId),
  { authz: { enforcedBy: 'readInboundMailPart -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit)' } },
)
