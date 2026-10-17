/**
 * Document Feature Types
 *
 * Re-exports API types from schemas and defines frontend-specific types.
 */

import type {
  DocumentFileStatus,
  CollectionInfo,
  FileInfo,
  IngestionJobStatus,
} from '@/adapters/api/documents-schemas'
import type { FileItem } from './components/project-file-workspace'
import type { QuarantineVerdict } from '@/lib/upload-screening/quarantine'

// Re-export API types from schemas (single source of truth)
export type {
  DocumentFileStatus,
  JobState,
  CollectionInfo,
  FileInfo,
  FileProgress,
  IngestionJobStatus,
} from '@/adapters/api/documents-schemas'

// ============================================================================
// Request Types
// ============================================================================

export interface CreateCollectionRequest {
  name: string
  description?: string
  metadata?: Record<string, unknown>
}

// ============================================================================
// Frontend State Types
// ============================================================================

/** What a retry must repeat of an upload: its destination and the reader's release. */
export interface UploadIntent {
  /** The folder the upload resolved to; `null` is the project root. */
  folderId: string | null
  /** That folder's path, which the name screening reads. */
  folderPath: string | null
  /** Released from the name screening in the upload dialog. */
  screeningReleased: boolean
  /** The document this file was filed as the new Fassung of, chosen in the upload dialog (ADR-0099); null for none. */
  fassungOf?: string | null
}

/** Every status a {@link TrackedFile} can be in; see its `status` field. */
export type TrackedFileStatus = DocumentFileStatus | 'deleting' | 'canceled' | 'held' | 'stored'

/** Tracked file in the upload queue (client-side) */
export interface TrackedFile {
  /** Client-generated ID */
  id: string
  /** Original File object (only available for locally uploaded files) */
  file?: File
  /**
   * Where this file was sent and what the reader decided about it, as the
   * upload resolved them, so a retry sends it to the same folder with the same
   * screening release rather than to wherever the reader stands now.
   */
  uploadIntent?: UploadIntent
  /** File name */
  fileName: string
  /** File size in bytes */
  fileSize: number
  /**
   * Current status: the backend's file vocabulary, the client-only transient
   * states, and two terminal states the backend's vocabulary cannot say:
   *
   * - `deleting` / `canceled`: client-only, transient.
   * - `held`: the content check (*Inhaltsprüfung*) held the file back
   *   (ADR-0086). Nothing failed and a re-upload is refused, so it is never
   *   retried; the reasons are in `quarantine` (ADR-0113). A
   *   reviewer lets it through (*zulassen*) or deletes it, elsewhere. Also a
   *   file refused because the document it replaces is held
   *   ({@link TrackedFile.replacesHeld}): it waits on the same decision.
   * - `stored`: the bytes are kept and nothing was read, the document's
   *   `uploaded` / `stored` status. Not a success, because Piloti cannot cite
   *   it, and not a failure.
   */
  status: TrackedFileStatus
  /**
   * Backend-reported ingestion progress (0-100).
   *
   * Kept because the ingest job reports it, but NOT what the upload UI draws a
   * bar from: it is the backend's view of a queue it processes in bursts, so it
   * holds one value for a long time and then jumps. See `lib/upload-progress.ts`
   * for which phases have a measurable percentage and which do not.
   */
  progress: number
  /**
   * Bytes of this file that have actually crossed the wire, from the browser's
   * own upload progress events. The only measured number in the whole pipeline.
   */
  bytesUploaded?: number
  /**
   * Epoch ms at which this file got an upload slot. Absent while it is still
   * queued behind the concurrency limit — which is how "queued" and "uploading"
   * are told apart without guessing from the byte count.
   */
  uploadStartedAt?: number
  /** Error message if failed */
  errorMessage?: string | null
  /**
   * Why the content check held it back, when it did (ADR-0113): the job's
   * typed verdict, or the document status read's. Read it through
   * `quarantineVerdictOf`, which also covers a job from before the field.
   */
  quarantine?: QuarantineVerdict | null
  /**
   * `false` when sending the same bytes again cannot succeed: the server
   * refused the upload for a reason a retry meets again (a re-upload onto a
   * quarantined file, `QUARANTINED_REPLACE_REASON`). Absent reads as retryable.
   * {@link mayRetryUpload} is the rule every retry surface asks.
   */
  retryable?: false
  /**
   * Set on a `held` row whose OWN bytes were never stored: the server refused
   * it because the document it would replace is held by the content check
   * (ADR-0086, `QUARANTINED_REPLACE_REASON`), and this person may see that
   * document. `errorMessage` is then the sentence that says so, not a verdict;
   * `documentId` is the held document, and `ownUpload` whether this person
   * uploaded it and so may ask the reviewers about it. Never `serverFileId`:
   * this row is not that document, and removing the row must not delete it.
   */
  replacesHeld?: { documentId: string | null; ownUpload: boolean }
  /** Backend file_id once uploaded */
  serverFileId?: string
  /** Ingestion job ID */
  jobId?: string
  /**
   * The server already held these exact bytes as the live document, so it
   * wrote nothing and made no version. Shown as „Unverändert – bereits
   * vorhanden" rather than as a fresh upload.
   */
  unchanged?: boolean
  /** Collection this file belongs to */
  collectionName?: string
  /** When the file was uploaded (from server) */
  uploadedAt?: string | null
}

