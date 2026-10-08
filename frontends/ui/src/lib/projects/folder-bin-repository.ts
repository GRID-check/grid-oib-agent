/**
 * The SQL behind the Papierkorb (migration 0115): moving a folder's subtree to
 * the bin and back, its queue row, its listing, the purge marker, and the
 * search for what was derived from a folder.
 *
 * Repository rules: organization in every WHERE (or a project already proven
 * to be the organization's), lists bounded or paged to the end. A function
 * that runs inside a caller's transaction takes its executor.
 *
 * Project folders only. `project_folders` also holds the Archiv's folders
 * (migration 0102), which have no Papierkorb: every read here names a project,
 * and a folder is found only on the project shelf (`scope = 'project'`), so an
 * Archiv folder id is simply not found.
 */

import 'server-only'
import { and, asc, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { executeRows } from '@/lib/db/execute-rows'
import { withTenant } from '@/lib/db/tenant-context'
import { deletionQueue, documents, projectFolders, projects, type Document } from '@/lib/db/schema'

/**
 * Take the project's bin lock until the transaction ends. Inserts and moves of
 * documents and folders into a folder of the project take it SHARED in their
 * trigger (`grid_refuse_write_into_deleted_folder`), so once this returns no
 * write into the subtree is in flight, and none starts before the commit.
 */
export async function takeBinLock(tx: DbExecutor, projectId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(grid_folder_bin_lock_key(${projectId}::uuid))`)
}

/** A PROJECT folder row in any state, with what the bin reads of it. */
export type BinFolderRow = Pick<
  typeof projectFolders.$inferSelect,
  'id' | 'parentId' | 'name' | 'path' | 'accessMode' | 'deletedAt' | 'deletedBy' | 'binRootId' | 'purgedAt'
> & { projectId: string }

type StoredBinFolderRow = Omit<BinFolderRow, 'projectId'> & { projectId: string | null }

/** A row read on the project shelf, as a project folder; null for one with no project (never, by the CHECK). */
function asProjectFolder(row: StoredBinFolderRow | undefined): BinFolderRow | null {
  if (!row || row.projectId === null) return null
  return { ...row, projectId: row.projectId }
}

const binFolderColumns = {
  id: projectFolders.id,
  projectId: projectFolders.projectId,
  parentId: projectFolders.parentId,
  name: projectFolders.name,
  path: projectFolders.path,
  accessMode: projectFolders.accessMode,
  deletedAt: projectFolders.deletedAt,
  deletedBy: projectFolders.deletedBy,
  binRootId: projectFolders.binRootId,
  purgedAt: projectFolders.purgedAt,
}

/** One folder of an organization's project, living or deleted; null when it is not there. */
export async function findFolderInOrg(
  executor: DbExecutor,
  organizationId: string,
  projectId: string,
  folderId: string
): Promise<BinFolderRow | null> {
  const [row] = await executor
    .select(binFolderColumns)
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.projectId))
    .where(
      and(
        eq(projectFolders.id, folderId),
        eq(projectFolders.projectId, projectId),
        eq(projectFolders.organizationId, organizationId),
        eq(projectFolders.scope, 'project'),
        eq(projects.organizationId, organizationId)
      )
    )
    .limit(1)
  return asProjectFolder(row)
}

/** One folder of the organization by id alone, its project proven the organization's by the join. */
export async function findFolderByIdInOrg(
  executor: DbExecutor,
  organizationId: string,
  folderId: string
): Promise<BinFolderRow | null> {
  const [row] = await executor
    .select(binFolderColumns)
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.projectId))
    .where(
      and(
        eq(projectFolders.id, folderId),
        eq(projectFolders.organizationId, organizationId),
        eq(projectFolders.scope, 'project'),
        eq(projects.organizationId, organizationId)
      )
    )
    .limit(1)
  return asProjectFolder(row)
}

/**
 * Every folder of a bin entry, purged ones included: what a retry of a
 * purged folder still reaches. A tombstone older than 0114 has no entry and is
 * its own.
 */
export async function listEntryFolderIds(executor: DbExecutor, root: BinFolderRow): Promise<string[]> {
  if (root.binRootId !== root.id) return [root.id]
  const rows = await executor
    .select({ id: projectFolders.id })
    .from(projectFolders)
    .where(and(eq(projectFolders.projectId, root.projectId), eq(projectFolders.binRootId, root.id)))
    .limit(10_000)
  return rows.map((row) => row.id)
}

/** A living folder and every living folder below it, by id. */
export async function listLivingSubtree(executor: DbExecutor, projectId: string, rootId: string): Promise<string[]> {
  const rows = executeRows<{ id: string }>(
    await executor.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT f.id FROM project_folders f
        WHERE f.id = ${rootId}::uuid AND f.project_id = ${projectId}::uuid AND f.deleted_at IS NULL
        UNION
        SELECT c.id FROM project_folders c JOIN subtree s ON c.parent_id = s.id
        WHERE c.deleted_at IS NULL
      )
      SELECT id FROM subtree
    `)
  )
  return rows.map((row) => String(row.id))
}

