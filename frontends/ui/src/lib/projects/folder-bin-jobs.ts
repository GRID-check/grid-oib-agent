/**
 * The Papierkorb's two walks on the `bff-jobs` pool (ADR-0087, ADR-0079).
 *
 * Both used to run inside the person's request on a user-facing frontend,
 * which a rollout drains in 30 s. Each now belongs to a job the request queues
 * in the same transaction as its own writes, so whatever the request did not
 * finish has an owner the moment it commits.
 *
 * - `restore_folder_bin` ({@link runRestoreFolderSlice}): reads a restored
 *   folder's documents into the index again, a page per slice, as the person
 *   who restored it. The restore marked them `processing` with this job's id,
 *   so a slice reads exactly the rows still waiting, and a row the job never
 *   reaches is one the stuck-processing sweep recovers.
 * - `purge_binned_chunks` ({@link runPurgeBinnedChunksSlice}): finishes the
 *   chunk purge of a delete whose request died after binning the folder.
 *   Held back `BIN_PURGE_TAKEOVER_MS` and withdrawn by a request that
 *   finished, so normally it never runs. It runs as the system: a folder in the
 *   bin must leave retrieval whether or not the person who deleted it is still
 *   a member.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { computeFolderAccess, loadCustomFolderTree } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import type { Document } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { collectionFileRef } from '@/lib/documents/collection-file-ref'
import { resolveDocumentFolderPath } from '@/lib/documents/folder-path'
import { redispatchPublishedVersion } from '@/lib/documents/lifecycle'
import { markDocumentIngestFailed } from '@/lib/documents/repository'
import { INGEST_DISPATCH_FAILED_MESSAGE, dispatchDocument } from '@/lib/documents/service'
import {
  recordJobFailure,
  type JobAttempt,
  type JobCounts,
  type JobSliceResult,
  type PurgeBinnedChunksPayload,
  type RestoreFolderBinPayload,
} from '@/lib/jobs-queue/types'
import { BACKEND_CONCURRENCY, inPool, purgeChunksOf, returnFromBin } from './folder-bin'
import {
  findBinEntryById,
  findFolderInOrg,
  listDocumentPageInFolders,
  listEntryFolderIds,
  listRestoringDocumentPage,
  mergeBinEntryPayload,
  setDocumentCollection,
  type FolderBinPayload,
} from './folder-bin-repository'
import { findProjectInOrg } from './repository'

/** Documents one restore slice re-dispatches: seconds of work, the unit a draining worker waits for. */
export const RESTORE_SLICE_DOCUMENTS = 25
/** Re-dispatches one restore slice has in flight at once. */
const RESTORE_CONCURRENCY = 4
/** Documents one purge slice takes out of retrieval; a purge is one backend call each. */
export const PURGE_SLICE_DOCUMENTS = 50

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

/**
 * One slice of a `purge_binned_chunks` job: the next page of a binned folder's
 * documents taken out of retrieval, for a delete whose request did not confirm
 * it.
 *
 * Nothing to do (the job ends) once the bin entry is no longer pending (it was
 * restored, or a purge has claimed it and erases the documents itself), says
 * `chunksPurgedAt` (the request finished), or names a folder that is not in
 * the bin. A purge the index does not confirm is retried by the queue, with its
 * backoff; on the last attempt the delete is undone instead, as the request
 * would have undone it, so the folder is never left in the bin while part of it
 * is still searchable.
 */
export async function runPurgeBinnedChunksSlice(
  organizationId: string,
  payload: PurgeBinnedChunksPayload,
  attempt: JobAttempt
): Promise<JobSliceResult<PurgeBinnedChunksPayload>> {
  const finished = { done: true, payload }
  const entry = await findBinEntryById(organizationId, payload.entryId)
  const recorded = (entry?.payload ?? null) as Partial<FolderBinPayload> | null
  if (!entry || entry.status !== 'pending' || recorded?.chunksPurgedAt) return finished
  const db = getDb()
  const root = await withTenant({ organizationId }, () => findFolderInOrg(db, organizationId, payload.projectId, payload.folderId))
  if (!root || !root.deletedAt || root.purgedAt || root.binRootId !== root.id) return finished

  const folderIds = await withTenant({ organizationId }, () => listEntryFolderIds(db, root))
  const page = await listDocumentPageInFolders(organizationId, root.projectId, folderIds, payload.cursor, PURGE_SLICE_DOCUMENTS)
  const confirmed = await inPool(page, BACKEND_CONCURRENCY, purgeChunksOf)
  const refused = confirmed.filter((ok) => !ok).length
  if (refused > 0) {
    if (!attempt.last) {
      throw new Error(`the search index did not confirm the chunk purge of ${refused} document(s) of binned folder ${root.id}`)
    }
    const project = await findProjectInOrg(root.projectId, organizationId)
    if (project) await returnFromBin(organizationId, project, root.id, payload.requester)
    console.error(`[folder-bin] the index refused the chunk purge of binned folder ${root.id} on every attempt; the delete was undone`)
    return finished
  }

  const next: PurgeBinnedChunksPayload = {
    ...payload,
    cursor: page.at(-1)?.id ?? payload.cursor,
    documents: payload.documents + page.length,
  }
  if (page.length === PURGE_SLICE_DOCUMENTS) return { done: false, payload: next }
  await mergeBinEntryPayload(organizationId, root.id, { chunksPurgedAt: new Date().toISOString(), documents: next.documents })
  console.warn(`[folder-bin] finished the chunk purge of binned folder ${root.id}, which its delete request left unfinished`)
  return { done: true, payload: next }
}
