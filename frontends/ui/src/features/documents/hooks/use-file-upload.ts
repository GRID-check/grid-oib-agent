/**
 * useFileUpload Hook
 *
 * Simplified hook for file upload operations.
 * Delegates complex orchestration (polling, persistence, session management)
 * to the UploadOrchestrator service.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useLocale, useTranslations } from '@/i18n'
import { createDocumentsClient } from '@/adapters/api'
import { xhrUpload, XhrUploadError } from '@/lib/http/xhr-upload'
import { useDocumentsStore } from '../store'
import { useAuth } from '@/adapters/auth'
import { useAppConfig } from '@/shared/context'
import { useLayoutStore } from '@/features/layout/store'
import type { TrackedFile } from '../types'
import { mapUploadResponseStatus } from '../utils'
import { distributeBatchBytes, shouldEmitProgress } from '../lib/upload-progress'
import { runWithConcurrency, UPLOAD_CONCURRENCY } from '../lib/upload-queue'
import { validateFileUpload, type ValidationContext } from '../validation'
import { UploadOrchestrator } from '../orchestrator'
import type { PendingJob } from '../orchestrator'
import { markSessionHasCollection } from '../persistence'

/** The durable-upload endpoints' response (`/api/documents/upload`, `/api/archiv/documents/upload`). */
interface UploadDocumentResponse {
  documentId?: string
  jobId?: string | null
  status?: string
}

/** A user-initiated cancel, not a failure — it must not colour a row red. */
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

/** The clearest sentence available about why an upload did not happen. */
const failureMessage = (error: unknown, fallback: string): string => {
  if (error instanceof XhrUploadError) {
    try {
      const body: unknown = JSON.parse(error.responseText)
      const message = (body as { error?: unknown })?.error
      if (typeof message === 'string' && message) return message
    } catch {
      // Not JSON — fall through to the transport's own message.
    }
  }
  return error instanceof Error ? error.message : fallback
}

interface UseFileUploadOptions {
  collectionName?: string
  projectId?: string
  folderId?: string
  /**
   * Upload into the org-wide Archiv instead of a project corpus. Mutually
   * exclusive with `projectId`: files POST to `/api/archiv/documents/upload`
   * (the org is resolved server-side from the session) and land in the shared
   * `archiv_<orgId>` collection passed as `collectionName`.
   */
  archiv?: boolean
  onComplete?: () => void
  onError?: (error: Error) => void
}

interface UseFileUploadReturn {
  uploadFiles: (files: File[], collectionOverride?: string) => Promise<void>
  cancelUpload: () => void
  /** Abort one in-flight file, leaving the rest of the batch running. */
  cancelFile: (fileId: string) => void
  /** Drop settled rows (done, failed, canceled) from the upload surface. */
  dismissFiles: (fileIds: string[]) => void
  deleteFile: (fileId: string) => Promise<void>
  retryFile: (fileId: string) => Promise<void>
  trackedFiles: TrackedFile[]
  sessionFiles: TrackedFile[]
  validationContext: ValidationContext
  isUploading: boolean
  isPolling: boolean
  error: string | null
  clearError: () => void
}