/** Put these folders in the bin, as one entry named by `rootId`. */
export async function markFoldersBinned(
  tx: DbExecutor,
  projectId: string,
  folderIds: readonly string[],
  rootId: string,
  deletedBy: string,
  at: Date
): Promise<void> {
  if (folderIds.length === 0) return
  await tx
    .update(projectFolders)
    .set({ deletedAt: at, deletedBy, binRootId: rootId, updatedAt: at })
    .where(
      and(eq(projectFolders.projectId, projectId), inArray(projectFolders.id, [...folderIds]), isNull(projectFolders.deletedAt))
    )
}

/** Take the folders of one bin entry out of the bin, by id; the caller holds the bin lock. */
export async function unbinFolders(tx: DbExecutor, projectId: string, rootId: string, at: Date): Promise<string[]> {
  const rows = await tx
    .update(projectFolders)
    .set({ deletedAt: null, deletedBy: null, binRootId: null, updatedAt: at })
    .where(and(eq(projectFolders.projectId, projectId), eq(projectFolders.binRootId, rootId), isNull(projectFolders.purgedAt)))
    .returning({ id: projectFolders.id })
  return rows.map((row) => row.id)
}

/**
 * Mark the documents of restored folders `processing`, owned by the restore's
 * job: in the transaction that takes them out of the bin, so a restore never
 * leaves a document that reads indexed while its chunks are gone (they were
 * purged when the folder went to the bin). The job re-ingests them; a row it
 * never reaches is one the stuck-processing sweep finds, because its job is
 * gone or dead.
 *
 * Not every row: a quarantined file waits on a reviewer and was never
 * indexed, an upload still writing its bytes finishes on its own, and a
 * machine's document with no published version owns no chunks to restore.
 * The previous ingest's job id goes; the restore's goes in its place.
 */
export async function markDocumentsRestoring(
  tx: DbExecutor,
  organizationId: string,
  projectId: string,
  folderIds: readonly string[],
  jobId: string,
  at: Date
): Promise<number> {
  if (folderIds.length === 0) return 0
  const rows = await tx
    .update(documents)
    .set({
      status: 'processing',
      errorMessage: null,
      metadata: sql`(coalesce(${documents.metadata}, '{}'::jsonb) - 'ingestJobId') || ${JSON.stringify({ bffJobId: jobId })}::text::jsonb`,
      updatedAt: at,
    })
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.projectId, projectId),
        inArray(documents.folderId, [...folderIds]),
        notInArray(documents.status, ['quarantined', 'uploading']),
        or(eq(documents.authoredBy, 'user'), isNotNull(documents.publishedVersionId))
      )
    )
    .returning({ id: documents.id })
  return rows.length
}

/**
 * One page of the documents a restore job still owns, by id after `afterId`:
 * `processing` and stamped with the job's id, in a folder that is not (again)
 * in the bin. A row the job has dispatched has moved on and drops out.
 */
export async function listRestoringDocumentPage(
  organizationId: string,
  projectId: string,
  jobId: string,
  afterId: string | null,
  limit: number
): Promise<Document[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({ document: documents })
      .from(documents)
      .innerJoin(projectFolders, eq(projectFolders.id, documents.folderId))
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.status, 'processing'),
          sql`${documents.metadata}->>'bffJobId' = ${jobId}`,
          isNull(projectFolders.deletedAt),
          ...(afterId ? [gt(documents.id, afterId)] : [])
        )
      )
      .orderBy(asc(documents.id))
      .limit(limit)
  ).then((rows) => rows.map((row) => row.document))
}

