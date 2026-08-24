'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Moves keyboard focus to the main content landmark whenever the route changes
 * client-side, so keyboard and screen-reader users start from the freshly
 * rendered content instead of being stranded on a link in the (persistent)
 * navigation.
 *
 * Rules:
 *   - Never fires on the initial mount / full page load — only on subsequent
 *     pathname changes. On first load the browser's own focus placement (or an
 *     intentional autofocus) should stand.
 *   - Only pulls focus to the landmark when focus is NOT already inside it.
 *     Child effects flush before this parent effect, so a page that made a
 *     deliberate in-content focus choice (the chat page autofocuses its
 *     composer) already contains `document.activeElement`, and we leave it be.
 *     This is what stops the hook from yanking the composer's autofocus.
 *   - `preventScroll` avoids a jarring jump to the top of the landmark.
 *
 * SSR-safe: DOM access is confined to the effect.
 *
 * @param targetId id of the focus target (a landmark with `tabIndex={-1}`).
 */
export function useRouteFocus(targetId = 'main-content'): void {
  const pathname = usePathname()
  const isInitialRun = useRef(true)

  useEffect(() => {
    if (isInitialRun.current) {
      isInitialRun.current = false
      return
    }
    if (typeof document === 'undefined') return

    const target = document.getElementById(targetId)
    if (!target) return
    if (target.contains(document.activeElement)) return

    target.focus({ preventScroll: true })
  }, [pathname, targetId])
}
