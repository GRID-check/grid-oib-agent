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
/**
 * Who Piloti is currently answering for, when it is somebody OTHER than the reader.
 *
 * Published by the same seam and for the same reason as sharedness: the composer is
 * locked by `isBusy` while a turn runs, and in a shared thread that turn may belong
 * to a colleague — leaving an observer looking at a dead input with no explanation.
 * `thread.composerBusy` existed for exactly this and nothing rendered it, because the
 * name lives in the seam and the composer is a sibling. One request, two readers.
 *
 * Null means "no turn, or the turn is the reader's own" — the asker already has a
 * typing indicator and the Herleitung, so naming them would be noise.
 */
const turnActors = new Map<string, string>()
/**
 * The reader's own role in a shared thread ('viewer' | 'collaborator' | 'owner'),
 * published by the seam for the same reason as the turn actor: the server rejects
 * a viewer's send, so the composer must be read-only before the attempt — a ghost
 * bubble only the viewer sees is the alternative. Absent means "not shared for
 * this reader, or not yet known" — both of which keep the composer enabled.
 */
const threadRoles = new Map<string, string>()
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

/**
 * Record whose question Piloti is answering, or clear it. Idempotent, so the seam's
 * repeated renders are free.
 */
export function publishTurnActor(conversationId: string, name: string | null): void {
  const current = turnActors.get(conversationId) ?? null
  if (current === name) return
  if (name === null) turnActors.delete(conversationId)
  else turnActors.set(conversationId, name)
  emit()
}

/**
 * Record the reader's role in a shared thread, or clear it (private thread,
 * access lost). Idempotent, so the seam's refreshes are free.
 */
export function publishThreadRole(conversationId: string, role: string | null): void {
  const current = threadRoles.get(conversationId) ?? null
  if (current === role) return
  if (role === null) threadRoles.delete(conversationId)
  else threadRoles.set(conversationId, role)
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
  if (facts.size === 0 && turnActors.size === 0 && threadRoles.size === 0) return
  facts.clear()
  turnActors.clear()
  threadRoles.clear()
  emit()
}

/**
 * Whose question Piloti is answering in this conversation, when it is not the
 * reader's own. Null otherwise.
 */
export function useTurnActorName(conversationId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (conversationId ? (turnActors.get(conversationId) ?? null) : null),
    () => null
  )
}

/**
 * The reader's own role in this conversation, or null when the thread is not
 * shared for them (or the access read has not landed). The composer disables
 * itself on `'viewer'`.
 */
export function useThreadRole(conversationId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (conversationId ? (threadRoles.get(conversationId) ?? null) : null),
    () => null
  )
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
