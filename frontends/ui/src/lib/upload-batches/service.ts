/**
 * Upload batches: one upload gesture, from the browser's first request to the
 * moment everything it brought in has been read (migration 0110, ADR-0086).
 *
 *   open    → the browser, before it sends a file (`POST /api/upload-batches`)
 *   stamp   → each upload names the batch; the document row carries its id
 *   seal    → the browser, after its last request (`POST …/[id]/seal`)
 *   settle  → reconciliation, once no document of a sealed batch is in flight
 *             (`./settle`), which tells the uploader in their inbox
 *   summary → what arrived, where, what it is, what was held back and why
 *
 * The summary is the uploader's. It names what the office's screening kept on
 * their machine only by term and count: those files never reached the server.
 */

import 'server-only'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  atLeast,
  clearanceOf,
  computeFolderAccess,
  folderTree,
  isUnderOwnList,
  loadCustomFolderTree,
  unreadableFolderIds,
  type FolderTree,
  type ProjectFolderAccess,
} from '@/lib/authz/folder-access'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document, UploadBatch, UploadBatchExclusion, UploadBatchScope } from '@/lib/db/schema'
import { documentStatusFacts } from '@/lib/documents/document-status'
import { reconcileDocumentStatuses, type DocumentMetadata } from '@/lib/documents/reconcile-status'
import { encodeDocumentListCursor, type DocumentListCursor } from '@/lib/documents/list-cursor'
import { findFolderPathsInProject } from '@/lib/documents/repository'
import { memberReader } from '@/lib/documents/document-reader'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { parseQuarantine, type QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import {
  countBatchDocumentsByStatus,
  findUploadBatch,
  insertUploadBatch,
  listBatchDocuments,
  listProjectUploadBatchPage,
  sealUploadBatch,
} from './repository'

/** The shelves an upload can go to; re-stated here so a route needs nothing from the db layer. */
export { UPLOAD_BATCH_SCOPES } from '@/lib/db/schema'

/** Most files one batch may announce. Mirrors the CHECK in migration 0110. */
export const UPLOAD_BATCH_MAX_FILES = 10_000

export interface OpenUploadBatchInput {
  id: string
  scope: UploadBatchScope
  projectId: string | null
  conversationId: string | null
  expectedCount: number
  excluded: UploadBatchExclusion[]
}

/**
 * Open a batch for the session's upload. Authorized as the upload itself will
 * be: a project upload needs document write access, the Büroablage its
 * curators. A chat attachment's batch needs no more than the session, because
 * every upload into the chat is authorized on its own and the batch grants
 * nothing.
 */
export async function openUploadBatch(session: AuthorizedSession, input: OpenUploadBatchInput): Promise<void> {
  if (input.scope === 'project') {
    if (!input.projectId) throw new BadRequestError('A project upload names its project')
    await requireProjectAccess(session, input.projectId, ['project:documents:write', 'project:edit'])
  } else if (input.scope === 'archiv' && !canManageArchiv(session)) {
    throw new NotFoundError('Upload not found')
  }
  await insertUploadBatch({
    id: input.id,
    organizationId: session.organizationId,
    createdBy: session.userId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : null,
    conversationId: input.scope === 'session' ? input.conversationId : null,
    expectedCount: input.expectedCount,
    excluded: input.excluded,
  })
}

/** The session's own batch, or null. Another member's batch answers like a missing one. */
export async function findOwnUploadBatch(session: AuthorizedSession, batchId: string): Promise<UploadBatch | null> {
  const batch = await findUploadBatch(session.organizationId, batchId)
  return batch && batch.createdBy === session.userId ? batch : null
}

/**
 * The batch id an upload request may carry, or null when it may not carry
 * this one. An invalid id never fails the upload: the file is what the person
 * asked for, and the summary is a courtesy. It is ignored instead when the
 * batch is someone else's, sealed already, or for another shelf.
 */
export async function acceptedUploadBatchId(
  session: AuthorizedSession,
  rawId: unknown,
  shelf: { scope: UploadBatchScope; projectId: string | null }
): Promise<string | null> {
  if (typeof rawId !== 'string' || !UUID_PATTERN.test(rawId)) return null
  const batch = await findOwnUploadBatch(session, rawId).catch(() => null)
  if (!batch || batch.sealedAt || batch.scope !== shelf.scope) return null
  if (shelf.scope === 'project' && batch.projectId !== shelf.projectId) return null
  return batch.id
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The multipart field an upload names its batch in; anything but a uuid is no batch. */
export function readUploadBatchId(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

/** Seal the session's batch once its last request has answered. Idempotent for a sealed batch. */
export async function sealOwnUploadBatch(
  session: AuthorizedSession,
  batchId: string,
  counts: { unchanged: number; failed: number }
): Promise<void> {
  const batch = await findOwnUploadBatch(session, batchId)
  if (!batch) throw new NotFoundError('Upload not found')
  if (batch.sealedAt) return
  const sealed = await sealUploadBatch(session.organizationId, batchId, session.userId, counts, new Date())
  if (!sealed) throw new ConflictError('The upload changed while it was being sealed')
  // A batch whose documents all finished before the seal arrived completes
  // here rather than waiting for a reader or the sweep.
  const { settleUploadBatches } = await import('./settle')
  await settleUploadBatches(session.organizationId, [batchId])
}

/** A batch as a server-side job filing into it sees it; see {@link findJobUploadBatch}. */
export type JobUploadBatchState =
  | { status: 'missing' | 'foreign' | 'sealed' }
  | { status: 'open'; documents: number }

/**
 * A batch a server-side job files into on a person's behalf (the mail import,
 * ADR-0085): missing, someone else's, sealed, or open with how many documents
 * carry it. The job opens it with {@link openUploadBatch} as that person.
 */
export async function findJobUploadBatch(
  organizationId: string,
  batchId: string,
  createdBy: string
): Promise<JobUploadBatchState> {
  const batch = await findUploadBatch(organizationId, batchId)
  if (!batch) return { status: 'missing' }
  if (batch.createdBy !== createdBy) return { status: 'foreign' }
  if (batch.sealedAt) return { status: 'sealed' }
  return { status: 'open', documents: await countUploadBatchDocuments(organizationId, batchId, createdBy) }
}

/**
 * Every document in the job's batch, held ones included: the job files as the
 * person who opened it, so their own reader sees all of it (ADR-0086).
 */
async function countUploadBatchDocuments(organizationId: string, batchId: string, createdBy: string): Promise<number> {
  const counts = await countBatchDocumentsByStatus(organizationId, [batchId], { reader: memberReader(createdBy) })
  return counts.reduce((sum, row) => sum + row.count, 0)
}

/**
 * Seal a batch a job filed into, once it has nothing more to send. The job
 * did not know up front how much it would send, so it opened the batch
 * announcing nothing and the seal announces the documents that carry it.
 * Needs no session: the job may be ending because its person left. A missing,
 * foreign or sealed batch is left alone.
 */
export async function sealJobUploadBatch(organizationId: string, batchId: string, createdBy: string): Promise<void> {
  const state = await findJobUploadBatch(organizationId, batchId, createdBy)
  if (state.status !== 'open') return
  const expected = Math.min(state.documents, UPLOAD_BATCH_MAX_FILES)
  await sealUploadBatch(organizationId, batchId, createdBy, { unchanged: 0, failed: 0, expected }, new Date())
  const { settleUploadBatches } = await import('./settle')
  await settleUploadBatches(organizationId, [batchId])
}

/** What one document of an upload became, as the summary shows it. */
export interface UploadSummaryDocument {
  id: string
  filename: string
  displayName: string | null
  folderPath: string | null
  status: string
  /** The status family, so the client need not re-derive it. */
  outcome: 'ready' | 'reading' | 'quarantined' | 'failed' | 'stored'
  screening: Document['screeningOutcome']
  quarantine: QuarantineVerdict | null
  errorMessage: string | null
  summary: string | null
  tags: string[]
  pageCount: number | null
  /**
   * A new version of a document that was already on the shelf (ADR-0054), not
   * a new document: „geändert". Read off the row rather than recorded: a
   * re-upload keeps the document's id and `created_at` and stamps this batch,
   * so a row older than its batch is one this upload changed.
   */
  replaced: boolean
  /**
   * Filed in a folder with its own access list, or below one (ADR-0088):
   * „geschützt", as ticket „Übersicht" asks. The test the folder's lock in the
   * file browser and the download log apply (`isUnderOwnList`), whatever the
   * list grants: one that lets every member read and limits only who may
   * change the files counts too, so the mark and the lock never disagree.
   */
  restricted: boolean
}

export interface UploadSummary {
  id: string
  scope: UploadBatchScope
  projectId: string | null
  conversationId: string | null
  createdAt: string
  sealedAt: string | null
  completedAt: string | null
  expectedCount: number
  unchangedCount: number
  failedCount: number
  excluded: UploadBatchExclusion[]
  documents: UploadSummaryDocument[]
}

function outcomeOf(status: string): UploadSummaryDocument['outcome'] {
  if (status === 'quarantined') return 'quarantined'
  const facts = documentStatusFacts(status)
  if (!facts) return 'stored'
  if (facts.phase === 'in-flight') return 'reading'
  if (facts.variant === 'success') return 'ready'
  if (facts.variant === 'destructive') return 'failed'
  return 'stored'
}

type EnrichedDocument = Document & DocumentMetadata

function toSummaryDocument(
  row: EnrichedDocument,
  folderPaths: Map<string, string>,
  facts: { replaced: boolean; restricted: boolean }
): UploadSummaryDocument {
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.displayName ?? null,
    folderPath: row.folderId ? (folderPaths.get(row.folderId) ?? null) : null,
    status: row.status,
    outcome: outcomeOf(row.status),
    screening: row.screeningOutcome,
    quarantine: parseQuarantine(row.errorMessage),
    // A quarantine verdict is shown as reasons, not as an error string.
    errorMessage: row.status === 'quarantined' ? null : row.errorMessage,
    summary: row.summary ?? null,
    tags: row.tags ?? [],
    pageCount: row.pageCount ?? null,
    ...facts,
  }
}

/** The counts a batch holds itself rather than on a document row. */
type BatchCounts = Pick<UploadBatch, 'expectedCount' | 'unchangedCount' | 'failedCount' | 'excluded'>

/**
 * A batch's own counts, as this reader may see them. Only a document row
 * carries a folder: the files the batch announced, the ones the server
 * answered „unchanged" for (no row is written), the transfers that failed and
 * the files the screening kept back are counts on the batch, and any of them
 * may be of a file bound for a folder hidden from the reader. Where that is
 * possible, `placed` (the documents the reader may see) stands in for the
 * announced total and the rest is withheld; `null` passes the batch through.
 * It is possible while a folder the reader may not read can still receive a
 * file, empty or not: a batch is opened before its first file lands.
 */
function batchCounts(batch: UploadBatch, placed: number | null): BatchCounts {
  if (placed === null) {
    const { expectedCount, unchangedCount, failedCount, excluded } = batch
    return { expectedCount, unchangedCount, failedCount, excluded }
  }
  return { expectedCount: placed, unchangedCount: 0, failedCount: 0, excluded: [] }
}

/**
 * A project's folder tree and the session's access to it, or null when no
 * folder hides anything from anyone (no own list, nothing in the Papierkorb):
 * one probe, as `getProjectFolderAccess` costs. The tree is kept because the
 * summary's „geschützt" asks it a question the access answer does not hold.
 */
async function readerFolders(
  session: AuthorizedSession,
  projectId: string
): Promise<{ tree: FolderTree; access: ProjectFolderAccess } | null> {
  const folders = await loadCustomFolderTree(session.organizationId, projectId)
  if (!folders) return null
  return { tree: folderTree(folders), access: computeFolderAccess(folders, await clearanceOf(session, projectId), '') }
}

/** What the reader may see of a batch, and which of its folders have their own access list. */
interface ReaderView {
  rows: Document[]
  /** A row was left out because its folder is one the reader may not read: the batch's own counts go too. */
  withheld: boolean
  isRestricted: (folderId: string | null) => boolean
}

const UNRESTRICTED = (): boolean => false

/**
 * The batch's documents this reader may still see. A folder restricted after
 * the upload hides what was filed in it from its own uploader too (ADR-0087):
 * the summary names files, and a name is what the restriction withholds. Once
 * it hides any of them, the batch's own counts are withheld as well
 * (`batchCounts`), since they may count files in that folder. A file in the
 * Papierkorb is left out as the file list leaves it out, but withholds
 * nothing while the uploader may still read its folder: what it would reveal
 * they may see in the bin. A batch that wrote no row at all (every file
 * „unchanged") keeps its counts: nothing places it, and they only restate what
 * its uploader sent.
 */
async function readerView(session: AuthorizedSession, batch: UploadBatch, rows: Document[]): Promise<ReaderView> {
  const open = { rows, withheld: false, isRestricted: UNRESTRICTED }
  if (batch.scope !== 'project' || !batch.projectId) return open
  const project = await findProjectInOrg(batch.projectId, session.organizationId)
  if (!project) return { rows: [], withheld: false, isRestricted: UNRESTRICTED }
  const folders = await readerFolders(session, batch.projectId)
  if (!folders) return open
  const { tree, access } = folders
  return {
    rows: rows.filter((row) => access.isVisible(row.folderId)),
    withheld: rows.some((row) => row.folderId !== null && !atLeast(access.levelOf(row.folderId), 'read')),
    isRestricted: (folderId) => isUnderOwnList(tree, folderId),
  }
}

/**
 * The uploader's summary of one upload. Reads go through status
 * reconciliation, so opening the summary is itself a reader that can settle
 * the batch, and the summary and tags come from the same enrichment the file
 * list uses.
 */
export async function getUploadSummary(session: AuthorizedSession, batchId: string): Promise<UploadSummary> {
  const batch = await findOwnUploadBatch(session, batchId)
  if (!batch) throw new NotFoundError('Upload not found')
  const rows = await listBatchDocuments(session.organizationId, batchId, memberReader(session.userId))
  const view = await readerView(session, batch, rows)
  const enriched = await reconcileDocumentStatuses(view.rows, session.organizationId)
  const folderIds = [...new Set(enriched.map((row) => row.folderId).filter((id): id is string => !!id))]
  const folderPaths =
    batch.projectId && folderIds.length > 0
      ? await findFolderPathsInProject(folderIds, batch.projectId, session.organizationId)
      : new Map<string, string>()
  const fresh = await findOwnUploadBatch(session, batchId)
  const openedAt = new Date(batch.createdAt).getTime()
  return {
    id: batch.id,
    scope: batch.scope,
    projectId: batch.projectId,
    conversationId: batch.conversationId,
    createdAt: new Date(batch.createdAt).toISOString(),
    sealedAt: batch.sealedAt ? new Date(batch.sealedAt).toISOString() : null,
    completedAt: fresh?.completedAt ? new Date(fresh.completedAt).toISOString() : null,
    ...batchCounts(batch, view.withheld ? enriched.length : null),
    documents: enriched.map((row) =>
      toSummaryDocument(row, folderPaths, {
        replaced: new Date(row.createdAt).getTime() < openedAt,
        restricted: view.isRestricted(row.folderId ?? null),
      })
    ),
  }
}

/** One row of a project's upload history (ticket „Verlauf/Protokoll"). */
export interface UploadHistoryEntry {
  id: string
  createdBy: string
  /** The uploader's display name from the organization directory; null when they have left it. */
  createdByName: string | null
  createdAt: string
  completedAt: string | null
  expectedCount: number
  unchangedCount: number
  failedCount: number
  excludedCount: number
  counts: Record<UploadSummaryDocument['outcome'], number>
}

/**
 * The folders the reader may not read that a file can still be filed in: every
 * unreadable folder but a purged tombstone. The purge erases a folder's
 * documents before it marks the folder purged, and nothing is uploaded into or
 * restored to a tombstone, so it holds no file and never will. A living folder
 * can receive one at any moment, empty or not.
 */
function foldersClosedToReader(tree: FolderTree, access: ProjectFolderAccess): string[] {
  return unreadableFolderIds(access).filter((folderId) => !tree.get(folderId)?.purgedAt)
}

/** One page of a project's upload history. */
export interface UploadHistoryPage {
  uploads: UploadHistoryEntry[]
  /** Where the next page starts (`?cursor=`), or `null` on the last one. */
  nextCursor: string | null
}

/**
 * A project's uploads, newest first, one keyset page at a time: every upload
 * is reachable by following `nextCursor`. Readable by anyone who can open the
 * project: it says who brought how much in when, and the per-file detail stays
 * in each uploader's summary.
 *
 * What was filed in a folder hidden from the reader (ADR-0087) is left out as
 * the document listing leaves it out, as if it did not exist. A count is
 * metadata, and „12 Dateien, 3 in Quarantäne" for a folder the reader cannot
 * open says who filed how much there and when. Only a document row carries a
 * folder, so a reader who cannot open every folder of the project is shown
 * only the documents that landed where they can look: the batch's own counts
 * (the files it announced, the ones the server answered „unchanged" for, the
 * transfers that failed, the ones the screening kept back) cannot be placed
 * in a folder, and an upload with no such document is not listed at all. A
 * page can therefore hold fewer rows than it read, or none, and still have a
 * next one. A folder in the Papierkorb is hidden from everyone, organization
 * admins included, so its files are not tallied; it withholds the batch's
 * counts only from a reader who may not read it, or every project with a
 * binned folder would show everyone a cut-down history.
 *
 * What withholds is a folder closed to the reader that can still hold a file
 * (`foldersClosedToReader`). An empty one withholds too: the batch is opened
 * with its announced total before the first file is sent, so a history that
 * showed „12 Dateien" while the folder is empty and then dropped the upload
 * once its first file landed there would tell the reader who filed how much
 * there, and when. A purged folder's tombstone (closed to non-admins under the
 * `admins` and `remove` settings) does not: the purge erased what it held
 * before marking it, and nothing is filed in a tombstone again. Otherwise one
 * purge would cut every project member's history down for good, though nothing
 * is left to withhold.
 */
export async function listProjectUploadHistory(
  session: AuthorizedSession,
  projectId: string,
  { cursor }: { cursor?: DocumentListCursor } = {}
): Promise<UploadHistoryPage> {
  await requireProjectAccess(session, projectId, 'project:view')
  const [{ batches, nextCursor }, folders] = await Promise.all([
    listProjectUploadBatchPage(session.organizationId, projectId, { cursor }),
    readerFolders(session, projectId),
  ])
  const hiddenFolderIds = folders ? [...folders.access.hiddenFolderIds] : []
  const reader = await shelfReaderFor(session, { scope: 'project', projectId })
  const filesHiddenFromReader = folders !== null && foldersClosedToReader(folders.tree, folders.access).length > 0
  const [counts, directory] = await Promise.all([
    countBatchDocumentsByStatus(
      session.organizationId,
      batches.map((batch) => batch.id),
      { hiddenFolderIds, reader }
    ),
    loadOrganizationDirectory(session.organizationId),
  ])
  const uploads = batches.flatMap((batch): UploadHistoryEntry[] => {
    const tally: UploadHistoryEntry['counts'] = { ready: 0, reading: 0, quarantined: 0, failed: 0, stored: 0 }
    for (const row of counts) {
      if (row.batchId === batch.id) tally[outcomeOf(row.status)] += row.count
    }
    const placed = Object.values(tally).reduce((sum, count) => sum + count, 0)
    if (filesHiddenFromReader && placed === 0) return []
    const own = batchCounts(batch, filesHiddenFromReader ? placed : null)
    return [
      {
        id: batch.id,
        createdBy: batch.createdBy,
        createdByName: directory.get(batch.createdBy)?.name ?? null,
        createdAt: new Date(batch.createdAt).toISOString(),
        completedAt: batch.completedAt ? new Date(batch.completedAt).toISOString() : null,
        expectedCount: own.expectedCount,
        unchangedCount: own.unchangedCount,
        failedCount: own.failedCount,
        excludedCount: own.excluded.reduce((sum, entry) => sum + entry.count, 0),
        counts: tally,
      },
    ]
  })
  return { uploads, nextCursor: nextCursor ? encodeDocumentListCursor(nextCursor) : null }
}
