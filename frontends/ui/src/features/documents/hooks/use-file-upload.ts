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
import { deleteSessionDocument } from '@/adapters/api/session-documents-client'
import { xhrUpload, XhrUploadError } from '@/lib/http/xhr-upload'
import { useDocumentsStore } from '../store'
import { useAuth } from '@/adapters/auth'
import { useAppConfig } from '@/shared/context'
import { useLayoutStore } from '@/features/layout/store'
import type { TrackedFile, UploadIntent } from '../types'
import { mapUploadResponseStatus } from '../utils'
import { shouldEmitProgress } from '../lib/upload-progress'
import { isJoblessIngesting } from '../lib/document-status-reads'
import { runWithConcurrency, sendWaitingOutRateLimit, UPLOAD_CONCURRENCY } from '../lib/upload-queue'
import { validateFileUpload, type ValidationContext } from '../validation'
import { summarizeValidation } from '../lib/validation-messages'
import { UploadOrchestrator } from '../orchestrator'
import type { PendingJob } from '../orchestrator'
import { markSessionHasCollection } from '../persistence'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'
import { loadUploadScreeningPolicy } from '@/adapters/api/upload-screening-policy'
import { screenUploadName, type NameMatch } from '@/lib/upload-screening/name-screen'
import { describeNameMatch } from '@/lib/upload-screening/quarantine'
import { exclusionsByTerm, openUploadBatch, sealUploadBatch } from '../lib/upload-batch'

/**
 * The upload endpoints' response: `/api/documents/upload`,
 * `/api/archiv/documents/upload` and `/api/session/documents/upload`.
 */
interface UploadDocumentResponse {
  documentId?: string
  jobId?: string | null
  status?: string
  /** The bytes were already the live document's; nothing was written. */
  unchanged?: boolean
}

/** Where each shelf deletes one of its documents. */
const DELETE_ROUTE: Record<'project' | 'archiv', (id: string) => string> = {
  project: (id) => `/api/documents/${encodeURIComponent(id)}`,
  archiv: (id) => `/api/archiv/documents/${encodeURIComponent(id)}`,
}

/** Delete one document through its shelf's first-party route. Already gone is success. */
async function deleteShelfDocument(shelf: 'project' | 'archiv' | 'session', documentId: string): Promise<void> {
  if (shelf === 'session') return deleteSessionDocument(documentId)
  const response = await fetch(DELETE_ROUTE[shelf](documentId), { method: 'DELETE' })
  if (response.ok || response.status === 404) return
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  throw new Error(typeof message === 'string' && message ? message : `Delete failed: ${response.status}`)
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
  /**
   * For a chat upload (no `projectId`, not `archiv`): the project the chat
   * belongs to. The server uses it only if it has to create the conversation
   * row, so a chat attached to before its first message still lands in its
   * project.
   */
  conversationProjectId?: string | null
  onComplete?: () => void
  onError?: (error: Error) => void
}

/** Per-call overrides for one batch. */
export interface UploadFilesOptions {
  /**
   * Target this collection instead of the memoized one.
   *
   * For callers that just created the session and upload in the same tick: the
   * hook's `collectionName` is captured from the PREVIOUS render and is still
   * undefined at that point.
   */
  collectionOverride?: string
  /**
   * Where each file is filed, decided per file rather than per batch.
   *
   * The hook's own `folderId` is the folder the reader is standing in, which is
   * the right answer for every upload except the one this exists for: a FOLDER
   * upload reproduces a directory tree, so its files go to as many folders as
   * the tree has. Returning `null` files at the project root — distinct from
   * returning `undefined`, which defers to the batch's own folder.
   */
  folderIdFor?: (file: File) => string | null | undefined
  /**
   * The project folder a file lands in, as a path from the project root, for
   * the upload screening (ADR-0077). The server screens against it too, so a
   * caller that knows it must say it — or the browser lets through a file the
   * server will then refuse, after its bytes have left the office.
   */
  folderPathFor?: (file: File) => string | null | undefined
  /**
   * The reader released this file from the upload screening in the upload
   * dialog. Sent to the server as `screeningRelease`, which audits it.
   */
  screeningReleased?: (file: File) => boolean
  /**
   * What the upload dialog's screening already held back, one entry per file
   * (its matches). Recorded on the upload's batch by term and count, so the
   * summary can say why something is missing; never sent by name.
   */
  excludedByScreening?: ReadonlyArray<readonly NameMatch[]>
}

