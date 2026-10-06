/**
 * Every project document in the retrieval collection its folder puts it in
 * (ADR-0080).
 *
 * A document under a restricted folder belongs in that folder's collection
 * (`<project collection>_r<…>`); every other document in the project's own.
 * Which one is a function of the folder tree alone, so after anything that can
 * change it — a restriction drawn or lifted, a folder moved or deleted, a
 * document moved — this is called and moves exactly the documents that are now
 * in the wrong place. Idempotent: calling it again retries what failed and
 * moves nothing else.
 *
 * A move is purge, then re-point, then re-ingest. The purge comes FIRST so that
 * a document moving into a restricted folder stops being findable in the open
 * collection before anything else happens; if the purge fails the document is
 * left where it is and reported, and the next call tries again. Re-ingesting
 * costs what an upload costs (it is one), which is why a restriction on a large
 * folder takes a while to settle.
 *
 * Complete, and bounded per call. The candidates are read in pages by id until
 * none are left, so no number of correctly placed rows can hide a misplaced one
 * behind a page limit. What is bounded is the MOVES: each is a purge and a
 * re-ingest, so one call attempts at most `PLACEMENT_MOVES` and reports the
 * rest as `pending`, which the placement sweep finishes on its next ticks.
 *
 * A row whose ingest is still in flight is not moved: its job is still writing
 * chunks into the old collection, and a purge now would be followed by those
 * chunks landing there anyway. Its status is reconciled with the backend first
 * (nothing else may have read it since the job ended); one still running is
 * `pending`, and a later call moves it once the job has settled.
 *
 * What a move loses: a Dokumentart or display title set on the backend's
 * metadata row (`document_metadata`, keyed by collection) is not carried over;
 * the BFF's own `display_name` is, and is mirrored again on the next rename.
 */

import 'server-only'
import { and, asc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm'
import { getBackendUrl } from '@/lib/backend-proxy'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolders } from '@/lib/db/schema'
import { computeFolderAccess } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { collectionFileRef, purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { IN_FLIGHT_DOCUMENT_STATUSES } from '@/lib/documents/document-status'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { dispatchDocument } from '@/lib/documents/service'
import { invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import { findProjectInOrg } from '@/lib/projects/repository'

const PURGE_TIMEOUT_MS = 15_000

export interface PlacementResult {
  /** Documents re-pointed to the collection their folder puts them in. */
  moved: number
  /** Documents whose move was attempted and did not complete, by id; a later call retries them. */
  failed: string[]
  /**
   * Documents in the wrong collection that this call did not attempt: past the
   * move budget, or with an ingest still in flight. A later call moves them.
   */
  pending: number
}

interface PlacementRow {
  id: string
  folderId: string | null
  collectionName: string
  filename: string
  status: string
  errorMessage: string | null
  metadata: unknown
  updatedAt: Date
  authoredBy: (typeof documents.$inferSelect)['authoredBy']
  publishedVersionId: string | null
  storageKey: string | null
  storageBucket: string | null
}

interface Misplaced {
  row: PlacementRow
  target: string
}

/** Candidate rows one page of the scan reads. Every page is read; this bounds memory, not coverage. */
export const PLACEMENT_PAGE = 500

/** Moves one placement attempts. Each is a purge and a re-ingest; the rest is reported `pending`. */
export const PLACEMENT_MOVES = 100

/**
 * One page of the rows that can be in the wrong collection, after `afterId`:
 * those outside the project's own collection (filed under a restriction, or
 * left there by one since lifted), and those filed under a restricted folder.
 * Everything else is where it belongs by construction, so a project of ten
 * thousand open documents is not read to move none.
 */
async function listPlacementRows(
  organizationId: string,
  projectId: string,
  projectCollection: string,
  restrictedSubtree: readonly string[],
  afterId: string | null
): Promise<PlacementRow[]> {
  const db = getDb()
  const candidates = or(
    ne(documents.collectionName, projectCollection),
    ...(restrictedSubtree.length > 0 ? [inArray(documents.folderId, [...restrictedSubtree])] : [])
  )
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        folderId: documents.folderId,
        collectionName: documents.collectionName,
        filename: documents.filename,
        status: documents.status,
        errorMessage: documents.errorMessage,
        metadata: documents.metadata,
        updatedAt: documents.updatedAt,
        authoredBy: documents.authoredBy,
        publishedVersionId: documents.publishedVersionId,
        storageKey: documents.storageKey,
        storageBucket: documents.storageBucket,
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.scope, 'project'),
          candidates,
          ...(afterId ? [gt(documents.id, afterId)] : [])
        )
      )
      .orderBy(asc(documents.id))
      .limit(PLACEMENT_PAGE)
  )
}

/** Re-point one row, guarded on the collection it was read with. False when it moved meanwhile, or the name is taken there. */
async function repoint(organizationId: string, row: PlacementRow, target: string): Promise<boolean> {
  const db = getDb()
  try {
    const updated = await withTenant({ organizationId }, () =>
      db
        .update(documents)
        .set({ collectionName: target, updatedAt: new Date() })
        .where(
          and(
            eq(documents.id, row.id),
            eq(documents.organizationId, organizationId),
            eq(documents.collectionName, row.collectionName)
          )
        )
        .returning({ id: documents.id })
    )
    return updated.length > 0
  } catch (error) {
    // `uniq_documents_live_name_per_collection`: the target already holds a
    // live document of this name. Left where it is, and reported.
    console.warn(`[placement] could not move document ${row.id} to ${target}:`, error)
    return false
  }
}

