/**
 * `GET /api/inbox` — one page of the caller's own inbox (spec IB-20).
 *
 * Whose inbox is never a parameter: the service reads it from the session, so
 * there is no id a caller could swap. `?pendingOnly=true` is the "needs me"
 * filter; anything else lists everything unarchived.
 *
 * **There is deliberately no `requireCollaborationEnabled` here any more.** The
 * gate moved into the item-type registry (`@/lib/inbox/registry`'s `gate`) and
 * is applied by `listInbox` as a SQL type filter. A blanket 403 was wrong once
 * the inbox carried anything that is not a collaboration event: it made an
 * OPERATIONAL alert — "this organization is running out of storage" — silently
 * unreachable for exactly the tenants that have not bought a chat feature. A
 * tenant without collaboration now gets an inbox containing its operational
 * items and nothing else, which is the same guarantee NF-8 asked for, stated per
 * type instead of per route.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
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
    const { pendingOnly } = parseQuery(request, listQuerySchema)
    return listInbox(session, { pendingOnly })
  },
  { authz: { enforcedBy: 'listInbox (rows are keyed to session.userId)' } }
)
