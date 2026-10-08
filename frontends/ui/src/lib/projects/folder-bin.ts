/**
 * The Papierkorb: deleting a folder, restoring it and purging it (ADR-0087,
 * `docs/architecture/deletion-pipeline.md`).
 *
 * ## Deleting takes the contents with it
 *
 * A folder goes to the bin with its subfolders and their documents, as one
 * entry. That is what "delete a folder" means in every document system people
 * know, and it is the only shape that changes nobody's access: moving the
 * contents up into the parent (what deleting did before) lifts the folder's own
 * list from them, so a deletion could widen who reads them.
 *
 * Deleting needs write on the folder AND on every folder below it, because
 * their documents go too. A subtree that holds a folder the person may not
 * read, or may only read, is refused with one generic answer
 * ({@link FOLDER_CONTENTS_PROTECTED_REASON}): neither "not found" (which named
 * the hidden folder by its absence) nor a list. Moving the protected part up
 * instead would change its path and lift the deleted folder's list from it.
 *
 * ## Hidden at once, from retrieval too
 *
 * The folders are marked deleted, which hides them and everything filed in
 * them from every listing and document read (`folder-access-rule.ts`, the same
 * enforcement a restricted folder has). The documents' chunks are PURGED from
 * the vector store in the same request and re-ingested on restore. Filtering
 * hits by folder state instead would have to be repeated in every path that
 * reads the index, the agent's included, and a path that forgot would leak; a
 * purged chunk cannot be found by any path. If the backend does not confirm a
 * purge, the delete is undone (its documents are read again) and refused with
 * 502, so a folder is never in the bin while its content is still searchable.
 * An ingest still running when the folder went to the bin asks
 * `document-exists` once it has indexed, is told "gone", and takes its chunks
 * back out.
 *
 * A request can die half way (a rollout drains a frontend in 30 s). So the
 * transaction that bins the folder also queues a `purge_binned_chunks` job,
 * held back {@link BIN_PURGE_TAKEOVER_MS}: the request withdraws it once every
 * purge is confirmed and the entry records `chunksPurgedAt`; when the request
 * did not get that far, the job finishes the purge on the `bff-jobs` pool, or
 * undoes the delete when the index keeps refusing (`folder-bin-jobs.ts`).
 *
 * ## Restore reads the documents again, as a job
 *
 * The transaction that takes the folder out of the bin also marks its
 * documents `processing`, stamped with a `restore_folder_bin` job it queues in
 * the same transaction. The job re-ingests them on the `bff-jobs` pool at
 * `bulk` priority, a page per slice, as the person who restored; a row it
 * never reaches is still `processing` with its job gone, which the
 * stuck-processing sweep recovers. Never a document that reads indexed with
 * its chunks gone.
 *
 * Nothing can be filed into a deleted folder: migration 0114's triggers refuse
 * the insert or move (SQLSTATE `GFD01`) under the project's bin lock, which
 * the delete holds while it reads the subtree.
 *
 * ## Purge, tombstone, derived content
 *
 * After `FOLDER_PURGE_GRACE_DAYS` (default 14) the purger claims the queue row
 * and asks {@link purgeBinnedFolder} through the internal route. Its steps are
 * idempotent and the folder rows are marked last: mark the answers drawn from
 * the folder („Quelle gelöscht am …") and record the folder on their
 * conversations; remove derived content when the organization's setting says
 * `remove`; erase each document by the document
 * delete's own steps; then the folders become permanent tombstones with their
 * grants. Who sees what was derived is decided at read time by the folder
 * rule and the organization's setting.
 *
 * The Langfuse traces of the conversations a removal touched are the
 * purger's to erase, never the BFF's: only the purger and the scheduler hold
 * Langfuse's credentials and may reach it (`deploy/pulumi`, `config.ts` and
 * `network-policies.ts`). „Endgültig löschen" therefore runs the purge in the
 * request and, when there are traces owed, hands the row to the purger, whose
 * own call finds the folder purged and erases them.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { ConflictError, ForbiddenError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import {
  atLeast,
  clearanceOf,
  computeFolderAccess,
  effectiveFolderLevel,
  folderReadOnlyError,
  folderTree,
  loadCustomFolderTree,
  projectMayWriteDocuments,
  type FolderLevel,
} from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { assertNoActiveHold } from '@/lib/compliance/holds'
import { lockConversationAudience, recordSourceFolders } from '@/lib/conversations/restricted-use-repository'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import { withTenant } from '@/lib/db/tenant-context'
import type { Document } from '@/lib/db/schema'
import { computePurgeAfter, folderGraceDays } from '@/lib/deletion/policy'
import { collectionFileRef, purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { eraseProjectDocument } from '@/lib/documents/service'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { deleteQueuedJob } from '@/lib/jobs-queue/repository'
import {
  BFF_JOB_PRIORITY,
  emptyCounts,
  requesterOf,
  type JobRequester,
  type PurgeBinnedChunksPayload,
  type RestoreFolderBinPayload,
} from '@/lib/jobs-queue/types'
import { getDeletedFolderContentPolicy } from '@/lib/organizations/deleted-folder-content'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  closeBinEntryPurged,
  closeBinEntryRestored,
  claimBinEntryNow,
  findActiveBinEntry,
  handBinEntryToPurger,
  findFolderByIdInOrg,
  findFolderInOrg,
  listEntryFolderIds,
  findLivingFolder,
  insertFolderBinEntry,
  listBinEntries,
  listDocumentIdsInFolders,
  listDocumentsInFolders,
  listLivingSubtree,
  markDocumentsRestoring,
  markFoldersBinned,
  markFoldersPurged,
  mergeBinEntryPayload,
  rehomeFolder,
  releaseBinEntry,
  takeBinLock,
  unbinFolders,
  type BinFolderRow,
  type FolderBinPayload,
  type FolderPurgeCounts,
} from './folder-bin-repository'
import {
  deleteMemoryDrawnFrom,
  findAnswersDrawingOn,
  listReportsDerivedFrom,
  markAnswersSourceDeleted,
  markReportsSourceDeleted,
  replaceRemovedAnswers,
} from './folder-derived-repository'
import { buildFolderPath } from './folders'
import { findProjectInOrg } from './repository'

/** The machine-readable reason a delete is refused because the folder holds content the person may not delete. */
export const FOLDER_CONTENTS_PROTECTED_REASON = 'folder-contents-protected'

