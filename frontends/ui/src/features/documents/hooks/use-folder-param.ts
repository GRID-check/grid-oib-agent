'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/**
 * Which folder is open, in the URL rather than in state.
 *
 * It was `useState`, and that made the folder tree the one part of the page the
 * browser did not know about: three folders deep, the back button left the page
 * instead of going up one level, a reload dropped the reader at the root, and a
 * folder could not be sent to a colleague. Every other view on the page — which
 * model, which storey, which file — lives in the URL for exactly these reasons.
 *
 * `?folder=<id>` and not a path segment: the tree is arbitrarily deep and
 * folders are renameable, so a route would need a catch-all resolved by name
 * (ambiguous — siblings may share one) or the same id in a prettier place. The
 * id is what the API takes.
 *
 * `push`, so each folder is its own history entry and back means "up one
 * level". `scroll: false` because the listing replaces itself in place.
 */
export function useFolderParam(): readonly [string | null, (next: string | null) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selected = searchParams?.get('folder')?.trim() || null

  const select = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      if (next === null) params.delete('folder')
      else params.set('folder', next)
      // Leaving a level closes whatever was open in it: a `doc` from the folder
      // you just left is not in the folder you just entered.
      params.delete('doc')
      const query = params.toString()
      const path = pathname ?? ''
      router.push(query ? `${path}?${query}` : path, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  return [selected, select] as const
}
