/**
 * The Outlook archive import (ADR-0085): start one, send the archive in parts,
 * complete it, cancel it, list a project's imports.
 *
 * Authorization is the upload path's: `project:documents:write` on the project
 * to start and send, `project:view` to see that imports exist. An import
 * belongs to the person who started it; only they send its parts, complete or
 * cancel it, and a holder of `org:projects:administer` may cancel anyone's,
 * because a stuck twenty-gigabyte upload must not wait for its owner to return.
 * The job that files it is `./job.ts`.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isMailImportEnabled } from '@/lib/authz/feature-flags'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { MailImport } from '@/lib/db/schema'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { projectShelf } from '@/lib/documents/shelf'
import { BFF_JOB_PRIORITY, requesterOf } from '@/lib/jobs-queue/types'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { MAIL_ARCHIVE_EXTENSIONS, MAIL_IMPORT_PART_BYTES, maxArchiveBytes } from './config'
import * as repository from './repository'
import {
  abortStagedUpload,
  beginStagedUpload,
  completeStagedUpload,
  deleteStagedArchive,
  listStagedParts,
  putStagedPart,
  type UploadedPart,
} from './staging'
import type { MailImportList, MailImportUploadPlan, MailImportView, StartMailImportInput } from './types'

/** Imports one person may have open in one project at a time. */
const OPEN_IMPORTS_PER_PERSON = 1

export async function listMailImports(session: AuthorizedSession, projectId: string): Promise<MailImportList> {
  await requireProjectAccess(session, projectId, 'project:view')
  const rows = await repository.listProjectMailImports(session.organizationId, projectId)
  return {
    imports: rows.map((row) => toView(row, session)),
    maxSizeBytes: maxArchiveBytes(),
    partSize: MAIL_IMPORT_PART_BYTES,
  }
}

export async function startMailImport(
  session: AuthorizedSession,
  projectId: string,
  input: StartMailImportInput,
): Promise<MailImportUploadPlan> {
  requireEnabled(session)
  await requireShelfWrite(session, projectShelf(projectId))
  assertArchiveAccepted(input)
  await assertWithinStorageQuota(session.organizationId, input.sizeBytes)

  const open = (await repository.listProjectMailImports(session.organizationId, projectId)).filter(
    (row) => row.userId === session.userId && isOpen(row),
  )
  if (open.length >= OPEN_IMPORTS_PER_PERSON) {
    throw new ConflictError('An import of yours is still running in this project.', { importId: open[0].id })
  }

  const id = randomUUID()
  const staged = await beginStagedUpload(session.organizationId, id)
  const row = await repository.insertMailImport({
    id,
    organizationId: session.organizationId,
    projectId,
    userId: session.userId,
    userEmail: session.email || null,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    stagingBucket: staged.bucket,
    stagingKey: staged.key,
    uploadId: staged.uploadId,
  })
  return uploadPlan(row, session, [])
}

/** The plan for a send that broke off: which parts the store already has. */
export async function resumeMailImportUpload(
  session: AuthorizedSession,
  projectId: string,
  importId: string,
): Promise<MailImportUploadPlan> {
  const row = await ownedUpload(session, projectId, importId)
  const parts = await listStagedParts(staged(row), uploadIdOf(row))
  return uploadPlan(row, session, parts.map((part) => part.partNumber))
}

export async function putMailImportPart(
  session: AuthorizedSession,
  projectId: string,
  importId: string,
  partNumber: number,
  request: Request,
): Promise<{ partNumber: number }> {
  const row = await ownedUpload(session, projectId, importId)
  const expected = expectedPartSize(row.sizeBytes, partNumber)
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared !== expected) {
    throw new BadRequestError(`Part ${partNumber} must be ${expected} bytes`, { expected, declared })
  }
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength !== expected) {
    throw new BadRequestError(`Part ${partNumber} must be ${expected} bytes`, { expected, received: body.byteLength })
  }
  await putStagedPart(staged(row), uploadIdOf(row), partNumber, body)
  // Touch the row: an upload still receiving parts is not a stale one.
  await repository.updateMailImport(session.organizationId, row.id, ['uploading'], {})
  return { partNumber }
}

export async function completeMailImportUpload(
  session: AuthorizedSession,
  projectId: string,
  importId: string,
): Promise<MailImportView> {
  requireEnabled(session)
  const row = await ownedUpload(session, projectId, importId)
  const parts = await listStagedParts(staged(row), uploadIdOf(row))
  const missing = missingParts(row.sizeBytes, parts)
  if (missing.length > 0) {
    throw new ConflictError('The archive has not been sent completely.', { missingParts: missing.slice(0, 50) })
  }
  await completeStagedUpload(staged(row), uploadIdOf(row), parts)

  const queued = await repository.updateMailImport(session.organizationId, row.id, ['uploading'], {
    status: 'queued',
    uploadId: null,
  })
  if (!queued) throw new ConflictError('The import was cancelled meanwhile.')
  await enqueueJob({
    kind: 'mail_import',
    organizationId: session.organizationId,
    priority: BFF_JOB_PRIORITY.bulk,
    payload: { importId: row.id, projectId, requester: requesterOf(session) },
  })
  return toView(queued, session)
}