/** The reason a restore is refused because a living sibling holds the folder's name. */
export const FOLDER_NAME_TAKEN_REASON = 'folder-name-taken'

const CHUNK_PURGE_TIMEOUT_MS = 15_000
/** How many backend calls one bin operation has in flight at once. */
export const BACKEND_CONCURRENCY = 8
/** How many documents a purge erases at once: each is several stores. */
const ERASE_CONCURRENCY = 4

/**
 * How long a delete's own request has to confirm its chunk purge before its
 * `purge_binned_chunks` job takes over. Well past a frontend's drain (30 s),
 * short because a binned folder whose purge is unfinished is still partly
 * searchable until then. A request still purging when the job starts costs
 * only a second purge of the same chunks, which is idempotent.
 */
export const BIN_PURGE_TAKEOVER_MS = 2 * 60_000

/** Run `work` over `items`, at most `limit` at a time, in order of the results. */
export async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** Take one document's chunks out of retrieval; true when the backend confirmed (or it owns none). */
export function purgeChunksOf(doc: Document): Promise<boolean> {
  const ref = collectionFileRef(doc)
  return ref ? purgeIngestedChunks(getBackendUrl(), ref, CHUNK_PURGE_TIMEOUT_MS) : Promise.resolve(true)
}

/**
 * Withdraw a delete's `purge_binned_chunks` job once the request has done its
 * work. Best effort: a job left behind finds the entry says `chunksPurgedAt`
 * (or is no longer pending) and ends without touching anything.
 */
async function withdrawPurgeJob(organizationId: string, jobId: string): Promise<void> {
  await withTenant({ organizationId }, () => deleteQueuedJob(jobId)).catch((error) => {
    console.warn('[folder-bin] could not withdraw the chunk purge job', jobId, error)
  })
}

function contentsProtectedError(): ForbiddenError {
  return new ForbiddenError('This folder holds content you may not delete.', { reason: FOLDER_CONTENTS_PROTECTED_REASON })
}

/**
 * Whether the session may take this whole subtree to the bin: write on the
 * folder itself (not readable is 404, read-only is 403), and on every folder
 * below it, where any shortfall is the one generic refusal.
 */
