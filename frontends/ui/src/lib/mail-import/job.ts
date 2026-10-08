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
 * the backend restarting) is a passing failure: the job HANDS THE IMPORT ON to
 * a fresh job that waits out a backoff, and ends itself. The queue's own
 * attempts are spent per job and never given back for progress, so leaning on
 * them would end a twenty-gigabyte import on its third blip, hours and
 * thousands of mails apart. `failure_streak` counts failures since a mail was
 * last filed, and only a streak that runs through every backoff ends the
 * import `failed`. Each ending deletes the staged archive and tells the person
 * in their inbox.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport, MailImportErrorCode, MailImportSkippedSample, MailImportStatus } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { ApiError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { isAuthzError } from '@/lib/auth-utils'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { projectShelf } from '@/lib/documents/shelf'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY, requesterOf, type JobSliceResult, type MailImportPayload } from '@/lib/jobs-queue/types'
import { getOrCreateProjectFolderByName } from '@/lib/projects/folder-service'
import { readArchivePage, UnreadableArchiveError, type ArchiveItem, type ArchiveRef } from './archive-client'
import {
  MAIL_IMPORT_PAGE_SIZE,
  MAIL_IMPORT_RETRY_BACKOFF_MINUTES,
  MAIL_IMPORT_ROOT_FOLDER,
  MAIL_IMPORT_SLICE_BUDGET_MS,
  SKIPPED_SAMPLES_KEPT,
  STALE_UPLOAD_HOURS,
  STALLED_IMPORT_MINUTES,
} from './config'
import {
  createFolderWithFreeName,
  fileMail,
  filingContext,
  ImportMovedOnError,
  MailImportQuotaError,
  SliceBudgetSpentError,
  type FilingContext,
} from './filing'
import { archiveFolderName } from './naming'
import * as repository from './repository'
import { discardStaging } from './service'
import { archiveUrlForBackend } from './staging'

