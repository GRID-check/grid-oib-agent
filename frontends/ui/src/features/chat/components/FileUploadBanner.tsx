/**
 * FileUploadBanner Component
 *
 * Displays status banners for file upload progress in the chat area.
 * Variants:
 * - "uploaded": Informational banner shown when files start uploading/ingesting
 * - "pending_warning": Warning when user submits with pending files
 */

'use client'

import { type FC } from 'react'
import { Info, AlertTriangle, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatTime } from '@/shared/utils/format-time'
import type { FileUploadStatusType } from '../types'

export interface FileUploadBannerProps {
  /** Type of status: uploaded or pending_warning */
  type: FileUploadStatusType
  /** Number of files in the batch */
  fileCount: number
  /** Timestamp of the status update (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /** Callback when the banner is dismissed (removes message from chat) */
  onDismiss?: () => void
}

interface BannerContent {
  message: string
  status: 'info' | 'warning'
  dismissable: boolean
}

/**
 * Banner content configuration for each status type.
 * Returns null for unknown/legacy types (e.g. 'ingested' from persisted conversations)
 * so the component can skip rendering them.
 */
const getBannerContent = (type: FileUploadStatusType): BannerContent | null => {
  switch (type) {
    case 'uploaded':
      return {
        message:
          'File is uploading and ingesting. Until completion, a file cannot be included in queries.',
        status: 'info',
        dismissable: true,
      }
    case 'pending_warning':
      return {
        message:
          'Files are pending! Wait until they are ready or send your query again to continue WITHOUT those files.',
        status: 'warning',
        dismissable: false,
      }
    default:
      // Legacy/unknown types from persisted conversations — skip silently
      return null
  }
}

/**
 * File upload status banner displayed in the chat area
 */
export const FileUploadBanner: FC<FileUploadBannerProps> = ({
  type,
  timestamp,
  onDismiss,
}) => {
  const content = getBannerContent(type)

  // Skip rendering for unknown/legacy types
  if (!content) return null

  const StatusIcon = content.status === 'warning' ? AlertTriangle : Info
  const showDismiss = content.dismissable && !!onDismiss

  return (
    <div className="flex w-full flex-col gap-1">
      <Alert variant={content.status} className="relative">
        <StatusIcon />
        <AlertDescription className={showDismiss ? 'pr-6' : undefined}>
          {content.message}
        </AlertDescription>
        {showDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground absolute right-3 top-3 rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </Alert>
      {timestamp && (
        <span className="text-subtle mr-3 self-end text-xs">{formatTime(timestamp)}</span>
      )}
    </div>
  )
}
