'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** How long "Rückgängig" stays on offer. Long enough for a thumb, short enough to stay a toast. */
export const ARCHIVE_UNDO_MS = 5000

export interface UndoableArchive {
  /** Ids the reader archived whose write has not been sent yet: hide them. */
  pendingIds: ReadonlySet<string>
  /** Hides the row now and sends the archive after the undo window. */
  request: (itemId: string) => void
  /** Brings the row back and sends nothing. */
  undo: (itemId: string) => void
}

/**
 * Archiving that can be taken back within a toast's lifetime.
 *
 * The write itself is what waits: the row leaves the list at once (that is the
 * feedback), and the request is sent when the undo window closes. Undo inside
 * the window therefore never touches the server, and cannot half-succeed. After
 * the window, the row is under „Archiviert“, which restores it
 * (`DELETE /api/inbox/:id/archive`).
 *
 * Anything still waiting is sent when the list goes away (a route change, the
 * sheet closing) and when the page is hidden, so leaving never turns an
 * archive the reader asked for into a row that comes back.
 */
export function useUndoableArchive(
  archive: (itemId: string) => Promise<void>,
  delayMs: number = ARCHIVE_UNDO_MS,
): UndoableArchive {
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // The latest `archive`, so a timer set earlier never calls a stale closure.
  const archiveRef = useRef(archive)
  useEffect(() => {
    archiveRef.current = archive
  }, [archive])

  const forget = useCallback((itemId: string): void => {
    setPendingIds((current) => {
      if (!current.has(itemId)) return current
      const next = new Set(current)
      next.delete(itemId)
      return next
    })
  }, [])

  const commit = useCallback(
    (itemId: string): void => {
      const timer = timers.current.get(itemId)
      if (timer === undefined) return
      clearTimeout(timer)
      timers.current.delete(itemId)
      // A refused write leaves the row on the server, so once it is no longer
      // pending it simply comes back, with the list's own error beside it.
      void archiveRef.current(itemId).finally(() => forget(itemId))
    },
    [forget],
  )

  const request = useCallback(
    (itemId: string): void => {
      if (timers.current.has(itemId)) return
      setPendingIds((current) => new Set(current).add(itemId))
      timers.current.set(
        itemId,
        setTimeout(() => commit(itemId), delayMs),
      )
    },
    [commit, delayMs],
  )

  const undo = useCallback(
    (itemId: string): void => {
      const timer = timers.current.get(itemId)
      if (timer === undefined) return
      clearTimeout(timer)
      timers.current.delete(itemId)
      forget(itemId)
    },
    [forget],
  )

  useEffect(() => {
    const flush = (): void => {
      for (const itemId of [...timers.current.keys()]) commit(itemId)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [commit])

  return { pendingIds, request, undo }
}
