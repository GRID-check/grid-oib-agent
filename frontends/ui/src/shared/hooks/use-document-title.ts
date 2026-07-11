'use client'

import { useEffect, useRef } from 'react'

/**
 * Imperatively override the browser tab title from a client component, and
 * cleanly restore whatever title was there before once the override ends.
 *
 * This complements Next.js route metadata (which owns the static/base title):
 * pass a string to temporarily take over the tab (e.g. live progress), and pass
 * `null` to relinquish it. On the transition back to `null` — and on unmount —
 * the title present *at the moment the override began* is restored, so control
 * hands cleanly back to whatever the route metadata last set.
 *
 * SSR-safe: all DOM access is guarded and confined to an effect, so it is a
 * no-op during server rendering.
 */
export function useDocumentTitle(title: string | null): void {
  // Holds the title we displaced, so we can put it back verbatim.
  const restoreRef = useRef<string | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return
    // `null` means "don't override" — leave the route-metadata title alone.
    if (title === null) return

    restoreRef.current = document.title
    document.title = title

    return () => {
      if (restoreRef.current !== null) {
        document.title = restoreRef.current
        restoreRef.current = null
      }
    }
  }, [title])
}
