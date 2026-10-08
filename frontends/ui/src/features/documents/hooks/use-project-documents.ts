'use client'

import { useFileUpload, type UploadFilesOptions } from '@/features/documents/hooks/use-file-upload'

interface UseProjectDocumentsOptions {
  projectId?: string
  /**
   * The project's RAG collection.
   *
   * Passed in, not looked up. The Files page's server render has the project row
   * in hand and threads `collectionName` to the workspace as a prop, so there is
   * no request to wait for. A missing name would answer a drop with "Collection
   * name required for upload", which is the wrong sentence for "the page has not
   * finished loading".
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
