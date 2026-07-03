// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FC, useCallback, useMemo, useState } from 'react'
import { FileCheck2, FileText, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

interface ProjectFileExplorerProps {
  documents: DocumentRow[]
}

export const ProjectFileExplorer: FC<ProjectFileExplorerProps> = ({ documents }) => {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const filteredDocuments = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return documents
    return documents.filter((doc) => doc.filename.toLowerCase().includes(normalized))
  }, [documents, query])

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

  return (
    <div className="rounded-[2rem] border border-base bg-surface-base shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)]">
      <div className="border-b border-base p-5">
        <div className="flex flex-col items-start justify-between gap-4 md:flex-row">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-base bg-surface-sunken text-accent-primary">
              <FileCheck2 className="h-6 w-6" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-[0.24em] text-subtle">project file explorer</span>
              <span className="text-lg font-bold text-primary">Documents ({documents.length})</span>
            </div>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-base px-4 py-2 text-sm text-subtle">
            <Upload className="h-4 w-4" />
            Upload from the Files sidebar
          </div>
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files by name..."
          className="mt-5 h-auto rounded-2xl border-base bg-surface-sunken px-4 py-3 text-sm text-primary focus-visible:border-brand"
        />
      </div>

      {filteredDocuments.length === 0 ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-dashed border-base text-subtle">
            <FileText className="h-7 w-7" />
          </div>
          <span className="text-base font-bold text-primary">No files found</span>
          <p className="max-w-md text-sm text-subtle">
            Project uploads appear here after they are added from the chat Files sidebar.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-base">
          {filteredDocuments.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-surface-raised-30">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-surface-sunken text-accent-primary">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold text-primary">{doc.filename}</span>
                  <div className="flex flex-wrap items-center gap-3">
                    {doc.fileSize ? <span className="text-xs text-subtle">{formatFileSize(doc.fileSize)}</span> : null}
                    {doc.contentType ? <span className="text-xs text-subtle">{doc.contentType}</span> : null}
                    <Badge variant={statusBadgeVariant(doc.status)}>{doc.status}</Badge>
                  </div>
                  {doc.errorMessage ? <span className="text-xs text-error">{doc.errorMessage}</span> : null}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => handleDownload(doc.id)} disabled={downloadingId === doc.id}>
                {downloadingId === doc.id ? 'Downloading...' : 'Download'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function statusBadgeVariant(status: string): 'warning' | 'success' | 'destructive' | 'secondary' {
  if (status === 'uploaded' || status === 'pending') return 'warning'
  if (status === 'ingested' || status === 'success') return 'success'
  if (status === 'failed') return 'destructive'
  return 'secondary'
}