export const useFileUpload = (options: UseFileUploadOptions = {}): UseFileUploadReturn => {
  const { collectionName, projectId, folderId, archiv, onComplete, onError } = options

  const { idToken } = useAuth()
  const t = useTranslations('files')
  // The APP's locale, not the runtime's: a size named in a validation error must
  // be punctuated like the one on the file card beside it, and the user may be
  // reading the app in German on an English-locale browser.
  const { locale } = useLocale()
  const { fileUpload: fileUploadConfig } = useAppConfig()
  const clientRef = useRef(createDocumentsClient({ authToken: idToken }))
  const previousSessionIdRef = useRef<string | undefined>(undefined)
  /**
   * One abort handle per in-flight request, keyed by tracked-file id. Per-file
   * rather than one for the batch: a 150 MB model that the user changed their
   * mind about must be abandonable without taking the eleven PDFs beside it
   * down too. (The session path sends the batch as a single request, so it
   * registers one handle under its first file's id.)
   */
  const abortControllersRef = useRef(new Map<string, AbortController>())

  const trackedFiles = useDocumentsStore((s) => s.trackedFiles)
  const isUploading = useDocumentsStore((s) => s.isUploading)
  const isPolling = useDocumentsStore((s) => s.isPolling)
  const error = useDocumentsStore((s) => s.error)
  const setCurrentCollection = useDocumentsStore((s) => s.setCurrentCollection)
  const setCollectionInfo = useDocumentsStore((s) => s.setCollectionInfo)
  const addTrackedFile = useDocumentsStore((s) => s.addTrackedFile)
  const updateTrackedFile = useDocumentsStore((s) => s.updateTrackedFile)
  const setUploadProgress = useDocumentsStore((s) => s.setUploadProgress)
  const removeTrackedFile = useDocumentsStore((s) => s.removeTrackedFile)
  const dismissTrackedFiles = useDocumentsStore((s) => s.dismissTrackedFiles)
  const unmarkRecentlyDeleted = useDocumentsStore((s) => s.unmarkRecentlyDeleted)
  const removeRecentlyDeletedIds = useDocumentsStore((s) => s.removeRecentlyDeletedIds)
  const setUploading = useDocumentsStore((s) => s.setUploading)
  const setError = useDocumentsStore((s) => s.setError)
  const clearError = useDocumentsStore((s) => s.clearError)

  const sessionFiles = useMemo(
    () => (collectionName ? trackedFiles.filter((f) => f.collectionName === collectionName) : []),
    [trackedFiles, collectionName]
  )

  const validationContext: ValidationContext = useMemo(
    () => ({
      existingTotalSize: sessionFiles.reduce((sum, f) => sum + f.fileSize, 0),
      existingFileCount: sessionFiles.length,
      existingFileNames: new Set(sessionFiles.map((f) => f.fileName)),
      durableCorpus: Boolean(projectId || archiv),
    }),
    [sessionFiles, projectId, archiv]
  )

  useEffect(() => {
    clientRef.current = createDocumentsClient({ authToken: idToken })
    UploadOrchestrator.setAuthToken(idToken)
  }, [idToken])

  useEffect(() => {
    UploadOrchestrator.setCallbacks({ onComplete, onError })
  }, [onComplete, onError])

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current

    if (collectionName !== previousSessionId) {
      UploadOrchestrator.handleSessionChange(collectionName)
      previousSessionIdRef.current = collectionName
    }
  }, [collectionName])

  // Retry file loading when knowledgeLayerAvailable becomes true.
  // On browser refresh, the initial loadFilesForSession call may fire before
  // fetchDataSources completes, causing it to skip because
  // knowledgeLayerAvailable is still false. This effect ensures we retry
  // once the knowledge layer is confirmed available.
  const knowledgeLayerAvailable = useLayoutStore((state) => state.knowledgeLayerAvailable)
  useEffect(() => {
    if (collectionName) {
      UploadOrchestrator.loadFilesForSession(collectionName)
    }
  }, [knowledgeLayerAvailable, collectionName])

  // Note: We intentionally don't cleanup the orchestrator on unmount.
  // The orchestrator is a singleton that manages polling across component lifecycles.
  // Cleanup happens via session changes (handleSessionChange) when user switches sessions.

  const ensureCollectionExists = useCallback(
    async (collectionName: string): Promise<void> => {
      let collection = await clientRef.current.getCollection(collectionName)

      if (!collection) {
        collection = await clientRef.current.createCollection(
          collectionName,
          `Documents for session ${collectionName}`
        )
      }

      // Mark this session as having a collection so future session switches
      // know to check the backend for files (prevents unnecessary 404s)
      markSessionHasCollection(collectionName)

      setCurrentCollection(collectionName)
      setCollectionInfo(collection)
    },
    [setCurrentCollection, setCollectionInfo]
  )

  const uploadFiles = useCallback(
    async (files: File[], collectionOverride?: string) => {
      if (files.length === 0) return

      // `collectionOverride` lets callers that just created the session
      // (ensureSession() immediately followed by an upload) target it without
      // waiting for a re-render: the memoized `collectionName` is captured
      // from the PREVIOUS render and is still undefined at that point.
      const targetCollection = collectionOverride ?? collectionName
      if (!targetCollection) {
        const uploadError = new Error('Collection name required for upload')
        setError(uploadError.message)
        onError?.(uploadError)
        return
      }

      const validationResult = validateFileUpload(files, validationContext, fileUploadConfig, locale)

      // Images rejected because no VLM is configured (flag on, capability off)
      // get a localized, specific reason so admins aren't puzzled by a generic
      // "unsupported type". Falls back to the validator's summary otherwise.
      const imageVlmBlocked = validationResult.fileErrors.some((e) => e.reason === 'image-vlm-unavailable')
      const imageVlmMessage = t('errors.imageVlmUnavailable')

      if (validationResult.batchErrors.length > 0) {
        setError(validationResult.summary)
        return
      }

      if (validationResult.validFiles.length === 0) {
        setError(imageVlmBlocked ? imageVlmMessage : validationResult.summary)
        return
      }

      const validFiles = validationResult.validFiles
      setUploading(true)

      if (validationResult.fileErrors.length > 0) {
        const skippedCount = validationResult.fileErrors.length
        const uploadingCount = validFiles.length
        setError(
          t('errors.uploadingSkipped', {
            uploading: uploadingCount,
            fileLabel: uploadingCount > 1 ? t('errors.filePlural') : t('errors.fileSingular'),
            skipped: skippedCount,
            summary: imageVlmBlocked ? imageVlmMessage : (validationResult.summary ?? ''),
          })
        )
      } else {
        clearError()
      }

      // Paired by INDEX, not by filename: two files selected in one batch can
      // legitimately share a name (from different folders), and a name-keyed map
      // silently drops one of them.
      const entries = validFiles.map((file) => ({
        file,
        tracked: {
          id: uuidv4(),
          file,
          fileName: file.name,
          fileSize: file.size,
          status: 'uploading',
          progress: 0,
          bytesUploaded: 0,
          collectionName: targetCollection,
          uploadedAt: new Date().toISOString(),
        } satisfies TrackedFile as TrackedFile,
      }))

      // Add tracked files to the store immediately so the upload surface shows
      // the whole batch — as queued rows — before any network call. Everything
      // the user dropped is accounted for from the first frame.
      for (const entry of entries) addTrackedFile(entry.tracked)

      try {
        await ensureCollectionExists(targetCollection)

        if (projectId || archiv) {
          // Project AND Archiv uploads persist a durable document row before
          // backend ingestion (unlike throwaway chat-session uploads). They
          // share the per-file POST; only the endpoint and form fields differ
          // (Archiv resolves the org server-side, no projectId/folderId).
          //
          // Several at a time, not one after another: each POST also writes to
          // object storage, checks the org quota and dispatches to the ingest
          // API, so a serial loop left the connection idle for most of every
          // file and made the batch take the SUM of all of them.
          const uploadUrl = archiv ? '/api/archiv/documents/upload' : '/api/documents/upload'
          const results = await runWithConcurrency(entries, UPLOAD_CONCURRENCY, async ({ file, tracked }) => {
            const controller = new AbortController()
            abortControllersRef.current.set(tracked.id, controller)
            // Getting a slot is what turns "queued" into "uploading" — the byte
            // count cannot say, because it is legitimately 0 for both.
            updateTrackedFile(tracked.id, { uploadStartedAt: Date.now() })

            const formData = new FormData()
            if (projectId) {
              formData.append('projectId', projectId)
              if (folderId) formData.append('folderId', folderId)
            }
            formData.append('file', file)

            let lastEmitted = 0
            try {
              const responseText = await xhrUpload({
                url: uploadUrl,
                body: formData,
                signal: controller.signal,
                onProgress: (loaded, total) => {
                  // `total` counts multipart framing too; scale back to the
                  // file's own bytes so the row's percentage is the file's.
                  const bytes = total > 0 ? Math.min(file.size, Math.round((loaded / total) * file.size)) : 0
                  if (!shouldEmitProgress(lastEmitted, bytes, file.size)) return
                  lastEmitted = bytes
                  setUploadProgress(tracked.id, bytes)
                },
              })

              const result = JSON.parse(responseText) as UploadDocumentResponse
              updateTrackedFile(tracked.id, {
                status: mapUploadResponseStatus(result.status),
                serverFileId: result.documentId,
                jobId: result.jobId ?? undefined,
                // Every byte is on the server now, whatever the last progress
                // event happened to say.
                bytesUploaded: file.size,
              })
            } catch (err) {
              if (isAbort(err)) {
                updateTrackedFile(tracked.id, { status: 'canceled' })
                return
              }
              // The failure belongs to THIS file. The other eleven documents in
              // an Einreichung are still wanted, and the row that refused is the
              // one that has to say so.
              const message = failureMessage(err, 'Upload failed')
              updateTrackedFile(tracked.id, { status: 'failed', errorMessage: message })
              throw err instanceof Error ? err : new Error(message)
            } finally {
              abortControllersRef.current.delete(tracked.id)
            }
          })

          const firstFailure = results.find((result) => result.status === 'rejected')
          if (firstFailure && firstFailure.status === 'rejected') {
            const failedCount = results.filter((result) => result.status === 'rejected').length
            const message = failureMessage(firstFailure.reason, 'Upload failed')
            setError(
              failedCount > 1
                ? t('errors.someUploadsFailed', { failed: failedCount, total: entries.length, reason: message })
                : message
            )
            onError?.(firstFailure.reason instanceof Error ? firstFailure.reason : new Error(message))
          }
        } else {
          // Session uploads go through the canonical collection documents API,
          // which takes the whole batch in ONE multipart request — so there is
          // one progress stream for all of them, split back out per file below.
          const controller = new AbortController()
          const batchKey = entries[0].tracked.id
          abortControllersRef.current.set(batchKey, controller)
          const startedAt = Date.now()
          for (const { tracked } of entries) updateTrackedFile(tracked.id, { uploadStartedAt: startedAt })

          const sizes = entries.map((entry) => entry.file.size)
          const lastEmitted = sizes.map(() => 0)

          try {
            const { job_id: jobId, file_ids: fileIds } = await clientRef.current.uploadFiles(
              targetCollection,
              validFiles,
              {
                signal: controller.signal,
                onProgress: (loaded, total) => {
                  distributeBatchBytes(loaded, total, sizes).forEach((bytes, index) => {
                    if (!shouldEmitProgress(lastEmitted[index], bytes, sizes[index])) return
                    lastEmitted[index] = bytes
                    setUploadProgress(entries[index].tracked.id, bytes)
                  })
                },
              }
            )
            removeRecentlyDeletedIds(fileIds)

            entries.forEach(({ file, tracked }, index) => {
              updateTrackedFile(tracked.id, {
                status: 'ingesting',
                serverFileId: fileIds[index],
                jobId,
                bytesUploaded: file.size,
              })
            })
          } finally {
            abortControllersRef.current.delete(batchKey)
          }
        }
      } catch (err) {
        if (isAbort(err)) {
          for (const { tracked } of entries) {
            const storeFile = useDocumentsStore.getState().trackedFiles.find((f) => f.id === tracked.id)
            if (storeFile?.status === 'uploading') updateTrackedFile(tracked.id, { status: 'canceled' })
          }
          return
        }
        const message = failureMessage(err, 'Upload failed')
        setError(message)
        onError?.(err instanceof Error ? err : new Error(message))

        // Only mark files that never reached the server as failed: anything
        // already accepted is ingesting server-side and must keep its real
        // status. (Per-file failures in the concurrent path above have already
        // marked themselves; this covers the batch-wide ones — a collection that
        // could not be created, a session upload that was refused whole.)
        for (const { tracked } of entries) {
          const storeFile = useDocumentsStore.getState().trackedFiles.find((f) => f.id === tracked.id)
          if (!storeFile || storeFile.serverFileId || storeFile.jobId) continue
          if (storeFile.status !== 'uploading') continue
          updateTrackedFile(tracked.id, { status: 'failed', errorMessage: message })
        }
      } finally {
        // Enqueue polling for every job the server accepted — including when
        // another file in the batch failed, otherwise those live jobs are
        // never polled and their rows stay stuck at "processing".
        const filesByJob = new Map<string, TrackedFile[]>()
        for (const { tracked } of entries) {
          const storeFile = useDocumentsStore.getState().trackedFiles.find((f) => f.id === tracked.id)
          if (!storeFile?.jobId) continue
          const files = filesByJob.get(storeFile.jobId) || []
          files.push(storeFile)
          filesByJob.set(storeFile.jobId, files)
        }

        const pendingJobEntries: PendingJob[] = []
        for (const [jobId, files] of filesByJob) {
          pendingJobEntries.push({ jobId, collectionName: targetCollection, files })
        }
        if (pendingJobEntries.length > 0) {
          UploadOrchestrator.enqueueJobs(pendingJobEntries)
        }
        setUploading(false)
      }
    },
    [
      collectionName,
      projectId,
      folderId,
      archiv,
      validationContext,
      fileUploadConfig,
      locale,
      ensureCollectionExists,
      addTrackedFile,
      updateTrackedFile,
      setUploadProgress,
      setUploading,
      clearError,
      setError,
      onError,
      removeRecentlyDeletedIds,
      t,
    ]
  )

  /**
   * Abandon one file. The request is aborted at the transport, so the bytes
   * stop moving immediately rather than finishing invisibly in the background,
   * and the row settles as `canceled` — a decision, not a failure.
   */
  const cancelFile = useCallback((fileId: string) => {
    abortControllersRef.current.get(fileId)?.abort()
  }, [])

  const cancelUpload = useCallback(() => {
    for (const controller of abortControllersRef.current.values()) controller.abort()
    abortControllersRef.current.clear()
    UploadOrchestrator.stopPolling()
    setUploading(false)
  }, [setUploading])

  /**
   * Take settled rows off the upload surface. A dismissal of the NOTICE — not
   * to be confused with `deleteFile`, which removes the document itself.
   */
  const dismissFiles = useCallback(
    (fileIds: string[]) => {
      dismissTrackedFiles(fileIds)
    },
    [dismissTrackedFiles]
  )

  const deleteFile = useCallback(
    async (fileId: string) => {
      const file = trackedFiles.find((f) => f.id === fileId)
      if (!file || !file.collectionName) {
        removeTrackedFile(fileId)
        return
      }

      const collectionName = file.collectionName
      const deleteId = file.serverFileId || file.fileName

      // Optimistic delete: remove from UI immediately, call API in background.
      // This prevents the file from reappearing if a concurrent server reload
      // returns stale data before the backend processes the delete.
      removeTrackedFile(fileId)

      try {
        await clientRef.current.deleteFiles(collectionName, [deleteId])
      } catch (err) {
        // Restore the file on failure so the user can retry.
        // Also undo the recentlyDeletedIds entry so the file isn't
        // filtered out on the next server sync.
        addTrackedFile(file)
        unmarkRecentlyDeleted(file)
        const message = err instanceof Error ? err.message : 'Delete failed'
        setError(message)
      }
    },
    [trackedFiles, addTrackedFile, removeTrackedFile, unmarkRecentlyDeleted, setError]
  )

  const retryFile = useCallback(
    async (fileId: string) => {
      const file = trackedFiles.find((f) => f.id === fileId)
      if (!file) return

      if (!file.file) {
        setError(t('errors.cannotRetryServerFile'))
        return
      }

      removeTrackedFile(fileId)
      await uploadFiles([file.file])
    },
    [trackedFiles, removeTrackedFile, uploadFiles, setError, t]
  )

  return {
    uploadFiles,
    cancelUpload,
    cancelFile,
    dismissFiles,
    deleteFile,
    retryFile,
    trackedFiles,
    sessionFiles,
    validationContext,
    isUploading,
    isPolling,
    error,
    clearError,
  }
}