/**
 * Whether sending this upload again can come out differently. A held file is
 * refused a re-upload (ADR-0086) and nothing went wrong to repeat, and a row
 * marked `retryable: false` was refused for a reason the retry meets again.
 * `retryFile` refuses both; a surface offering „Erneut versuchen“ asks this.
 */
export function mayRetryUpload(file: Pick<TrackedFile, 'status' | 'retryable'>): boolean {
  return file.status !== 'held' && file.retryable !== false
}

/** Tracks which banners have been shown for a job */
export interface JobBannerState {
  uploaded: boolean
  ingested: boolean
}

/** Banner type derived from JobBannerState keys */
export type BannerType = keyof JobBannerState

/** Default state for job banners (none shown) */
export const DEFAULT_JOB_BANNER_STATE: JobBannerState = {
  uploaded: false,
  ingested: false,
}

/**
 * Map a composer/upload {@link TrackedFile} onto the {@link FileItem} shape the
 * shared FilePreviewDialog / FilePreviewPane consume, so an attached file can be
 * opened in the same read-only preview used everywhere else. Metadata the pane
 * fetches or tolerates as null (summary, page/chunk counts, content types, tags,
 * MIME type) is passed as null — the pane resolves what it can from the preview
 * endpoint using the (server) file id. Prefers `serverFileId` so the preview
 * fetch hits the persisted document; falls back to the client id pre-upload.
 */
export function trackedFileToFileItem(file: TrackedFile): FileItem {
  return {
    id: file.serverFileId ?? file.id,
    filename: file.fileName,
    // An upload in flight has no rename: the row it will become was created a
    // moment ago and nobody has had the chance.
    displayName: null,
    fileSize: file.fileSize ?? null,
    contentType: null,
    // The preview's badge reads the DOCUMENT vocabulary: a held file is the
    // document's `quarantined`, and `stored` is already a document status.
    status: file.status === 'held' ? 'quarantined' : file.status,
    folderId: null,
    createdAt: file.uploadedAt ?? new Date().toISOString(),
    errorMessage: file.errorMessage ?? null,
    quarantine: file.quarantine ?? null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
  }
}

/** Document store state */
export interface DocumentsState {
  /** Current session's collection name (same as sessionId) */
  currentCollectionName: string | null
  /** Collection info if exists */
  collectionInfo: CollectionInfo | null
  /** Files being tracked (uploading, processing, complete) */
  trackedFiles: TrackedFile[]
  /** Active ingestion job ID for polling */
  activeJobId: string | null
  /** Loading states */
  isCreatingCollection: boolean
  isUploading: boolean
  isPolling: boolean
  isLoadingFiles: boolean
  /** Session ID for which files were last loaded from the server (null = never loaded) */
  loadedSessionId: string | null
  /** Client id + serverFileId tombstoned after delete — filters stale server rows by file_id; not fileName (re-upload) */
  recentlyDeletedIds: Set<string>
  /** Error message */
  error: string | null
  /** Tracks which banners have been shown for each job (NOT persisted) */
  shownBannersForJobs: Record<string, JobBannerState>
}

/** Document store actions */
export interface DocumentsActions {
  // Collection management
  setCurrentCollection: (name: string | null) => void
  setCollectionInfo: (info: CollectionInfo | null) => void

  // File tracking
  addTrackedFile: (file: TrackedFile) => void
  updateTrackedFile: (id: string, updates: Partial<TrackedFile>) => void
  /**
   * Hot-path sibling of {@link updateTrackedFile} for upload progress events,
   * which arrive ~20×/second per in-flight file. Returns the previous state
   * untouched when the byte count has not moved, so an unchanged value costs no
   * re-render of the tray.
   */
  setUploadProgress: (id: string, bytesUploaded: number) => void
  removeTrackedFile: (id: string) => void
  /**
   * Drop rows from the upload surface WITHOUT tombstoning them — the user is
   * dismissing a notice, not deleting a document. `removeTrackedFile` is the
   * delete; conflating the two hides freshly-uploaded files from the next sync.
   */
  dismissTrackedFiles: (ids: string[]) => void
  /** Remove a file's IDs from recentlyDeletedIds (used to undo optimistic delete on failure) */
  unmarkRecentlyDeleted: (file: TrackedFile) => void
  /** Drop tombstone entries for these ids (e.g. backend reused file_id after a new upload) */
  removeRecentlyDeletedIds: (ids: string[]) => void
  clearTrackedFiles: () => void
  /** Clear files for a specific collection (used when switching sessions) */
  clearFilesForCollection: (collectionName: string) => void

  // Job tracking
  setActiveJobId: (jobId: string | null) => void

  // Loading states
  setCreatingCollection: (loading: boolean) => void
  setUploading: (loading: boolean) => void
  setPolling: (polling: boolean) => void
  setLoadingFiles: (loading: boolean) => void

  // Error handling
  setError: (error: string | null) => void
  clearError: () => void

  // Bulk operations
  updateFilesFromJobStatus: (jobStatus: IngestionJobStatus) => void
  /** Load files from server for a collection (used when switching sessions) */
  setFilesFromServer: (collectionName: string, files: FileInfo[]) => void

  // Banner tracking (for deduplication)
  /** Mark a banner as shown for a job */
  markBannerShown: (jobId: string, type: BannerType) => void
}

export type DocumentsStore = DocumentsState & DocumentsActions
