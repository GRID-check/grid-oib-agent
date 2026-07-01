// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FC, useCallback, useState } from 'react'
import { Flex, Text } from '@/adapters/ui'

interface DocumentRow {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string
  createdAt: Date
  errorMessage: string | null
}

interface DocumentListProps {
  documents: DocumentRow[]
}

export const DocumentList: FC<DocumentListProps> = ({ documents }) => {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const handleDownload = useCallback(async (docId: string) => {
    setDownloadingId(docId)
    try {
      const res = await fetch(`/api/documents/${docId}/download`)
      if (!res.ok) throw new Error('Download failed')
      const { downloadUrl, filename } = await res.json()
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = filename
      a.click()
    } catch {
      console.error('Failed to download document')
    } finally {
      setDownloadingId(null)
    }
  }, [])

  if (documents.length === 0) {
    return (
      <Text kind="body/regular/sm" className="py-4 text-center text-subtle">
        No documents uploaded yet.
      </Text>
    )
  }

  return (
    <Flex direction="col" gap="2">
      {documents.map((doc) => (
        <Flex
          key={doc.id}
          align="center"
          justify="between"
          className="rounded-lg border px-4 py-3 transition-colors hover:bg-surface-raised-50"
        >
          <Flex direction="col" gap="1" className="min-w-0 flex-1">
            <Text kind="label/semibold/sm" className="truncate text-primary">
              {doc.filename}
            </Text>
            <Flex gap="3" align="center">
              {doc.fileSize && (
                <Text kind="body/regular/xs" className="text-subtle">
                  {formatFileSize(doc.fileSize)}
                </Text>
              )}
              {doc.contentType && (
                <Text kind="body/regular/xs" className="text-subtle">
                  {doc.contentType}
                </Text>
              )}
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                doc.status === 'uploaded' || doc.status === 'pending'
                  ? 'bg-yellow-100 text-yellow-800'
                  : doc.status === 'ingested' || doc.status === 'success'
                    ? 'bg-green-100 text-green-800'
                    : doc.status === 'failed'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-gray-100 text-gray-800'
              }`}>
                {doc.status}
              </span>
            </Flex>
            {doc.errorMessage && (
              <Text kind="body/regular/xs" className="text-error">
                {doc.errorMessage}
              </Text>
            )}
          </Flex>
          <button
            onClick={() => handleDownload(doc.id)}
            disabled={downloadingId === doc.id}
            className="ml-4 shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-primary underline-offset-4 hover:bg-surface-raised-100 disabled:opacity-50"
            title="Download file"
          >
            {downloadingId === doc.id ? 'Downloading...' : 'Download'}
          </button>
        </Flex>
      ))}
    </Flex>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
