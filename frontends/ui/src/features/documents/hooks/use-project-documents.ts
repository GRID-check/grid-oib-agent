'use client'

import { useFileUpload, type UploadFilesOptions } from '@/features/documents/hooks/use-file-upload'

interface UseProjectDocumentsOptions {
  projectId?: string
  /**
   * The project's RAG collection.
   *
   * Passed in, not looked up. This hook used to `GET /api/projects/{id}` on
   * mount for this one string — a fourth round trip on the Files page, whose
   * server render has the project row in hand and already threads
   * `collectionName` to the workspace as a prop. Until that request came back
   * the upload button was wired to `undefined` and a drop was answered with
   * "Collection name required for upload", which is the wrong sentence for
   * "the page has not finished loading".
   */
  collectionName?: string
  folderId?: string
  onComplete?: () => void
  onError?: (error: Error) => void
}

interface UseProjectDocumentsReturn {
  /**
   * `options` carries the per-file folder targeting a FOLDER upload needs — see
   * {@link UploadFilesOptions}. A plain batch passes nothing and lands in the
   * folder this hook was given.
   */
  uploadFiles: (files: File[], options?: UploadFilesOptions) => Promise<void>
  cancelUpload: () => void
  cancelFile: (fileId: string) => void
  dismissFiles: (fileIds: string[]) => void
  retryFile: (fileId: string) => Promise<void>
  trackedFiles: import('@/features/documents/types').TrackedFile[]
  isUploading: boolean
  isPolling: boolean
  error: string | null
  clearError: () => void
  collectionName?: string
}

export function useProjectDocuments(options: UseProjectDocumentsOptions = {}): UseProjectDocumentsReturn {
  const { projectId, collectionName, folderId, onComplete, onError } = options

  const upload = useFileUpload({ collectionName, projectId, folderId, onComplete, onError })

  return {
    ...upload,
    collectionName,
  }
}
