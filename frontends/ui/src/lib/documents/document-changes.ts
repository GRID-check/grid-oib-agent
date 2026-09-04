/**
 * "The document estate changed" — one signal, so caches that must not go stale
 * do not each have to be told by every mutation.
 *
 * TWO module-scope caches hold document listings for the lifetime of the page:
 * `useSourcePreviewIndex` (which decides whether a citation can be opened) and
 * `useSurfacedDocuments` (which fills the document cards). Neither was ever
 * invalidated outside tests, so a file uploaded DURING a conversation was
 * invisible to both — the answer would cite `Brandschutzkonzept.pdf`, and the
 * chip offered no way in and no reason, until a reload. That is verbatim the
 * complaint that produced #623, on a path the fix for it did not reach.
 *
 * A listener registry rather than an import from either cache: this module is
 * in `lib/`, the caches are in `features/`, and `features` may depend on `lib`
 * and never the other way round. A mutation calls `notifyDocumentsChanged()`
 * without knowing who is listening, which is also what keeps the third cache —
 * whenever it appears — from being the one nobody remembers to invalidate.
 *
 * Two shapes, because dropping a cache is only half of it. The caches are
 * module-scope Maps and clearing one re-renders nothing, so a surface that was
 * ALREADY MOUNTED when the change happened kept serving what it had loaded —
 * which is every rename and every delete, since the citation chip and the
 * document card showing that document are on screen at the time. Upload got
 * away with it only because a new answer mounts new chips.
 *
 * So `onDocumentsChanged` drops the cache, and `useDocumentsGeneration` is the
 * number a component puts in its effect deps to reload after it. One counter
 * for the whole estate rather than per-corpus invalidation: the refetch is four
 * cheap listings, and a signal nobody can subscribe to incorrectly is worth
 * more than one that avoids a request.
 */

import { useSyncExternalStore } from 'react'

type Listener = () => void

const listeners = new Set<Listener>()

/** Bumped by every change — the value `useDocumentsGeneration` hands out. */
let generation = 0
const generationListeners = new Set<Listener>()

/**
 * Register a cache to be dropped when documents change. Returns the
 * unsubscribe, so a caller with a lifetime shorter than the module's can use it
 * too.
 */
export function onDocumentsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A document was added, removed or renamed — anything that changes what a
 * listing would return.
 *
 * Iterated over a copy so a listener that unsubscribes itself while running
 * cannot skip the next one, and each is isolated: one throwing listener must
 * not stop the others from being told, or an unrelated bug becomes a stale
 * citation index.
 */
export function notifyDocumentsChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn('[documents] a change listener threw', error)
    }
  }
  // After the caches have been dropped, never before: a subscriber that
  // re-reads on this tick must not be handed the stale index it just invalidated.
  generation += 1
  for (const listener of [...generationListeners]) listener()
}

const subscribeGeneration = (listener: Listener): (() => void) => {
  generationListeners.add(listener)
  return () => {
    generationListeners.delete(listener)
  }
}

/**
 * A number that changes whenever the document estate does.
 *
 * Put it in the deps of the effect that loads a document listing. On the server
 * it is 0 and never moves, which is the honest answer there — nothing has
 * changed during a render that has not happened yet.
 */
export function useDocumentsGeneration(): number {
  return useSyncExternalStore(
    subscribeGeneration,
    () => generation,
    () => 0
  )
}
