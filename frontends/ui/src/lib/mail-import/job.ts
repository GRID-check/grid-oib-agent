/**
 * The job that files a staged archive into its project (ADR-0085), one slice
 * at a time on the BFF job queue (ADR-0079).
 *
 * A slice reads pages of messages from the backend from the import's cursor
 * and files each mail before it moves the cursor past it, until its time
 * budget is spent; then it hands back and the runner calls it again. All state
 * is on the `mail_imports` row, so a slice on another worker resumes exactly
 * there, and the job's own payload only names the import and who asked.
 *
 * Endings. The archive filed completely: `completed`. The archive is not one
 * the backend can read, the quota is full, or the person lost access:
 * `failed`, at once, because no retry changes that. Anything else (the store,
 * the backend restarting) throws for the queue to retry, and on the last
 * attempt the import is ended `failed` with the reason rather than left
 * reading `importing` forever. Each ending deletes the staged archive and
 * tells the person in their inbox.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport, MailImportSkippedSample, MailImportStatus } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { projectShelf } from '@/lib/documents/shelf'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import type { JobAttempt, JobSliceResult, MailImportPayload } from '@/lib/jobs-queue/types'
import { getOrCreateProjectFolderByName } from '@/lib/projects/folder-service'
import { readArchivePage, UnreadableArchiveError, type ArchiveItem, type ArchiveRef } from './archive-client'
import {
  MAIL_IMPORT_PAGE_SIZE,
  MAIL_IMPORT_ROOT_FOLDER,
  MAIL_IMPORT_SLICE_BUDGET_MS,
  SKIPPED_SAMPLES_KEPT,
  STALE_UPLOAD_HOURS,
  STALLED_IMPORT_MINUTES,
} from './config'
import { createFolderWithFreeName, fileMail, filingContext, MailImportQuotaError, type FilingContext } from './filing'
import { archiveFolderName } from './naming'
import * as repository from './repository'
import { discardStaging } from './service'
import { archiveUrlForBackend } from './staging'

/** A reason no retry changes; the import ends `failed` with it. */
class PermanentImportFailure extends Error {}

const OPEN: MailImportStatus[] = ['queued', 'importing']

/**
 * One slice. `session` is the requester's today, or null when they are no
 * longer a member, which ends the import.
 */
export async function runMailImportSlice(
  session: AuthorizedSession | null,
  payload: MailImportPayload,
  attempt: JobAttempt,
  organizationId: string,
): Promise<JobSliceResult<MailImportPayload>> {
  const done = { done: true, payload }
  const row = await repository.findMailImport(organizationId, payload.projectId, payload.importId)
  if (!row || !OPEN.includes(row.status)) return done
  if (!session) {
    await finish(row, 'failed', 'The person who started the import is no longer a member of the organization.')
    return done
  }
  try {
    const finished = await fileUntilBudget(session, row)
    return finished ? done : { done: false, payload }
  } catch (error) {
    const reason = failureReason(error)
    if (!reason && !attempt.last) throw error
    await finish(row, 'failed', reason ?? `The import stopped after repeated errors: ${messageOf(error)}`)
    return done
  }
}

/** File from the cursor until the budget is spent; true when the archive is done. */
async function fileUntilBudget(session: AuthorizedSession, initial: MailImport): Promise<boolean> {
  const deadline = Date.now() + MAIL_IMPORT_SLICE_BUDGET_MS
  const context = await startSlice(session, initial)
  if (!context) return true
  while (Date.now() < deadline) {
    const page = await readArchivePage(context.archive, context.mailImport.nextPosition, MAIL_IMPORT_PAGE_SIZE)
    await recordTotal(context, page.total)
    for (const item of page.messages) {
      if (Date.now() >= deadline) return false
      if (!(await fileItem(context, item))) return true
    }
    if (page.next_position === null) {
      await finish(context.mailImport, 'completed', null)
      return true
    }
  }
  return false
}