export async function cancelMailImport(
  session: AuthorizedSession,
  projectId: string,
  importId: string,
): Promise<MailImportView> {
  await requireProjectAccess(session, projectId, 'project:view')
  const row = await repository.findMailImport(session.organizationId, projectId, importId)
  if (!row) throw new NotFoundError('Import not found')
  const mayCancel = row.userId === session.userId || hasPermission(session, ORG_PERMISSIONS.projectsAdminister)
  if (!mayCancel) throw new ForbiddenError()
  if (!isOpen(row)) return toView(row, session)

  const now = new Date()
  const cancelled = await repository.updateMailImport(session.organizationId, row.id, ['uploading', 'queued', 'importing'], {
    status: 'cancelled',
    completedAt: now,
    inflightPosition: null,
    inflightFolderId: null,
  })
  if (!cancelled) return toView((await repository.findMailImport(session.organizationId, projectId, importId)) ?? row, session)
  await discardStaging(cancelled)
  return toView(cancelled, session)
}

/**
 * Delete what an ended import left in storage: its parts, or its archive. A
 * running slice reading the archive meanwhile fails its read and, on the
 * retry, finds the import ended.
 */
export async function discardStaging(row: MailImport): Promise<void> {
  if (row.uploadId) await abortStagedUpload(staged(row), row.uploadId)
  await deleteStagedArchive(staged(row))
  await repository.updateMailImport(row.organizationId, row.id, ['completed', 'failed', 'cancelled'], {
    uploadId: null,
    stagingDeletedAt: new Date(),
  })
}

export function toView(row: MailImport, session: Pick<AuthorizedSession, 'userId'>): MailImportView {
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: Number(row.sizeBytes),
    status: row.status,
    startedBy: { userId: row.userId, email: row.userEmail },
    ownedByViewer: row.userId === session.userId,
    folderId: row.rootFolderId,
    totalItems: row.totalItems,
    processedItems: row.nextPosition,
    mailsFiled: row.mailsFiled,
    filesFiled: row.filesFiled,
    itemsSkipped: row.itemsSkipped,
    filesSkipped: row.filesSkipped,
    skippedSamples: row.skippedSamples,
    error: row.lastError,
    createdAt: new Date(row.createdAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
  }
}

/** How many parts an archive of `sizeBytes` is sent in. */
export function partCountFor(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / MAIL_IMPORT_PART_BYTES))
}

/** The exact size part `partNumber` must have; throws for a number outside the archive. */
export function expectedPartSize(sizeBytes: number, partNumber: number): number {
  const count = partCountFor(sizeBytes)
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new BadRequestError(`Part number must be between 1 and ${count}`)
  }
  return partNumber < count ? MAIL_IMPORT_PART_BYTES : sizeBytes - MAIL_IMPORT_PART_BYTES * (count - 1)
}

/** The part numbers the store does not hold at their exact size. */
export function missingParts(sizeBytes: number, parts: readonly UploadedPart[]): number[] {
  const held = new Map(parts.map((part) => [part.partNumber, part.size]))
  const missing: number[] = []
  for (let n = 1; n <= partCountFor(sizeBytes); n += 1) {
    if (held.get(n) !== expectedPartSize(sizeBytes, n)) missing.push(n)
  }
  return missing
}

function assertArchiveAccepted(input: StartMailImportInput): void {
  const lower = input.filename.toLowerCase()
  if (!MAIL_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    throw new BadRequestError('Only Outlook archives (.pst, .ost) can be imported', {
      accepted: [...MAIL_ARCHIVE_EXTENSIONS],
    })
  }
  const max = maxArchiveBytes()
  if (input.sizeBytes > max) {
    throw new BadRequestError(`The archive exceeds the maximum of ${Math.round(max / 1024 ** 3)} GB`, {
      maxSizeBytes: max,
      fileSize: input.sizeBytes,
    })
  }
}

function requireEnabled(session: AuthorizedSession): void {
  if (!isMailImportEnabled(session)) throw new ForbiddenError('Mail import is not enabled for this organization')
}

/** The import, when it is the caller's and still receiving parts. */
async function ownedUpload(session: AuthorizedSession, projectId: string, importId: string): Promise<MailImport> {
  await requireShelfWrite(session, projectShelf(projectId))
  const row = await repository.findMailImport(session.organizationId, projectId, importId)
  if (!row || row.userId !== session.userId) throw new NotFoundError('Import not found')
  if (row.status !== 'uploading' || !row.uploadId) throw new ConflictError('The import is no longer receiving its archive.')
  return row
}

function uploadPlan(row: MailImport, session: AuthorizedSession, uploadedParts: number[]): MailImportUploadPlan {
  return {
    import: toView(row, session),
    partSize: MAIL_IMPORT_PART_BYTES,
    partCount: partCountFor(Number(row.sizeBytes)),
    uploadedParts,
  }
}

function isOpen(row: MailImport): boolean {
  return row.status === 'uploading' || row.status === 'queued' || row.status === 'importing'
}

function staged(row: MailImport) {
  return { bucket: row.stagingBucket, key: row.stagingKey }
}

function uploadIdOf(row: MailImport): string {
  if (!row.uploadId) throw new ConflictError('The import is no longer receiving its archive.')
  return row.uploadId
}
