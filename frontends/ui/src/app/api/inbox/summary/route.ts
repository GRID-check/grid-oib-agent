/**
 * `GET /api/inbox/summary` — the badge number alone (spec IB-19).
 *
 * Deliberately a separate endpoint from the list: every page render needs the
 * count and none of them need the rows, and the count is one indexed query
 * whereas the list re-authorizes every target it returns.
 *
 * Gated per ITEM TYPE rather than per route (see `/api/inbox`): the count is
 * computed over the same type set the list uses, so badge and list can never
 * disagree about what is in the inbox.
 */

import { apiRoute } from '@/lib/api/handler'
import { getInboxSummary } from '@/lib/inbox/service'

export const GET = apiRoute(
  async ({ session }) => {
    return getInboxSummary(session)
  },
  { authz: { enforcedBy: 'getInboxSummary (rows are keyed to session.userId)' } }
)
