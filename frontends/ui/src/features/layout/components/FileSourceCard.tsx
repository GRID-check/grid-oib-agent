// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * FileSourceCard Component
 *
 * Displays a single uploaded file source with status and delete action.
 * Shows file title, upload time, description, and current status.
 */

'use client'

import { type FC, useState, useEffect } from 'react'
import { Check, FileText, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useIsCurrentSessionBusy } from '@/features/chat'
import { formatFileSize } from '@/lib/utils/format-file-size'

/** File source status types */
export type FileSourceStatus = 'uploading' | 'ingesting' | 'available' | 'error' | 'deleting'

export interface FileSourceCardProps {
  /** Unique identifier for the file */
  id: string
  /** File title/name */
  title: string
  /** File size in bytes */
  fileSize?: number | null
  /** When the file was uploaded (optional - not displayed if null/undefined) */
  uploadedAt?: Date | string | null
  /** Optional description of the file */
  description?: string
  /** Current status of the file */
  status: FileSourceStatus
  /** Error message when status is 'error' */
  errorMessage?: string
  /** Hours after upload before the file may expire (0 = no expiry shown) */
  expirationIntervalHours?: number
  /** Callback when delete is clicked */
  onDelete: (id: string) => void
}

/** Status configuration for styling */
const STATUS_CONFIG: Record<
  FileSourceStatus,
  { label: string; textClass: string; showSpinner: boolean }
> = {
  uploading: {
    label: 'Uploading...',
    textClass: 'text-info',
    showSpinner: true,
  },
  ingesting: {
    label: 'Ingesting...',
    textClass: 'text-info',
    showSpinner: true,
  },
  available: {
    label: 'Available',
    textClass: 'text-success',
    showSpinner: false,
  },
  error: {
    label: 'Error',
    textClass: 'text-error',
    showSpinner: false,
  },
  deleting: {
    label: 'Deleting...',
    textClass: 'text-muted-foreground',
    showSpinner: true,
  },
}

/**
 * Format upload timestamp for display
 */
const formatDateTime = (date: Date | string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Compute the milliseconds remaining until expiration.
 * Returns null if inputs are invalid or interval is 0.
 */
const computeMsRemaining = (
  uploadedAt: Date | string | null | undefined,
  intervalHours: number
): number | null => {
  if (!uploadedAt || intervalHours <= 0) return null
  const dateObj = typeof uploadedAt === 'string' ? new Date(uploadedAt) : uploadedAt
  if (isNaN(dateObj.getTime())) return null
  const expiresAtMs = dateObj.getTime() + intervalHours * 60 * 60 * 1000
  return expiresAtMs - Date.now()
}

/**
 * Format milliseconds remaining into "Expires in H:MM" or the expired label.
 * Returns null when expiration doesn't apply.
 */
const formatExpiryLabel = (
  msRemaining: number | null
): { text: string; expired: boolean } | null => {
  if (msRemaining === null) return null
  if (msRemaining <= 0) return { text: 'Deletion Pending - Reupload', expired: true }

  const totalMinutes = Math.max(1, Math.ceil(msRemaining / 60_000))
  return { text: `Expires in ${totalMinutes} min`, expired: false }
}

/**
 * Hook that returns a live expiry label, re-evaluated every minute.
 */
const useExpiryLabel = (
  uploadedAt: Date | string | null | undefined,
  intervalHours: number,
  active: boolean
): { text: string; expired: boolean } | null => {
  const [label, setLabel] = useState<{ text: string; expired: boolean } | null>(() =>
    active ? formatExpiryLabel(computeMsRemaining(uploadedAt, intervalHours)) : null
  )

  useEffect(() => {
    if (!active) {
      setLabel(null)
      return
    }

    // Compute immediately
    setLabel(formatExpiryLabel(computeMsRemaining(uploadedAt, intervalHours)))

    // Re-evaluate every 60 seconds
    const id = setInterval(() => {
      setLabel(formatExpiryLabel(computeMsRemaining(uploadedAt, intervalHours)))
    }, 60_000)

    return () => clearInterval(id)
  }, [uploadedAt, intervalHours, active])

  return label
}

/**
 * Card component for displaying an uploaded file source.
 */
export const FileSourceCard: FC<FileSourceCardProps> = ({
  id,
  title,
  fileSize,
  uploadedAt,
  description,
  status,
  errorMessage,
  expirationIntervalHours = 0,
  onDelete,
}) => {
  const config = STATUS_CONFIG[status]
  const isBusy = useIsCurrentSessionBusy()
  const expiryLabel = useExpiryLabel(uploadedAt, expirationIntervalHours, status === 'available')

  const handleDelete = () => {
    onDelete(id)
  }

  const isProcessing = status === 'uploading' || status === 'ingesting'
  const isDeleting = status === 'deleting'
  const deleteDisabled = isBusy || isProcessing || isDeleting

  return (
    <div
      className={cn(
        'group flex items-start justify-between rounded-lg border bg-muted/40 p-3 transition-colors',
        status === 'error' && 'border-error/50',
        isDeleting && 'opacity-50'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* File Icon or Spinner */}
        {config.showSpinner ? (
          <Spinner size="sm" label={config.label} />
        ) : (
          <FileText
            className={cn('h-8 w-8', status === 'error' ? 'text-error' : 'text-muted-foreground')}
            aria-hidden="true"
          />
        )}

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Title, file size, and timestamp */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{title}</span>
            {fileSize != null && fileSize > 0 && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatFileSize(fileSize)}
              </span>
            )}
            {uploadedAt && (
              <>
                <span className="shrink-0 text-muted-foreground">•</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(uploadedAt)}
                </span>
              </>
            )}
          </div>

          {/* Description (if provided) */}
          {description && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span>
          )}

          {/* Status and expiration row */}
          <div className="mt-1 flex items-center gap-2">
            {/* Status indicator */}
            <span className="flex items-center gap-1">
              {status === 'available' && (
                <Check className="h-3 w-3 text-success" aria-hidden="true" />
              )}
              {status === 'error' && <X className="h-3 w-3 text-error" aria-hidden="true" />}
              <span className={cn(config.showSpinner ? 'text-sm' : 'text-xs', config.textClass)}>
                {config.label}
              </span>
            </span>

            {/* Expiration countdown */}
            {expiryLabel && (
              <>
                <span className="text-muted-foreground">•</span>
                <span
                  className={cn('text-xs', expiryLabel.expired ? 'text-warning' : 'text-orange-400')}
                >
                  {expiryLabel.text}
                </span>
              </>
            )}
          </div>

          {/* Error message */}
          {status === 'error' && errorMessage && (
            <span className="mt-1 text-xs text-error">{errorMessage}</span>
          )}
        </div>

        {/* Delete button */}
        <Button
          variant="ghost"
          size="icon"
          className="ml-2 size-8 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          onClick={handleDelete}
          disabled={deleteDisabled}
          aria-label={deleteDisabled ? `Delete ${title} (disabled)` : `Delete ${title}`}
          title={
            isProcessing
              ? 'Wait for upload to complete'
              : deleteDisabled
                ? 'Cannot delete files during active operations'
                : 'Delete file'
          }
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
