// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import type { FileItem } from './project-file-workspace'

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-surface-sunken rounded-lg ${className}`} />
}

interface FilePreviewPaneProps {
  file: FileItem
  projectId: string
}

const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']

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

export function FilePreviewPane({ file, projectId }: FilePreviewPaneProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const canPreview = PREVIEW_TYPES.includes(file.contentType ?? '')

  useEffect(() => {
    if (!canPreview) {
      setPreviewUrl(null)
      return
    }

    setIsLoading(true)
    fetch(`/api/documents/${file.id}/preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.url) setPreviewUrl(data.url)
      })
      .catch(() => setPreviewUrl(null))
      .finally(() => setIsLoading(false))
  }, [file.id, canPreview])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-base px-4 py-3">
        <h3 className="text-sm font-medium text-primary truncate">{file.filename}</h3>
      </div>

      {/* Preview */}
      <div className="flex-1 overflow-auto">
        {canPreview && previewUrl && (
          file.contentType === 'application/pdf' ? (
            <iframe src={previewUrl} className="h-full w-full" title={file.filename} />
          ) : (
            <img src={previewUrl} alt={file.filename} className="w-full object-contain" />
          )
        )}
        {canPreview && isLoading && (
          <div className="p-6 space-y-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {!canPreview && (
          <div className="flex flex-col items-center justify-center h-32 px-4 text-center">
            <p className="text-sm text-subtle">Preview not available for this file type.</p>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="border-t border-base px-4 py-3 space-y-2">
        <div className="flex justify-between text-xs">
          <span className="text-subtle">Size</span>
          <span className="text-secondary font-medium">{formatFileSize(file.fileSize)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-subtle">Type</span>
          <span className="text-secondary font-medium">{file.contentType ?? 'Unknown'}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-subtle">Status</span>
          <span className="text-secondary font-medium">{file.status ?? 'Unknown'}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="border-t border-base px-4 py-3">
        <a
          href={`/api/documents/${file.id}/download`}
          className="flex w-full items-center justify-center rounded-lg border border-base bg-surface-base px-4 py-2 text-sm font-medium text-secondary hover:bg-surface-sunken"
        >
          Download
        </a>
      </div>
    </div>
  )
}