/** A reason no retry changes; the import ends `failed` with it. */
class PermanentImportFailure extends Error {
  constructor(
    readonly code: MailImportErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Why an import failed: a code the UI words, and the detail for whoever debugs it. */
interface Failure {
  code: MailImportErrorCode
  detail: string
}

const OPEN: MailImportStatus[] = ['queued', 'importing']

/**
 * One slice. `session` is the requester's today, or null when they are no
 * longer a member, which ends the import.
 */
export async function runMailImportSlice(
  session: AuthorizedSession | null,
  payload: MailImportPayload,
  organizationId: string,
): Promise<JobSliceResult<MailImportPayload>> {
  const done = { done: true, payload }
  const row = await repository.findMailImport(organizationId, payload.projectId, payload.importId)
  if (!row || !OPEN.includes(row.status)) return done
  if (!session) {
    await finish(row, 'failed', {
      code: 'requester_left',
      detail: 'The person who started the import is no longer a member of the organization.',
    })
    return done
  }
  try {
    const finished = await fileUntilBudget(session, row)
    return finished ? done : { done: false, payload }
  } catch (error) {
    const failure = failureOf(error)
    if (failure) {
      await finish(row, 'failed', failure)
      return done
    }
    console.warn(`[mail-import] ${row.id}: a slice failed; handing the import on`, error)
    await handOn(organizationId, payload, messageOf(error))
    return done
  }
}

/**
 * After a passing failure: count it, and give the import to a fresh job that
 * waits out the next backoff, or end it once the streak has run through every
 * backoff without a mail filed.
 */
async function handOn(organizationId: string, payload: MailImportPayload, detail: string): Promise<void> {
  const current = await repository.findMailImport(organizationId, payload.projectId, payload.importId)
  if (!current || !OPEN.includes(current.status)) return
  const streak = current.failureStreak + 1
  const backoff = MAIL_IMPORT_RETRY_BACKOFF_MINUTES[streak - 1]
  if (backoff === undefined) {
    await finish(current, 'failed', { code: 'stopped', detail: `Repeated errors: ${detail}` })
    return
  }
  const counted = await repository.updateMailImport(organizationId, current.id, OPEN, {
    failureStreak: streak,
    lastError: detail.slice(0, 1000),
  })
  if (!counted) return
  await enqueueJob({
    kind: 'mail_import',
    organizationId,
    priority: BFF_JOB_PRIORITY.bulk,
    payload,
    notBefore: new Date(Date.now() + backoff * 60_000),
  })
}

/** File from the cursor until the budget is spent; true when the archive is done. */
async function fileUntilBudget(session: AuthorizedSession, initial: MailImport): Promise<boolean> {
  const deadline = Date.now() + MAIL_IMPORT_SLICE_BUDGET_MS
  const context = await startSlice(session, initial, deadline)
  if (!context) return true
  try {
    return await fileFrom(context, deadline)
  } catch (error) {
    // Out of time inside a mail: its folder is recorded, the next slice resumes into it.
    if (error instanceof SliceBudgetSpentError) return false
    // Cancelled, or taken over: nothing more for this slice to do.
    if (error instanceof ImportMovedOnError) return true
    throw error
  }
}

async function fileFrom(context: FilingContext, deadline: number): Promise<boolean> {
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
async function startSlice(
  session: AuthorizedSession,
  initial: MailImport,
  deadline: number,
): Promise<FilingContext | null> {
  const running =
    initial.status === 'importing'
      ? initial
      : await repository.updateMailImport(initial.organizationId, initial.id, ['queued'], { status: 'importing' })
  if (!running) return null
  try {
    await requireShelfWrite(session, projectShelf(running.projectId))
  } catch (error) {
    // Only a refusal is lost access. A database or FGA outage is a passing failure.
    if (!isRefusal(error)) throw error
    throw new PermanentImportFailure(
      'access',
      'The person who started the import may no longer add documents to this project.',
    )
  }
  const archiveFolderId = await ensureArchiveFolder(session, running)
  const archive: ArchiveRef = {
    key: running.stagingKey,
    url: await archiveUrlForBackend({ bucket: running.stagingBucket, key: running.stagingKey }),
    size: Number(running.sizeBytes),
  }
  // The audit trail reads an IP and a user agent off the request; a job has neither.
  const request = new Request('http://bff-jobs.internal/mail-import', { headers: { 'user-agent': 'piloti-mail-import' } })
  return filingContext({
    session,
    mailImport: { ...running, rootFolderId: archiveFolderId },
    archive,
    archiveFolderId,
    request,
    deadline,
  })
}

/** `E-Mail-Import/<archive name>`, made once per import and remembered on the row. */
async function ensureArchiveFolder(session: AuthorizedSession, row: MailImport): Promise<string> {
  if (row.rootFolderId) return row.rootFolderId
  const root = await getOrCreateProjectFolderByName(row.projectId, MAIL_IMPORT_ROOT_FOLDER, row.organizationId)
  const folder = await createFolderWithFreeName({ session, projectId: row.projectId }, root.id, archiveFolderName(row.filename))
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
    // Counted, not sampled: a calendar walked first would fill every sample.
    advance.itemsSkipped = 1
  } else if (item.kind === 'unreadable') {
    advance.itemsSkipped = 1
    samples = [{ mail: `#${item.position + 1}`, file: null, reason: 'unreadable' }]
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
async function finish(row: MailImport, status: 'completed' | 'failed', failure: Failure | null): Promise<void> {
  const ended = await repository.updateMailImport(row.organizationId, row.id, OPEN, {
    status,
    completedAt: new Date(),
    errorCode: failure?.code ?? null,
    lastError: failure?.detail.slice(0, 1000) ?? null,
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
  const anchorId = row.rootFolderId ?? `import:${row.id}`
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

function failureOf(error: unknown): Failure | null {
  if (error instanceof UnreadableArchiveError) return { code: 'unreadable', detail: error.message }
  if (error instanceof MailImportQuotaError) return { code: 'quota', detail: error.message }
  if (error instanceof PermanentImportFailure) return { code: error.code, detail: error.message }
  return null
}

/** A refusal of the person, as opposed to a failure to ask. */
function isRefusal(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 403 || error.status === 404
  return isAuthzError(error)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface MailImportSweepResult {
  checked: number
  aborted: number
  requeued: number
  failed: number
  waiting: number
  errors: number
}

/**
 * Settle imports nothing will move on: abort an upload nobody finished within
 * two days; give a queued or running import that has made no progress for half
 * an hour and has no live job a new one (the streak decides when to stop); and
 * delete the staged archive of an import that ended while its deletion failed.
 * Discovery under the platform bypass, each settling inside its own
 * organization. Bounded, like every housekeeping step.
 */
export async function sweepStaleMailImports(now: Date = new Date(), batch = 50): Promise<MailImportSweepResult> {
  const uploadsBefore = new Date(now.getTime() - STALE_UPLOAD_HOURS * 3_600_000)
  const stalledBefore = new Date(now.getTime() - STALLED_IMPORT_MINUTES * 60_000)
  const rows = await withPlatformAccess('mail import sweep: finding imports left open without progress', () =>
    repository.listStaleOpenImports(uploadsBefore, stalledBefore, batch),
  )
  const result: MailImportSweepResult = { checked: rows.length, aborted: 0, requeued: 0, failed: 0, waiting: 0, errors: 0 }
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

async function settleStale(row: MailImport): Promise<'aborted' | 'requeued' | 'failed' | 'waiting'> {
  if (!OPEN.includes(row.status) && row.status !== 'uploading') {
    // Ended, but its staged archive survived the ending: delete it now.
    await discardStaging(row)
    return 'aborted'
  }
  if (row.status === 'uploading') {
    const ended = await repository.updateMailImport(row.organizationId, row.id, ['uploading'], {
      status: 'cancelled',
      completedAt: new Date(),
      errorCode: 'upload_expired',
      lastError: 'The archive was not sent completely within two days.',
    })
    if (ended) await discardStaging(ended)
    return 'aborted'
  }
  const job = await findOpenJobId({ kind: 'mail_import', organizationId: row.organizationId, matching: { importId: row.id } })
  if (job) return 'waiting'
  return (await requeue(row)) ? 'requeued' : 'failed'
}

/**
 * Give an import whose job is gone (it died with its attempts spent, or the
 * enqueue after the upload failed) a new one, counted on the streak like any
 * passing failure. True when it was queued again.
 */
async function requeue(row: MailImport): Promise<boolean> {
  const session = await resolvePinnedRequesterSession({
    userId: row.userId,
    email: row.userEmail,
    organizationId: row.organizationId,
  })
  if (!session) {
    await finish(row, 'failed', {
      code: 'requester_left',
      detail: 'The person who started the import is no longer a member of the organization.',
    })
    return false
  }
  const streak = row.failureStreak + 1
  if (streak > MAIL_IMPORT_RETRY_BACKOFF_MINUTES.length) {
    await finish(row, 'failed', { code: 'stalled', detail: 'The import job kept stopping without finishing.' })
    return false
  }
  const counted = await repository.updateMailImport(row.organizationId, row.id, OPEN, { failureStreak: streak })
  if (!counted) return false
  await enqueueJob({
    kind: 'mail_import',
    organizationId: row.organizationId,
    priority: BFF_JOB_PRIORITY.bulk,
    payload: { importId: row.id, projectId: row.projectId, requester: requesterOf(session) },
  })
  return true
}
