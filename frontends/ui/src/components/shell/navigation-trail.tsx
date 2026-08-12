'use client'

/**
 * Records every in-app location the reader visits into the tab's return trail
 * (`lib/navigation/return-trail`), so any page can offer a back control that
 * goes where the reader actually came from instead of guessing.
 *
 * Mounted once in the ROOT layout — not in `/app` — because the trail's promise
 * to its consumers is that the entry below the top is exactly one step back in
 * browser history. A page the recorder never saw would break that promise: the
 * trail would name a location two steps back while `history.back()` went one.
 *
 * Renders nothing. Its only effect is a `sessionStorage` write per navigation.
 */

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { labelVisit, readTrail, recordVisit, writeTrail } from '@/lib/navigation/return-trail'

export function NavigationTrail(): null {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname) return
    const trail = readTrail()
    const next = recordVisit(trail, pathname)
    if (next !== trail) writeTrail(next)
  }, [pathname])

  return null
}

/**
 * Tells the trail what the current location is CALLED — mounted by a page (or a
 * layout) that holds a name the URL does not, which in practice means the
 * project shell: `/app/projects/<id>/files` says nothing about "Stadthaus Wien".
 *
 * Recorded at visit time rather than looked up later on purpose. The back
 * control then names the destination with the same words the reader saw while
 * they were there, needs no request to render its own label, and cannot leak a
 * name for a project the reader has since lost access to — they can only be told
 * a name they were already shown.
 *
 * Renders nothing.
 */
export function NavigationTrailLabel({ label }: { label: string }): null {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname || !label) return
    const trail = readTrail()
    // Records the visit as well as naming it: this effect belongs to a component
    // deeper in the tree than <NavigationTrail>, and React runs child effects
    // FIRST — so on the first render of a project page the entry it wants to
    // label does not exist yet. `recordVisit` is idempotent, so whichever of the
    // two runs first, the entry ends up recorded exactly once and named.
    const next = labelVisit(recordVisit(trail, pathname), pathname, label)
    if (next !== trail) writeTrail(next)
  }, [pathname, label])

  return null
}
