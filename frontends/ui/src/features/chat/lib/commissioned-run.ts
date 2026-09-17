/**
 * The message a commissioned run narrates itself in, fetched once.
 *
 * When a turn commissions a run instead of answering (ADR-0062), the BFF has
 * already written that run's message into this thread — empty, with the
 * ledger's first frame on it. The terminal websocket frame names it, and this
 * is how the open thread gets hold of it without a reload: one read of the
 * conversation's messages, mapped by the same mapper a reload uses, and the one
 * message with that id.
 *
 * Not a new endpoint: the run message is an ordinary message, and a by-id door
 * for exactly one caller would be a second way to read the same row. This runs
 * once per escalated turn, which is rare next to the minutes of work it starts.
 *
 * Fail-open: a refused or malformed read returns `null`. The block then appears
 * on the next reload, which is a delay, not a loss — the run is a row and a
 * message no matter what this call does.
 */

import type { ChatMessage } from '@/features/chat/types'
import { mapServerMessagesToChatMessages } from './server-message-mapper'

export async function fetchRunMessage(
  conversationId: string,
  messageId: string,
): Promise<ChatMessage | null> {
  try {
    // Loaded lazily, like every other reader of this client: it is browser-only.
    const { conversationsClient } = await import('@/adapters/api/conversations-client')
    const messages = mapServerMessagesToChatMessages(
      await conversationsClient.listMessages(conversationId),
    )
    return messages.find((message) => message.id === messageId) ?? null
  } catch {
    return null
  }
}
