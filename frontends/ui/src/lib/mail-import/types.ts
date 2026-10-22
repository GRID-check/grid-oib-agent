/**
 * The mail import's wire shapes (ADR-0085), shared by the routes, the service
 * and the client. No server imports: the upload dialog reads these too.
 */

import { z } from 'zod'
import type { MailImportErrorCode, MailImportSkippedSample, MailImportStatus } from '@/lib/db/schema/mail-imports'
import { decodeDocumentListCursor, DOCUMENT_LIST_CURSOR_MAX_LENGTH } from '@/lib/documents/list-cursor'

export const startMailImportSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
})
export type StartMailImportInput = z.infer<typeof startMailImportSchema>

/** Imports one page carries when the request does not say: the import dialog's list. */
export const MAIL_IMPORT_LIST_PAGE_SIZE = 20
/** The most imports one page carries. Each is a full view with its skip samples, so the page stays small. */
export const MAIL_IMPORT_LIST_PAGE_MAX = 50

/**
 * `GET /api/projects/[id]/mail-imports` (ADR-0131 rule 3): newest first, a page
 * at a time. The cursor is the `nextCursor` of the page before, the last
 * import's position in `created_at DESC, id DESC`; one this list did not write
 * is a 400, never the first page.
 */
export const mailImportListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAIL_IMPORT_LIST_PAGE_MAX)
    .optional()
    .describe(`Default ${MAIL_IMPORT_LIST_PAGE_SIZE}, max ${MAIL_IMPORT_LIST_PAGE_MAX}.`),
  cursor: z
    .string()
    .max(DOCUMENT_LIST_CURSOR_MAX_LENGTH)
    .refine((value) => decodeDocumentListCursor(value) !== null, { message: 'Invalid cursor' })
    .optional()
    .describe('The nextCursor of the previous page.'),
})
export type MailImportListQuery = z.infer<typeof mailImportListQuerySchema>

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
  /** One page, newest first. */
  imports: MailImportView[]
  /** Where the next page starts; `null` on the last. */
  nextCursor: string | null
  /** The largest archive this deployment takes. */
  maxSizeBytes: number
  partSize: number
}
