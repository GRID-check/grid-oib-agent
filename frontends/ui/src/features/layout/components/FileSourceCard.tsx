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
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { motion, springGentle } from '@/components/motion'
import { useIsCurrentSessionBusy } from '@/features/chat'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'

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
  /**
   * Opens a read-only preview of the file. When provided AND the file is
   * `available`, the icon+content become a button so tapping the row previews it
   * (matching the "tap a file → preview" model). Omitted or non-available files
   * stay inert — there is nothing to preview yet.
   */
  onOpen?: (id: string) => void
}

/** Status configuration for styling */
const STATUS_CONFIG: Record<
  FileSourceStatus,
  { labelKey: string; textClass: string; showSpinner: boolean }
> = {
  uploading: {
    labelKey: 'fileSourceCard.statusUploading',
    textClass: 'text-info',
    showSpinner: true,
  },
  ingesting: {
    labelKey: 'fileSourceCard.statusIngesting',
    textClass: 'text-info',
    showSpinner: true,
  },
  available: {
    labelKey: 'fileSourceCard.statusAvailable',
    textClass: 'text-success',
    showSpinner: false,
  },
  error: {
    labelKey: 'fileSourceCard.statusError',
    textClass: 'text-error',
    showSpinner: false,
  },
  deleting: {
    labelKey: 'fileSourceCard.statusDeleting',
    textClass: 'text-muted-foreground',
    showSpinner: true,
  },
}

/**
 * Format upload timestamp for display
 */
const formatDateTime = (date: Date | string, locale?: string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleString(locale, {
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

/** Expiry state exposed to the component for localized formatting. */
type ExpiryInfo = { expired: boolean; minutes: number }

/**
 * Compute expiry state from milliseconds remaining.
 * Returns null when expiration doesn't apply.
 */
const computeExpiryInfo = (msRemaining: number | null): ExpiryInfo | null => {
  if (msRemaining === null) return null
  if (msRemaining <= 0) return { expired: true, minutes: 0 }

  const totalMinutes = Math.max(1, Math.ceil(msRemaining / 60_000))
  return { expired: false, minutes: totalMinutes }
}

/**
 * Hook that returns live expiry state, re-evaluated every minute.
 */
const useExpiryInfo = (
  uploadedAt: Date | string | null | undefined,
  intervalHours: number,
  active: boolean
): ExpiryInfo | null => {
  const [info, setInfo] = useState<ExpiryInfo | null>(() =>
    active ? computeExpiryInfo(computeMsRemaining(uploadedAt, intervalHours)) : null
  )

  useEffect(() => {
    if (!active) {
      setInfo(null)
      return
    }

    // Compute immediately
    setInfo(computeExpiryInfo(computeMsRemaining(uploadedAt, intervalHours)))

    // Re-evaluate every 60 seconds
    const id = setInterval(() => {
      setInfo(computeExpiryInfo(computeMsRemaining(uploadedAt, intervalHours)))
    }, 60_000)

    return () => clearInterval(id)
  }, [uploadedAt, intervalHours, active])

  return info
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
  onOpen,
}) => {
  const t = useTranslations('research')
  const { locale } = useLocale()
  const config = STATUS_CONFIG[status]
  const label = t(config.labelKey)
  const isBusy = useIsCurrentSessionBusy()
  const expiryInfo = useExpiryInfo(uploadedAt, expirationIntervalHours, status === 'available')

  const handleDelete = () => {
    onDelete(id)
  }

  const isProcessing = status === 'uploading' || status === 'ingesting'
  const isDeleting = status === 'deleting'
  const deleteDisabled = isBusy || isProcessing || isDeleting
  // Only an available file has something to preview; before that there is no
  // persisted document behind the row.
  const canOpen = !!onOpen && status === 'available'

  // Icon + textual content, shared by the openable-button and inert-div layouts.
  const rowBody = (
    <>
      {/* File Icon or Spinner */}
      {config.showSpinner ? (
        <Spinner size="sm" label={label} />
      ) : (
        <FileText
          className={cn('size-8', status === 'error' ? 'text-error' : 'text-muted-foreground')}
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
              {formatBytes(fileSize, locale)}
            </span>
          )}
          {uploadedAt && (
            <>
              <span className="shrink-0 text-muted-foreground">•</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDateTime(uploadedAt, locale)}
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
              <Check className="size-3 text-success" aria-hidden="true" />
            )}
            {status === 'error' && <X className="size-3 text-error" aria-hidden="true" />}
            <span className={cn(config.showSpinner ? 'text-sm' : 'text-xs', config.textClass)}>
              {label}
            </span>
          </span>

          {/* Expiration countdown */}
          {expiryInfo && (
            <>
              <span className="text-muted-foreground">•</span>
              <span className={cn('text-xs', expiryInfo.expired ? 'text-error' : 'text-warning')}>
                {expiryInfo.expired
                  ? t('fileSourceCard.expiryPending')
                  : t('fileSourceCard.expiresIn', { minutes: expiryInfo.minutes })}
              </span>
            </>
          )}
        </div>

        {/* Error message */}
        {status === 'error' && errorMessage && (
          <span className="mt-1 text-xs text-error">{errorMessage}</span>
        )}
      </div>
    </>
  )

  return (
    <motion.div
      className={cn(
        'group flex items-start justify-between rounded-2xl bg-card p-3 shadow-xs transition-colors duration-quick ease-out',
        status === 'error' && 'ring-1 ring-error/40'
      )}
      initial={{ opacity: 0, y: 8 }}
      // Deleting state dims the card (was `opacity-50`; motion owns inline opacity now)
      animate={{ opacity: isDeleting ? 0.5 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={springGentle}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {canOpen ? (
          <button
            type="button"
            onClick={() => onOpen?.(id)}
            aria-label={t('fileSourceCard.open', { title })}
            className="focus-visible:ring-ring/50 -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left focus-visible:outline-none focus-visible:ring-2"
          >
            {rowBody}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{rowBody}</div>
        )}

        {/* Delete button */}
        <Button
          variant="ghost"
          size="icon"
          // `focus-visible:opacity-100` already gave the keyboard a way in;
          // `pointer-coarse:opacity-100` is the same admission for a finger.
          // Hover is the only trigger a touch device cannot generate, so without
          // it this row's delete was a control that existed, took a tab stop, and
          // could never be seen on a phone.
          className="ml-2 size-8 flex-shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity duration-quick ease-out hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
          onClick={handleDelete}
          disabled={deleteDisabled}
          aria-label={
            deleteDisabled
              ? t('fileSourceCard.deleteDisabled', { title })
              : t('fileSourceCard.delete', { title })
          }
          title={
            isProcessing
              ? t('fileSourceCard.waitUpload')
              : deleteDisabled
                ? t('fileSourceCard.cannotDeleteBusy')
                : t('fileSourceCard.deleteFile')
          }
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </motion.div>
  )
}

/**
 * Loading placeholder that mirrors a real {@link FileSourceCard}'s shape — an
 * icon block plus two text lines inside the same rounded card — so the file list
 * loads with the skeleton vocabulary used by the grid file surfaces, instead of
 * a lone centered spinner.
 */
export const FileSourceCardSkeleton: FC = () => (
  <div className="flex items-center gap-3 rounded-2xl bg-card p-3 shadow-xs">
    <Skeleton className="size-8 shrink-0 rounded-lg" />
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3 w-1/4" />
    </div>
  </div>
)
