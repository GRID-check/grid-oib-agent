/**
 * File one archived mail into the project (ADR-0085): a folder for the mail,
 * its attachments, and a Markdown note with its headers and text.
 *
 * Everything goes through the ordinary upload path as the person who started
 * the import, so the same type, size, quota and permission gates apply as when
 * they drop a file, and the audit trail names them. What a person could not
 * upload is skipped and named, never forced in.
 *
 * **Retry-safe by construction.** The job may die anywhere in here and run the
 * same mail again. The mail's folder is recorded (`markInflight`) the moment it
 * exists, so the retry files into it rather than beside it. A file whose name
 * is already in that folder is uploaded under the same name, which makes it the
 * same document again: a new version of it, or `unchanged` when its bytes are
 * identical and it has finished indexing. Never a second document. Names are
 * chosen in attachment order with the names this mail already claimed set
 * aside, so a retry arrives at the same name for the same file.
 */

import 'server-only'
import { BadRequestError, InsufficientStorageError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport, MailImportSkippedSample, MailImportSkipReason } from '@/lib/db/schema'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { documentNameKey } from '@/lib/documents/name-match'
import { findLiveDocumentByFilename } from '@/lib/documents/repository'
import { assertFileSizeAllowed, assertUploadTypeAllowed, uploadDocument } from '@/lib/documents/service'
import { projectShelf } from '@/lib/documents/shelf'
import { shelfCollectionName } from '@/lib/documents/shelf-collection'
import { FOLDER_NAME_TAKEN } from '@/lib/documents/shelf-folders'
import { createProjectFolder, ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import {
  AttachmentTooLargeError,
  AttachmentUnreadableError,
  readArchiveAttachment,
  type ArchiveAttachment,
  type ArchiveMail,
  type ArchiveRef,
} from './archive-client'
import {
  attachmentFilename,
  mailFolderName,
  mailNote,
  noteFilename,
  numbered,
  numberedFilename,
  outlookFolderPath,
} from './naming'
import { markInflight } from './repository'

/** Candidates tried for a taken name before the mail is given up on. */
const MAX_NAME_ATTEMPTS = 50

/** The slice's time is up in the middle of a mail; the next slice resumes into its folder. */
export class SliceBudgetSpentError extends Error {
  constructor() {
    super('The slice budget was spent in the middle of a mail')
    this.name = 'SliceBudgetSpentError'
  }
}

/** The import moved on under this slice (cancelled, or another slice took it over). */
export class ImportMovedOnError extends Error {
  constructor() {
    super('The import is no longer at this mail')
    this.name = 'ImportMovedOnError'
  }
}

/** The storage quota ran out: no later mail can be filed either. */
export class MailImportQuotaError extends Error {
  constructor() {
    super('The organization’s storage quota is full.')
    this.name = 'MailImportQuotaError'
  }
}

export interface FilingContext {
  session: AuthorizedSession
  mailImport: MailImport
  archive: ArchiveRef
  /** The folder the archive's tree is mirrored under. */
  archiveFolderId: string
  collectionName: string
  request: Request
  /** Outlook folder path → project folder id, for this slice. */
  folders: Map<string, string>
  /** `Date.now()` past which no new attachment is started. */
  deadline: number
}

export interface FiledMail {
  folderName: string
  filesFiled: number
  filesSkipped: number
  skipped: MailImportSkippedSample[]
}

/** Build the context a slice files with; throws when the project has no collection. */
export async function filingContext(
  input: Omit<FilingContext, 'collectionName' | 'folders' | 'deadline'> & { deadline?: number },
): Promise<FilingContext> {
  const shelf = projectShelf(input.mailImport.projectId)
  const collectionName = await shelfCollectionName(shelf, input.session.organizationId)
  if (!collectionName) throw new NotFoundError('Project not found')
  return { deadline: Number.POSITIVE_INFINITY, ...input, collectionName, folders: new Map() }
}

/**
 * File one mail. Throws {@link MailImportQuotaError} when nothing more can be
 * stored, {@link SliceBudgetSpentError} when the slice's time ran out between
 * two of its files, and {@link ImportMovedOnError} when the import moved on.
 */
export async function fileMail(context: FilingContext, mail: ArchiveMail): Promise<FiledMail> {
  const folder = await mailFolder(context, mail)
  const result: FiledMail = { folderName: folder.name, filesFiled: 0, filesSkipped: 0, skipped: [] }
  const filedNames: string[] = []
  // Names this mail has taken so far: the second `scan.pdf` of one mail is
  // `scan (2).pdf`, not a new version of the first.
  const claimed = new Set<string>()

  for (const attachment of mail.attachments) {
    if (attachment.inline) continue
    if (Date.now() >= context.deadline) throw new SliceBudgetSpentError()
    const outcome = await fileAttachment(context, mail, folder, attachment, claimed)
    if (outcome.filed) {
      result.filesFiled += 1
      filedNames.push(outcome.filename)
      continue
    }
    result.filesSkipped += 1
    result.skipped.push({ mail: folder.name, file: attachment.filename, reason: outcome.reason })
  }

  const note = mailNote(
    {
      subject: mail.subject,
      sender: mail.sender,
      to: mail.to,
      cc: mail.cc,
      sentAt: mail.sent_at,
      receivedAt: mail.received_at,
      folderPath: mail.folder_path,
      body: mail.body,
    },
    filedNames,
  )
  const noteName = noteFilename(folder.name)
  const filedNote = await fileBytes(context, folder.id, noteName, new TextEncoder().encode(note), 'text/markdown', claimed)
  if (!filedNote) {
    result.filesSkipped += 1
    result.skipped.push({ mail: folder.name, file: noteName, reason: 'type' })
  }
  return result
}

interface MailFolder {
  id: string
  name: string
}

/** The mail's folder: the one a died slice recorded, or a new one with the first free name. */
async function mailFolder(context: FilingContext, mail: ArchiveMail): Promise<MailFolder> {
  const { mailImport, session } = context
  if (mailImport.inflightPosition === mail.position && mailImport.inflightFolderId) {
    const path = await resolveShelfFolderPath(
      projectShelf(mailImport.projectId),
      mailImport.inflightFolderId,
      session.organizationId,
    )
    if (path !== null) return { id: mailImport.inflightFolderId, name: path.split('/').pop() ?? path }
  }
  const parentId = await outlookFolder(context, mail.folder_path)
  const folder = await createFolderWithFreeName(context, parentId, mailFolderName(mail.sent_at ?? mail.received_at, mail.sender))
  // Fenced: a slice that is no longer the import's (cancelled, or another
  // slice moved the cursor) must not file into the folder it just made.
  if (!(await markInflight(session.organizationId, mailImport.id, mail.position, folder.id))) {
    throw new ImportMovedOnError()
  }
  return folder
}

/** The project folder mirroring an Outlook folder path, created on first use. */
async function outlookFolder(context: FilingContext, outlookPath: readonly string[]): Promise<string> {
  const path = outlookFolderPath(outlookPath)
  if (!path) return context.archiveFolderId
  const known = context.folders.get(path)
  if (known) return known

  const ensured = await ensureProjectFolderPaths(
    { projectId: context.mailImport.projectId, parentId: context.archiveFolderId, paths: [path] },
    context.session,
  )
  const id = ensured.ok ? ensured.folderIdByPath[path] : undefined
  if (!id) throw new Error(`could not create the folder ${path}: ${ensured.ok ? 'no id' : ensured.error}`)
  context.folders.set(path, id)
  return id
}

/** Create `name` under `parentId`, or `name (2)`, `name (3)`… when a sibling has it. */
export async function createFolderWithFreeName(
  context: Pick<FilingContext, 'session' | 'mailImport'>,
  parentId: string | null,
  name: string,
): Promise<MailFolder> {
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n += 1) {
    const candidate = numbered(name, n)
    const created = await createProjectFolder(
      { projectId: context.mailImport.projectId, parentId, name: candidate },
      context.session,
    )
    if (created.ok) return { id: created.folder.id, name: created.folder.name }
    if (created.error !== FOLDER_NAME_TAKEN) throw new Error(`could not create the folder ${candidate}: ${created.error}`)
  }
  throw new Error(`no free folder name for ${name} after ${MAX_NAME_ATTEMPTS} attempts`)
}

