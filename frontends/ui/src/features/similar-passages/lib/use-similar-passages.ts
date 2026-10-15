'use client'

/**
 * „Im Büro behandelt" as state a viewer holds: which passage is being searched
 * from, which similar passage is open on the stage, and the search itself.
 *
 * Two hooks, because two different things own them. The search
 * ({@link useSimilarPassages}) belongs to the panel that lists its answer; what
 * is on the stage ({@link useSimilarPassagesViewer}) belongs to the dialog that
 * draws the document, so the citation viewer and the Files viewer open a hit
 * the same way.
 */

import { useCallback, useEffect, useState } from 'react'
import { capturePosthog } from '@/lib/analytics/posthog'
import { fetchSimilarPassages, SimilarPassagesError, type SimilarPassagesFailure } from '@/lib/similar-passages/client'
import type {
  SimilarGroupKind,
  SimilarPassagesRequest,
  SimilarPassagesResponse,
} from '@/lib/similar-passages/types'
import { similarDocumentsOf } from '@/lib/similar-passages/types'
import { documentFileUrl } from '@/lib/documents/urls'

/** How the panel asks; the real client unless a preview hands it a fixture. */
export type SimilarPassagesLoader = (
  request: SimilarPassagesRequest,
  signal: AbortSignal
) => Promise<SimilarPassagesResponse>

export const loadSimilarPassages: SimilarPassagesLoader = (request, signal) =>
  fetchSimilarPassages(request, { signal })

export type SimilarPassagesState =
  | { status: 'loading' }
  | { status: 'ready'; response: SimilarPassagesResponse }
  | { status: 'error'; failure: SimilarPassagesFailure }

/** The search for one source passage; a new request (or a retry) asks again and abandons the old answer. */
export function useSimilarPassages(
  request: SimilarPassagesRequest,
  load: SimilarPassagesLoader = loadSimilarPassages
): { state: SimilarPassagesState; retry: () => void } {
  const [state, setState] = useState<SimilarPassagesState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // The request's identity is its content: a parent that rebuilds the object
  // on every render must not search again for the same passage.
  const key = JSON.stringify(request)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    load(JSON.parse(key) as SimilarPassagesRequest, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        setState({ status: 'ready', response })
        // Counts and kinds only: never the passage, a document or a project name.
        capturePosthog('similar_passages_searched', {
          entry: (JSON.parse(key) as SimilarPassagesRequest).passage.cited ? 'citation' : 'selection',
          origin: response.origin,
          groups: response.groups.length,
          documents: similarDocumentsOf(response).length,
          projects_searched: response.projectsSearched,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', failure: error instanceof SimilarPassagesError ? error.reason : 'failed' })
      })
    return () => controller.abort()
  }, [key, load, attempt])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  return { state, retry }
}

/** A similar passage as the stage opens it. */
export interface OpenedPassage {
  /** Stable within one answer: which passage the panel marks as open. */
  key: string
  documentId: string
  filename: string
  title: string
  contentType: string | null
  page: number | null
  snippet: string
  groupKind: SimilarGroupKind
  /** Where it is, as the rail names its group: „Dieses Projekt", a project's name, „Büroablage". */
  groupLabel: string
  /** The document's place in the answer, 0 = best. */
  rank: number
}

/** What a viewer shows while a similar passage is open: the document, at the passage, marked. */
export interface SimilarStage {
  src: string
  fileName: string
  title: string
  page: number | null
  highlight: string
  isImage: boolean
}

/** Where a stored document's bytes stream from; a preview passes fixture URLs instead. */
export type DocumentSrcOf = (documentId: string) => string

export const stageOf = (opened: OpenedPassage, srcOf: DocumentSrcOf = documentFileUrl): SimilarStage => ({
  // Same-origin stream: the viewer reads the bytes to find the passage (`documentFileUrl`).
  src: srcOf(opened.documentId),
  fileName: opened.filename,
  title: opened.title,
  page: opened.page,
  highlight: opened.snippet,
  isImage: (opened.contentType ?? '').toLowerCase().startsWith('image/'),
})

/** The viewer's side: the passage searched from, and the similar passage on the stage. */
export function useSimilarPassagesViewer(): {
  request: SimilarPassagesRequest | null
  opened: OpenedPassage | null
  start: (request: SimilarPassagesRequest) => void
  open: (passage: OpenedPassage) => void
  backToSource: () => void
  close: () => void
} {
  const [request, setRequest] = useState<SimilarPassagesRequest | null>(null)
  const [opened, setOpened] = useState<OpenedPassage | null>(null)

  const start = useCallback((next: SimilarPassagesRequest) => {
    setRequest(next)
    setOpened(null)
  }, [])
  const open = useCallback((passage: OpenedPassage) => {
    setOpened(passage)
    capturePosthog('similar_passage_opened', { group: passage.groupKind, rank: passage.rank })
  }, [])
  const backToSource = useCallback(() => setOpened(null), [])
  const close = useCallback(() => {
    setRequest(null)
    setOpened(null)
  }, [])
  return { request, opened, start, open, backToSource, close }
}
