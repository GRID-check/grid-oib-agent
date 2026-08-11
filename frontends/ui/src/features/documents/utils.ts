/**
 * Document Feature Utilities
 *
 * Shared utility functions for status mapping and other common operations.
 */

import type { DocumentFileStatus } from './types'
import type { FileSourceStatus } from '@/features/layout/components/FileSourceCard'

/**
 * Map backend file status string to DocumentFileStatus
 */
export const mapBackendStatus = (backendStatus: string): DocumentFileStatus => {
  const statusMap: Record<string, DocumentFileStatus> = {
    uploading: 'uploading',
    ingesting: 'ingesting',
    success: 'success',
    failed: 'failed',
  }
  return statusMap[backendStatus] || 'uploading'
}

/**
 * Map the durable-upload endpoint's document status onto a tracked-file status.
 *
 * The BFF answers with the DOCUMENT's lifecycle (`pending` / `processing` /
 * `uploaded` / `failed`), which is a different vocabulary from the tracked
 * file's. `uploaded` is the odd one: the bytes are stored but ingest handed
 * back no job, so nothing will ever poll it — it is as finished as it is going
 * to get, which is what `success` means here and what the status badge already
 * renders it as.
 */
export const mapUploadResponseStatus = (status: string | null | undefined): DocumentFileStatus => {
  switch (status) {
    case 'failed':
      return 'failed'
    case 'uploaded':
      return 'success'
    default:
      return 'ingesting'
  }
}

/**
 * Map DocumentFileStatus to FileSourceCard display status
 */
export const mapToDisplayStatus = (status: string): FileSourceStatus => {
  switch (status) {
    case 'uploading':
      return 'uploading'
    case 'ingesting':
      return 'ingesting'
    case 'success':
      return 'available'
    case 'failed':
      return 'error'
    case 'deleting':
      return 'deleting'
    default:
      return 'uploading'
  }
}

/**
 * Normalize backend filename to display name.
 * Backend returns filenames like "tmp_m04en5b_original-file.pdf"
 * This extracts "original-file.pdf" for display.
 *
 * Pattern: tmp_{random_id}_{original_filename}
 */
export const normalizeFileName = (backendFileName: string): string => {
  // Match pattern: tmp_{alphanumeric_id}_{rest}
  const match = backendFileName.match(/^tmp_[a-z0-9]+_(.+)$/i)
  if (match) {
    return match[1]
  }
  return backendFileName
}
