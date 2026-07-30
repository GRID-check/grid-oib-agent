/**
 * `GET /api/inbox/summary` — the badge number alone (spec IB-19).
 *
 * Deliberately a separate endpoint from the list: every page render needs the
 * count and none of them need the rows, and the count is one indexed query
 * whereas the list re-authorizes every target it returns.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { getInboxSummary } from '@/lib/inbox/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    return getInboxSummary(session)
  },
  { authz: { enforcedBy: 'getInboxSummary (rows are keyed to session.userId)' } }
)
