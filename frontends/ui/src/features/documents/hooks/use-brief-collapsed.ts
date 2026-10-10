'use client'

import { useCallback, useEffect, useState } from 'react'

const BRIEF_STORAGE_KEY = 'grid.files.brief.collapsed'

/**
 * Whether the folder brief is folded to its one-line summary, remembered per
 * browser like the card/list choice. Open by default: the brief is the answer
 * to "what has Piloti read here", and a first visit should see it.
 */
export function useBriefCollapsed(): readonly [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(BRIEF_STORAGE_KEY) === '1') setCollapsed(true)
    } catch {
      // Storage unavailable — the choice holds for this visit.
    }
  }, [])
  const select = useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      window.localStorage.setItem(BRIEF_STORAGE_KEY, next ? '1' : '0')
    } catch {
      // As above.
    }
  }, [])
  return [collapsed, select] as const
}
