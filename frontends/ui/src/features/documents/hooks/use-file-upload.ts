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
import { useTranslations } from '@/i18n'
import { createDocumentsClient } from '@/adapters/api'
import { useDocumentsStore } from '../store'
import { useAuth } from '@/adapters/auth'
import { useAppConfig } from '@/shared/context'
import { useLayoutStore } from '@/features/layout/store'
import type { TrackedFile } from '../types'
import { validateFileUpload, type ValidationContext } from '../validation'
import { UploadOrchestrator } from '../orchestrator'
import type { PendingJob } from '../orchestrator'
import { markSessionHasCollection } from '../persistence'
import { useChatStore } from '@/features/chat'

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
  const { fileUpload: fileUploadConfig } = useAppConfig()
  const clientRef = useRef(createDocumentsClient({ authToken: idToken }))
  const previousSessionIdRef = useRef<string | undefined>(undefined)

  const trackedFiles = useDocumentsStore((s) => s.trackedFiles)
  const isUploading = useDocumentsStore((s) => s.isUploading)
  const isPolling = useDocumentsStore((s) => s.isPolling)
  const error = useDocumentsStore((s) => s.error)
  const setCurrentCollection = useDocumentsStore((s) => s.setCurrentCollection)
  const setCollectionInfo = useDocumentsStore((s) => s.setCollectionInfo)
  const addTrackedFile = useDocumentsStore((s) => s.addTrackedFile)
  const updateTrackedFile = useDocumentsStore((s) => s.updateTrackedFile)
  const removeTrackedFile = useDocumentsStore((s) => s.removeTrackedFile)
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
    }),
    [sessionFiles]
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

      const validationResult = validateFileUpload(files, validationContext, fileUploadConfig)

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

      const trackedFileMap: Map<string, TrackedFile> = new Map()

      // Add tracked files to the store immediately so uploading cards appear
      // in the UI before any network calls (collection creation, upload POST)
      for (const file of validFiles) {
        const trackedFile: TrackedFile = {
          id: uuidv4(),
          file,
          fileName: file.name,
          fileSize: file.size,
          status: 'uploading',
          progress: 0,
          collectionName: targetCollection,
          uploadedAt: new Date().toISOString(),
        }
        addTrackedFile(trackedFile)
        trackedFileMap.set(file.name, trackedFile)
      }

      // Show informational banner in chat as soon as upload starts
      const chatStore = useChatStore.getState()
      chatStore.addFileUploadStatusCard(
        'uploaded',
        validFiles.length,
        `upload-${Date.now()}`,
        targetCollection
      )

      try {
        await ensureCollectionExists(targetCollection)

        if (projectId || archiv) {
          // Project AND Archiv uploads persist a durable document row before
          // backend ingestion (unlike throwaway chat-session uploads). They
          // share the per-file POST loop; only the endpoint and form fields
          // differ (Archiv resolves the org server-side, no projectId/folderId).
          const uploadUrl = archiv ? '/api/archiv/documents/upload' : '/api/documents/upload'
          for (const file of validFiles) {
            const trackedFile = trackedFileMap.get(file.name)
            if (!trackedFile) continue

            const formData = new FormData()
            if (projectId) {
              formData.append('projectId', projectId)
              if (folderId) {
                formData.append('folderId', folderId)
              }
            }
            formData.append('file', file)

            const response = await fetch(uploadUrl, {
              method: 'POST',
              body: formData,
            })

            if (!response.ok) {
              const errBody = await response.json().catch(() => ({ error: 'Upload failed' }))
              throw new Error(errBody.error || `Upload failed with status ${response.status}`)
            }

            const result = await response.json()
            const { documentId, jobId, status } = result

            updateTrackedFile(trackedFile.id, {
              status: status === 'pending' ? 'ingesting' : status,
              serverFileId: documentId,
              jobId,
            })
          }
        } else {
          // Session uploads go through the canonical collection documents API.
          const { job_id: jobId, file_ids: fileIds } = await clientRef.current.uploadFiles(targetCollection, validFiles)
          removeRecentlyDeletedIds(fileIds)

          validFiles.forEach((file, index) => {
            const trackedFile = trackedFileMap.get(file.name)
            if (!trackedFile) return

            updateTrackedFile(trackedFile.id, {
              status: 'ingesting',
              serverFileId: fileIds[index],
              jobId,
            })
          })
        }

      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return
        }
        const message = err instanceof Error ? err.message : 'Upload failed'
        setError(message)
        onError?.(err instanceof Error ? err : new Error(message))

        // Only mark files that never reached the server as failed: in the
        // sequential project loop, files uploaded before the failing one are
        // already ingesting server-side and must keep their real status.
        for (const trackedFile of trackedFileMap.values()) {
          const storeFile = useDocumentsStore.getState().trackedFiles.find((f) => f.id === trackedFile.id)
          if (storeFile?.serverFileId || storeFile?.jobId) continue
          updateTrackedFile(trackedFile.id, {
            status: 'failed',
            errorMessage: message,
          })
        }
      } finally {
        // Enqueue polling for every job the server accepted — including when
        // a later file in the batch failed, otherwise those live jobs are
        // never polled and their cards stay stuck at "ingesting".
        const filesByJob = new Map<string, TrackedFile[]>()
        for (const file of validFiles) {
          const trackedFile = trackedFileMap.get(file.name)
          if (!trackedFile) continue
          const storeFile = useDocumentsStore.getState().trackedFiles.find((f) => f.id === trackedFile.id)
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
      ensureCollectionExists,
      addTrackedFile,
      updateTrackedFile,
      setUploading,
      clearError,
      setError,
      onError,
      removeRecentlyDeletedIds,
      t,
    ]
  )

  const cancelUpload = useCallback(() => {
    UploadOrchestrator.stopPolling()
    setUploading(false)
  }, [setUploading])

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
