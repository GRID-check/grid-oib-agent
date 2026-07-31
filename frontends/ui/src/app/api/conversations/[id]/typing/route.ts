/**
 * `POST /api/conversations/:id/typing` — broadcast that the caller is composing.
 *
 * Fire-and-forget presence, not state: nothing is stored, nothing is returned,
 * and there is no matching GET (see `@/lib/conversations/presence` for why).
 * `{ typing: false }` withdraws the claim early when the composer is sent or
 * cleared; otherwise it expires on its own.
 *
 * Answers `204` even for a thread that is private or a feature that is off — the
 * service simply publishes nothing. A caller who may not contribute still gets the
 * usual `404` from the access check, so this is not a membership oracle.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { publishTypingPresence } from '@/lib/conversations/presence'

type Params = { id: string }

const typingSchema = z.object({
  /** Absent means "still typing" — the common case is the smallest body. */
  typing: z.boolean().optional(),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, typingSchema)
    await publishTypingPresence(session, params.id, input.typing ?? true)
    // Nothing to return; the factory turns an empty result into `204`.
  },
  { authz: { enforcedBy: 'publishTypingPresence (requireResourceAccess, collaborator)' } }
)