async function assertMayBinSubtree(
  session: AuthorizedSession,
  projectId: string,
  rootId: string,
  subtree: readonly string[]
): Promise<void> {
  const folders = await loadCustomFolderTree(session.organizationId, projectId)
  if (!folders) return
  const access = computeFolderAccess(folders, await clearanceOf(session, projectId), '')
  if (!access.isVisible(rootId)) throw new NotFoundError('Folder not found')
  if (access.levelOf(rootId) !== 'write') throw folderReadOnlyError()
  for (const folderId of subtree) {
    if (folderId === rootId) continue
    if (!access.isVisible(folderId) || access.levelOf(folderId) !== 'write') throw contentsProtectedError()
  }
}

/** The project of a folder action, in the session's organization; 404 when it is not there. */
async function projectFor(organizationId: string, projectId: string) {
  const project = await findProjectInOrg(projectId, organizationId)
  if (!project) throw new NotFoundError('Project not found')
  return project
}

export interface BinFolderResult {
  documentsBinned: number
  foldersBinned: number
  purgeAfter: Date
}

interface BinOptions {
  /** When the purge may run; default now plus the folder grace period. */
  purgeAfter?: Date
  /**
   * Bin the folder only when it holds exactly these documents, checked under
   * the bin lock, which every insert or move into a folder also takes: a
   * caller that filled the folder itself („Ausmisten", ADR-0090) never bins a
   * file someone else put there meanwhile. Otherwise 409, and nothing moves.
   */
  onlyDocuments?: readonly string[]
}

/** The 409 reason when a folder binned with `onlyDocuments` holds something else. */
export const FOLDER_CONTENTS_CHANGED_REASON = 'folder-contents-changed'

/**
 * Move a folder, its subfolders and their documents to the Papierkorb.
 * Returns what went and when the purge may run.
 */
export async function moveFolderToBin(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string },
  request?: Request,
  options: BinOptions = {}
): Promise<BinFolderResult> {
  const { organizationId } = session
  await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  const project = await projectFor(organizationId, input.projectId)
  const db = getDb()
  const root = await withTenant({ organizationId }, () => findFolderInOrg(db, organizationId, project.id, input.folderId))
  if (!root || root.deletedAt) throw new NotFoundError('Folder not found')

  const checked = await withTenant({ organizationId }, () => listLivingSubtree(db, project.id, root.id))
  await assertMayBinSubtree(session, project.id, root.id, checked)

  const purgeAfter = options.purgeAfter ?? computePurgeAfter(new Date(), folderGraceDays())
  const at = new Date()
  const purgeJobId = randomUUID()
  const requester = requesterOf(session)
  const folderIds = await withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      await takeBinLock(tx, project.id)
      const subtree = await listLivingSubtree(tx, project.id, root.id)
      if (subtree.length === 0) throw new NotFoundError('Folder not found')
      // A folder created below it since the check was not checked: refuse
      // rather than bin what nobody asked about.
      const known = new Set(checked)
      if (subtree.some((folderId) => !known.has(folderId))) {
        throw new ConflictError('The folder changed while it was being deleted. Please try again.')
      }
      if (options.onlyDocuments) {
        const held = await listDocumentIdsInFolders(tx, project.id, subtree)
        const expected = new Set(options.onlyDocuments)
        if (held.length !== expected.size || held.some((id) => !expected.has(id))) {
          throw new ConflictError('The folder changed while it was being deleted. Please try again.', {
            reason: FOLDER_CONTENTS_CHANGED_REASON,
          })
        }
      }
      await markFoldersBinned(tx, project.id, subtree, root.id, session.userId, at)
      const payload: FolderBinPayload = {
        projectId: project.id,
        folderIds: subtree,
        documents: 0,
      }
      const entryId = await insertFolderBinEntry(tx, {
        organizationId,
        folderId: root.id,
        displayName: root.path,
        requestedBy: session.userId,
        purgeAfter,
        payload,
      })
      // Whoever finishes the purge if this request does not: committed with
      // the bin entry, so there is no moment the folder is in the bin with
      // nothing owning its chunks.
      const takeover: PurgeBinnedChunksPayload = {
        projectId: project.id,
        folderId: root.id,
        entryId,
        requester,
        cursor: null,
        documents: 0,
      }
      await enqueueJob(
        {
          kind: 'purge_binned_chunks',
          organizationId,
          payload: { ...takeover },
          priority: BFF_JOB_PRIORITY.interactive,
          jobId: purgeJobId,
          notBefore: new Date(at.getTime() + BIN_PURGE_TAKEOVER_MS),
        },
        tx
      )
      return subtree
    })
  )

  // Out of retrieval at once. Every purge confirmed, or the bin entry is
  // undone and the request refused: never in the bin and still searchable.
  const docs = await listDocumentsInFolders(organizationId, project.id, folderIds)
  const purged = await inPool(docs, BACKEND_CONCURRENCY, purgeChunksOf)
  if (purged.some((ok) => !ok)) {
    try {
      await returnFromBin(organizationId, project, root.id, requester)
      await withdrawPurgeJob(organizationId, purgeJobId)
    } catch (error) {
      // The job stays: it finishes the purge the person asked for, or undoes
      // the delete itself, so the folder is not left half searchable.
      console.error('[folder-bin] undoing a delete whose chunk purge failed also failed:', root.id, error)
    }
    throw new UpstreamError(
      'The folder could not be moved to the bin: the search index did not confirm. Nothing was deleted; please try again.'
    )
  }
  await mergeBinEntryPayload(organizationId, root.id, { documents: docs.length, chunksPurgedAt: new Date().toISOString() })
  await withdrawPurgeJob(organizationId, purgeJobId)

  await recordAuditEvent({
    organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.binned',
    targetType: 'project',
    targetId: project.id,
    metadata: { folderId: root.id, documents: docs.length, folders: folderIds.length, purgeAfter: purgeAfter.toISOString() },
    request,
  })
  return { documentsBinned: docs.length, foldersBinned: folderIds.length, purgeAfter }
}

