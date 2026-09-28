'use client'

/**
 * Does the server have this conversation yet?
 *
 * A new chat gets its id in the browser (`ensureSession`, on the first
 * keystroke) and its server row only when the first message is stored
 * (`ensureServerConversation`). In between, every read of the conversation is
 * a question the server cannot answer: `GET /api/conversations/:id` and
 * `GET /api/sharing/conversation/:id` answered 404 on every new chat, the first
 * read as "private" and the second retried until the create landed.
 *
 * So the one page that minted an id records it here until the create succeeds,
 * and the readers wait for that instead of asking. The set is of ids the server
 * does NOT have, not of ids it does, on purpose: an id this page did not mint
 * came from the server (its list, a link, an inbox item) or from an earlier page
 * life, and a reader must ask about it at once. A positive set would need every
 * one of those entry paths to register, and the one that forgot would never be
 * read at all, which for a shared thread opened by link is the whole feature.
 *
 * Not persisted. A chat minted before a reload and never sent is read once and
 * answered 404, which the readers already take as "private".
 */

import { useSyncExternalStore } from 'react'

const notOnServer = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** This page minted the id; the server has no row for it until it is created. */
export function markConversationMinted(conversationId: string): void {
  if (notOnServer.has(conversationId)) return
  notOnServer.add(conversationId)
  emit()
}

/** The server holds the conversation now (its create succeeded). Idempotent. */
export function markConversationOnServer(conversationId: string): void {
  if (!notOnServer.delete(conversationId)) return
  emit()
}

/**
 * False only for an id this page minted and has not created yet. No id is
 * false too: there is nothing to read.
 */
export function isConversationOnServer(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId) && !notOnServer.has(conversationId as string)
}

/** {@link isConversationOnServer}, re-rendering when the create lands. */
export function useConversationOnServer(conversationId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isConversationOnServer(conversationId),
    () => isConversationOnServer(conversationId)
  )
}

/** Forget everything. For tests, which must not inherit one case's ids. */
export function resetConversationsOnServer(): void {
  if (notOnServer.size === 0) return
  notOnServer.clear()
  emit()
}
