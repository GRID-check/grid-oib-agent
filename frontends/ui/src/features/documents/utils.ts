/**
 * Document Feature Utilities
 *
 * Shared utility functions for status mapping and other common operations.
 */

import { reportsQuarantine } from '@/lib/upload-screening/quarantine'
import type { DocumentFileStatus, TrackedFileStatus } from './types'
import type { ListedFileStatus } from '@/adapters/api/documents-schemas'
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
 * A file the backend reports, as a tracked-file status: an ingest job's file
 * (`file_details`) or a listed file (`FileInfo`).
 *
 * The backend's file vocabulary has no word for a file the content check held
 * back (ADR-0086): the job ends it `failed` and says why in `quarantine`
 * (ADR-0113; a job from before the field, in a `quarantined:{…}` error). Read
 * as `failed`, the tray coloured it red and offered to retry it, and the retry
 * was refused, because a re-upload onto a held file is a 409. So the report
 * decides here, once, for every path that reads a backend file.
 */
export const trackedStatusOfJobFile = (jobFile: {
  status: string
  error_message?: string | null
  quarantine?: unknown
}): TrackedFileStatus => {
  if (jobFile.status === 'failed' && reportsQuarantine(jobFile)) return 'held'
  // The two at-rest states only a listing says (`ListedFileStatusSchema`):
  // kept as they are, or a re-list would read them as an upload in flight.
  if (isAtRestListedStatus(jobFile.status)) return jobFile.status
  return mapBackendStatus(jobFile.status)
}

const AT_REST_LISTED_STATUSES: ReadonlySet<string> = new Set<ListedFileStatus>(['stored', 'held'])

function isAtRestListedStatus(status: string): status is 'stored' | 'held' {
  return AT_REST_LISTED_STATUSES.has(status)
}

/**
 * Map the durable-upload endpoint's document status onto a tracked-file status.
 *
 * The BFF answers with the DOCUMENT's lifecycle (`pending` / `processing` /
 * `uploaded` / `failed` / `quarantined`), which is a different vocabulary from
 * the tracked file's:
 *
 * - `uploaded`: the bytes are stored and nothing will read them, so nothing
 *   will ever poll it. That is `stored`, which the status badge renders as
 *   „Abgelegt“, never as citable.
 * - `quarantined`: a row nothing was dispatched for, waiting on a reviewer.
 * - `unchanged`: the server already held these exact bytes as the live
 *   document and wrote nothing. Its answer says `uploaded` only because no
 *   dispatch happened; the document itself is whatever it was, and the tray
 *   says „Unverändert – bereits vorhanden“ for it, so it stays `success`.
 */
export const mapUploadResponseStatus = (
  status: string | null | undefined,
  unchanged = false
): TrackedFileStatus => {
  if (unchanged) return 'success'
  switch (status) {
    case 'failed':
      return 'failed'
    case 'uploaded':
      return 'stored'
    case 'quarantined':
      return 'held'
    default:
      return 'ingesting'
  }
}

/**
 * Map a tracked-file status to the FileSourceCard display status.
 *
 * `stored` is NOT `available`. A chat attachment at `uploaded` was stored and
 * never read: nothing of it is in the index, and it has no passing screening
 * verdict, so the hold of ADR-0086 (amended 2026-10-08) keeps it from every
 * model path, the agent's byte lookup for a chat subject included. The chat
 * cannot answer from it, so it gets the neutral „Abgelegt“, never the green
 * „Verfügbar“. `held` has its own look: nothing failed, so not „Fehler“.
 */
export const mapToDisplayStatus = (status: string): FileSourceStatus => {
  switch (status) {
    case 'uploading':
      return 'uploading'
    case 'ingesting':
      return 'ingesting'
    case 'success':
      return 'available'
    case 'stored':
      return 'stored'
    case 'failed':
      return 'error'
    case 'held':
      return 'held'
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
