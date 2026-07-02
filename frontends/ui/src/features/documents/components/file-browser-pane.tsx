// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import type { FileItem } from './project-file-workspace'

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
  ready: 'bg-green-50 text-green-700',
  uploaded: 'bg-green-50 text-green-700',
  pending: 'bg-blue-50 text-blue-700',
  ingesting: 'bg-blue-50 text-blue-700',
  failed: 'bg-red-50 text-red-700',
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
        <p className="text-sm text-neutral-400">Loading files...</p>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-neutral-400">No files in this folder. Upload to get started.</p>
      </div>
    )
  }

  return (
    <div>
      {/* Search bar */}
      <div className="sticky top-0 border-b border-neutral-200 bg-white px-4 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files..."
          className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
        />
      </div>

      {/* File list */}
      <div className="divide-y divide-neutral-100">
        {filteredFiles.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-neutral-400">
            No files match "{search}"
          </div>
        )}
        {filteredFiles.map((file) => (
          <button
            key={file.id}
            onClick={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
            className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${
              selectedFileId === file.id ? 'bg-neutral-50' : ''
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-lg shrink-0">
                {file.contentType?.startsWith('image/') ? '🖼' :
                 file.contentType === 'application/pdf' ? '📄' : '📎'}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900 truncate">{file.filename}</p>
                <p className="text-xs text-neutral-400">{formatFileSize(file.fileSize)}</p>
              </div>
            </div>
            <span className={`inline-flex items-center shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_COLORS[file.status ?? ''] ?? 'bg-neutral-50 text-neutral-500'
            }`}>
              {file.status ?? 'unknown'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
