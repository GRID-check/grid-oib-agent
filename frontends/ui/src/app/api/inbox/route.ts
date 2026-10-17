/**
 * `GET /api/inbox` — one page of the caller's own inbox (spec IB-20).
 *
 * Whose inbox is never a parameter: the service reads it from the session, so
 * there is no id a caller could swap. `?filter=` picks the slice
 * (`InboxListFilter`: `requests` waits on the reader, `unread` is not opened
 * yet, `all` is everything unarchived, `archived` what was put away, `pending`
 * the badge's own set). `?cursor=` is the previous page's `nextCursor`.
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
import { INBOX_LIST_FILTERS } from '@/lib/inbox/types'

const listQuerySchema = z.object({
  filter: z.enum(INBOX_LIST_FILTERS).optional(),
  cursor: z.string().min(1).max(200).optional(),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const { filter, cursor } = parseQuery(request, listQuerySchema)
    return listInbox(session, { filter: filter ?? 'all', cursor })
  },
  { authz: { enforcedBy: 'listInbox (rows are keyed to session.userId)' } }
)
