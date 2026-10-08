'use client'

/**
 * A project's uploads, newest first (ticket „Verlauf/Protokoll", ADR-0083),
 * one keyset page at a time: the first page on mount, each older one when the
 * reader asks for it, so no upload falls off the end of the list.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { listProjectUploads, type UploadHistoryEntry } from '@/adapters/api/upload-batches-client'

export type ProjectUploadsState =
  | { status: 'loading' }
  | {
      status: 'ready'
      uploads: UploadHistoryEntry[]
      /** Where the next older page starts; `null` once the list is complete. */
      nextCursor: string | null
      /** The older page being read, or why it could not be. */
      more: 'idle' | 'loading' | 'error'
    }
  | { status: 'error' }

export function useProjectUploads(projectId: string): {
  state: ProjectUploadsState
  retry: () => void
  loadMore: () => void
} {
  const [state, setState] = useState<ProjectUploadsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // The project's controller, so an older page still in flight is dropped when
  // the project changes or the list reloads.
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ status: 'loading' })
    listProjectUploads(projectId, { signal: controller.signal })
      .then(({ uploads, nextCursor }) => setState({ status: 'ready', uploads, nextCursor, more: 'idle' }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })
    return () => controller.abort()
  }, [projectId, attempt])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  const loadMore = useCallback(() => {
    if (state.status !== 'ready' || !state.nextCursor || state.more === 'loading') return
    const controller = controllerRef.current
    const cursor = state.nextCursor
    setState({ ...state, more: 'loading' })
    listProjectUploads(projectId, { cursor, signal: controller?.signal })
      .then((page) =>
        setState((current) =>
          current.status === 'ready' && current.nextCursor === cursor
            ? { status: 'ready', uploads: [...current.uploads, ...page.uploads], nextCursor: page.nextCursor, more: 'idle' }
            : current
        )
      )
      .catch(() => {
        if (controller?.signal.aborted) return
        setState((current) => (current.status === 'ready' ? { ...current, more: 'error' } : current))
      })
  }, [projectId, state])

  return { state, retry, loadMore }
}
