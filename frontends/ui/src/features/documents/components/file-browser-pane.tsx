// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import type { FileItem } from './project-file-workspace'
import { ImageIcon, FileText, Paperclip } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatFileSize } from '@/lib/utils/format-file-size'

interface FileBrowserPaneProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
}

const STATUS_BADGE_VARIANT: Record<string, 'success' | 'warning' | 'destructive'> = {
  ready: 'success',
  uploaded: 'success',
  pending: 'warning',
  ingesting: 'warning',
  failed: 'destructive',
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
      <div className="flex-1 p-4 space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-6 w-full" />
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
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files..."
          className="focus-visible:border-brand"
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
                {file.contentType?.startsWith('image/') ? <ImageIcon className="h-4 w-4 text-subtle" /> :
                 file.contentType === 'application/pdf' ? <FileText className="h-4 w-4 text-subtle" /> :
                 <Paperclip className="h-4 w-4 text-subtle" />}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary truncate">{file.filename}</p>
                <p className="text-xs text-subtle">{formatFileSize(file.fileSize)}</p>
              </div>
            </div>
            <Badge variant={STATUS_BADGE_VARIANT[file.status ?? ''] ?? 'secondary'} className="shrink-0">
              {file.status ?? 'unknown'}
            </Badge>
          </button>
        ))}
      </div>
    </div>
  )
}
