'use client'

import { useEffect } from 'react'
import { documentStatusFacts } from '@/lib/documents/document-status'
import { isFailedStatus } from '../components/document-status'
import { useDocumentsStore } from '../store'
import type { TrackedFile } from '../types'

/** What this hook reads off a listing row. */
interface ListedDocument {
  id: string
  status: string | null
  errorMessage?: string | null
}

/**
 * Finish the upload tray's rows that no job will ever finish.
 *
 * The upload orchestrator settles a tray row by polling its ingest job. A
 * DETACHED extraction has none at upload time — an `.ifc`, and an office file
 * whose PDF rendition is converted before it is read — so the upload answers
 * `{ jobId: null, status: 'processing' }` and the row sat at "Wird
 * verarbeitet…" after the document had long been ready in the grid beside it.
 * The listing the workspace already polls (`useSettlingRefresh`) is the one
 * read that follows those documents to the end, so it settles their rows too.
 *
 * Only rows without a job: a row with one belongs to the orchestrator, and two
 * writers racing on the same row is how a finished upload flickers back.
 *
 * @param documents The workspace's listing, fresh from its settling poll.
 * @param uploads This session's tray rows for the same collection.
 */
export function useSettleTrackedUploads(
  documents: readonly ListedDocument[],
  uploads: readonly TrackedFile[]
): void {
  useEffect(() => {
    const waiting = uploads.filter((u) => u.status === 'ingesting' && !u.jobId && u.serverFileId)
    if (waiting.length === 0) return
    const byId = new Map(documents.map((d) => [d.id, d]))
    const { updateTrackedFile } = useDocumentsStore.getState()
    for (const upload of waiting) {
      const row = byId.get(upload.serverFileId ?? '')
      // A status this build does not know is not an answer either way.
      if (documentStatusFacts(row?.status)?.phase !== 'terminal') continue
      updateTrackedFile(
        upload.id,
        isFailedStatus(row?.status)
          ? { status: 'failed', errorMessage: row?.errorMessage ?? undefined }
          : { status: 'success', progress: 100 }
      )
    }
  }, [documents, uploads])
}
