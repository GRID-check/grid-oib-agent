// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useProjectDocuments } from '@/features/documents/hooks/use-project-documents'
import { Flex, Text } from '@/adapters/ui'

interface ProjectUploadZoneProps {
  projectId: string
}

export function ProjectUploadZone({ projectId }: ProjectUploadZoneProps): JSX.Element {
  const { uploadFiles, trackedFiles, isUploading, error, clearError } = useProjectDocuments({ projectId })

  return (
    <div className="rounded-lg border p-4">
      <Text kind="label/bold/md" className="mb-2 text-primary">Upload documents</Text>
      <input
        type="file"
        multiple
        onChange={(e) => {
          clearError()
          const files = Array.from(e.target.files || [])
          if (files.length) uploadFiles(files)
        }}
      />
      {isUploading && (
        <Text kind="body/regular/sm" className="mt-2 text-subtle">Uploading...</Text>
      )}
      {error && (
        <Text kind="body/regular/sm" className="mt-2 text-red-500">
          {error}
        </Text>
      )}
      <Flex direction="col" gap="1" className="mt-2">
        {trackedFiles.map((file) => (
          <Text key={file.id} kind="body/regular/sm" className="text-subtle">
            {file.fileName} — {file.status}
          </Text>
        ))}
      </Flex>
    </div>
  )
}
