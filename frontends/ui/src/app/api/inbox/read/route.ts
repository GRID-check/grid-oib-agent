/**
 * `POST /api/inbox/read` — mark items read (spec IB-20).
 *
 * One endpoint for both shapes because they are the same intent at two
 * granularities: `{ itemIds }` for the rows the user saw, `{ all: true }` for
 * "clear all". The response carries the recomputed badge count so the caller
 * never needs a follow-up read.
 *
 * Gated per ITEM TYPE rather than per route (see `/api/inbox`). `all: true` is
 * scoped to the types the caller can see, so it cannot silently settle rows
 * they were never shown.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { INBOX_LIST_LIMIT, markAllRead, markRead } from '@/lib/inbox/service'

/**
 * `itemIds` is bounded by the page size — a mark-read request can only ever be
 * about rows the client was actually shown, and an unbounded `IN (…)` is not
 * something a user-facing endpoint should accept.
 */
const markReadSchema = z
  .object({
    itemIds: z.array(z.string().uuid()).min(1).max(INBOX_LIST_LIMIT).optional(),
    all: z.boolean().optional(),
  })
  .refine((body) => body.all === true || (body.itemIds?.length ?? 0) > 0, {
    message: 'Provide itemIds or all: true',
  })

export const POST = apiRoute(
  async ({ session, request }) => {
    const body = await parseJsonBody(request, markReadSchema)
    return body.all ? markAllRead(session) : markRead(session, body.itemIds ?? [])
  },
  { authz: { enforcedBy: 'markRead / markAllRead (rows are keyed to session.userId)' } }
)
