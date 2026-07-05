'use client'

import { useMemo, useState, type ReactNode } from 'react'
import type { FileItem } from './project-file-workspace'
import { Search, FolderOpen, UploadCloud } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { DocumentStatusBadge, fileTypeIcon } from './document-status'

interface FileBrowserPaneProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /** True when a specific folder is selected (vs. the "All Files" root). */
  hasFolderSelected: boolean
  /** Upload control rendered inside the first-run empty state. */
  uploadControl?: ReactNode
}

export function FileBrowserPane({
  files,
  selectedFileId,
  onSelectFile,
  isLoading,
  hasFolderSelected,
  uploadControl,
}: FileBrowserPaneProps) {
  const [search, setSearch] = useState('')

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return files
    const q = search.toLowerCase()
    return files.filter((f) => f.filename.toLowerCase().includes(q))
  }, [files, search])

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-1 py-2">
            <Skeleton className="size-8 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
        ))}
      </div>
    )
  }

  // First-run empty state — the whole corpus (or selected folder) has no files.
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        {hasFolderSelected ? (
          <EmptyState
            icon={FolderOpen}
            title="This folder is empty"
            description="Upload documents here, or pick another folder from the sidebar."
            action={uploadControl}
          />
        ) : (
          <EmptyState
            icon={UploadCloud}
            title="No documents yet"
            description="Add your building's plans, permits and reports. Grid reads them to ground every answer in your project's own documents — not generic guidance."
            action={uploadControl}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Search bar */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files..."
            aria-label="Search files"
            className="pl-8"
          />
        </div>
      </div>

      {/* File list */}
      <div className="divide-y">
        {filteredFiles.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No files match &ldquo;{search}&rdquo;
          </div>
        )}
        {filteredFiles.map((file) => {
          const Icon = fileTypeIcon(file.contentType, file.filename)
          const isSelected = selectedFileId === file.id
          return (
            <button
              key={file.id}
              onClick={() => onSelectFile(isSelected ? null : file.id)}
              aria-pressed={isSelected}
              className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors duration-200 ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                isSelected ? 'bg-accent' : ''
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{file.filename}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">{formatFileSize(file.fileSize)}</p>
                </div>
              </div>
              <DocumentStatusBadge status={file.status} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