/** Re-home a restored folder (its parent gone, or its path stale) and rewrite every path below it. */
export async function rehomeFolder(
  tx: DbExecutor,
  projectId: string,
  folderId: string,
  parentId: string | null,
  oldPath: string,
  newPath: string,
  at: Date
): Promise<void> {
  await tx
    .update(projectFolders)
    .set({ parentId, path: newPath, updatedAt: at })
    .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId)))
  if (oldPath === newPath) return
  const escaped = oldPath.replace(/([\\%_])/g, '\\$1')
  await tx.execute(sql`
    UPDATE project_folders
    SET path = ${newPath} || substring(path from ${oldPath.length + 1}), updated_at = ${at.toISOString()}::timestamptz
    WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL AND path LIKE ${`${escaped}/%`}
  `)
}

/** Mark every folder of a bin entry purged: from now on permanent tombstones. The last step of a purge. */
export async function markFoldersPurged(
  executor: DbExecutor,
  projectId: string,
  rootId: string,
  at: Date
): Promise<number> {
  const rows = await executor
    .update(projectFolders)
    .set({ purgedAt: at, updatedAt: at })
    .where(and(eq(projectFolders.projectId, projectId), eq(projectFolders.binRootId, rootId), isNull(projectFolders.purgedAt)))
    .returning({ id: projectFolders.id })
  return rows.length
}

/** Documents of one page, by id. */
const DOCUMENT_PAGE = 500

/**
 * Every document filed in these folders, read in pages by id to the end: the
 * bin's chunk purge, a restore's re-ingest and the purge itself must each see
 * all of them.
 */
export async function listDocumentsInFolders(
  organizationId: string,
  projectId: string,
  folderIds: readonly string[]
): Promise<Document[]> {
  const found: Document[] = []
  let afterId: string | null = null
  for (;;) {
    const page: Document[] = await listDocumentPageInFolders(organizationId, projectId, folderIds, afterId, DOCUMENT_PAGE)
    found.push(...page)
    if (page.length < DOCUMENT_PAGE) return found
    afterId = page[page.length - 1].id
  }
}

/** One page of the documents filed in these folders, by id after `afterId`: what a sliced job reads. */
export async function listDocumentPageInFolders(
  organizationId: string,
  projectId: string,
  folderIds: readonly string[],
  afterId: string | null,
  limit: number
): Promise<Document[]> {
  if (folderIds.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          inArray(documents.folderId, [...folderIds]),
          ...(afterId ? [gt(documents.id, afterId)] : [])
        )
      )
      .orderBy(asc(documents.id))
      .limit(limit)
  )
}

/** Point a document at the collection a restore puts it in. */
export async function setDocumentCollection(organizationId: string, documentId: string, collectionName: string): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ collectionName, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
  )
}

/** What the bin entry's queue row carries besides its columns. No content: ids and counts. */
export interface FolderBinPayload {
  projectId: string
  folderIds: string[]
  documents: number
  /**
   * When every document's chunks were confirmed purged. Absent while the
   * delete's purge is unfinished: the request that binned the folder died
   * before it was done, and its `purge_binned_chunks` job finishes it.
   */
  chunksPurgedAt?: string
  /** Set when the purge removed what was derived from the folder („Mit dem Ordner entfernen"): the ids. */
  derivedRemoval?: DerivedRemovalRecord
  /** What a purge removed, counted. */
  purged?: FolderPurgeCounts
}

export interface FolderPurgeCounts {
  documents: number
  folders: number
  memoryNotes: number
  answers: number
  conversations: number
  reports: number
  tracesErased: number
}

/** What a purge under „Mit dem Ordner entfernen" removed: ids and when, never content. */
export interface DerivedRemovalRecord {
  removedAt: string
  /** The ids of what the removal touched; never their content. */
  conversationIds?: string[]
  messageIds?: string[]
  memoryIds?: string[]
  reportIds?: string[]
}

/** Insert the bin entry's queue row. */
export async function insertFolderBinEntry(
  tx: DbExecutor,
  entry: {
    organizationId: string
    folderId: string
    displayName: string
    requestedBy: string
    purgeAfter: Date
    payload: FolderBinPayload
  }
): Promise<string> {
  const [row] = await tx
    .insert(deletionQueue)
    .values({
      entityType: 'folder',
      entityId: entry.folderId,
      displayName: entry.displayName,
      organizationId: entry.organizationId,
      requestedBy: entry.requestedBy,
      purgeAfter: entry.purgeAfter,
      payload: { ...entry.payload },
    })
    .returning({ id: deletionQueue.id })
  return row.id
}

