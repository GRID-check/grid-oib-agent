// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * FileUploadZone Component
 *
 * Drag-and-drop file upload zone built on a hidden native file input
 * plus a styled drop target. Integrates with useFileUpload hook for
 * handling uploads.
 */

'use client'

import { type ChangeEvent, type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FileText, Loader2, Upload, XCircle } from 'lucide-react'
import { useDocumentsStore } from '../store'
import { useIsCurrentSessionBusy } from '@/features/chat'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE } from '../'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface UploadedFile {
  id: string
  file: File
  status: 'uploading' | 'success' | 'error'
  errorMessage?: string
  uploadedBytes?: number
}

interface FileUploadZoneProps {
  /** Collection name for filtering displayed files */
  collectionName?: string
  /** @deprecated use collectionName */
  sessionId?: string
  /** Max file size in bytes (for display only) */
  maxFileSize?: number
  /** Accepted file types (MIME types or extensions) */
  acceptedTypes?: string
  /** Handler for uploading files (parent handles validation via hook) */
  onUpload?: (files: File[]) => void
  /** Whether upload is in progress */
  isUploading?: boolean
  /** Label for the form field */
  label?: string
}

// ============================================================================
// Component
// ============================================================================

export const FileUploadZone: FC<FileUploadZoneProps> = ({
  collectionName,
  sessionId,
  maxFileSize = MAX_FILE_SIZE,
  acceptedTypes = ACCEPTED_FILE_TYPES,
  onUpload,
  isUploading = false,
  label,
}) => {
  // Check if current session is busy with operations
  const isBusy = useIsCurrentSessionBusy()
  const targetCollectionName = collectionName ?? sessionId
  const inputRef = useRef<HTMLInputElement>(null)

  // Get files for current upload target collection
  const trackedFiles = useDocumentsStore((state) => state.trackedFiles)
  const collectionFiles = useMemo(
    () => (targetCollectionName ? trackedFiles.filter((f) => f.collectionName === targetCollectionName) : []),
    [trackedFiles, targetCollectionName]
  )

  // Mirror tracked files into the upload value shape used for rendering file cards
  const [uploadValue, setUploadValue] = useState<UploadedFile[]>([])

  // Sync collection files to uploadValue
  useEffect(() => {
    const mapped = collectionFiles
      .filter((tf) => tf.file) // Only include files with File object (can be displayed)
      .map((tf) => ({
        id: tf.id,
        file: tf.file!,
        status:
          tf.status === 'failed'
            ? ('error' as const)
            : tf.status === 'success'
              ? ('success' as const)
              : ('uploading' as const),
        errorMessage: tf.errorMessage ?? undefined,
        uploadedBytes: tf.progress ? Math.floor((tf.progress / 100) * tf.fileSize) : undefined,
      }))
    setUploadValue(mapped)
  }, [collectionFiles])

  const uploadDisabled = isUploading || isBusy

  const handleValueChange = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      // Pass files to parent - validation happens in uploadFiles hook
      onUpload?.(files)
    },
    [onUpload]
  )

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])
      handleValueChange(files)
      // Reset so selecting the same file again re-triggers onChange
      event.target.value = ''
    },
    [handleValueChange]
  )

  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: handleValueChange,
    disabled: uploadDisabled,
  })

  const openFilePicker = useCallback(() => {
    if (!uploadDisabled) inputRef.current?.click()
  }, [uploadDisabled])

  return (
    <div className="flex flex-col gap-3">
      {label ? <label className="text-sm font-medium text-primary">{label}</label> : null}

      <div
        {...dragHandlers}
        role="button"
        tabIndex={uploadDisabled ? -1 : 0}
        aria-disabled={uploadDisabled}
        onClick={openFilePicker}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !uploadDisabled) {
            event.preventDefault()
            openFilePicker()
          }
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors',
          isDragging && isUnsupportedDrag && 'border-error bg-error/5',
          isDragging && !isUnsupportedDrag && 'border-brand bg-surface-sunken',
          !isDragging && 'border-base hover:border-brand hover:bg-surface-sunken/50',
          uploadDisabled && 'pointer-events-none cursor-not-allowed opacity-50'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={acceptedTypes}
          disabled={uploadDisabled}
          onChange={handleInputChange}
          data-testid="nv-upload-input-element"
          className="hidden"
        />
        <Upload className="h-6 w-6 text-subtle" />
        <p className="text-sm text-secondary">
          <span className="font-medium text-accent-primary">Click to upload</span> or drag and drop
        </p>
        <p className="text-xs text-subtle">
          <span>Up to {Math.round(maxFileSize / (1024 * 1024))} MB</span>
          <span> · </span>
          <span>Accepts: {acceptedTypes}</span>
        </p>
      </div>

      {uploadValue.length > 0 && (
        <ul className="flex flex-col gap-2">
          {uploadValue.map((item) => (
            <li
              key={item.id}
              role="listitem"
              className="flex items-center gap-3 rounded-lg border border-base px-3 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-subtle" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-primary">{item.file.name}</p>
                {item.errorMessage ? <p className="text-xs text-error">{item.errorMessage}</p> : null}
              </div>
              {item.status === 'uploading' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-subtle" />
              ) : null}
              {item.status === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : null}
              {item.status === 'error' ? <XCircle className="h-4 w-4 shrink-0 text-error" /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
