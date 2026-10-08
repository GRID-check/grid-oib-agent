'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toFileItem, type DocumentWireRow } from '../lib/file-item'
import { fetchListingPages, type ListingPage } from '../lib/fetch-listing-pages'
import type { FileItem } from '../file-types'
import type { ShelfEndpoints } from '../lib/file-shelf'
import { useSettlingRefresh } from './use-settling-refresh'
import { useSettlingStatusReads } from './use-settling-status-reads'

interface ListingBody extends ListingPage<DocumentWireRow> {
  collectionName?: string
}

export interface FileListingOptions {
  endpoints: Pick<ShelfEndpoints, 'list' | 'listParams'>
  /** The two filters the SERVER answers; each is a refetch, not a predicate. */
  agentAuthoredOnly: boolean
  includeArchived: boolean
  /** The first paint as the server already read it. Absent means "ask". */
  initialFiles?: readonly DocumentWireRow[]
  /** Whether `initialFiles` is the whole shelf; false reads the rest quietly. */
  initialFilesComplete?: boolean
}

/**
 * One shelf's documents: the full drain, and the guarantees around it.
 *
 * The project workspace and the Archiv both load through this hook.
 *
 * ## Only the LATEST request may commit its answer
 *
 * `useSettlingRefresh` serialises its own polls, but a poll already in flight
 * can still land after a FOREGROUND load (mount, upload settled, retry). A slow
 * poll carrying `processing` landing after a newer load carrying `ready` would
 * regress a badge the user was just told had flipped, and restart the poll. A
 * monotonic generation stamped when the request goes out and re-checked before
 * every state write makes the newest request the only one that can win.
 */
export function useFileListing({
  endpoints,
  agentAuthoredOnly,
  includeArchived,
  initialFiles,
  initialFilesComplete = true,
}: FileListingOptions) {
  const [files, setFiles] = useState<FileItem[]>(() => (initialFiles ?? []).map(toFileItem))
  // Seeded means loaded: starting at `true` with the answer in state would draw
  // the skeleton over a listing this render could paint.
  const [isLoading, setIsLoading] = useState(initialFiles === undefined)
  const [error, setError] = useState(false)
  /** The drain stopped at its page ceiling: older documents are not loaded. */
  const [truncated, setTruncated] = useState(false)
  const [collectionName, setCollectionName] = useState<string | undefined>(undefined)
  const loadGeneration = useRef(0)

  const settlingReads = useSettlingStatusReads(files, setFiles)
  const { beginLoad } = settlingReads
  // Re-ask while anything is still being read, and stop once all is terminal.
  useSettlingRefresh(files, settlingReads.tick)

  const { list, listParams } = endpoints
  const paramsKey = JSON.stringify(listParams ?? {})

  /** @param quiet Refresh without the skeleton — a reload behind a grid being read. */
  const load = useCallback(
    (quiet = false) => {
      const generation = ++loadGeneration.current
      const withNewerReads = beginLoad()
      const isStale = () => generation !== loadGeneration.current
      if (!quiet) setIsLoading(true)
      setError(false)
      const params = new URLSearchParams(JSON.parse(paramsKey) as Record<string, string>)
      if (agentAuthoredOnly) params.set('authoredBy', 'agent')
      if (includeArchived) params.set('includeArchived', 'true')
      const query = params.toString()
      // Every page: search, filters, folder counts and the upload plan all read
      // `files` as the shelf's corpus (fetch-listing-pages.ts).
      return fetchListingPages<DocumentWireRow, ListingBody>(query ? `${list}?${query}` : list)
        .then(({ first, documents, truncated: stoppedEarly }) => {
          if (isStale()) return
          setCollectionName(first.collectionName)
          setFiles(withNewerReads(documents.map(toFileItem)))
          setTruncated(stoppedEarly)
        })
        .catch(() => {
          // A failed POLL must not empty a list being read; only a foreground
          // load owns the error state, and only while it is still the latest.
          if (quiet || isStale()) return
          setFiles([])
          setError(true)
        })
        .finally(() => {
          // Deliberately NOT generation-guarded: the spinner belongs to the
          // foreground loads, and a quiet poll starting mid-load would
          // otherwise leave it spinning with nobody left to clear it.
          if (!quiet) setIsLoading(false)
        })
    },
    [list, paramsKey, agentAuthoredOnly, includeArchived, beginLoad]
  )

  // Through a ref so the orchestrator subscription is made once, and quiet
  // because the grid is already on screen.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])
  const reloadQuietly = useCallback(() => void loadRef.current(true), [])

  // The seeded first render is the answer, so the mount load is skipped once —
  // by the first run of this effect, not by a condition still true when `load`
  // changes identity (a filter flip is a request for another listing).
  const seeded = useRef(initialFiles !== undefined && initialFilesComplete)
  const seededPartially = useRef(initialFiles !== undefined && !initialFilesComplete)
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false
      return
    }
    const quiet = seededPartially.current
    seededPartially.current = false
    void load(quiet)
  }, [load])

  return { files, setFiles, isLoading, error, truncated, collectionName, load, reloadQuietly }
}