/** Mark the import running, check the person may still write, and build the filing context. */
async function startSlice(session: AuthorizedSession, initial: MailImport): Promise<FilingContext | null> {
  const running =
    initial.status === 'importing'
      ? initial
      : await repository.updateMailImport(initial.organizationId, initial.id, ['queued'], { status: 'importing' })
  if (!running) return null
  try {
    await requireShelfWrite(session, projectShelf(running.projectId))
  } catch {
    throw new PermanentImportFailure('The person who started the import may no longer add documents to this project.')
  }
  const archiveFolderId = await ensureArchiveFolder(session, running)
  const archive: ArchiveRef = {
    key: running.stagingKey,
    url: await archiveUrlForBackend({ bucket: running.stagingBucket, key: running.stagingKey }),
    size: Number(running.sizeBytes),
  }
  // The audit trail reads an IP and a user agent off the request; a job has neither.
  const request = new Request('http://bff-jobs.internal/mail-import', { headers: { 'user-agent': 'piloti-mail-import' } })
  return filingContext({ session, mailImport: { ...running, rootFolderId: archiveFolderId }, archive, archiveFolderId, request })
}

/** `E-Mail-Import/<archive name>`, made once per import and remembered on the row. */
async function ensureArchiveFolder(session: AuthorizedSession, row: MailImport): Promise<string> {
  if (row.rootFolderId) return row.rootFolderId
  const root = await getOrCreateProjectFolderByName(row.projectId, MAIL_IMPORT_ROOT_FOLDER, row.organizationId)
  const folder = await createFolderWithFreeName({ session, mailImport: row }, root.id, archiveFolderName(row.filename))
  await repository.updateMailImport(row.organizationId, row.id, ['importing'], { rootFolderId: folder.id })
  return folder.id
}

async function recordTotal(context: FilingContext, total: number): Promise<void> {
  if (context.mailImport.totalItems === total) return
  await repository.updateMailImport(context.mailImport.organizationId, context.mailImport.id, ['importing'], {
    totalItems: total,
  })
  context.mailImport = { ...context.mailImport, totalItems: total }
}

/** File one item and move the cursor past it; false when the import stopped meanwhile. */
async function fileItem(context: FilingContext, item: ArchiveItem): Promise<boolean> {
  const current = context.mailImport
  const advance = { to: item.position + 1, mailsFiled: 0, filesFiled: 0, itemsSkipped: 0, filesSkipped: 0 }
  let samples: MailImportSkippedSample[] = []
  if (item.kind === 'other') {
    advance.itemsSkipped = 1
    samples = [{ mail: item.message_class, file: null, reason: 'not_mail' }]
  } else {
    const filed = await fileMail(context, item)
    Object.assign(advance, { mailsFiled: 1, filesFiled: filed.filesFiled, filesSkipped: filed.filesSkipped })
    samples = filed.skipped
  }
  const skippedSamples = [...current.skippedSamples, ...samples].slice(0, SKIPPED_SAMPLES_KEPT)
  const moved = await repository.advanceMailImport(current.organizationId, current.id, item.position, {
    ...advance,
    skippedSamples,
  })
  if (!moved) return false
  context.mailImport = {
    ...current,
    nextPosition: advance.to,
    mailsFiled: current.mailsFiled + advance.mailsFiled,
    filesFiled: current.filesFiled + advance.filesFiled,
    itemsSkipped: current.itemsSkipped + advance.itemsSkipped,
    filesSkipped: current.filesSkipped + advance.filesSkipped,
    skippedSamples,
    inflightPosition: null,
    inflightFolderId: null,
  }
  return true
}