/** A bin entry's queue row by its id, in any state; null when it is not the organization's folder entry. */
export async function findBinEntryById(organizationId: string, entryId: string): Promise<FolderQueueRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(deletionQueue)
      .where(
        and(eq(deletionQueue.id, entryId), eq(deletionQueue.entityType, 'folder'), eq(deletionQueue.organizationId, organizationId))
      )
      .limit(1)
  )
  return row ?? null
}

export type FolderQueueRow = typeof deletionQueue.$inferSelect

/** The live (pending or purging) queue row of a bin entry. */
export async function findActiveBinEntry(
  executor: DbExecutor,
  organizationId: string,
  folderId: string
): Promise<FolderQueueRow | null> {
  const [row] = await executor
    .select()
    .from(deletionQueue)
    .where(
      and(
        eq(deletionQueue.entityType, 'folder'),
        eq(deletionQueue.entityId, folderId),
        eq(deletionQueue.organizationId, organizationId),
        inArray(deletionQueue.status, ['pending', 'purging', 'failed'])
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Close a bin entry as restored. Only a row the purger has never claimed: one
 * it has claimed may have erased documents already, and a half-restored folder
 * is worse than a refusal.
 */
export async function closeBinEntryRestored(tx: DbExecutor, organizationId: string, folderId: string): Promise<boolean> {
  const rows = await tx
    .update(deletionQueue)
    .set({ status: 'restored' })
    .where(
      and(
        eq(deletionQueue.entityType, 'folder'),
        eq(deletionQueue.entityId, folderId),
        eq(deletionQueue.organizationId, organizationId),
        eq(deletionQueue.status, 'pending'),
        isNull(deletionQueue.claimedAt)
      )
    )
    .returning({ id: deletionQueue.id })
  return rows.length > 0
}

/**
 * Claim a bin entry for a purge run in the request („Endgültig löschen"):
 * `pending` to `purging`, as the purger's claim does. False
 * when the purger holds it, or it is gone.
 */
export async function claimBinEntryNow(organizationId: string, folderId: string): Promise<FolderQueueRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(deletionQueue)
      .set({ status: 'purging', claimedAt: new Date(), attempts: sql`${deletionQueue.attempts} + 1` })
      .where(
        and(
          eq(deletionQueue.entityType, 'folder'),
          eq(deletionQueue.entityId, folderId),
          eq(deletionQueue.organizationId, organizationId),
          inArray(deletionQueue.status, ['pending', 'failed'])
        )
      )
      .returning()
  )
  return row ?? null
}

/** Finish a claimed bin entry: `purged`, with what was removed merged into its payload. */
export async function closeBinEntryPurged(
  organizationId: string,
  folderId: string,
  payload: Partial<FolderBinPayload>
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(deletionQueue)
      .set({
        status: 'purged',
        purgedAt: new Date(),
        lastError: null,
        payload: sql`coalesce(${deletionQueue.payload}, '{}'::jsonb) || ${JSON.stringify(payload)}::jsonb`,
      })
      .where(
        and(
          eq(deletionQueue.entityType, 'folder'),
          eq(deletionQueue.entityId, folderId),
          eq(deletionQueue.organizationId, organizationId),
          eq(deletionQueue.status, 'purging')
        )
      )
  )
}

/** Put a claimed bin entry back after a purge in the request failed: the purger retries it. */
export async function releaseBinEntry(organizationId: string, folderId: string, error: string): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(deletionQueue)
      .set({ status: 'pending', lastError: error.slice(0, 2000) })
      .where(
        and(
          eq(deletionQueue.entityType, 'folder'),
          eq(deletionQueue.entityId, folderId),
          eq(deletionQueue.organizationId, organizationId),
          eq(deletionQueue.status, 'purging')
        )
      )
  )
}

