'use client'

import { useEffect, useState } from 'react'
import { useFileUpload } from '@/features/documents/hooks/use-file-upload'

interface UseProjectDocumentsOptions {
  projectId?: string
  folderId?: string
  onComplete?: () => void
  onError?: (error: Error) => void
}

interface UseProjectDocumentsReturn {
  uploadFiles: (files: File[]) => Promise<void>
  cancelUpload: () => void
  retryFile: (fileId: string) => Promise<void>
  trackedFiles: import('@/features/documents/types').TrackedFile[]
  isUploading: boolean
  isPolling: boolean
  error: string | null
  clearError: () => void
  collectionName?: string
}

export function useProjectDocuments(options: UseProjectDocumentsOptions = {}): UseProjectDocumentsReturn {
  const { projectId, folderId, onComplete, onError } = options
  const [collectionName, setCollectionName] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!projectId) {
      setCollectionName(undefined)
      return
    }

    let cancelled = false
    fetch(`/api/projects/${projectId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((project: { collectionName?: string } | null) => {
        if (!cancelled) {
          setCollectionName(project?.collectionName)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCollectionName(undefined)
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  const upload = useFileUpload({ collectionName, projectId, folderId, onComplete, onError })

  return {
    ...upload,
    collectionName,
  }
}
