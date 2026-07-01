// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import { useFileUpload } from '@/features/documents/hooks/use-file-upload'

interface UseProjectDocumentsOptions {
  projectId?: string
  onComplete?: () => void
  onError?: (error: Error) => void
}

interface UseProjectDocumentsReturn {
  uploadFiles: (files: File[]) => Promise<void>
  cancelUpload: () => void
  trackedFiles: import('@/features/documents/types').TrackedFile[]
  isUploading: boolean
  isPolling: boolean
  error: string | null
  clearError: () => void
  collectionName?: string
}

export function useProjectDocuments(options: UseProjectDocumentsOptions = {}): UseProjectDocumentsReturn {
  const { projectId, onComplete, onError } = options
  const collectionName = useMemo(() => (projectId ? `proj_${projectId}` : undefined), [projectId])

  const upload = useFileUpload({ collectionName, onComplete, onError })

  return {
    ...upload,
    collectionName,
  }
}
