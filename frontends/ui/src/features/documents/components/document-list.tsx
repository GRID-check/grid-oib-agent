// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FC, useCallback, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatFileSize } from '@/lib/utils/format-file-size'

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
    return <p className="py-4 text-center text-sm text-subtle">No documents uploaded yet.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="flex items-center justify-between rounded-lg border px-4 py-3 transition-colors hover:bg-surface-raised-50"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-semibold text-primary">{doc.filename}</span>
            <div className="flex items-center gap-3">
              {doc.fileSize && <span className="text-xs text-subtle">{formatFileSize(doc.fileSize)}</span>}
              {doc.contentType && <span className="text-xs text-subtle">{doc.contentType}</span>}
              <Badge variant={statusBadgeVariant(doc.status)}>{doc.status}</Badge>
            </div>
            {doc.errorMessage && <span className="text-xs text-error">{doc.errorMessage}</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDownload(doc.id)}
            disabled={downloadingId === doc.id}
            className="ml-4 shrink-0"
            title="Download file"
          >
            {downloadingId === doc.id ? 'Downloading...' : 'Download'}
          </Button>
        </div>
      ))}
    </div>
  )
}

function statusBadgeVariant(status: string): 'warning' | 'success' | 'destructive' | 'secondary' {
  if (status === 'uploaded' || status === 'pending') return 'warning'
  if (status === 'ingested' || status === 'success') return 'success'
  if (status === 'failed') return 'destructive'
  return 'secondary'
}


