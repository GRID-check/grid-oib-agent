/**
 * Live-turn spectating — the authorization half of "watch Piloti answer".
 *
 * `GET /api/conversations/:id/live` relays the agent's outbound frames for one
 * conversation (see `@/lib/events/conversation-frames` for where those frames
 * come from). That is a per-RESOURCE channel, which makes this the one place in
 * the collaboration feature where authorization is **not** settled at publish
 * time, and the difference is worth being explicit about:
 *
 *  - The per-user event bus is safe because a subscriber is attached to their own
 *    channel and the server decides what to address to it (ADR-0035 §9).
 *  - A conversation's frame channel carries whatever the agent says to whoever
 *    asked. Anyone attached to it sees the whole turn. So access is checked
 *    before the subscription opens **and re-checked while it is open**, because a
 *    connection that outlives a revoked grant is a subscription to a thread the
 *    reader may no longer read.
 *
 * `viewer` is the bar, deliberately: reading along is exactly what a viewer is
 * for, and the frames only ever contain the answer they will read a moment later
 * anyway. What a viewer must not be able to do — answer a prompt, send a message —
 * is refused elsewhere and is not reachable from a one-way stream.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireResourceAccess } from '@/lib/sharing/access'

/**
 * How often an open stream re-proves the reader may still read this thread.
 *
 * Short enough that a revocation is acted on while it still matters, long enough
 * that a thread being watched by a handful of colleagues is not a query storm.
 * A dropped grant also reaches the browser as `resource.access.changed`, so this
 * is the server-side backstop for a client that ignores it, not the only defence.
 */
export const LIVE_REAUTHORIZE_MS = 30_000

/**
 * Prove the caller may watch this conversation. Throws `NotFoundError` when not
 * (never a 403: a denial must not confirm the thread exists — same rule as every
 * other conversation read).
 */
export async function requireConversationSpectator(
  session: AuthorizedSession,
  conversationId: string,
): Promise<void> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
}

/**
 * Re-prove it, for a stream that is already open. Returns `false` instead of
 * throwing: the caller's job is to close the stream tidily, not to turn a
 * revocation into an unhandled rejection inside a `setInterval`.
 */
export async function stillMayWatchConversation(
  session: AuthorizedSession,
  conversationId: string,
): Promise<boolean> {
  try {
    await requireConversationSpectator(session, conversationId)
    return true
  } catch {
    return false
  }
}
