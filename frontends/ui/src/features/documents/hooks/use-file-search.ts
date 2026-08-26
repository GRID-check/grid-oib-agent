'use client'

import { useCallback, useMemo, useState } from 'react'
import type { FileItem } from '../components/project-file-workspace'
import { documentDisplayName } from '@/lib/documents/display-name'
import { useSemanticSearch, type SemanticSearchState } from './use-semantic-search'

/**
 * The instant, client-side filter over a listing that is already in memory:
 * name, plus the AI tags and summary once the backend has produced them.
 *
 * Both names, deliberately: somebody who renamed a document looks for what they
 * called it, and somebody who uploaded it looks for the file they sent.
 */
export function filterDocumentsByQuery<T extends FileItem>(files: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return files
  return files.filter(
    (f) =>
      documentDisplayName(f).toLowerCase().includes(q) ||
      f.filename.toLowerCase().includes(q) ||
      (f.summary ?? '').toLowerCase().includes(q) ||
      (f.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
  )
}

export interface FileSearchState {
  /** What is in the field right now (drives the instant substring filter). */
  query: string
  /** Type into the field. Any edit drops semantic mode — see below. */
  setQuery: (value: string) => void
  /** Commit the query (Enter / the run button). No-op when semantic is off. */
  submit: () => void
  /** Empty the field and leave semantic mode. */
  clear: () => void
  /** Whether the explicit-run semantic search is available on this surface. */
  canSearch: boolean
  semantic: SemanticSearchState
  /** The instant filter, bound to the current query. */
  filter: <T extends FileItem>(files: T[]) => T[]
}

/**
 * Search for one file surface: the typed query, the explicit-run semantic
 * search over its corpus, and the instant substring filter over what is already
 * listed.
 *
 * It exists so the WORKSPACE can own the search while the PANE renders the
 * results — the field sits in the page header and the listing is a scroll
 * container two levels down, so the state cannot live in either of them alone.
 * Both surfaces had their own copy of these four handlers before, and they had
 * already drifted apart in whether an edit reset semantic mode.
 *
 * @param canSearch pass `false` where no semantic endpoint is reachable (the
 * substring filter keeps working; the run button is simply absent).
 */
export function useFileSearch({
  endpoint,
  extraBody,
  canSearch = true,
}: {
  endpoint: string
  extraBody?: Record<string, unknown>
  canSearch?: boolean
}): FileSearchState {
  const [query, setQueryState] = useState('')
  const semantic = useSemanticSearch({ endpoint, extraBody })

  // Any edit to the query drops back to the live substring filter so the two
  // modes never show a stale mix; the reset control does the same explicitly.
  const setQuery = useCallback(
    (value: string) => {
      setQueryState(value)
      if (semantic.active) semantic.reset()
    },
    [semantic]
  )

  const submit = useCallback(() => {
    if (canSearch) semantic.run(query)
  }, [canSearch, semantic, query])

  const clear = useCallback(() => {
    setQueryState('')
    semantic.reset()
  }, [semantic])

  const filter = useCallback(
    <T extends FileItem>(files: T[]): T[] => filterDocumentsByQuery(files, query),
    [query]
  )

  return useMemo(
    () => ({ query, setQuery, submit, clear, canSearch, semantic, filter }),
    [query, setQuery, submit, clear, canSearch, semantic, filter]
  )
}
