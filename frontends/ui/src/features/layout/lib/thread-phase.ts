/**
 * What the open thread is right now, decided once for every surface that
 * draws around it.
 *
 * `MainLayout` lifts the composer onto the empty canvas and `ChatArea` draws
 * the greeting; both used to decide "empty" for themselves, from different
 * inputs (the raw message count against the displayable messages), and a
 * thread whose messages were still on their way read as empty to both. The
 * greeting flashed, the composer sprang to the middle of the column and back,
 * and every message then played its entrance (thread audit, 2026-10). One
 * selector, so the two cannot disagree.
 */

import type { ChatMessage } from '@/features/chat/types'
import { isAwaitingServerMessages } from '@/features/chat/stores/chat-storage'

/**
 * - `hydrating`: the persisted store has not been read yet.
 * - `loading`: a thread is open (or about to be, from a deep link) whose
 *   messages are not here yet: from the server, or from a shared thread's
 *   first read (`ChatArea` names it in `pendingMessagesFor` too).
 * - `empty`: a thread with nothing to show: the greeting's canvas.
 * - `thread`: something to show.
 */
export type ThreadPhase = 'hydrating' | 'loading' | 'empty' | 'thread'

/**
 * A dropped socket this page is already reconnecting: said by a quiet status
 * line above the composer, never by a card in the thread. A card collapsed
 * out of the thread the moment the socket came back, moving everything below
 * it, for a condition the reader could do nothing about.
 */
export const isTransientConnectionError = (message: ChatMessage): boolean =>
  message.messageType === 'error' &&
  (message.errorData?.errorCode === 'connection.failed' ||
    message.errorData?.errorCode === 'connection.lost')

/**
 * Whether the thread draws this message. Assistant `text` messages (full
 * reports) are read in the details panel, and legacy status rows nowhere.
 */
export const isDisplayableMessage = (message: ChatMessage): boolean => {
  const messageType = message.messageType || (message.role === 'user' ? 'user' : 'assistant')
  if (isTransientConnectionError(message)) return false
  return (
    messageType === 'user' ||
    messageType === 'prompt' ||
    messageType === 'agent_response' ||
    messageType === 'file' ||
    messageType === 'error'
  )
}

/** The store fields the phase is decided from. */
export interface ThreadPhaseInput {
  hasHydrated?: boolean
  currentConversation?: { id?: string; messages?: ChatMessage[] } | null
  pendingMessagesFor?: string | null
  serverConversationsLoaded?: boolean
}

export const selectThreadPhase = (state: ThreadPhaseInput): ThreadPhase => {
  if (state.hasHydrated === false) return 'hydrating'
  const conversation = state.currentConversation
  const pending = state.pendingMessagesFor ?? null
  // A deep link names a thread that is not the open one yet: what is on screen
  // is about to be replaced, so it is not offered as the canvas either.
  if (pending !== null && pending !== conversation?.id) return 'loading'
  const shown = (conversation?.messages ?? []).some(isDisplayableMessage)
  if (shown) return 'thread'
  if (!conversation?.id) return 'empty'
  if (pending === conversation.id) return 'loading'
  // Restored from storage without its messages, before the server list that
  // starts their fetch has landed: not loaded is not empty.
  if (
    state.serverConversationsLoaded === false &&
    (conversation.messages?.length ?? 0) === 0 &&
    isAwaitingServerMessages(conversation.id)
  ) {
    return 'loading'
  }
  return 'empty'
}