type AttachmentOutcome = { filed: true; filename: string } | { filed: false; reason: MailImportSkipReason }

async function fileAttachment(
  context: FilingContext,
  mail: ArchiveMail,
  folder: MailFolder,
  attachment: ArchiveAttachment,
  claimed: Set<string>,
): Promise<AttachmentOutcome> {
  if (attachment.embedded_message) return { filed: false, reason: 'embedded_message' }
  const desired = attachmentFilename(folder.name, attachment.filename)
  const refused = await refusalBeforeReading(context.session, desired, attachment.size)
  if (refused) return { filed: false, reason: refused }

  let bytes: Uint8Array
  try {
    bytes = await readArchiveAttachment(context.archive, mail.position, attachment.index)
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) return { filed: false, reason: 'size' }
    if (error instanceof AttachmentUnreadableError) return { filed: false, reason: 'unreadable' }
    throw error
  }
  const filename = await fileBytes(context, folder.id, desired, bytes, attachment.content_type ?? '', claimed)
  return filename ? { filed: true, filename } : { filed: false, reason: 'type' }
}

/** What the upload gates would refuse, asked before the bytes are fetched from the archive. */
async function refusalBeforeReading(
  session: AuthorizedSession,
  filename: string,
  size: number,
): Promise<MailImportSkipReason | null> {
  try {
    await assertUploadTypeAllowed(session, filename)
  } catch (error) {
    if (error instanceof BadRequestError) return 'type'
    throw error
  }
  try {
    assertFileSizeAllowed(size, filename)
  } catch (error) {
    if (error instanceof BadRequestError) return 'size'
    throw error
  }
  return null
}

