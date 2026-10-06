'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Presentation of the file browser.
 *
 * `cards` browses, `list` is the explorer detail view for a corpus too large to
 * skim as tiles. Both read the same documents through the same search and the
 * same folder drill-down.
 */
export type FileView = 'cards' | 'list'

const VIEW_STORAGE_KEY = 'grid.files.view'

/**
 * Cards or list, remembered per browser — and shared by every shelf, so the
 * choice made in Dateien is the one the Archiv opens in. A stored value that is
 * neither (the removed third view) falls back to cards rather than surviving as
 * a dead one.
 */
export function useViewPreference(): readonly [FileView, (next: FileView) => void] {
  const [view, setView] = useState<FileView>('cards')
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY)
      if (stored === 'cards' || stored === 'list') setView(stored)
    } catch {
      // Storage unavailable — the choice holds for this visit.
    }
  }, [])
  const select = useCallback((next: FileView) => {
    setView(next)
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next)
    } catch {
      // As above.
    }
  }, [])
  return [view, select] as const
}
