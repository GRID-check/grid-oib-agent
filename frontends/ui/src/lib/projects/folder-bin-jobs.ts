/**
 * The Papierkorb's walk on the `bff-jobs` pool (ADR-0087, ADR-0079).
 *
 * It used to run inside the person's request on a user-facing frontend, which
 * a rollout drains in 30 s. It now belongs to a job the restore queues in the
 * same transaction as its own writes, so whatever is not yet read again has an
 * owner the moment the restore commits.
 *
 * `restore_folder_bin` ({@link runRestoreFolderSlice}) reads a restored
 * folder's documents into the index again, a page per slice, as the person who
 * restored it. The restore marked them `processing` with this job's id, so a
 * slice reads exactly the rows still waiting, and a row the job never reaches
 * is one the stuck-processing sweep recovers.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { computeFolderAccess, loadCustomFolderTree } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document } from '@/lib/db/schema'
import { collectionFileRef } from '@/lib/documents/collection-file-ref'
import { resolveDocumentFolderPath } from '@/lib/documents/folder-path'
import { redispatchPublishedVersion } from '@/lib/documents/lifecycle'
import { markDocumentIngestFailed } from '@/lib/documents/repository'
import { INGEST_DISPATCH_FAILED_MESSAGE, dispatchDocument } from '@/lib/documents/service'
import {
  recordJobFailure,
  type JobCounts,
  type JobSliceResult,
  type RestoreFolderBinPayload,
} from '@/lib/jobs-queue/types'
import { inPool } from './folder-bin'
import { listRestoringDocumentPage, setDocumentCollection } from './folder-bin-repository'
import { findProjectInOrg } from './repository'

/** Documents one restore slice re-dispatches: seconds of work, the unit a draining worker waits for. */
export const RESTORE_SLICE_DOCUMENTS = 25
/** Re-dispatches one restore slice has in flight at once. */
const RESTORE_CONCURRENCY = 4

type ProjectRow = NonNullable<Awaited<ReturnType<typeof findProjectInOrg>>>

/** Where each restored document belongs now: its folder may come back under other lists than it left. */
async function collectionPlacement(organizationId: string, project: ProjectRow): Promise<(doc: Document) => string> {
  const folders = await loadCustomFolderTree(organizationId, project.id)
  if (!folders) return () => project.collectionName
  const placement = computeFolderAccess(folders, { roles: [], seesEverything: true }, project.collectionName)
  return (doc) => placement.collectionFor(doc.folderId)
}

/**
 * Read one restored document into the index again, in the collection it
 * belongs in now. Every outcome leaves the row able to say what happened: the
 * dispatch moves it on (`pending`, or `failed` with the backend's reason), and
 * a row there is nothing to read from is failed here, never left looking
 * indexed with its chunks gone.
 */
async function reingestRestored(
  organizationId: string,
  project: ProjectRow,
  target: string,
  doc: Document
): Promise<'queued' | 'failed'> {
  if (target !== doc.collectionName) await setDocumentCollection(organizationId, doc.id, target)
  const placed = { ...doc, collectionName: target }
  if (!collectionFileRef(placed) || !doc.storageKey) {
    await markDocumentIngestFailed(doc.id, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    return 'failed'
  }
  try {
    // A machine's document is indexed only as its published version, with the
    // provenance that version carries; a person's as the bytes the row names.
    const { status } =
      doc.authoredBy === 'user'
        ? await dispatchDocument({
            organizationId,
            projectId: project.id,
            documentId: doc.id,
            filename: doc.filename,
            storageKey: doc.storageKey,
            storageBucket: doc.storageBucket,
            collectionName: target,
            folderPath: await resolveDocumentFolderPath(placed, organizationId),
            priority: 'bulk',
          })
        : await redispatchPublishedVersion(organizationId, placed, 'bulk')
    return status === 'failed' ? 'failed' : 'queued'
  } catch (error) {
    console.warn(`[folder-bin] re-ingest of ${doc.id} after restore failed:`, error)
    await markDocumentIngestFailed(doc.id, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    return 'failed'
  }
}

/**
 * One slice of a `restore_folder_bin` job: the next page of the documents the
 * restore marked for this job, read into the index again at `bulk` priority,
 * and the position to resume from.
 *
 * The requester's rights are asked again every slice, as a reindex asks them:
 * a person who lost the project's document-write permission since they clicked
 * stops the walk. The rows it did not reach stay `processing` with this job
 * gone, and the stuck-processing sweep re-dispatches them as the system: the
 * folder IS restored, and its documents must not stay unsearchable because of
 * who restored it.
 */
export async function runRestoreFolderSlice(
  session: AuthorizedSession,
  payload: RestoreFolderBinPayload
): Promise<JobSliceResult<RestoreFolderBinPayload>> {
  const { organizationId } = session
  try {
    await requireProjectAccess(session, payload.projectId, ['project:documents:write', 'project:edit'])
  } catch (error) {
    if (!(error instanceof NotFoundError) && !(error instanceof ForbiddenError)) throw error
    console.warn(`[folder-bin] restore of ${payload.folderId}: the requester no longer has access; stopping`)
    return { done: true, payload }
  }
  const project = await findProjectInOrg(payload.projectId, organizationId)
  if (!project) return { done: true, payload }

  const rows = await listRestoringDocumentPage(organizationId, project.id, payload.jobId, payload.cursor, RESTORE_SLICE_DOCUMENTS)
  const counts: JobCounts = { ...payload.counts, failedNames: [...payload.counts.failedNames] }
  if (rows.length > 0) {
    const collectionFor = await collectionPlacement(organizationId, project)
    await inPool(rows, RESTORE_CONCURRENCY, async (doc) => {
      const outcome = await reingestRestored(organizationId, project, collectionFor(doc), doc)
      if (outcome === 'failed') recordJobFailure(counts, doc.id)
      else counts.queued += 1
    })
  }

  const next: RestoreFolderBinPayload = { ...payload, cursor: rows.at(-1)?.id ?? payload.cursor, counts }
  const done = rows.length < RESTORE_SLICE_DOCUMENTS
  if (done && counts.failed > 0) {
    console.warn(
      `[folder-bin] restore of ${payload.folderId}: ${counts.queued} re-dispatched, ${counts.failed} failed (${counts.failedNames.join(', ')})`
    )
  }
  return { done, payload: next }
}
