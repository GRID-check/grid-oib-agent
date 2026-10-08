/**
 * The name probe's wire contract: "which of these filenames does this shelf
 * already hold?" (ADR-0055 — the routes, the client and the tests share it).
 *
 * The upload planner must not answer that from the listing the browser has
 * loaded. A listing is paged, can be narrowed by a filter, and leaves archived
 * documents out — while the server's upload replaces by filename across all of
 * them (`findLiveDocumentByFilename`, `uniq_documents_live_name_per_collection`).
 * A same-name document the browser has not loaded would be silently given a
 * new version. The probe asks the database the question the upload will ask.
 *
 * A match is returned when the name is the SAME document to the server (the
 * filename, in either Unicode form) or to a person (the filename or the rename,
 * case-folded — the planner's `duplicate`). Only person-uploaded rows: the
 * unique index is partial on `authored_by = 'user'`, and a machine-authored row
 * coexists with a person's file of the same name. Archived rows ARE included,
 * because the upload versions them too; `lifecycle` says which they are.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { DOCUMENT_AUTHORS } from './document-authors'
import { DOCUMENT_LIFECYCLES } from './lifecycle-types'

/**
 * Most names one probe carries — the folder-drop walker's own ceiling
 * (`dropped-entries.ts` stops at 2000 files).
 */
export const NAME_PROBE_MAX_NAMES = 2000

const names = z.array(z.string().min(1).max(1024)).min(1).max(NAME_PROBE_MAX_NAMES)

export const archivNameProbeRequestSchema = z.object({ names })
export const projectNameProbeRequestSchema = z.object({ projectId: z.string().min(1), names })

export const documentNameMatchSchema = z.object({
  id: z.string(),
  filename: z.string(),
  displayName: z.string().nullable(),
  fileSize: z.number().nullable(),
  contentHash: z.string().nullable(),
  folderId: z.string().nullable(),
  authoredBy: z.enum(DOCUMENT_AUTHORS),
  lifecycle: z.enum(DOCUMENT_LIFECYCLES),
})
export type DocumentNameMatch = z.infer<typeof documentNameMatchSchema>

export const nameProbeResponseSchema = z.object({ documents: z.array(documentNameMatchSchema) })
export type NameProbeResponse = z.infer<typeof nameProbeResponseSchema>