/**
 * Upload `bytes` into the mail's folder under the first name free in the
 * project. The name used, or null when the upload path refused the file: a
 * refusal a retry would repeat, so it is a skip, not a failed slice.
 */
async function fileBytes(
  context: FilingContext,
  folderId: string,
  desired: string,
  bytes: Uint8Array,
  contentType: string,
  claimed: Set<string>,
): Promise<string | null> {
  const filename = await freeFilename(context, folderId, desired, claimed)
  claimed.add(filename)
  const file = new File([bytes as Uint8Array<ArrayBuffer>], filename, { type: contentType })
  try {
    await uploadDocument(
      context.session,
      { projectId: context.mailImport.projectId, folderId, file, priority: 'bulk' },
      context.request,
    )
  } catch (error) {
    if (error instanceof InsufficientStorageError) throw new MailImportQuotaError()
    if (error instanceof BadRequestError) return null
    throw error
  }
  return filename
}

/**
 * The first of `desired`, `desired (2)`… that this mail has not taken already
 * and that no document in the project has, or that the one in this very
 * folder has (a retry of this mail).
 */
async function freeFilename(
  context: FilingContext,
  folderId: string,
  desired: string,
  claimed: ReadonlySet<string>,
): Promise<string> {
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n += 1) {
    const candidate = documentNameKey(numberedFilename(desired, n))
    if (claimed.has(candidate)) continue
    const existing = await findLiveDocumentByFilename(context.session.organizationId, context.collectionName, candidate)
    if (!existing || existing.folderId === folderId) return candidate
  }
  throw new Error(`no free filename for ${desired} after ${MAX_NAME_ATTEMPTS} attempts`)
}
