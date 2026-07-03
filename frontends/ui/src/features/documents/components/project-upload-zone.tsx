// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useProjectDocuments } from '@/features/documents/hooks/use-project-documents'

interface ProjectUploadZoneProps {
  projectId: string
}

export function ProjectUploadZone({ projectId }: ProjectUploadZoneProps): JSX.Element {
  const { uploadFiles, trackedFiles, isUploading, error, clearError } = useProjectDocuments({ projectId })

  return (
    <div className="rounded-lg border p-4">
      <p className="mb-2 text-sm font-bold text-primary">Upload documents</p>
      <input
        type="file"
        multiple
        onChange={(e) => {
          clearError()
          const files = Array.from(e.target.files || [])
          if (files.length) uploadFiles(files)
        }}
      />
      {isUploading && <p className="mt-2 text-sm text-subtle">Uploading...</p>}
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
      <div className="mt-2 flex flex-col gap-1">
        {trackedFiles.map((file) => (
          <p key={file.id} className="text-sm text-subtle">
            {file.fileName} — {file.status}
          </p>
        ))}
      </div>
    </div>
  )
}
