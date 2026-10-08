/**
 * The mail import's wire shapes (ADR-0085), shared by the routes, the service
 * and the client. No server imports: the upload dialog reads these too.
 */

import { z } from 'zod'
import type { MailImportSkippedSample, MailImportStatus } from '@/lib/db/schema/mail-imports'

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
  /** Whether the viewer may send parts, complete or cancel it. */
  ownedByViewer: boolean
  /** The folder the mails are filed under, once the job has made it. */
  folderId: string | null
  totalItems: number | null
  processedItems: number
  mailsFiled: number
  filesFiled: number
  itemsSkipped: number
  filesSkipped: number
  skippedSamples: MailImportSkippedSample[]
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
