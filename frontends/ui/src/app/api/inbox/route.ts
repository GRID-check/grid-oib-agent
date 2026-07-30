/**
 * `GET /api/inbox` — one page of the caller's own inbox (spec IB-20).
 *
 * Whose inbox is never a parameter: the service reads it from the session, so
 * there is no id a caller could swap. `?pendingOnly=true` is the "needs me"
 * filter; anything else lists everything unarchived.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { listInbox } from '@/lib/inbox/service'

/**
 * An explicit `'true' | 'false'` enum rather than `z.coerce.boolean()`, which
 * would read every non-empty string (including `"false"`) as true.
 */
const listQuerySchema = z.object({
  pendingOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const { pendingOnly } = parseQuery(request, listQuerySchema)
    return listInbox(session, { pendingOnly })
  },
  { authz: { enforcedBy: 'listInbox (rows are keyed to session.userId)' } }
)