/**
 * Give a claimed bin entry whose purge is done to the purger, for the one step
 * the BFF does not take: erasing the Langfuse traces of the conversations the
 * removal touched. The BFF has neither Langfuse's credentials nor a network
 * path to it (`deploy/pulumi`); the purger has both. Due now and never claimed
 * (no backoff, the attempt refunded), so the purger takes it on its next tick:
 * its purge call finds the folder purged and answers with the conversations
 * whose traces are owed (`purgeBinnedFolder`), and it closes the row.
 */
export async function handBinEntryToPurger(
  organizationId: string,
  folderId: string,
  payload: Partial<FolderBinPayload>
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(deletionQueue)
      .set({
        status: 'pending',
        purgeAfter: sql`least(${deletionQueue.purgeAfter}, now())`,
        claimedAt: null,
        attempts: sql`greatest(${deletionQueue.attempts} - 1, 0)`,
        lastError: null,
        payload: sql`coalesce(${deletionQueue.payload}, '{}'::jsonb) || ${JSON.stringify(payload)}::jsonb`,
      })
      .where(
        and(
          eq(deletionQueue.entityType, 'folder'),
          eq(deletionQueue.entityId, folderId),
          eq(deletionQueue.organizationId, organizationId),
          eq(deletionQueue.status, 'purging')
        )
      )
  )
}

/** Merge into a live bin entry's payload (the purge records what it removed as it goes). */
export async function mergeBinEntryPayload(
  organizationId: string,
  folderId: string,
  payload: Partial<FolderBinPayload>
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(deletionQueue)
      .set({ payload: sql`coalesce(${deletionQueue.payload}, '{}'::jsonb) || ${JSON.stringify(payload)}::jsonb` })
      .where(
        and(
          eq(deletionQueue.entityType, 'folder'),
          eq(deletionQueue.entityId, folderId),
          eq(deletionQueue.organizationId, organizationId),
          inArray(deletionQueue.status, ['pending', 'purging', 'failed'])
        )
      )
  )
}

/** One entry of a project's Papierkorb, as the listing reads it. */
export interface BinEntryRow {
  folderId: string
  name: string
  path: string
  deletedAt: Date
  deletedBy: string | null
  purgeAfter: Date
  status: string
  documents: number
  folders: number
}

/** Most bin entries one listing returns. */
export const BIN_LIST_LIMIT = 200

/** The project's bin entries, newest first: each deleted folder's root, with what it holds. */
export async function listBinEntries(organizationId: string, projectId: string): Promise<BinEntryRow[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db.execute(sql`
      SELECT f.id AS folder_id, f.name, f.path, f.deleted_at, f.deleted_by,
             q.purge_after, q.status,
             (SELECT count(*) FROM project_folders s
               WHERE s.bin_root_id = f.id AND s.purged_at IS NULL) AS folders,
             (SELECT count(*) FROM documents d
               WHERE d.organization_id = ${organizationId}
                 AND d.folder_id IN (SELECT s.id FROM project_folders s WHERE s.bin_root_id = f.id)) AS documents
      FROM project_folders f
      JOIN projects p ON p.id = f.project_id AND p.organization_id = ${organizationId}
      JOIN deletion_queue q
        ON q.entity_type = 'folder' AND q.entity_id = f.id::text
       AND q.organization_id = ${organizationId}
       AND q.status IN ('pending', 'purging', 'failed')
      WHERE f.project_id = ${projectId}::uuid
        AND f.bin_root_id = f.id
        AND f.deleted_at IS NOT NULL
        AND f.purged_at IS NULL
      ORDER BY f.deleted_at DESC
      LIMIT ${BIN_LIST_LIMIT}
    `)
  )
  return executeRows<Record<string, unknown>>(rows).map((row) => ({
    folderId: String(row.folder_id),
    name: String(row.name),
    path: String(row.path),
    deletedAt: new Date(String(row.deleted_at)),
    deletedBy: row.deleted_by === null ? null : String(row.deleted_by),
    purgeAfter: new Date(String(row.purge_after)),
    status: String(row.status),
    documents: Number(row.documents),
    folders: Number(row.folders),
  }))
}

/** A living folder of the project, for a restore that keeps its parent. */
export async function findLivingFolder(tx: DbExecutor, projectId: string, folderId: string): Promise<BinFolderRow | null> {
  const [row] = await tx
    .select(binFolderColumns)
    .from(projectFolders)
    .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId), isNull(projectFolders.deletedAt)))
    .limit(1)
  return asProjectFolder(row)
}
