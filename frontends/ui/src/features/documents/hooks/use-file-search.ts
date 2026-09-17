'use client'

import { useCallback, useMemo, useState } from 'react'
import { useSemanticSearch, type SemanticSearchState } from './use-semantic-search'

/**
 * The two-mode file search, as one value a caller can hold and hand around.
 *
 * Typing filters the current listing by substring, instantly. Committing the
 * query (Enter, or the run button) asks the backend for a vector search over
 * the whole project corpus. The two must never show a stale mix, which is the
 * one rule this hook exists to keep: any edit to the query drops semantic mode.
 *
 * It is a hook rather than state inside the browser pane because the field and
 * the results no longer live in the same box — Files renders the field in the
 * page header and the results below it, so the state has to be owned above
 * both.
 */
export interface FileSearch {
  /** What is in the field right now (drives the substring filter). */
  query: string
  /** Edit the query. Drops back out of semantic mode. */
  setQuery: (value: string) => void
  /** Commit the query to the semantic search. No-op when it is unavailable. */
  run: () => void
  /** Empty the field and leave semantic mode. */
  clear: () => void
  /** Whether the explicit-run semantic search is reachable at all. */
  canSearch: boolean
  semantic: SemanticSearchState
}

/**
 * @param projectId Corpus the semantic search queries. Omit to offer the
 * substring filter alone — `canSearch` then reports false and the run control
 * is not drawn.
 */
export function useFileSearch({ projectId }: { projectId?: string }): FileSearch {
  const [query, setQueryState] = useState('')
  const extraBody = useMemo(() => ({ projectId }), [projectId])
  const semantic = useSemanticSearch({ endpoint: '/api/documents/search', extraBody })
  const canSearch = projectId !== undefined

  const setQuery = useCallback(
    (value: string) => {
      setQueryState(value)
      if (semantic.active) semantic.reset()
    },
    [semantic]
  )

  const run = useCallback(() => {
    if (canSearch) semantic.run(query)
  }, [canSearch, query, semantic])

  const clear = useCallback(() => {
    setQueryState('')
    semantic.reset()
  }, [semantic])

  return { query, setQuery, run, clear, canSearch, semantic }
}
