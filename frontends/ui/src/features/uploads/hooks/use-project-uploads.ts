'use client'

/** A project's uploads, newest first (ticket „Verlauf/Protokoll", ADR-0086). */

import { useCallback, useEffect, useState } from 'react'
import { listProjectUploads, type UploadHistoryEntry } from '@/adapters/api/upload-batches-client'

export type ProjectUploadsState =
  | { status: 'loading' }
  | { status: 'ready'; uploads: UploadHistoryEntry[] }
  | { status: 'error' }

export function useProjectUploads(projectId: string): { state: ProjectUploadsState; retry: () => void } {
  const [state, setState] = useState<ProjectUploadsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    listProjectUploads(projectId, controller.signal)
      .then((uploads) => setState({ status: 'ready', uploads }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })
    return () => controller.abort()
  }, [projectId, attempt])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  return { state, retry }
}