/** End the import, delete its staging, and tell the person. A second ending is a no-op. */
async function finish(row: MailImport, status: 'completed' | 'failed', error: string | null): Promise<void> {
  const ended = await repository.updateMailImport(row.organizationId, row.id, OPEN, {
    status,
    completedAt: new Date(),
    lastError: error?.slice(0, 1000) ?? null,
    inflightPosition: null,
    inflightFolderId: null,
  })
  if (!ended) return
  try {
    await discardStaging(ended)
  } catch (cause) {
    // The archive outlives its import; the sweep's next pass deletes it.
    console.error(`[mail-import] could not delete the staged archive of ${ended.id}:`, cause)
  }
  await announce(ended)
}

async function announce(row: MailImport): Promise<void> {
  const type = row.status === 'completed' ? 'mail_import.completed' : 'mail_import.failed'
  const anchorId = row.rootFolderId ?? row.id
  try {
    await emitInboxItems([
      {
        organizationId: row.organizationId,
        recipientUserId: row.userId,
        type,
        resourceType: 'project',
        resourceId: row.projectId,
        anchorId,
        // Piloti did the work; an actor equal to the recipient would drop the row.
        actorUserId: null,
        groupKey: inboxGroupKey(type, 'project', row.projectId, anchorId),
        payload: { subject: row.filename, ...(row.rootFolderId ? { folderId: row.rootFolderId } : {}) },
      },
    ])
  } catch (cause) {
    console.error(`[mail-import] could not announce the end of ${row.id}:`, cause)
  }
}

function failureReason(error: unknown): string | null {
  if (error instanceof UnreadableArchiveError) return `${error.message}. Is it an Outlook data file (.pst or .ost)?`
  if (error instanceof MailImportQuotaError) return 'The organization’s storage quota is full; the rest of the archive was not filed.'
  if (error instanceof PermanentImportFailure) return error.message
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface MailImportSweepResult {
  checked: number
  aborted: number
  failed: number
  waiting: number
  errors: number
}

/**
 * End imports nothing will move on: an upload nobody finished within two days,
 * and a queued or running import that has made no progress for half an hour
 * and has no live job. And delete the staged archive of an import that ended
 * while its deletion failed. Discovery under the platform bypass; each
 * settling inside its own organization. Bounded, like every housekeeping step.
 */
export async function sweepStaleMailImports(now: Date = new Date(), batch = 50): Promise<MailImportSweepResult> {
  const uploadsBefore = new Date(now.getTime() - STALE_UPLOAD_HOURS * 3_600_000)
  const stalledBefore = new Date(now.getTime() - STALLED_IMPORT_MINUTES * 60_000)
  const rows = await withPlatformAccess('mail import sweep: finding imports left open without progress', () =>
    repository.listStaleOpenImports(uploadsBefore, stalledBefore, batch),
  )
  const result: MailImportSweepResult = { checked: rows.length, aborted: 0, failed: 0, waiting: 0, errors: 0 }
  for (const row of rows) {
    try {
      const verdict = await withTenant({ organizationId: row.organizationId }, () => settleStale(row))
      result[verdict] += 1
    } catch (error) {
      console.error('[mail-import] could not settle the stale import', row.id, error)
      result.errors += 1
    }
  }
  return result
}

async function settleStale(row: MailImport): Promise<'aborted' | 'failed' | 'waiting'> {
  if (!OPEN.includes(row.status) && row.status !== 'uploading') {
    // Ended, but its staged archive survived the ending: delete it now.
    await discardStaging(row)
    return 'aborted'
  }
  if (row.status === 'uploading') {
    const ended = await repository.updateMailImport(row.organizationId, row.id, ['uploading'], {
      status: 'cancelled',
      completedAt: new Date(),
      lastError: 'The archive was not sent completely within two days.',
    })
    if (ended) await discardStaging(ended)
    return 'aborted'
  }
  const job = await findOpenJobId({ kind: 'mail_import', organizationId: row.organizationId, matching: { importId: row.id } })
  if (job) return 'waiting'
  await finish(row, 'failed', 'The import job stopped without finishing.')
  return 'failed'
}
