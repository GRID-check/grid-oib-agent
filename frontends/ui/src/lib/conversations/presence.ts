/**
 * Composing presence — "Anna is typing…" for a shared conversation.
 *
 * ## Why this is a separate module from the conversations service
 *
 * Everything in `./service` writes something and then tells people about it.
 * This writes nothing. A typing claim is true for a few seconds and worthless
 * afterwards, so it never reaches Postgres and there is deliberately no endpoint
 * that answers "who is typing right now" — the only way to learn it is to be
 * connected when it happens, and the only cost of missing it is that a colleague's
 * message appears without the two seconds of warning (spec RT-4 is untouched:
 * nothing here is state a client must converge on).
 *
 * ## Why `collaborator`, not `viewer`
 *
 * A viewer cannot send a message, so "a viewer is typing" is a claim about
 * something that will never happen — and broadcasting it would leak that someone
 * with read-only access is looking at the thread and drafting, which is not theirs
 * to announce. The role check is the same `requireResourceAccess` every other
 * conversation write goes through, so a caller who may not contribute gets the
 * same `NotFoundError` they would get for posting.
 *
 * ## Why the caller cannot name the typist
 *
 * The published `userId` is `session.userId`, never a request field. Otherwise any
 * member of a thread could make it look like a colleague was about to answer.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { publishToUsers } from '@/lib/events/bus'
import { isShared, requireResourceAccess } from '@/lib/sharing/access'
import { consumeRateLimit, TYPING_RATE_LIMIT } from '@/lib/sharing/rate-limit'
import { countGrantsForResource } from '@/lib/sharing/repository'
import { resolveParticipants } from '@/lib/sharing/service'
// The cadence pair lives in a client-safe module so the composer can import it
// without dragging the event bus into the browser bundle.
import { TYPING_TTL_MS } from './presence-contract'

/**
 * Broadcast (or withdraw) the caller's composing state.
 *
 * **A solo thread publishes nothing at all.** Same rule as every other
 * collaboration fan-out (spec NF-8): a private conversation with no grants must
 * not be able to notice this feature exists, and the grant count is only queried
 * when visibility alone cannot settle it.
 *
 * Best-effort by construction — the caller is told the request was accepted, not
 * that anybody received it. There is nothing to retry: by the time a retry landed
 * the claim would be about a keystroke that is already history.
 */
export async function publishTypingPresence(
  session: AuthorizedSession,
  conversationId: string,
  typing: boolean,
): Promise<void> {
  if (!isCollaborationEnabled(session)) return

  const access = await requireResourceAccess(session, 'conversation', conversationId, 'collaborator')

  // Shed silently past the bound rather than refusing: the caller is already
  // told only that the request was accepted, and a presence claim nobody
  // receives is exactly what happens when the channel drops one anyway.
  const limit = await consumeRateLimit(TYPING_RATE_LIMIT, session.userId)
  if (!limit.allowed) return

  const shared = isShared(
    access.visibility,
    access.visibility === 'private'
      ? await countGrantsForResource('conversation', conversationId)
      : 0,
  )
  if (!shared) return

  const participants = await resolveParticipants(
    session.organizationId,
    'conversation',
    conversationId,
  )
  // Nobody but the typist is listening — publishing would be an echo, and the
  // browser would have to filter it back out.
  const audience = participants.filter((userId) => userId !== session.userId)
  if (audience.length === 0) return

  await publishToUsers(audience, {
    kind: 'conversation.typing',
    conversationId,
    userId: session.userId,
    typing,
    ttlMs: TYPING_TTL_MS,
  })
}
