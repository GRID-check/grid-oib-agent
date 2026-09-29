'use client'

import { useEffect, useState, type RefCallback } from 'react'

/**
 * Whether an element has ever been on screen, latched: once true, it stays true.
 *
 * For work that should wait until somebody can see its result and then stay
 * put: mounting a heavy renderer (pdf.js) in a pane that may open collapsed or
 * off-screen, without unmounting it again when the reader scrolls past, which
 * would throw away its state and pay the load twice.
 *
 * A callback ref rather than a `RefObject`, so the observer attaches when the
 * node actually mounts. Without `IntersectionObserver` (old engines, SSR) the
 * answer is "seen" at once: the fallback is the eager behaviour, never a
 * renderer that waits forever for an observer that does not exist.
 */
export function useSeenOnce<T extends Element>(): [RefCallback<T>, boolean] {
  const [node, setNode] = useState<T | null>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (seen || !node) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true)
        observer.disconnect()
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, seen])

  return [setNode, seen]
}
