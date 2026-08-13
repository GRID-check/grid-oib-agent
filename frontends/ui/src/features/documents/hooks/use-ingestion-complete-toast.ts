'use client'

import { useEffect, useRef } from 'react'
import { isCitableStatus } from '../components/document-status'

interface StatusTrackedFile {
  id: string
  status: string | null
}

/** Fields the diff reads; the callback receives the full item it was given. */

/**
 * Fires a callback the exact instant a tracked document transitions INTO a
 * citable status (async ingestion finished), exactly once per file.
 *
 * Detection is a previous-vs-current status diff over the durable document list:
 * a file that was non-citable on the prior render and is citable now just became
 * usable. A file that is already citable the first time it is seen (e.g. every
 * document on the initial page load, or a refresh) does NOT fire — only a real
 * transition does — so the confirmation is tied to the completion event, not to
 * merely observing an indexed document. A per-id guard makes it idempotent
 * across re-renders and duplicate list reloads.
 *
 * Shared by the project Files and org Archiv workspaces (each supplies its own
 * provenance-correct toast via {@link onCitable}).
 */
export function useIngestionCompleteToast<T extends StatusTrackedFile>(
  files: T[],
  onCitable: (file: T) => void
): void {
  const previousStatuses = useRef<Map<string, string | null>>(new Map())
  const alreadyToasted = useRef<Set<string>>(new Set())
  // Keep the latest callback without making it an effect dependency, so a fresh
  // inline closure each render never re-runs the diff (which would re-scan an
  // unchanged list).
  const onCitableRef = useRef<(file: T) => void>(onCitable)
  onCitableRef.current = onCitable

  useEffect(() => {
    const previous = previousStatuses.current
    for (const file of files) {
      const seenBefore = previous.has(file.id)
      const wasCitable = isCitableStatus(previous.get(file.id))
      if (seenBefore && !wasCitable && isCitableStatus(file.status) && !alreadyToasted.current.has(file.id)) {
        alreadyToasted.current.add(file.id)
        onCitableRef.current(file)
      }
    }

    const next = new Map<string, string | null>()
    for (const file of files) next.set(file.id, file.status)
    previousStatuses.current = next
  }, [files])
}
