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

export interface DeleteFilesRequest {
  file_ids: string[]
}

// ============================================================================
// Frontend State Types
// ============================================================================

/** Tracked file in the upload queue (client-side) */
export interface TrackedFile {
  /** Client-generated ID */
  id: string
  /** Original File object (only available for locally uploaded files) */
  file?: File
  /** File name */
  fileName: string
  /** File size in bytes */
  fileSize: number
  /** Current status (includes the client-only 'deleting' / 'canceled' transient states) */
  status: DocumentFileStatus | 'deleting' | 'canceled'
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
  /** Backend file_id once uploaded */
  serverFileId?: string
  /** Ingestion job ID */
  jobId?: string
  /** Collection this file belongs to */
  collectionName?: string
  /** When the file was uploaded (from server) */
  uploadedAt?: string | null
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
    fileSize: file.fileSize ?? null,
    contentType: null,
    status: file.status,
    folderId: null,
    createdAt: file.uploadedAt ?? new Date().toISOString(),
    errorMessage: file.errorMessage ?? null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
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