type ProjectRow = NonNullable<Awaited<ReturnType<typeof findProjectInOrg>>>

/** Where a restored folder landed. */
export type RestoredTo = 'original' | 'root'

/**
 * Take a bin entry out of the bin: the queue row closed as restored, every
 * folder of the entry living again, the root under its old parent or, when
 * that is gone, at the project root. Under the bin lock.
 *
 * Its documents come back `processing`, owned by a `restore_folder_bin` job
 * queued in the same transaction, which reads them into the index again as
 * `requester`. Nothing is dispatched here: a restore of thousands of
 * documents is a walk, and a walk belongs on the `bff-jobs` pool, not in a
 * request a rollout may cut off (ADR-0079).
 */
async function unbinEntry(
  organizationId: string,
  project: ProjectRow,
  root: BinFolderRow,
  requester: JobRequester
): Promise<{ restoredTo: RestoredTo; folders: number; documents: number }> {
  const db = getDb()
  const at = new Date()
  const jobId = randomUUID()
  try {
    return await withTenant({ organizationId }, () =>
      db.transaction(async (tx) => {
        await takeBinLock(tx, project.id)
        if (!(await closeBinEntryRestored(tx, organizationId, root.id))) {
          throw new ConflictError('This folder can no longer be restored: its final deletion has started.')
        }
        const parent = root.parentId ? await findLivingFolder(tx, project.id, root.parentId) : null
        const restoredTo: RestoredTo = root.parentId && !parent ? 'root' : 'original'
        const folderIds = await unbinFolders(tx, project.id, root.id, at)
        const path = buildFolderPath(parent?.path ?? '', root.name)
        await rehomeFolder(tx, project.id, root.id, parent?.id ?? null, root.path, path, at)
        const documents = await markDocumentsRestoring(tx, organizationId, project.id, folderIds, jobId, at)
        if (documents > 0) {
          const payload: RestoreFolderBinPayload = {
            projectId: project.id,
            folderId: root.id,
            jobId,
            requester,
            cursor: null,
            counts: emptyCounts(),
          }
          await enqueueJob(
            { kind: 'restore_folder_bin', organizationId, payload: { ...payload }, priority: BFF_JOB_PRIORITY.bulk, jobId },
            tx
          )
        }
        return { restoredTo, folders: folderIds.length, documents }
      })
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    throw new ConflictError('A folder with this name already exists there. Rename it, then restore again.', {
      reason: FOLDER_NAME_TAKEN_REASON,
    })
  }
}

/**
 * Undo a bin entry without a person asking (its chunk purge failed): out of
 * the bin, and its documents read again by the restore's job, as `requester`.
 */
export async function returnFromBin(
  organizationId: string,
  project: ProjectRow,
  rootId: string,
  requester: JobRequester
): Promise<void> {
  const db = getDb()
  const root = await withTenant({ organizationId }, () => findFolderInOrg(db, organizationId, project.id, rootId))
  if (!root) return
  await unbinEntry(organizationId, project, root, requester)
}

/** The session's level on a folder of the tree, tombstones included, before the project ceiling. */
async function levelOnFolder(session: AuthorizedSession, projectId: string, folderId: string): Promise<FolderLevel> {
  const tree = folderTree(await listProjectFolderTree(session.organizationId, projectId))
  return effectiveFolderLevel(tree, await clearanceOf(session, projectId), folderId)
}

/** A bin entry's root folder that the session may at least read; 404 otherwise. */
async function binEntryFor(session: AuthorizedSession, projectId: string, folderId: string): Promise<{ project: ProjectRow; root: BinFolderRow; level: FolderLevel }> {
  const project = await projectFor(session.organizationId, projectId)
  const db = getDb()
  const root = await withTenant({ organizationId: session.organizationId }, () =>
    findFolderInOrg(db, session.organizationId, project.id, folderId)
  )
  if (!root || !root.deletedAt || root.purgedAt || root.binRootId !== root.id) throw new NotFoundError('Folder not found')
  const level = await levelOnFolder(session, project.id, root.id)
  if (!atLeast(level, 'read')) throw new NotFoundError('Folder not found')
  return { project, root, level }
}

export interface RestoreFolderResult {
  restoredTo: RestoredTo
  folders: number
  /** Documents queued to be read into the index again. */
  documents: number
}

/**
 * Restore a folder from the Papierkorb with its access, its subfolders and its
 * documents, which a job reads into the index again. Needs what deleting it
 * needed: the project's document-write permission and write on the folder.
 * A folder whose parent is gone comes back at the project root, and says so.
 */
export async function restoreFolderFromBin(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string },
  request?: Request
): Promise<RestoreFolderResult> {
  const { closed } = await requireProjectAccess(session, input.projectId, 'project:view')
  const { project, root, level } = await binEntryFor(session, input.projectId, input.folderId)
  const projectWrite = await mayRestoreInProject(session, project.id, closed)
  if (level !== 'write' || !projectWrite) throw folderReadOnlyError()

  const { restoredTo, folders, documents } = await unbinEntry(session.organizationId, project, root, requesterOf(session))

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.restored',
    targetType: 'project',
    targetId: project.id,
    metadata: { folderId: root.id, documents, folders, restoredTo },
    request,
  })
  return { restoredTo, folders, documents }
}

