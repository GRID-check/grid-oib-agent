'use client'

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { isSettlingStatus } from '../components/document-status'
import type { FileItem } from '../components/project-file-workspace'
import {
  mergeStatusReads,
  nextStatusBatch,
  readDocumentStatuses,
  type DocumentStatusRead,
} from '../lib/document-status-reads'

interface HeldRead {
  /** Sequence number of the tick that asked. */
  at: number
  read: DocumentStatusRead
}

export interface SettlingStatusReads<T extends FileItem> {
  /** The quiet settling tick: reads the settling rows by id and merges them in. */
  tick: () => Promise<void>
  /**
   * Call when a full listing load goes out; apply what it returns to the rows
   * before committing them. A tick answered AFTER the load was sent is newer
   * than that load's rows, so its reads are laid over them instead of lost.
   */
  beginLoad: () => (rows: T[]) => T[]
}

/**
 * The cheap half of a document list's refresh: what can change while rows
 * settle, read per row.
 *
 * `useSettlingRefresh` used to call the list loader itself, which drains every
 * listing page (up to 20 × 500 rows) — every four seconds, for as long as one
 * PDF was being read. Now the tick asks `/api/documents/{id}/status` for the
 * settling rows only, a bounded batch at a time and round-robin across a big
 * upload, and merges by id. The full drain stays with the loads that need the
 * corpus: mount, a filter change, an upload landing, an explicit retry.
 *
 * The two can cross. A drain sent before a tick and answered after it would
 * put the older rows back; {@link SettlingStatusReads.beginLoad} lays the
 * newer tick's reads over them, so the latest answer about a row wins
 * whichever request carried it.
 */
export function useSettlingStatusReads<T extends FileItem>(
  files: readonly T[],
  setFiles: Dispatch<SetStateAction<T[]>>,
  { fetcher }: { fetcher?: typeof fetch } = {}
): SettlingStatusReads<T> {
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  }, [files])
  const sequence = useRef(0)
  const offset = useRef(0)
  const held = useRef(new Map<string, HeldRead>())

  const tick = useCallback(async () => {
    const settling = filesRef.current.filter((file) => isSettlingStatus(file.status)).map((file) => file.id)
    if (settling.length === 0) return
    const { batch, next } = nextStatusBatch(settling, offset.current)
    offset.current = next
    const at = ++sequence.current
    const reads = await readDocumentStatuses(batch, { fetcher })
    if (reads.size === 0) return
    for (const [id, read] of reads) held.current.set(id, { at, read })
    setFiles((previous) => mergeStatusReads(previous, reads))
  }, [setFiles, fetcher])

  const beginLoad = useCallback(() => {
    const at = ++sequence.current
    return (rows: T[]) => {
      const newer = new Map<string, DocumentStatusRead>()
      for (const [id, entry] of held.current) {
        if (entry.at > at) newer.set(id, entry.read)
        else held.current.delete(id)
      }
      return mergeStatusReads(rows, newer)
    }
  }, [])

  return { tick, beginLoad }
}
