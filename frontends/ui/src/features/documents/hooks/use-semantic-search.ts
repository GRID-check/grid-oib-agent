'use client'

import { useCallback, useRef, useState } from 'react'
import type { FileItem } from '../components/project-file-workspace'

/**
 * A file browser result carrying its semantic-search match evidence: the base
 * {@link FileItem} plus WHY it matched — the best snippet, the page it came
 * from, and the 0..1 relevance score. Mirrors the backend's document-centric
 * search contract (`POST /v1/collections/{c}/search`).
 */
export interface SemanticHit extends FileItem {
  snippet: string
  page: number | null
  score: number
}

interface UseSemanticSearchOptions {
  /** BFF search route, e.g. `/api/documents/search` or `/api/archiv/documents/search`. */
  endpoint: string
  /** Extra body fields merged into every request (e.g. `{ projectId }`). */
  extraBody?: Record<string, unknown>
}

export interface SemanticSearchState {
  /** The committed query while semantic mode is active; `null` in the normal list. */
  query: string | null
  /** Whether semantic mode is showing (a query has been committed). */
  active: boolean
  hits: SemanticHit[]
  isSearching: boolean
  /** True when the last run failed/timed out — treated as an empty result set. */
  error: boolean
  /** Run the semantic search for `query` (fires on Enter/button, not per keystroke). */
  run: (query: string) => void
  /** Clear semantic mode and return to the normal list. */
  reset: () => void
}

/** Normalize a raw BFF search hit into a {@link SemanticHit} — the same field
 * mapping the workspaces apply to the plain document list, plus match evidence. */
function toSemanticHit(d: Record<string, unknown>): SemanticHit {
  return {
    id: d.id as string,
    filename: d.filename as string,
    displayName: (d.displayName as string | null) ?? null,
    fileSize: (d.fileSize as number | null) ?? null,
    contentType: (d.contentType as string | null) ?? null,
    status: (d.status as string | null) ?? null,
    folderId: (d.folderId as string | null) ?? null,
    createdAt: d.createdAt as string,
    errorMessage: (d.errorMessage as string | null) ?? null,
    summary: (d.summary as string | null) ?? null,
    pageCount: (d.pageCount as number | null) ?? null,
    chunkCount: (d.chunkCount as number | null) ?? null,
    contentTypes: (d.contentTypes as string[] | null) ?? null,
    tags: (d.tags as string[] | null) ?? null,
    snippet: (d.snippet as string | null) ?? '',
    page: (d.page as number | null) ?? null,
    score: typeof d.score === 'number' ? d.score : 0,
  }
}

/**
 * Explicit-run semantic search for a file browser. Keeps the committed query,
 * the joined hits, and the loading/error flags; a stale in-flight response is
 * ignored (request-id guard) so a fast reset or re-run always wins. The fetch
 * fires only from {@link SemanticSearchState.run} — never per keystroke.
 */
export function useSemanticSearch({ endpoint, extraBody }: UseSemanticSearchOptions): SemanticSearchState {
  const [query, setQuery] = useState<string | null>(null)
  const [hits, setHits] = useState<SemanticHit[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState(false)
  const requestId = useRef(0)

  const run = useCallback(
    (raw: string) => {
      const q = raw.trim()
      if (!q) return
      const id = ++requestId.current
      setQuery(q)
      setIsSearching(true)
      setError(false)

      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, ...extraBody }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`Search failed (${r.status})`)
          return r.json() as Promise<{ hits?: Array<Record<string, unknown>> }>
        })
        .then((data) => {
          if (requestId.current !== id) return
          setHits((data.hits ?? []).map(toSemanticHit))
        })
        .catch(() => {
          if (requestId.current !== id) return
          // Fail-open: surface as an empty result set, never a crash.
          setHits([])
          setError(true)
        })
        .finally(() => {
          if (requestId.current === id) setIsSearching(false)
        })
    },
    [endpoint, extraBody],
  )

  const reset = useCallback(() => {
    // Invalidate any in-flight response and drop back to the normal list.
    requestId.current++
    setQuery(null)
    setHits([])
    setIsSearching(false)
    setError(false)
  }, [])

  return { query, active: query !== null, hits, isSearching, error, run, reset }
}