async function folderPathOf(organizationId: string, projectId: string, folderId: string | null): Promise<string | null> {
  if (!folderId) return null
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId), isNull(projectFolders.deletedAt)))
      .limit(1)
  )
  return row?.path ?? null
}

async function moveDocument(
  organizationId: string,
  projectId: string,
  row: PlacementRow,
  target: string
): Promise<boolean> {
  const ref = collectionFileRef(row)
  if (ref && !(await purgeIngestedChunks(getBackendUrl(), ref, PURGE_TIMEOUT_MS))) return false
  if (!(await repoint(organizationId, row, target))) return false
  // A row that owned no chunks (a draft Piloti wrote, never indexed) only
  // needed the pointer. One that did is read again, into its new collection.
  if (!ref || !row.storageKey) return true
  try {
    await dispatchDocument({
      organizationId,
      projectId,
      documentId: row.id,
      filename: row.filename,
      storageKey: row.storageKey,
      storageBucket: row.storageBucket,
      collectionName: target,
      folderPath: await folderPathOf(organizationId, projectId, row.folderId),
    })
  } catch (error) {
    // The move itself held: the chunks are gone from the old collection and
    // the row names the new one. A failed dispatch leaves it `failed`, which
    // the ordinary retry re-reads into the right place.
    console.warn(`[placement] re-ingest of ${row.id} into ${target} failed:`, error)
  }
  return true
}

const isInFlight = (status: string): boolean => IN_FLIGHT_DOCUMENT_STATUSES.has(status.toLowerCase())

/**
 * The misplaced rows with their status brought up to date. An in-flight status
 * is only as fresh as the last read of the row: the job may have ended long
 * ago with nobody listing the folder since, and such a row would otherwise wait
 * for a reader before it could ever move. Fail-open: a backend that cannot
 * answer leaves the statuses as read, so those rows wait.
 */
async function withSettledStatuses(organizationId: string, misplaced: Misplaced[]): Promise<Misplaced[]> {
  const inFlight = misplaced.filter(({ row }) => isInFlight(row.status)).map(({ row }) => row)
  if (inFlight.length === 0) return misplaced
  try {
    const reconciled = await reconcileDocumentStatuses(inFlight, organizationId)
    const statusById = new Map(reconciled.map((row) => [row.id, row.status]))
    return misplaced.map(({ row, target }) => ({ row: { ...row, status: statusById.get(row.id) ?? row.status }, target }))
  } catch (error) {
    console.warn('[placement] could not reconcile in-flight documents; they wait:', error)
    return misplaced
  }
}

/** Move what this page has in the wrong place, within the call's move budget; count the rest as pending. */
async function placePage(
  organizationId: string,
  projectId: string,
  misplaced: Misplaced[],
  result: PlacementResult
): Promise<void> {
  const attempted = (): number => result.moved + result.failed.length
  const settled = attempted() < PLACEMENT_MOVES ? await withSettledStatuses(organizationId, misplaced) : misplaced
  for (const { row, target } of settled) {
    if (attempted() >= PLACEMENT_MOVES || isInFlight(row.status)) {
      result.pending += 1
      continue
    }
    if (await moveDocument(organizationId, projectId, row, target)) result.moved += 1
    else result.failed.push(row.id)
  }
}

/**
 * Move every document of the project that is in the wrong collection, up to
 * `PLACEMENT_MOVES` of them; the rest come back as `pending`. Never throws for
 * one document.
 *
 * It also drops the project's cached prompt view, first and last. Every change
 * of who reads what ends in this call (a folder's list set, a folder or a
 * document moved, a folder deleted), and the view's document-roles block names
 * no document in a folder not every member reads: a view cached before the
 * change would keep naming a now-restricted document in every member's turns
 * until its TTL ran out. Once here is the hook the next write path cannot
 * forget. First, so a turn during a long placement builds from the tree as it
 * now is; last, for a build that began before the change and finished after
 * the first drop.
 */
export async function placeProjectDocuments(organizationId: string, projectId: string): Promise<PlacementResult> {
  await invalidateProjectPromptViewCache(projectId, organizationId)
  try {
    return await retryProjectPlacement(organizationId, projectId)
  } finally {
    await invalidateProjectPromptViewCache(projectId, organizationId)
  }
}

/**
 * {@link placeProjectDocuments} for a caller that changed nothing about who
 * reads what: the sweep finishing moves an outage interrupted. The prompt view
 * is left cached, because the sweep ticks over every restricted project and
 * would otherwise empty the cache of each of them every time.
 */
export async function retryProjectPlacement(organizationId: string, projectId: string): Promise<PlacementResult> {
  const result: PlacementResult = { moved: 0, failed: [], pending: 0 }
  const project = await findProjectInOrg(projectId, organizationId)
  if (!project) return result
  const tree = await listProjectFolderTree(organizationId, projectId)
  // Placement does not depend on who asks: an all-seeing clearance reads only
  // the "which collection" half of the decision.
  const placement = computeFolderAccess(tree, { roles: [], seesEverything: true }, project.collectionName)
  const restrictedSubtree = tree
    .filter((folder) => placement.collectionFor(folder.id) !== project.collectionName)
    .map((folder) => folder.id)
  let afterId: string | null = null
  for (;;) {
    const page = await listPlacementRows(organizationId, projectId, project.collectionName, restrictedSubtree, afterId)
    const misplaced = page
      .map((row) => ({ row, target: placement.collectionFor(row.folderId) }))
      .filter(({ row, target }) => target !== row.collectionName)
    await placePage(organizationId, projectId, misplaced, result)
    if (page.length < PLACEMENT_PAGE) return result
    afterId = page[page.length - 1].id
  }
}
