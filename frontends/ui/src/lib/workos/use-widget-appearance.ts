'use client'

/**
 * Resolve Grid's theme preference into a concrete WorkOS-widget appearance
 * ('light' | 'dark'), so embedded widgets stay in sync with the rest of the app
 * (including 'system', which we resolve via the media query).
 */

import { useEffect, useState } from 'react'
import type { WorkOsWidgetsProps } from '@workos-inc/widgets'
import { useLayoutStore } from '@/features/layout/store'

/**
 * The one theme every embedded WorkOS widget mounts with. It was previously
 * written out at each `<WorkOsWidgets>` call site, which is how the four of them
 * came to be maintained as four separate objects that happened to agree.
 *
 * Two settings make an embedded widget look like part of the page rather than
 * a hole punched in it, and both matter most in dark mode:
 *
 * `hasBackground: false` stops Radix painting its own theme background (its
 * `--gray-1`) on the widget root. Radix forces that background on for any Theme
 * given an explicit appearance — which ours always is, since we drive it from
 * Grid's theme — and its dark `gray-1` sits BELOW our `--card`, so every widget
 * rendered as a near-black rectangle inside an otherwise raised card. Off, our
 * own card surface shows through and the widget sits on it.
 *
 * `grayColor: 'sand'` picks Radix's warm gray over its default cold neutral, so
 * the widget's remaining surfaces, borders and muted text land in the same hue
 * family as the warm charcoal (and warm paper) around them.
 *
 * `panelBackground` is deliberately left at Radix's `translucent` default: with
 * no theme background of its own, a translucent panel composites against our
 * card and reads as a quiet inset, whereas `solid` would re-introduce the same
 * opaque `gray-1` block one level down.
 */
export function widgetTheme(appearance: 'light' | 'dark'): WorkOsWidgetsProps['theme'] {
  return { appearance, hasBackground: false, grayColor: 'sand', radius: 'medium', scaling: '100%' }
}

export function useResolvedAppearance(): 'light' | 'dark' {
  const theme = useLayoutStore((s) => s.theme)
  const [systemDark, setSystemDark] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mediaQuery.matches)
    const handler = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  return systemDark ? 'dark' : 'light'
}
