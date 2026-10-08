'use client'

/**
 * The import dialog's state (ADR-0085): the project's imports, polled while
 * the dialog is open and something is running, and the one archive this tab is
 * sending, if any.
 *
 * Sending lives here and not on the server because only this tab holds the
 * file. Closing the dialog does not stop it (the controller survives), leaving
 * the page does, and the row then reads `uploading` until the person chooses
 * the same file again to resume or cancels it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelMailImport,
  fetchMailImports,
  resumeMailImport,
  sendMailArchive,
  startMailImport,
} from '@/lib/mail-import/client'
import type { MailImportList, MailImportUploadPlan, MailImportView } from '@/lib/mail-import/types'

/** How often a running import is re-read while the dialog is open. */
const POLL_MS = 5_000

export interface MailImportSend {
  importId: string
  filename: string
  sentBytes: number
  totalBytes: number
}

export interface UseMailImports {
  list: MailImportList | null
  loadError: boolean
  sending: MailImportSend | null
  sendError: string | null
  start: (file: File) => Promise<void>
  resume: (row: MailImportView, file: File) => Promise<void>
  cancel: (row: MailImportView) => Promise<boolean>
}

export function useMailImports(projectId: string, open: boolean): UseMailImports {
  const [list, setList] = useState<MailImportList | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [sending, setSending] = useState<MailImportSend | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  const reload = useCallback(async () => {
    try {
      setList(await fetchMailImports(projectId))
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [projectId])

  const running = list?.imports.some((row) => row.status === 'queued' || row.status === 'importing') ?? false
  const isSending = sending !== null
  useEffect(() => {
    if (!open) return
    void reload()
    if (!running && !isSending) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [open, running, isSending, reload])

  // Leaving the page is the one thing that stops a send.
  useEffect(() => () => controller.current?.abort(), [])

  const send = useCallback(
    async (plan: MailImportUploadPlan, file: File) => {
      const abort = new AbortController()
      controller.current = abort
      setSendError(null)
      setSending({ importId: plan.import.id, filename: file.name, sentBytes: 0, totalBytes: file.size })
      try {
        await sendMailArchive(
          projectId,
          plan,
          file,
          ({ sentBytes, totalBytes }) =>
            setSending({ importId: plan.import.id, filename: file.name, sentBytes, totalBytes }),
          abort.signal,
        )
      } catch (error) {
        if (!abort.signal.aborted) setSendError(error instanceof Error ? error.message : String(error))
      } finally {
        controller.current = null
        setSending(null)
        await reload()
      }
    },
    [projectId, reload],
  )

  const start = useCallback(
    async (file: File) => {
      try {
        await send(await startMailImport(projectId, file), file)
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error))
      }
    },
    [projectId, send],
  )

  const resume = useCallback(
    async (row: MailImportView, file: File) => {
      try {
        await send(await resumeMailImport(projectId, row.id), file)
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error))
      }
    },
    [projectId, send],
  )

  const cancel = useCallback(
    async (row: MailImportView) => {
      if (sending?.importId === row.id) controller.current?.abort()
      try {
        await cancelMailImport(projectId, row.id)
        return true
      } catch {
        return false
      } finally {
        await reload()
      }
    },
    [projectId, reload, sending],
  )

  return { list, loadError, sending, sendError, start, resume, cancel }
}
