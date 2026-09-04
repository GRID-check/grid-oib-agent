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
 * Deliberately not a store: nothing renders off it, and the caches want an
 * imperative "drop what you have", not a value to subscribe a component to.
 */

type Listener = () => void

const listeners = new Set<Listener>()

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
}
