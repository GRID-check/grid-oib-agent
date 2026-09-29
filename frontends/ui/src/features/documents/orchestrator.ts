/**
 * Upload Orchestrator
 *
 * Centralized service for managing file upload orchestration including:
 * - Polling lifecycle (start, stop, cleanup)
 * - Persistence (localStorage save/restore for page refresh)
 * - Session switching (cleanup, resume)
 * - File loading from server
 *
 * This service lives outside React's lifecycle to avoid complex ref coordination
 * and effect races that were previously managed in the useFileUpload hook.
 *
 * Two shelves, two transports. A project or Archiv collection is listed through
 * the v1 proxy and its ingest jobs are polled by job id. A chat's attachments
 * (`shelf: 'session'`) are document rows (ADR-0047 Phase 2): they are listed
 * through `GET /api/session/documents`, which reconciles in-flight statuses on
 * every read, so polling them is re-listing until nothing is in flight. That
 * also makes a reload resume on its own, with no job persisted in the browser.
 */

import { toast } from 'sonner'
import { createDocumentsClient } from '@/adapters/api'
import { getStoreTranslator } from '@/i18n/store-translator'
import { listSessionDocuments } from '@/adapters/api/session-documents-client'
import { useDocumentsStore } from './store'
import { useLayoutStore } from '@/features/layout/store'
import type { TrackedFile } from './types'
import { mapBackendStatus } from './utils'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'
import {
  isJoblessIngesting,
  nextStatusBatch,
  readDocumentStatuses,
  trackedPatchFromStatus,
} from './lib/document-status-reads'
import {
  persistJob,
  removePersistedJob,
  getPersistedJobForCollection,
  updatePersistedJobFiles,
  sessionHasKnownCollection,
  markSessionHasCollection,
  unmarkSessionCollection,
  removePersistedJobForCollection,
} from './persistence'

const POLL_INTERVAL_MS = 5000
/**
 * How long (420 × 5 s, 35 min) the orchestrator follows one job closely.
 *
 * Running out of it says nothing about the upload. A large set of drawings is
 * still being read long after that, and calling it "timed out" put a red
 * upload problem on a document that became citable a minute later. So the end
 * of the budget hands the rows on (see `handOverToListing`), it never fails them.
 */
const MAX_POLL_ATTEMPTS = 420
/** A chat's listing past the budget: still followed, just less often. */
const SLOW_POLL_INTERVAL_MS = 60_000
/**
 * How often a row no job follows is asked about by id: a handed-over row
 * (past the budget, or its job forgotten) or a detached extraction. Slow,
 * because a workspace that is open settles the same rows every few seconds
 * itself; this is the floor for everywhere else.
 */
const DOCUMENT_WATCH_INTERVAL_MS = SLOW_POLL_INTERVAL_MS
/** One notice per hand-over burst, however many jobs reach it together. */
const STILL_READING_TOAST_ID = 'upload-still-reading'

interface PollingState {
  jobId: string
  collectionName: string
  timeoutId: NodeJS.Timeout | null
  pollCount: number
  abortController: AbortController
}

/** Which listing a collection is read through. See the module comment. */
export type OrchestratorShelf = 'session' | 'corpus'

interface SessionPollState {
  conversationId: string
  timeoutId: NodeJS.Timeout | null
  pollCount: number
  abortController: AbortController
}

export interface PendingJob {
  jobId: string
  collectionName: string
  files: TrackedFile[]
}

export interface OrchestratorCallbacks {
  onComplete?: () => void
  onError?: (error: Error) => void
}

class UploadOrchestratorImpl {
  private pollingState: PollingState | null = null
  private sessionPoll: SessionPollState | null = null
  private currentShelf: OrchestratorShelf = 'corpus'
  private jobQueue: PendingJob[] = []
  private currentSessionId: string | null = null
  private lastLoadedSessionId: string | null = null
  private authToken: string | undefined = undefined
  /**
   * Everyone listening for an upload to finish, not whoever mounted last.
   *
   * This was one slot that each `useFileUpload` overwrote, and several mount
   * at once (the chat composer, the files tab, a project's Files page), so the
   * surface that had actually started the upload lost its `onComplete` to
   * whichever hook happened to render after it and never refreshed.
   */
  private subscribers = new Set<OrchestratorCallbacks>()
  /**
   * Tray rows (by tracked id) that no job follows, and the timer asking about
   * them by document id. See {@link watchDocuments}.
   */
  private watchedRows = new Set<string>()
  private documentWatchTimer: ReturnType<typeof setTimeout> | null = null
  private documentWatchOffset = 0

