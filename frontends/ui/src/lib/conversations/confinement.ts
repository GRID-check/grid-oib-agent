/**
 * Whether a conversation is readable by one person alone (ADR-0078).
 *
 * An answer drawn from a restricted folder may only land where nobody but its
 * asker can read it. Two callers ask, at two moments, and must agree:
 *
 *   * the WebSocket upgrade (`collection-scope-request.ts`), which puts the
 *     restricted collections into the signed scope only for such a thread;
 *   * every turn on that socket (`POST /api/internal/conversations/[id]/confinement`,
 *     asked by `aiq_api.chat_socket`), because the scope is signed once per
 *     socket and the owner can share the thread while the socket stays open.
 *
 * The per-turn ask is also where the conversation is marked as having run a
 * restricted turn ({@link admitRestrictedTurn}), which is what the share refusal
 * keys on.
 */

import {
  findConversationTenancy,
  recordRestrictedTurn,
  withdrawFreshRestrictedTurn,
} from '@/lib/conversations/repository'
import { countGrantsForResource } from '@/lib/sharing/repository'

export type ConversationTenancy = NonNullable<Awaited<ReturnType<typeof findConversationTenancy>>>

/**
 * A conversation that does not exist yet is confined: the first message creates
 * it `private`, owned by whoever sent it. An existing one must be `userId`'s,
 * `private`, and carry no grant.
 */
export async function conversationConfinedTo(
  userId: string,
  conversationId: string,
  tenancy: ConversationTenancy | null
): Promise<boolean> {
  if (!tenancy) return true
  if (tenancy.createdBy !== userId || tenancy.visibility !== 'private') return false
  return (await countGrantsForResource('conversation', conversationId)) === 0
}

/**
 * The per-turn question, for a caller that holds ids and no session (the agent,
 * over the internal route). A thread of another organization is nobody's here
 * to keep private, so it answers no.
 */
export async function conversationConfinedInOrg(
  organizationId: string,
  userId: string,
  conversationId: string
): Promise<boolean> {
  const tenancy = await findConversationTenancy(conversationId)
  if (tenancy && tenancy.organizationId !== organizationId) return false
  return conversationConfinedTo(userId, conversationId, tenancy)
}

/**
 * The per-turn admission of a turn whose signed scope holds a restricted
 * collection: mark the conversation, then answer whether it is still its
 * asker's alone. Yes keeps the mark, and the turn runs; no withdraws a mark this
 * call created, and the agent closes the socket.
 *
 * The mark is written at turn START, before the answer exists, because the
 * share refusal (`conversationDescriptor.confinedToOwner`) keys on it: the
 * inventory block can put a restricted summary into an answer that cites
 * nothing, and the owner can share while the answer streams.
 *
 * Mark first, read second. The sharing service writes first and re-reads the
 * mark second (`confirmMayLeaveOwner`). Whichever of the two commits second
 * sees the other's write, so a share and a restricted turn racing each other
 * cannot both go through.
 */
export async function admitRestrictedTurn(
  organizationId: string,
  userId: string,
  conversationId: string
): Promise<boolean> {
  const mark = await recordRestrictedTurn(conversationId, organizationId)
  if (await conversationConfinedInOrg(organizationId, userId, conversationId)) return true
  if (mark.created) await withdrawFreshRestrictedTurn(conversationId, organizationId)
  return false
}
