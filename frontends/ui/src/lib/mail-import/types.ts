/**
 * The mail import's wire shapes (ADR-0085), shared by the routes, the service
 * and the client. No server imports: the upload dialog reads these too.
 */

import { z } from 'zod'
import type { MailImportErrorCode, MailImportSkippedSample, MailImportStatus } from '@/lib/db/schema/mail-imports'

export const startMailImportSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
})
export type StartMailImportInput = z.infer<typeof startMailImportSchema>

/** One import as the project's files view shows it. */
export interface MailImportView {
  id: string
  filename: string
  sizeBytes: number
  status: MailImportStatus
  /** Who started it, so a colleague sees whose import is running. */
  startedBy: { userId: string; email: string | null }
  /** Whether the viewer started it, and so may send its parts or resume it. */
  ownedByViewer: boolean
  /** Whether the viewer may cancel it now: its starter, or a holder of `org:projects:administer`. */
  cancellable: boolean
  /** The folder the mails are filed under, once the job has made it. */
  folderId: string | null
  totalItems: number | null
  processedItems: number
  mailsFiled: number
  filesFiled: number
  itemsSkipped: number
  filesSkipped: number
  skippedSamples: MailImportSkippedSample[]
  /** Why it ended without filing everything; the dialog words it. */
  errorCode: MailImportErrorCode | null
  /** The technical detail, shown only where the code alone says too little (`stopped`). */
  error: string | null
  createdAt: string
  completedAt: string | null
}

/** What the client needs to send an archive, and to resume a send that broke off. */
export interface MailImportUploadPlan {
  import: MailImportView
  partSize: number
  partCount: number
  /** Parts the store already holds: a resumed upload skips them. */
  uploadedParts: number[]
}

export interface MailImportList {
  imports: MailImportView[]
  /** The largest archive this deployment takes. */
  maxSizeBytes: number
  partSize: number
}