/**
 * The project half of who may restore: document write, as for deleting. In a
 * closed project (ADR-0088) nobody writes, but a restore undoes a deletion
 * rather than adding content, and the 14-day purge keeps running: whoever
 * manages the project may restore there, so an „Ausgemistet" file is not lost
 * for want of a reopen.
 */
async function mayRestoreInProject(session: AuthorizedSession, projectId: string, closed: boolean): Promise<boolean> {
  if (!closed) return projectMayWriteDocuments(session, projectId)
  try {
    await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/** One entry of the Papierkorb view. */
export interface FolderBinEntry {
  folderId: string
  name: string
  path: string
  deletedAt: Date
  deletedBy: { userId: string | null; name: string | null }
  purgeAfter: Date
  /** `pending` restorable; `purging` being purged; `failed` the purge stopped and an admin is looking. */
  status: string
  documents: number
  folders: number
  canRestore: boolean
}

export interface FolderBinListing {
  entries: FolderBinEntry[]
  /** „Endgültig löschen": project admins (`project:manage`). */
  canPurge: boolean
}

async function mayManageProject(session: AuthorizedSession, projectId: string): Promise<boolean> {
  try {
    await requireProjectAccess(session, projectId, 'project:manage')
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/** The project's Papierkorb as the session may see it: the entries whose folder it may read. */
export async function listFolderBin(session: AuthorizedSession, projectId: string): Promise<FolderBinListing> {
  const { closed } = await requireProjectAccess(session, projectId, 'project:view')
  const project = await projectFor(session.organizationId, projectId)
  const [rows, folders, projectWrite, canPurge, directory] = await Promise.all([
    listBinEntries(session.organizationId, project.id),
    listProjectFolderTree(session.organizationId, project.id),
    mayRestoreInProject(session, project.id, closed),
    mayManageProject(session, project.id),
    loadOrganizationDirectory(session.organizationId),
  ])
  const tree = folderTree(folders)
  const clearance = await clearanceOf(session, project.id)
  const entries = rows.flatMap((row): FolderBinEntry[] => {
    const level = effectiveFolderLevel(tree, clearance, row.folderId)
    if (!atLeast(level, 'read')) return []
    const person = row.deletedBy ? directory.get(row.deletedBy) : undefined
    return [
      {
        ...row,
        deletedBy: { userId: row.deletedBy, name: person?.name ?? person?.email ?? null },
        canRestore: row.status === 'pending' && level === 'write' && projectWrite,
      },
    ]
  })
  return { entries, canPurge }
}

export interface FolderPurgeResult {
  /** `purged`: this run removed it; `already-purged`: an earlier run had. */
  status: 'purged' | 'already-purged'
  counts: FolderPurgeCounts
  /** Conversations whose traces must go: those of a removal of derived content. */
  traceConversationIds: string[]
}

/** The answer when the folder is not in the bin: the purger fails such a row for good. */
export class FolderNotInBinError extends ConflictError {
  constructor() {
    super('The folder is not in the bin.', { reason: 'not_in_bin' })
  }
}

const EMPTY_COUNTS: FolderPurgeCounts = {
  documents: 0,
  folders: 0,
  memoryNotes: 0,
  answers: 0,
  conversations: 0,
  reports: 0,
  tracesErased: 0,
}

/** Record the folder on each conversation that drew on it, so the read-time rule judges the conversation by it. */
async function recordFolderOnConversations(organizationId: string, conversationIds: readonly string[], folderId: string): Promise<void> {
  const db = getDb()
  for (const conversationId of conversationIds) {
    await withTenant({ organizationId }, () =>
      db.transaction(async (tx) => {
        await lockConversationAudience(tx, organizationId, conversationId)
        await recordSourceFolders(tx, organizationId, conversationId, [folderId])
      })
    )
  }
}

/**
 * The purge of one bin entry, after its grace period or at once: what the
 * purger's queue row asks of the BFF (`POST /api/internal/folders/[id]/purge`),
 * and what „Endgültig löschen" runs in the request.
 * Every step is idempotent and the folder rows are marked purged last, so a
 * retry after any failure finishes the work. Does not touch the queue row; the
 * caller closes it.
 */
export async function purgeBinnedFolder(organizationId: string, folderId: string): Promise<FolderPurgeResult> {
  const db = getDb()
  const root = await withTenant({ organizationId }, () => findFolderByIdInOrg(db, organizationId, folderId))
  if (!root || !root.deletedAt) throw new FolderNotInBinError()
  // The purger's claim skipped a held row; this is the check every purge
  // makes before its first destructive step, and it never names the hold.
  await assertNoActiveHold(organizationId, 'folder', root.id)

  const entry = await withTenant({ organizationId }, () => findActiveBinEntry(db, organizationId, root.id))
  const payload = (entry?.payload ?? null) as Partial<FolderBinPayload> | null
  if (root.purgedAt) {
    // Done: what a retry still owes is the traces of what the removal touched.
    return {
      status: 'already-purged',
      counts: { ...EMPTY_COUNTS, ...(payload?.purged ?? {}) },
      traceConversationIds: payload?.derivedRemoval?.conversationIds ?? [],
    }
  }
  // „Mit dem Ordner entfernen": the purge takes what was derived with it.
  const removeDerived = (await getDeletedFolderContentPolicy(organizationId)) === 'remove'
  const previous = payload?.derivedRemoval

  const folderIds = await withTenant({ organizationId }, () => listEntryFolderIds(db, root))
  const docs = await listDocumentsInFolders(organizationId, root.projectId, folderIds)
  const at = new Date()

  // What was derived from it, found while the documents still name it, and
  // marked, so a retry after they are gone finds it again by the mark.
  const answers = await findAnswersDrawingOn(
    organizationId,
    root.projectId,
    docs.map((doc) => ({ id: doc.id, collectionName: doc.collectionName, filename: doc.filename })),
    root.id
  )
  const conversationIds = [...new Set(answers.map((answer) => answer.conversationId))]
  const messageIds = answers.map((answer) => answer.messageId)
  await recordFolderOnConversations(organizationId, conversationIds, root.id)
  await markAnswersSourceDeleted(organizationId, messageIds, root.id, at)
  const reports = await listReportsDerivedFrom(organizationId, conversationIds, messageIds)
  await markReportsSourceDeleted(organizationId, reports.map((report) => report.id), root.id, at)

  let memoryIds: string[] = []
  let replaced = 0
  if (removeDerived) {
    memoryIds = await deleteMemoryDrawnFrom(organizationId, root.projectId, folderIds, conversationIds)
    replaced = await replaceRemovedAnswers(organizationId, messageIds, root.id, at)
    await mergeBinEntryPayload(organizationId, root.id, {
      derivedRemoval: {
        removedAt: previous?.removedAt ?? at.toISOString(),
        conversationIds: [...new Set([...(previous?.conversationIds ?? []), ...conversationIds])],
        messageIds: [...new Set([...(previous?.messageIds ?? []), ...messageIds])],
        memoryIds: [...new Set([...(previous?.memoryIds ?? []), ...memoryIds])],
        reportIds: [...new Set([...(previous?.reportIds ?? []), ...reports.map((report) => report.id)])],
      },
    })
  }

  // The documents, by the document delete's own steps. A failure throws and
  // the queue row's retry runs the whole purge again.
  await inPool(docs, ERASE_CONCURRENCY, (doc) => eraseProjectDocument(doc, organizationId))
  const folders = await withTenant({ organizationId }, () => markFoldersPurged(db, root.projectId, root.id, at))

  const counts: FolderPurgeCounts = {
    documents: docs.length,
    folders: Math.max(folders, folderIds.length),
    memoryNotes: memoryIds.length,
    answers: removeDerived ? replaced : messageIds.length,
    conversations: conversationIds.length,
    reports: reports.length,
    tracesErased: 0,
  }
  const traceConversationIds = removeDerived
    ? [...new Set([...(previous?.conversationIds ?? []), ...conversationIds])]
    : []
  return { status: 'purged', counts, traceConversationIds }
}

/**
 * Run a claimed bin entry's purge in the request and close its queue row; on
 * any failure the row goes back to `pending` and the purger retries it.
 *
 * When the removal touched conversations, their Langfuse traces are still
 * owed, and this pod cannot erase them (see the file comment): the row goes to
 * the purger instead of being closed, and the purger records how many traces
 * it erased. Until then `counts.tracesErased` is 0; the folder is purged
 * either way and gone from the Papierkorb.
 */
async function purgeClaimedNow(organizationId: string, folderId: string): Promise<FolderPurgeResult> {
  try {
    const result = await purgeBinnedFolder(organizationId, folderId)
    if (result.traceConversationIds.length > 0) {
      await handBinEntryToPurger(organizationId, folderId, { purged: result.counts })
    } else {
      await closeBinEntryPurged(organizationId, folderId, { purged: result.counts })
    }
    return result
  } catch (error) {
    await releaseBinEntry(organizationId, folderId, error instanceof Error ? error.message : String(error)).catch(() => undefined)
    throw error
  }
}

/**
 * „Endgültig löschen" from the Papierkorb: the purge at once, for project
 * admins (`project:manage`). A legal hold refuses it (409, never naming the hold).
 */
export async function purgeFolderFromBinNow(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string },
  request?: Request
): Promise<FolderPurgeResult> {
  await requireProjectAccess(session, input.projectId, 'project:manage')
  const { project, root } = await binEntryFor(session, input.projectId, input.folderId)
  await assertNoActiveHold(session.organizationId, 'folder', root.id)
  if (!(await claimBinEntryNow(session.organizationId, root.id))) {
    throw new ConflictError('This folder is already being deleted.')
  }
  const result = await purgeClaimedNow(session.organizationId, root.id)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.purged',
    targetType: 'project',
    targetId: project.id,
    metadata: { folderId: root.id, documents: result.counts.documents, folders: result.counts.folders },
    request,
  })
  return result
}
