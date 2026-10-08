'use client'

import { useFileUpload, type UploadFilesOptions } from '@/features/documents/hooks/use-file-upload'
import type { TrackedFile } from '@/features/documents/types'

interface UseArchivDocumentsOptions {
  /** The org's Archiv collection (`archiv_<orgId>`), from the list endpoint. */
  collectionName?: string
  /** The folder the reader is standing in; files are filed there. */
  folderId?: string
  onComplete?: () => void
  onError?: (error: Error) => void
}

interface UseArchivDocumentsReturn {
  uploadFiles: (files: File[], options?: UploadFilesOptions) => Promise<void>
  cancelUpload: () => void
  cancelFile: (fileId: string) => void
  dismissFiles: (fileIds: string[]) => void
  retryFile: (fileId: string) => Promise<void>
  trackedFiles: TrackedFile[]
  isUploading: boolean
  isPolling: boolean
  error: string | null
  clearError: () => void
}

/**
 * Org-wide Archiv counterpart to `useProjectDocuments`. Same upload engine
 * (`useFileUpload`) — progress tracking, orchestrated ingestion polling, error
 * surface — but targets the Archiv upload endpoint (filing into `folderId`, per file when a folder upload says so) and collection instead of a
 * project's. The collection name is resolved by the caller (from
 * `GET /api/archiv/documents`) and passed in.
 */
export function useArchivDocuments(options: UseArchivDocumentsOptions = {}): UseArchivDocumentsReturn {
  const { collectionName, folderId, onComplete, onError } = options
  return useFileUpload({ collectionName, archiv: true, folderId, onComplete, onError })
}