  setAuthToken(token: string | undefined): void {
    this.authToken = token
  }

  /** Listen for completion and failure. Returns the unsubscribe. */
  subscribe(callbacks: OrchestratorCallbacks): () => void {
    this.subscribers.add(callbacks)
    return () => {
      this.subscribers.delete(callbacks)
    }
  }

  /**
   * Tell every subscriber. Over a copy, so one that unsubscribes while running
   * cannot skip the next, and isolated, so one that throws cannot keep the
   * others from hearing about it.
   */
  private emit(event: 'onComplete'): void
  private emit(event: 'onError', error: Error): void
  private emit(event: 'onComplete' | 'onError', error?: Error): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        if (event === 'onComplete') subscriber.onComplete?.()
        else if (error) subscriber.onError?.(error)
      } catch (err) {
        console.warn('[UploadOrchestrator] a subscriber threw', err)
      }
    }
  }

  private getClient() {
    return createDocumentsClient({ authToken: this.authToken })
  }

  private getStore() {
    return useDocumentsStore.getState()
  }

  /**
   * Enqueue pending jobs to be polled sequentially.
   * If no job is currently being polled, starts the first one immediately.
   */
  enqueueJobs(jobs: PendingJob[]): void {
    this.jobQueue.push(...jobs)
    if (!this.pollingState && this.jobQueue.length > 0) {
      this.dequeueAndPoll()
    }
  }

  /**
   * Dequeue the next job and start polling it.
   */
  private dequeueAndPoll(): void {
    const next = this.jobQueue.shift()
    if (next) {
      this.startPolling(next.jobId, next.collectionName, next.files)
    }
  }

  /**
   * Handle session change - cleans up previous session and sets up new one
   */
  async handleSessionChange(
    newSessionId: string | undefined,
    shelf: OrchestratorShelf = 'corpus'
  ): Promise<void> {
    const previousSessionId = this.currentSessionId

    if (newSessionId === previousSessionId) {
      return
    }
    this.currentShelf = shelf

    // Stop polling from previous session. Also drop queued jobs: stopPolling
    // only aborts the ACTIVE poll, and a leftover queue entry from the old
    // session would otherwise be dequeued first and hijack polling (under the
    // old collection) as soon as the new session enqueues an upload.
    this.stopPolling()
    this.stopSessionPolling()
    this.jobQueue = []

    // Clear any upload error from previous session
    this.getStore().clearError()

    // Clear files for old session
    if (previousSessionId) {
      this.getStore().clearFilesForCollection(previousSessionId)
    }

    // Update session ID immediately to prevent race conditions
    this.currentSessionId = newSessionId ?? null
    this.lastLoadedSessionId = null

    // Signal loading immediately so the UI shows a spinner before any async work.
    // loadFilesForSession (or early returns below) will clear this.
    if (newSessionId && sessionHasKnownCollection(newSessionId)) {
      this.getStore().setLoadingFiles(true)
    }

    // A chat's attachments resume from their listing, not from a persisted job.
    // One left over from before they were rows names a proxy job; drop it.
    if (newSessionId && shelf === 'session') {
      removePersistedJobForCollection(newSessionId)
    }

    // Check for persisted job to resume
    if (newSessionId && shelf !== 'session') {
      const persistedJob = getPersistedJobForCollection(newSessionId)
      if (persistedJob) {
        // Verify session hasn't changed during sync operations
        if (this.currentSessionId === newSessionId) {
          await this.resumeFromPersistence(newSessionId, persistedJob.jobId)
        }
        return
      }
    }

    // Load files from server for new session
    if (newSessionId && this.currentSessionId === newSessionId) {
      await this.loadFilesForSession(newSessionId)
    }
  }

  /**
   * Load files from server for a session.
   * Only queries the backend if the session is known to have a collection
   * (from a previous upload) or has a persisted job in progress.
   * This prevents unnecessary 404 errors for sessions that never had files uploaded.
   */
  async loadFilesForSession(sessionId: string): Promise<void> {
    const store = this.getStore()

    // Skip if Knowledge Layer is not available (prevents 404 errors when backend
    // doesn't have knowledge_retrieval configured)
    const { knowledgeLayerAvailable } = useLayoutStore.getState()
    if (!knowledgeLayerAvailable) {
      store.setLoadingFiles(false)
      return
    }

    if (sessionId === this.lastLoadedSessionId) {
      store.setLoadingFiles(false)
      return
    }

    if (store.isUploading || store.isPolling) {
      store.setLoadingFiles(false)
      return
    }

    // Check if session changed before making network request
    if (sessionId !== this.currentSessionId) {
      store.setLoadingFiles(false)
      return
    }

    // Skip collection check if this session has never had files uploaded.
    // Collections are only created on first file upload, so querying the backend
    // for sessions without a known collection just generates 404 errors.
    const hasKnownCollection = sessionHasKnownCollection(sessionId)
    const hasPersistedJob = getPersistedJobForCollection(sessionId) !== null
    if (!hasKnownCollection && !hasPersistedJob) {
      this.lastLoadedSessionId = sessionId
      store.setLoadingFiles(false)
      return
    }

    if (this.currentShelf === 'session') {
      await this.loadSessionDocuments(sessionId)
      return
    }

    const client = this.getClient()

    store.setLoadingFiles(true)
    try {
      const collection = await client.getCollection(sessionId)

      // Re-check session after async call to avoid stale updates
      if (sessionId !== this.currentSessionId) {
        return
      }

      if (collection) {
        const files = await client.listFiles(sessionId)

        // Final session check after second async call
        if (sessionId !== this.currentSessionId) {
          return
        }

        store.setFilesFromServer(sessionId, files)
        store.setCurrentCollection(sessionId)
        store.setCollectionInfo(collection)

        // Confirm the collection marker (in case it was set by a different mechanism)
        markSessionHasCollection(sessionId)
      } else {
        // Collection not found (404) - may have been TTL-cleaned on the backend.
        // Remove the marker so we don't keep retrying for an expired collection.
        unmarkSessionCollection(sessionId)
      }

      this.lastLoadedSessionId = sessionId
    } catch (_error) {
      // Network/connection errors should still mark session as loaded to prevent retry loops.
      // Don't unmark the collection here - the backend may just be temporarily unavailable.
      this.lastLoadedSessionId = sessionId
    } finally {
      store.setLoadingFiles(false)
    }
  }

  /** {@link loadFilesForSession} for a chat: its document rows, first-party. */
  private async loadSessionDocuments(conversationId: string): Promise<void> {
    const store = this.getStore()
    store.setLoadingFiles(true)
    try {
      const files = await listSessionDocuments(conversationId)
      if (conversationId !== this.currentSessionId) return

      if (files === null) {
        // No such conversation on the server (deleted, or never created).
        unmarkSessionCollection(conversationId)
      } else {
        store.setFilesFromServer(conversationId, files)
        store.setCurrentCollection(conversationId)
        markSessionHasCollection(conversationId)
        if (files.some((file) => file.status === 'ingesting')) this.pollSessionDocuments(conversationId)
      }
      this.lastLoadedSessionId = conversationId
    } catch {
      // Same as the corpus path: a transient failure marks the session loaded
      // so it is not retried in a loop, and keeps the marker.
      this.lastLoadedSessionId = conversationId
    } finally {
      store.setLoadingFiles(false)
    }
  }

  /**
   * Poll a chat's attachments until none is in flight, by re-listing them.
   * The listing reconciles every pending row with the backend, so one request
   * covers the whole batch. Idempotent per conversation.
   */
  pollSessionDocuments(conversationId: string): void {
    if (this.sessionPoll?.conversationId === conversationId) return
    this.stopSessionPolling()
    this.sessionPoll = {
      conversationId,
      timeoutId: null,
      pollCount: 0,
      abortController: new AbortController(),
    }
    this.getStore().setPolling(true)
    this.scheduleSessionPoll()
  }

  private stopSessionPolling(): void {
    if (!this.sessionPoll) return
    if (this.sessionPoll.timeoutId) clearTimeout(this.sessionPoll.timeoutId)
    this.sessionPoll.abortController.abort()
    this.sessionPoll = null
    this.getStore().setPolling(this.pollingState !== null)
  }

  private scheduleSessionPoll(): void {
    const poll = this.sessionPoll
    if (!poll) return
    const interval = poll.pollCount > MAX_POLL_ATTEMPTS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS
    poll.timeoutId = setTimeout(() => {
      void this.runSessionPoll(poll)
    }, interval)
  }

  /**
   * Re-list a chat's attachments. Past the budget the listing is still the
   * only thing that will settle these rows, so it keeps going at a slower
   * pace instead of stopping, and says once that reading takes longer.
   */
  private async runSessionPoll(poll: SessionPollState): Promise<void> {
    if (this.sessionPoll !== poll) return
    const store = this.getStore()

    if (poll.pollCount === MAX_POLL_ATTEMPTS) this.announceStillReading()
    poll.pollCount++

    try {
      const files = await listSessionDocuments(poll.conversationId, poll.abortController.signal)
      if (this.sessionPoll !== poll) return
      if (files === null) {
        this.stopSessionPolling()
        return
      }
      store.setFilesFromServer(poll.conversationId, files)
      if (!files.some((file) => file.status === 'ingesting')) {
        this.stopSessionPolling()
        // The upload POST already said "changed", while these were still
        // being read; the listings that took that snapshot hold rows without
        // chunks until told again, now that there is something to cite.
        notifyDocumentsChanged()
        this.emit('onComplete')
        return
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error('[UploadOrchestrator] Session poll error:', err)
    }
    this.scheduleSessionPoll()
  }

  /**
   * Resume polling from a persisted job (after page refresh)
   */
  private async resumeFromPersistence(sessionId: string, jobId: string): Promise<void> {
    const store = this.getStore()
    const client = this.getClient()
    const persistedJob = getPersistedJobForCollection(sessionId)

    if (!persistedJob) return

    // Progress is surfaced by the composer's inline file chips (and the files
    // dialog), so resuming a persisted job no longer opens a side panel.
    try {
      const [serverFiles, jobStatus] = await Promise.all([
        client.listFiles(sessionId).catch(() => []),
        client.getJobStatus(jobId).catch(() => null),
      ])

      if (serverFiles.length > 0) {
        store.setFilesFromServer(sessionId, serverFiles)
      }

      if (jobStatus && jobStatus.status !== 'completed' && jobStatus.status !== 'failed') {
        const serverFileNames = new Set(serverFiles.map((f) => f.file_name))
        for (const jobFile of jobStatus.file_details) {
          if (!serverFileNames.has(jobFile.file_name)) {
            const persistedFile = persistedJob.files.find((f) => f.fileName === jobFile.file_name)
            if (persistedFile) {
              store.addTrackedFile({
                ...persistedFile,
                status: mapBackendStatus(jobFile.status),
                progress: jobFile.progress_percent,
                errorMessage: jobFile.error_message ?? undefined,
                serverFileId: jobFile.file_id,
              } as TrackedFile)
            }
          }
        }
      }

      if (serverFiles.length === 0 && (!jobStatus || jobStatus.file_details.length === 0)) {
        for (const file of persistedJob.files) {
          store.addTrackedFile(file as TrackedFile)
        }
      }
    } catch {
      for (const file of persistedJob.files) {
        store.addTrackedFile(file as TrackedFile)
      }
    }

    this.startPolling(jobId, sessionId)
  }

  /**
   * Start polling for a job
   */
  startPolling(jobId: string, collectionName: string, filesToPersist?: TrackedFile[]): void {
    this.stopPolling()

    const store = this.getStore()
    store.setPolling(true)
    store.setActiveJobId(jobId)

    if (filesToPersist && filesToPersist.length > 0) {
      persistJob(jobId, collectionName, filesToPersist)
    }

    const abortController = new AbortController()

    this.pollingState = {
      jobId,
      collectionName,
      timeoutId: null,
      pollCount: 0,
      abortController,
    }

    this.pollJobStatus()
  }

  /**
   * Stop current polling
   */
  stopPolling(): void {
    if (this.pollingState) {
      if (this.pollingState.timeoutId) {
        clearTimeout(this.pollingState.timeoutId)
      }
      this.pollingState.abortController.abort()
      this.pollingState = null
    }

    const store = this.getStore()
    store.setPolling(this.sessionPoll !== null)
    store.setActiveJobId(null)
  }

  /**
   * Stop polling only if it targets the given collection (session id).
   * Used when removing an upload-only session without affecting other sessions.
   */
  stopPollingIfCollection(collectionName: string): void {
    if (this.pollingState?.collectionName === collectionName) {
      this.stopPolling()
    }
    if (this.sessionPoll?.conversationId === collectionName) {
      this.stopSessionPolling()
    }
  }

  /**
   * Poll job status
   */
  private async pollJobStatus(): Promise<void> {
    if (!this.pollingState) return

    const { jobId, collectionName, abortController } = this.pollingState
    const store = this.getStore()
    const client = this.getClient()

    if (abortController.signal.aborted) {
      this.stopPolling()
      return
    }

    if (this.pollingState.pollCount >= MAX_POLL_ATTEMPTS) {
      this.handOverToListing(jobId)
      return
    }

    try {
      const status = await client.getJobStatus(jobId, abortController.signal)

      // The job store forgot the job (a restart, an expiry). The document rows
      // it was writing did not go anywhere, so neither does the upload.
      if (!status) {
        this.handOverToListing(jobId)
        return
      }

      store.updateFilesFromJobStatus(status)

      // Re-read state: `store` is a snapshot from before the update above, so
      // its trackedFiles would persist the PREVIOUS poll's progress.
      const currentFiles = this.getStore().trackedFiles.filter((f) => f.jobId === jobId)
      if (currentFiles.length > 0) {
        updatePersistedJobFiles(jobId, currentFiles)
      }

      const isTerminal = status.status === 'completed' || status.status === 'failed'
      console.debug('[UploadOrchestrator] Job status:', status.status, 'isTerminal:', isTerminal)

      if (isTerminal) {
        this.stopPolling()
        removePersistedJob(jobId)

        // Same reason as the session poll: the upload's own notification went
        // out while the job was still pending, and a failure changes the
        // listing just as much as a success does.
        notifyDocumentsChanged()

        // Terminal state (files available or an error) is reflected on the
        // composer's inline file chips; no side panel is opened.
        if (status.status === 'completed') {
          this.emit('onComplete')
        } else if (status.error_message) {
          store.setError(status.error_message)
          this.emit('onError', new Error(status.error_message))
        }

        // If more jobs in queue, dequeue and start the next one
        if (this.jobQueue.length > 0) {
          this.dequeueAndPoll()
          return
        }

        // Reload files from server (setFilesFromServer replaces files for the
        // collection while preserving client-side metadata like uploadedAt)
        this.lastLoadedSessionId = null
        this.loadFilesForSession(collectionName)
        return
      }

      this.pollingState.pollCount++
      this.scheduleNextPoll()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.stopPolling()
        return
      }

      // Log polling errors for debugging
      console.error('[UploadOrchestrator] Poll error:', err)

      if (!this.pollingState) return

      // A failed status read is not a failed upload. The budget check at the
      // top of the next poll decides when to stop asking.
      this.pollingState.pollCount++
      this.scheduleNextPoll()
    }
  }

  /**
   * Stop following a job without calling its upload failed.
   *
   * Its rows lose the job id and wait as `ingesting`. A mounted workspace
   * settles them from its listing (`useSettleTrackedUploads`); everywhere else
   * {@link watchDocuments} follows them by document status until they land.
   */
  private handOverToListing(jobId: string): void {
    this.stopPolling()
    removePersistedJob(jobId)
    const store = this.getStore()
    const handedOver: string[] = []
    for (const file of store.trackedFiles) {
      if (file.jobId !== jobId) continue
      if (file.status !== 'uploading' && file.status !== 'ingesting') continue
      store.updateTrackedFile(file.id, { jobId: undefined, status: 'ingesting' })
      handedOver.push(file.id)
    }
    this.watchDocuments(handedOver)
    this.announceStillReading()
    if (this.jobQueue.length > 0) this.dequeueAndPoll()
  }

  /**
   * Follow tray rows that no ingest job will finish, by their documents'
   * status, until each is terminal.
   *
   * The workspace listing settles these too, but only while a Files or Archiv
   * page is mounted. A project upload started from the chat's side panel, or
   * one the reader walked away from, had nothing asking at all and spun
   * forever. This is the floor: slow, per document, and only for rows that
   * carry a document id. Idempotent per row.
   *
   * @param trackedIds Tray row ids; rows that are not jobless-and-ingesting are ignored.
   */
  watchDocuments(trackedIds: readonly string[]): void {
    const rows = new Map(this.getStore().trackedFiles.map((file) => [file.id, file]))
    for (const id of trackedIds) {
      const row = rows.get(id)
      if (row && isJoblessIngesting(row)) this.watchedRows.add(id)
    }
    if (this.watchedRows.size > 0 && !this.documentWatchTimer) this.scheduleDocumentWatch()
  }

  private scheduleDocumentWatch(): void {
    this.documentWatchTimer = setTimeout(() => {
      void this.runDocumentWatch()
    }, DOCUMENT_WATCH_INTERVAL_MS)
  }

  private stopDocumentWatch(): void {
    if (this.documentWatchTimer) clearTimeout(this.documentWatchTimer)
    this.documentWatchTimer = null
    this.watchedRows.clear()
  }

  /** The rows still owed an answer, pruning any somebody else settled or removed. */
  private watchedWaiting(): TrackedFile[] {
    const rows = new Map(this.getStore().trackedFiles.map((file) => [file.id, file]))
    const waiting: TrackedFile[] = []
    for (const id of this.watchedRows) {
      const row = rows.get(id)
      if (row && isJoblessIngesting(row)) waiting.push(row)
      else this.watchedRows.delete(id)
    }
    return waiting
  }

  private async runDocumentWatch(): Promise<void> {
    this.documentWatchTimer = null
    const waiting = this.watchedWaiting()
    if (waiting.length === 0) return
    const ids = waiting.map((row) => row.serverFileId ?? '')
    const { batch, next } = nextStatusBatch(ids, this.documentWatchOffset)
    this.documentWatchOffset = next
    const reads = await readDocumentStatuses(batch)

    let completed = false
    const store = this.getStore()
    for (const row of this.watchedWaiting()) {
      const read = reads.get(row.serverFileId ?? '')
      if (!read) continue
      // Deleted meanwhile: nothing left to follow, and nothing to report.
      if (read.kind === 'gone') {
        this.watchedRows.delete(row.id)
        continue
      }
      const patch = trackedPatchFromStatus(read.fields.status, read.fields.errorMessage)
      if (!patch) continue
      store.updateTrackedFile(row.id, patch)
      this.watchedRows.delete(row.id)
      completed = true
    }
    if (completed) {
      // Same reason as the job and session polls: listings snapshotted while
      // these were being read hold rows without chunks until told again.
      notifyDocumentsChanged()
      this.emit('onComplete')
    }
    if (this.watchedRows.size > 0 && !this.documentWatchTimer) this.scheduleDocumentWatch()
  }

  /** A notice, not an error: nothing failed and there is nothing to retry. */
  private announceStillReading(): void {
    toast.info(getStoreTranslator('files')('uploads.stillReading'), { id: STILL_READING_TOAST_ID })
  }

  /**
   * Schedule the next poll using setTimeout
   */
  private scheduleNextPoll(): void {
    if (!this.pollingState) return

    this.pollingState.timeoutId = setTimeout(() => {
      this.pollJobStatus()
    }, POLL_INTERVAL_MS)
  }

  /**
   * Force-refresh files for the current session from the backend.
   * Bypasses the lastLoadedSessionId cache so the backend is always queried.
   * Use when the UI needs to reconcile with possible backend-side changes
   * (e.g. TTL-based collection cleanup).
   */
  async refreshFilesForSession(sessionId: string): Promise<void> {
    if (sessionId === this.currentSessionId) {
      this.lastLoadedSessionId = null
      await this.loadFilesForSession(sessionId)
    }
  }

  /**
   * Cleanup on unmount
   */
  cleanup(): void {
    this.stopPolling()
    this.stopSessionPolling()
    this.stopDocumentWatch()
    this.jobQueue = []
    this.currentSessionId = null
    this.lastLoadedSessionId = null
  }
}

export const UploadOrchestrator = new UploadOrchestratorImpl()
