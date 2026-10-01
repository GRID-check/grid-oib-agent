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
 */

import { findConversationTenancy } from '@/lib/conversations/repository'
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
