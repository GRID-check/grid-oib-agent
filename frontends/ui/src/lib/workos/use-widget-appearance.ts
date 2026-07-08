'use client'

/**
 * Resolve Grid's theme preference into a concrete WorkOS-widget appearance
 * ('light' | 'dark'), so embedded widgets stay in sync with the rest of the app
 * (including 'system', which we resolve via the media query).
 */

import { useEffect, useState } from 'react'
import { useLayoutStore } from '@/features/layout/store'

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
