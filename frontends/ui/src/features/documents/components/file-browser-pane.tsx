// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import type { FileItem } from './project-file-workspace'
import { Image, Document, Paperclip } from '@/adapters/ui/icons'

interface FileBrowserPaneProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
}

function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)} ${units[i]}`
}

const STATUS_COLORS: Record<string, string> = {
  ready: 'bg-success-subtle text-success',
  uploaded: 'bg-success-subtle text-success',
  pending: 'bg-info-subtle text-info',
  ingesting: 'bg-info-subtle text-info',
  failed: 'bg-danger-subtle text-danger',
}

export function FileBrowserPane({ files, selectedFileId, onSelectFile, isLoading }: FileBrowserPaneProps) {
  const [search, setSearch] = useState('')

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return files
    const q = search.toLowerCase()
    return files.filter((f) => f.filename.toLowerCase().includes(q))
  }, [files, search])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-subtle">Loading files...</p>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-subtle">No files in this folder. Upload to get started.</p>
      </div>
    )
  }

  return (
    <div>
      {/* Search bar */}
      <div className="sticky top-0 border-b border-base bg-surface-base px-4 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files..."
          className="w-full rounded-lg border border-base px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
        />
      </div>

      {/* File list */}
      <div className="divide-y divide-base">
        {filteredFiles.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-subtle">
            No files match "{search}"
          </div>
        )}
        {filteredFiles.map((file) => (
          <button
            key={file.id}
            onClick={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
            className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-sunken ${
              selectedFileId === file.id ? 'bg-surface-sunken' : ''
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0">
                {file.contentType?.startsWith('image/') ? <Image className="h-4 w-4 text-subtle" /> :
                 file.contentType === 'application/pdf' ? <Document className="h-4 w-4 text-subtle" /> :
                 <Paperclip className="h-4 w-4 text-subtle" />}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary truncate">{file.filename}</p>
                <p className="text-xs text-subtle">{formatFileSize(file.fileSize)}</p>
              </div>
            </div>
            <span className={`inline-flex items-center shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_COLORS[file.status ?? ''] ?? 'bg-surface-sunken text-subtle'
            }`}>
              {file.status ?? 'unknown'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
