'use client'

/**
 * Where "is this thread shared?" is published, so the composer can decide
 * whether it is allowed to open an agent socket on mount.
 *
 * ## Why this module exists
 *
 * Sharedness is a **server-computed fact** (ADR-0033 §1) and the ADR-0033 seam
 * (`useSharedThread`) is the one place that reads it. But the agent WebSocket is
 * owned by `useWebSocketChat`, mounted in a sibling component (`InputArea`)
 * alongside the seam's host (`ChatArea`). Rather than make the composer pay for a
 * second `GET /api/conversations/:id`, the seam publishes what it already learned
 * and the socket layer reads it. One request, two readers.
 *
 * ## Why the state is tri-valued
 *
 * `'unknown'` is not a placeholder, it is a decision: before the access read has
 * answered we do **not** know whether opening a socket would collide with another
 * participant's, so the socket layer treats unknown as "not yet permitted to
 * auto-connect" whenever collaboration is on. `'private'` is the positive
 * statement that today's local-first, connect-on-mount behaviour applies. That
 * asymmetry is the whole point: a wrong `'private'` re-opens the defect, a wrong
 * `'unknown'` only delays a connect by one already-in-flight round trip.
 *
 * Nothing here is persisted. A fact learned in one page life is not carried into
 * the next, because access can change while the tab is closed and a stale
 * `'private'` would be exactly the wrong error.
 */

import { useSyncExternalStore } from 'react'

/** What the server has told us about one conversation, if anything. */
export type ThreadSharing = 'unknown' | 'private' | 'shared'

const facts = new Map<string, 'private' | 'shared'>()
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

/**
 * Record what the server said about a conversation. Idempotent: re-publishing the
 * same answer notifies nobody, so the seam's focus/poll refreshes are free.
 */
export function publishThreadSharing(conversationId: string, shared: boolean): void {
  const next = shared ? 'shared' : 'private'
  if (facts.get(conversationId) === next) return
  facts.set(conversationId, next)
  emit()
}

/** Imperative read, for code that is not in a render (effects, callbacks). */
export function getThreadSharing(conversationId: string | null | undefined): ThreadSharing {
  if (!conversationId) return 'unknown'
  return facts.get(conversationId) ?? 'unknown'
}

/**
 * Drop everything learned so far. Exists for tests, which must not inherit one
 * case's sharedness into the next.
 */
export function resetThreadSharing(): void {
  if (facts.size === 0) return
  facts.clear()
  emit()
}

/** Subscribe to one conversation's sharedness. Returns a primitive, so a render
 * is only triggered when the answer actually changes. */
export function useThreadSharing(conversationId: string | null | undefined): ThreadSharing {
  return useSyncExternalStore(
    subscribe,
    () => getThreadSharing(conversationId),
    // Server render: nothing has been read yet, and the socket layer must not
    // conclude "private" from a snapshot taken before any request could run.
    () => 'unknown' as ThreadSharing
  )
}
