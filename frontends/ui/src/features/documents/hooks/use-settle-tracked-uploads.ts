'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useDocumentsStore } from '../store'
import type { TrackedFile } from '../types'
import {
  isJoblessIngesting,
  nextStatusBatch,
  readDocumentStatuses,
  trackedPatchFromStatus,
} from '../lib/document-status-reads'
import { useSettlingRefresh } from './use-settling-refresh'

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
 *
 * Two sources, so the tray does not depend on what the grid happens to show.
 * A row the workspace listing carries settles from it, for free: that listing
 * already follows its settling rows (`useSettlingRefresh`). A row it does NOT
 * carry — the „Von Piloti" filter narrows the listing to agent-authored
 * documents, so a person's own upload is never in it — is asked about by id,
 * on the same visibility-aware cadence, until it is terminal.
 *
 * Only rows without a job: a row with one belongs to the orchestrator, and two
 * writers racing on the same row is how a finished upload flickers back.
 *
 * @param documents The workspace's listing, fresh from its settling poll.
 * @param uploads This session's tray rows for the same collection.
 * @param options.fetcher Injected in tests.
 */
export function useSettleTrackedUploads(
  documents: readonly ListedDocument[],
  uploads: readonly TrackedFile[],
  { fetcher }: { fetcher?: typeof fetch } = {}
): void {
  const waiting = useMemo(() => uploads.filter(isJoblessIngesting), [uploads])

  useEffect(() => {
    if (waiting.length === 0) return
    const byId = new Map(documents.map((d) => [d.id, d]))
    const { updateTrackedFile } = useDocumentsStore.getState()
    for (const upload of waiting) {
      const row = byId.get(upload.serverFileId ?? '')
      const patch = row ? trackedPatchFromStatus(row.status, row.errorMessage) : null
      if (patch) updateTrackedFile(upload.id, patch)
    }
  }, [documents, waiting])

  // The rows the listing cannot answer for.
  const unlisted = useMemo(() => {
    const listed = new Set(documents.map((d) => d.id))
    return waiting.filter((upload) => !listed.has(upload.serverFileId ?? ''))
  }, [documents, waiting])
  const unlistedRef = useRef(unlisted)
  useEffect(() => {
    unlistedRef.current = unlisted
  }, [unlisted])
  const offset = useRef(0)

  const readUnlisted = useCallback(async () => {
    const rows = unlistedRef.current
    const ids = rows.map((upload) => upload.serverFileId ?? '').filter(Boolean)
    if (ids.length === 0) return
    const { batch, next } = nextStatusBatch(ids, offset.current)
    offset.current = next
    const reads = await readDocumentStatuses(batch, { fetcher })
    const { trackedFiles, updateTrackedFile } = useDocumentsStore.getState()
    for (const upload of rows) {
      const read = reads.get(upload.serverFileId ?? '')
      if (read?.kind !== 'row') continue
      // Re-checked against the store: the orchestrator may have settled it meanwhile.
      const current = trackedFiles.find((f) => f.id === upload.id)
      if (!current || !isJoblessIngesting(current)) continue
      const patch = trackedPatchFromStatus(read.fields.status, read.fields.errorMessage)
      if (patch) updateTrackedFile(upload.id, patch)
    }
  }, [fetcher])

  // `pending` rather than a status: these rows are not in any listing, and the
  // poll only needs to know that something is still owed an answer.
  const pollItems = useMemo(() => unlisted.map(() => ({ status: null, pending: true })), [unlisted])
  useSettlingRefresh(pollItems, readUnlisted)
}
