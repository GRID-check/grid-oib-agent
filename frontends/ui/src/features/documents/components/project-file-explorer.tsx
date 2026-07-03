// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FC, useCallback, useMemo, useState } from 'react'
import { Button, Flex, Text } from '@/adapters/ui'
import { Document, DocumentCheckmark, Upload } from '@/adapters/ui/icons'
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
        <Flex align="start" justify="between" gap="4" className="flex-col md:flex-row">
          <Flex gap="3" align="center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-base bg-surface-sunken text-brand">
              <DocumentCheckmark className="h-6 w-6" />
            </div>
            <Flex direction="col" gap="1">
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">project file explorer</Text>
              <Text kind="label/bold/lg" className="text-primary">Documents ({documents.length})</Text>
            </Flex>
          </Flex>
          <div className="inline-flex items-center gap-2 rounded-full border border-base px-4 py-2 text-sm text-subtle">
            <Upload className="h-4 w-4" />
            Upload from the Files sidebar
          </div>
        </Flex>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files by name..."
          className="mt-5 w-full rounded-2xl border border-base bg-surface-sunken px-4 py-3 text-sm text-primary outline-none transition focus:border-brand"
        />
      </div>

      {filteredDocuments.length === 0 ? (
        <Flex direction="col" align="center" justify="center" gap="3" className="min-h-[280px] p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-dashed border-base text-subtle">
            <Document className="h-7 w-7" />
          </div>
          <Text kind="label/bold/md" className="text-primary">No files found</Text>
          <Text kind="body/regular/sm" className="max-w-md text-subtle">
            Project uploads appear here after they are added from the chat Files sidebar.
          </Text>
        </Flex>
      ) : (
        <div className="divide-y divide-base">
          {filteredDocuments.map((doc) => (
            <Flex key={doc.id} align="center" justify="between" gap="4" className="px-5 py-4 transition hover:bg-surface-raised-30">
              <Flex align="center" gap="3" className="min-w-0 flex-1">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-surface-sunken text-brand">
                  <Document className="h-5 w-5" />
                </div>
                <Flex direction="col" gap="1" className="min-w-0 flex-1">
                  <Text kind="label/semibold/sm" className="truncate text-primary">{doc.filename}</Text>
                  <Flex align="center" gap="3" className="flex-wrap">
                    {doc.fileSize ? <Text kind="body/regular/xs" className="text-subtle">{formatFileSize(doc.fileSize)}</Text> : null}
                    {doc.contentType ? <Text kind="body/regular/xs" className="text-subtle">{doc.contentType}</Text> : null}
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusClassName(doc.status)}`}>{doc.status}</span>
                  </Flex>
                  {doc.errorMessage ? <Text kind="body/regular/xs" className="text-error">{doc.errorMessage}</Text> : null}
                </Flex>
              </Flex>
              <Button kind="secondary" size="small" onClick={() => handleDownload(doc.id)} disabled={downloadingId === doc.id}>
                {downloadingId === doc.id ? 'Downloading...' : 'Download'}
              </Button>
            </Flex>
          ))}
        </div>
      )}
    </div>
  )
}

function statusClassName(status: string): string {
  if (status === 'uploaded' || status === 'pending') return 'bg-yellow-100 text-yellow-800'
  if (status === 'ingested' || status === 'success') return 'bg-green-100 text-green-800'
  if (status === 'failed') return 'bg-red-100 text-red-800'
  return 'bg-gray-100 text-gray-800'
}


