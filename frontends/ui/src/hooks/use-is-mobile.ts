'use client'

import { useSyncExternalStore } from 'react'

/**
 * Matches Tailwind's `md` breakpoint: anything narrower is "mobile" for
 * layout decisions that can't be expressed in CSS alone (e.g. inline width
 * animations in the chat shell).
 */
const MOBILE_QUERY = '(max-width: 767px)'

const subscribe = (onStoreChange: () => void): (() => void) => {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

const getSnapshot = (): boolean => window.matchMedia(MOBILE_QUERY).matches

// SSR renders the desktop layout; the client corrects on hydration.
const getServerSnapshot = (): boolean => false

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
