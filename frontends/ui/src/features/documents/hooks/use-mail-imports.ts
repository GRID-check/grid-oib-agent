'use client'

/**
 * The import dialog's state (ADR-0085): the project's imports, polled while
 * the dialog is open and something is running, and the archive this tab is
 * sending, if it is one of this project's.
 *
 * The send itself lives in `../lib/mail-import-send.ts`, outside React, so it
 * outlives the dialog and the page: only closing the tab stops it, and the
 * browser asks first. The row then reads `uploading` until the person chooses
 * the same file again to resume, or cancels it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  cancelMailImport,
  fetchMailImports,
  MailImportRequestError,
  resumeMailImport,
  startMailImport,
} from '@/lib/mail-import/client'
import type { MailImportList, MailImportView } from '@/lib/mail-import/types'
import {
  abortMailImportSend,
  clearMailImportSendFailure,
  failMailImportSend,
  isMailImportSending,
  MailImportSendBusyError,
  mailImportSendServerSnapshot,
  mailImportSendSnapshot,
  runMailImportSend,
  subscribeMailImportSend,
  type MailImportSend,
  type MailImportSendFailure,
} from '../lib/mail-import-send'

export type { MailImportSend } from '../lib/mail-import-send'

/** How often a running import is re-read while the dialog is open. */
const POLL_MS = 5_000

/** Why a send did not go through, as the dialog words it. Never the server's own (English) text. */
export type MailImportSendErrorKind =
  | 'busy'
  | 'alreadyRunning'
  | 'cancelled'
  | 'quota'
  | 'forbidden'
  | 'rejected'
  | 'connection'
  | 'unknown'

export interface UseMailImports {
  list: MailImportList | null
  loadError: boolean
  sending: MailImportSend | null
  sendError: MailImportSendErrorKind | null
  cancelError: boolean
  start: (file: File) => Promise<void>
  resume: (row: MailImportView, file: File) => Promise<void>
  cancel: (row: MailImportView) => Promise<boolean>
  dismissErrors: () => void
}

export function sendErrorKind(failure: Pick<MailImportSendFailure, 'stage' | 'error'>): MailImportSendErrorKind {
  const { error } = failure
  if (error instanceof MailImportSendBusyError) return 'busy'
  if (!(error instanceof MailImportRequestError)) return 'connection'
  if (error.code === 'PART_FAILED' || error.status === 0) return 'connection'
  if (error.status === 409) return failure.stage === 'start' ? 'alreadyRunning' : 'cancelled'
  if (error.status === 507) return 'quota'
  if (error.status === 401 || error.status === 403) return 'forbidden'
  if (error.status === 400 || error.status === 413 || error.status === 422) return 'rejected'
  if (error.status === 429 || error.status >= 500) return 'connection'
  return 'unknown'
}

export function useMailImports(projectId: string, open: boolean): UseMailImports {
  const [list, setList] = useState<MailImportList | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [cancelError, setCancelError] = useState(false)
  const shared = useSyncExternalStore(subscribeMailImportSend, mailImportSendSnapshot, mailImportSendServerSnapshot)
  const sending = shared.send?.projectId === projectId ? shared.send : null
  const failure = shared.failure?.projectId === projectId ? shared.failure : null

  // Only the newest answer is shown: a slow poll must not overwrite a fresher one.
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const ticket = ++latest.current
    try {
      const next = await fetchMailImports(projectId)
      if (ticket !== latest.current) return
      setList(next)
      setLoadError(false)
    } catch {
      // One failed poll keeps what is shown; only a list never loaded is an error.
      if (ticket === latest.current) setLoadError(true)
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
    // `isSending` is a dependency so that the end of a send reloads the list at once.
  }, [open, running, isSending, reload])

  const start = useCallback(
    async (file: File) => {
      clearMailImportSendFailure()
      // Asked before the server makes a row, which a refused send would leave behind.
      if (isMailImportSending()) return failMailImportSend(projectId, new MailImportSendBusyError())
      let plan
      try {
        plan = await startMailImport(projectId, file)
      } catch (error) {
        failMailImportSend(projectId, error)
        return
      }
      await runMailImportSend(projectId, plan, file)
    },
    [projectId],
  )

  const resume = useCallback(
    async (row: MailImportView, file: File) => {
      clearMailImportSendFailure()
      if (isMailImportSending()) return failMailImportSend(projectId, new MailImportSendBusyError())
      let plan
      try {
        plan = await resumeMailImport(projectId, row.id)
      } catch (error) {
        failMailImportSend(projectId, error)
        return
      }
      await runMailImportSend(projectId, plan, file)
    },
    [projectId],
  )

  const cancel = useCallback(
    async (row: MailImportView) => {
      setCancelError(false)
      abortMailImportSend(row.id)
      try {
        await cancelMailImport(projectId, row.id)
        return true
      } catch {
        setCancelError(true)
        return false
      } finally {
        await reload()
      }
    },
    [projectId, reload],
  )

  const dismissErrors = useCallback(() => {
    clearMailImportSendFailure()
    setCancelError(false)
  }, [])

  return {
    list,
    loadError: loadError && list === null,
    sending,
    sendError: failure ? sendErrorKind(failure) : null,
    cancelError,
    start,
    resume,
    cancel,
    dismissErrors,
  }
}