interface UseFileUploadReturn {
  uploadFiles: (files: File[], options?: UploadFilesOptions) => Promise<void>
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
  const { collectionName, projectId, folderId, archiv, conversationProjectId, onComplete, onError } =
    options
  /**
   * Which shelf this upload surface files into. The caller says so through its
   * options; nothing reads it off the collection name (ADR-0047).
   */
  const shelf: 'project' | 'archiv' | 'session' = archiv ? 'archiv' : projectId ? 'project' : 'session'

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
   * down too. Every shelf, a chat included, sends one request per file.
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

  // One subscription per mount: several surfaces use this hook at once, and
  // each must hear about the uploads it is showing.
  useEffect(() => UploadOrchestrator.subscribe({ onComplete, onError }), [onComplete, onError])

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current

    if (collectionName !== previousSessionId) {
      UploadOrchestrator.handleSessionChange(collectionName, shelf === 'session' ? 'session' : 'corpus')
      previousSessionIdRef.current = collectionName
    }
  }, [collectionName, shelf])

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
      if (shelf === 'session') {
        // The server files the upload into the chat's collection and the
        // ingestor creates it on first use; there is nothing to create here.
        markSessionHasCollection(collectionName)
        setCurrentCollection(collectionName)
        return
      }
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
    [shelf, setCurrentCollection, setCollectionInfo]
  )

  const uploadFiles = useCallback(
    async (files: File[], options?: UploadFilesOptions) => {
      if (files.length === 0) return

      // See `UploadFilesOptions.collectionOverride`.
      const targetCollection = options?.collectionOverride ?? collectionName
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

      /**
       * The validator's own summary in the READER's language.
       *
       * `validation.ts` is pure and has callers with no dictionary, so its
       * `message` stays English — but that English was being spliced into a
       * localized sentence, and a German reader was told «1 Datei wird
       * hochgeladen, 1 übersprungen ("Plan.pdf" is 210 MB, exceeds 100 MB
       * limit)». Every error now carries its parts, and the words are chosen
       * here, where there is a `t`.
       */
      const localizedSummary = summarizeValidation(validationResult, t)

      if (validationResult.batchErrors.length > 0) {
        setError(localizedSummary)
        return
      }

      if (validationResult.validFiles.length === 0) {
        setError(imageVlmBlocked ? imageVlmMessage : localizedSummary)
        return
      }

      /*
       * The upload screening, last before a byte leaves (ADR-0077).
       *
       * The dialog already showed the reader what the office's policy holds
       * back and took their releases; this is the gate for every path that
       * does not pass the dialog (a chat attachment, a direct pick that met
       * nothing) and the backstop for the ones that do. What it holds back is
       * not sent at all.
       */
      const policy = await loadUploadScreeningPolicy()
      const screenedOut: Array<{ file: File; matches: NameMatch[] }> = []
      const validFiles = validationResult.validFiles.filter((file) => {
        if (options?.screeningReleased?.(file)) return true
        const verdict = screenUploadName(policy, {
          filename: file.name,
          originPath: file.webkitRelativePath || null,
          folderPath: options?.folderPathFor?.(file) ?? null,
        })
        if (verdict.blocked) screenedOut.push({ file, matches: verdict.matches })
        return !verdict.blocked
      })
      const screenedMessage =
        screenedOut.length > 0
          ? t('errors.screenedOut', {
              count: String(screenedOut.length),
              files: screenedOut
                .slice(0, 3)
                .map(({ file, matches }) =>
                  t('errors.screenedOutFile', {
                    name: file.name,
                    reason: matches.map((match) => describeNameMatch(match, t)).join(', '),
                  })
                )
                .join(', '),
            })
          : null
      if (validFiles.length === 0) {
        setError(screenedMessage ?? localizedSummary)
        return
      }
      setUploading(true)

      if (screenedMessage) {
        setError(screenedMessage)
      } else if (validationResult.fileErrors.length > 0) {
        const skippedCount = validationResult.fileErrors.length
        const uploadingCount = validFiles.length
        setError(
          t('errors.uploadingSkipped', {
            uploading: uploadingCount,
            fileLabel: uploadingCount > 1 ? t('errors.filePlural') : t('errors.fileSingular'),
            skipped: skippedCount,
            summary: imageVlmBlocked ? imageVlmMessage : (localizedSummary ?? ''),
          })
        )
      } else {
        clearError()
      }

      // Per file when the caller filed the batch (a folder upload), otherwise
      // the folder the reader is standing in. `undefined` defers; `null` is a
      // deliberate "the project root".
      const resolvedFolderId = (file: File): string | null => {
        const target = options?.folderIdFor ? options.folderIdFor(file) : folderId
        return (target === undefined ? folderId : target) ?? null
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
          uploadIntent: {
            folderId: resolvedFolderId(file),
            folderPath: options?.folderPathFor?.(file) ?? null,
            screeningReleased: options?.screeningReleased?.(file) === true,
          },
        } satisfies TrackedFile as TrackedFile,
      }))

      // Add tracked files to the store immediately so the upload surface shows
      // the whole batch — as queued rows — before any network call. Everything
      // the user dropped is accounted for from the first frame.
      for (const entry of entries) addTrackedFile(entry.tracked)

      try {
        await ensureCollectionExists(targetCollection)

        // Every shelf persists a durable document row before backend
        // ingestion, through its own first-party route, which also runs the
        // file-type gate and the storage quota. They share the per-file POST;
        // only the endpoint and form fields differ (Archiv resolves the org
        // server-side, a chat names its conversation).
        //
        // The batch these uploads belong to (ADR-0077), opened before the
        // first file goes so each upload can name it. Null: no summary, and
        // the upload goes ahead regardless.
        const batchId = await openUploadBatch({
          id: uuidv4(),
          scope: shelf,
          projectId: shelf === 'project' ? (projectId ?? null) : null,
          conversationId: shelf === 'session' ? targetCollection : null,
          expectedCount: entries.length,
          excluded: exclusionsByTerm([
            ...(options?.excludedByScreening ?? []),
            ...screenedOut.map(({ matches }) => matches),
          ]),
        })
        let unchangedCount = 0

        // Several at a time, not one after another: each POST also writes to
        // object storage, checks the org quota and dispatches to the ingest
        // API, so a serial loop left the connection idle for most of every
        // file and made the batch take the SUM of all of them.
        const uploadUrl =
          shelf === 'archiv'
            ? '/api/archiv/documents/upload'
            : shelf === 'session'
              ? '/api/session/documents/upload'
              : '/api/documents/upload'
        const results = await runWithConcurrency(entries, UPLOAD_CONCURRENCY, async ({ file, tracked }) => {
          const controller = new AbortController()
          abortControllersRef.current.set(tracked.id, controller)
          // Getting a slot is what turns "queued" into "uploading" — the byte
          // count cannot say, because it is legitimately 0 for both.
          updateTrackedFile(tracked.id, { uploadStartedAt: Date.now() })

          const formData = new FormData()
          if (shelf === 'session') {
            formData.append('conversationId', targetCollection)
            if (conversationProjectId) formData.append('projectId', conversationProjectId)
          }
          if (projectId) {
            formData.append('projectId', projectId)
            const resolved = resolvedFolderId(file)
            if (resolved) formData.append('folderId', resolved)
          }
          formData.append('file', file)
          if (options?.screeningReleased?.(file)) formData.append('screeningRelease', 'name')
          if (batchId) formData.append('uploadBatchId', batchId)
          // Where the file sat before it came here. Set by a folder INPUT
          // (`webkitdirectory`) and stamped onto a dropped tree's files by
          // `asPathStampedFiles`, so one property covers both ways of
          // choosing a folder. Absent for a picked file, which genuinely has
          // no origin path — the server records null rather than a guess.
          if (shelf !== 'session' && file.webkitRelativePath) {
            formData.append('originPath', file.webkitRelativePath)
          }

          let lastEmitted = 0
          try {
            const responseText = await sendWaitingOutRateLimit(
              () =>
                xhrUpload({
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
                }),
              (error) => (error instanceof XhrUploadError && error.status === 429 ? error.retryAfterSeconds ?? 1 : null),
              controller.signal
            )

            const result = JSON.parse(responseText) as UploadDocumentResponse
            if (result.unchanged) unchangedCount += 1
            // A re-upload replaces a document in place, under the same id: a
            // tombstone from an earlier delete must not hide it.
            if (result.documentId) removeRecentlyDeletedIds([result.documentId])
            updateTrackedFile(tracked.id, {
              status: mapUploadResponseStatus(result.status),
              serverFileId: result.documentId,
              jobId: result.jobId ?? undefined,
              ...(result.unchanged ? { unchanged: true } : {}),
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

        // Once, after the batch — not per file inside the fan-out. The
        // document listings held for the page lifetime are now stale: until
        // something fired this, a file uploaded mid-conversation was
        // invisible to the citation resolver, and the answer cited it while
        // the chip said there was nothing to open (#623, on the path its fix
        // missed). Firing it fifty times for a fifty-file folder upload would
        // make every surface that mounts during the batch refetch four
        // listings again for each one.
        notifyDocumentsChanged()

        // Sealed once every request has answered: the files that wrote no row
        // are counted here, the rest the server can see for itself.
        if (batchId) {
          await sealUploadBatch(batchId, {
            unchanged: unchangedCount,
            failed: results.filter((result) => result.status === 'rejected').length,
          })
        }

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
        // could not be created.)
        for (const { tracked } of entries) {
          const storeFile = useDocumentsStore.getState().trackedFiles.find((f) => f.id === tracked.id)
          if (!storeFile || storeFile.serverFileId || storeFile.jobId) continue
          if (storeFile.status !== 'uploading') continue
          updateTrackedFile(tracked.id, { status: 'failed', errorMessage: message })
        }
      } finally {
        // Enqueue polling for every job the server accepted — including when
        // another file in the batch failed, otherwise those live jobs are
        // never polled and their rows stay stuck at "processing". A chat's
        // attachments are polled by re-listing them instead (first-party, and
        // it covers the IFC path, which has no ingest job).
        const settled = entries.map(({ tracked }) =>
          useDocumentsStore.getState().trackedFiles.find((f) => f.id === tracked.id)
        )
        if (shelf === 'session') {
          if (settled.some((file) => file?.status === 'ingesting')) {
            UploadOrchestrator.pollSessionDocuments(targetCollection)
          }
        } else {
          const filesByJob = new Map<string, TrackedFile[]>()
          for (const storeFile of settled) {
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
          // A detached extraction (an `.ifc`, an office file converting to its
          // rendition) has no job to poll. The orchestrator follows it by
          // document status, so it settles wherever the upload was started.
          const detached = settled.filter((file): file is TrackedFile => !!file && isJoblessIngesting(file))
          if (detached.length > 0) UploadOrchestrator.watchDocuments(detached.map((file) => file.id))
        }
        setUploading(false)
      }
    },
    [
      collectionName,
      projectId,
      folderId,
      shelf,
      conversationProjectId,
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

      // Every shelf's file is a document row, deleted with its chunks and its
      // objects by that shelf's first-party route, by DOCUMENT id. This used to
      // be the proxy's chunk-only file delete, which takes filenames: handed a
      // document id it matched nothing, and the row and the object stayed. A
      // file that never reached the server has nothing to delete there.
      const documentId = file.serverFileId
      if (!documentId) {
        removeTrackedFile(fileId)
        return
      }

      // Optimistic delete: remove from UI immediately, call API in background.
      // This prevents the file from reappearing if a concurrent server reload
      // returns stale data before the backend processes the delete.
      removeTrackedFile(fileId)

      try {
        await deleteShelfDocument(shelf, documentId)
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
    [shelf, trackedFiles, addTrackedFile, removeTrackedFile, unmarkRecentlyDeleted, setError]
  )

  // Retries asked for in the same tick ("Retry all" calls this once per
  // failed row) go out as ONE batch, so they share the batch's concurrency
  // cap. One batch per row put every failed file in flight at once, straight
  // into the rate limit that had failed most of them.
  const pendingRetriesRef = useRef<{ files: File[]; done: Promise<void> } | null>(null)
  const retryIntentsRef = useRef(new Map<File, UploadIntent>())
  const retryFile = useCallback(
    async (fileId: string) => {
      const file = trackedFiles.find((f) => f.id === fileId)
      if (!file) return

      if (!file.file) {
        setError(t('errors.cannotRetryServerFile'))
        return
      }

      removeTrackedFile(fileId)
      if (file.uploadIntent) retryIntentsRef.current.set(file.file, file.uploadIntent)
      const pending = pendingRetriesRef.current
      if (pending) {
        pending.files.push(file.file)
        return pending.done
      }
      const files = [file.file]
      const done = Promise.resolve().then(async () => {
        pendingRetriesRef.current = null
        // The chat-session shelf caps a batch's count and total size, and the
        // validator refuses a batch whole: the combined retries could fail
        // validation although each file passed on its own, after their rows
        // were already removed. There, retry one file at a time; the durable
        // shelves have no batch cap and keep the single capped batch.
        // The same destination and release as the first attempt: a file the
        // reader released, or filed into a folder of its upload, goes there
        // again instead of being screened out or landing where they stand now.
        const intents = retryIntentsRef.current
        const intentOf = (each: File): UploadIntent | undefined => intents.get(each)
        const retryOptions: UploadFilesOptions = {
          folderIdFor: (each) => intentOf(each)?.folderId,
          folderPathFor: (each) => intentOf(each)?.folderPath,
          screeningReleased: (each) => intentOf(each)?.screeningReleased === true,
        }
        try {
          if (shelf !== 'session') return await uploadFiles(files, retryOptions)
          for (const each of files) await uploadFiles([each], retryOptions)
        } finally {
          for (const each of files) intents.delete(each)
        }
      })
      pendingRetriesRef.current = { files, done }
      await done
    },
    [trackedFiles, removeTrackedFile, uploadFiles, setError, t, shelf]
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
