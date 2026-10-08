/**
 * Every project document in the retrieval collection its folder puts it in
 * (ADR-0087).
 *
 * A document under a restricted folder belongs in that folder's collection
 * (`<project collection>_r<…>`); every other document in the project's own.
 * Which one is a function of the folder tree alone, so after anything that can
 * change it — a restriction drawn or lifted, a folder moved or deleted, a
 * document moved — this is called and moves exactly the documents that are now
 * in the wrong place. A document in the Papierkorb is never moved. Idempotent: calling it again retries what failed and
 * moves nothing else.
 *
 * A move is purge, then re-point, then re-ingest. The purge comes FIRST so that
 * a document moving into a restricted folder stops being findable in the open
 * collection before anything else happens; if the purge fails the document is
 * left where it is and reported, and the next call tries again. Those two steps
 * are the security-relevant part and run here, in the caller: a few small
 * requests and one UPDATE per document, no model.
 *
 * The re-ingest does not. It costs what an upload costs, and a restriction over
 * a large folder is thousands of them, so the re-point hands it to the
 * `placement_reingest` job (ADR-0079) in the same statement: the row goes to
 * `processing`, marked as waiting for that job, and one job per project, at
 * bulk priority on the `bff-jobs` pool, re-reads the marked rows a page at a
 * time with every dispatch `bulk` (ADR-0081). A colleague's upload in the same
 * office is claimed first, and the re-reads take provider slots only after
 * interactive work. The job dispatches each row into the collection its folder
 * puts it in when the job runs, so a tree that changed again while it waited is
 * honoured without a second purge: the row's chunks are already gone
 * everywhere.
 *
 * Complete, and bounded per call. The candidates are read in pages by id until
 * none are left, so no number of correctly placed rows can hide a misplaced one
 * behind a page limit. What is bounded is the MOVES: each is a purge, so one
 * call attempts at most `PLACEMENT_MOVES` and reports the rest as `pending`,
 * which the placement sweep finishes on its next ticks.
 *
 * A row whose ingest is still in flight is not moved: its job is still writing
 * chunks into the old collection, and a purge now would be followed by those
 * chunks landing there anyway. Its status is reconciled with the backend first
 * (nothing else may have read it since the job ended); one still running is
 * `pending`, and a later call moves it once the job has settled. A row still
 * waiting for its placement re-read is the exception: nothing is writing its
 * chunks, so it moves like a settled one.
 *
 * What a move loses: a Dokumentart or display title set on the backend's
 * metadata row (`document_metadata`, keyed by collection) is not carried over;
 * the BFF's own `display_name` is, and is mirrored again on the next rename.
 * A machine's published document is re-pointed and not re-read: placement does
 * not dispatch the published version's bytes and provenance the publish door
 * does (`lifecycle.ts`, `ingestPublished`), so its chunks are gone until it is
 * published again.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { withTenant } from '@/lib/db/tenant-context'
import { computeFolderAccess, type ProjectFolderAccess } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { collectionFileRef, purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { IN_FLIGHT_DOCUMENT_STATUSES } from '@/lib/documents/document-status'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { markDocumentIngestFailed } from '@/lib/documents/repository'
import { dispatchDocument, INGEST_DISPATCH_FAILED_MESSAGE } from '@/lib/documents/service'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import type { JobSliceResult, PlacementReingestPayload } from '@/lib/jobs-queue/types'
import { invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import { findProjectInOrg } from '@/lib/projects/repository'
import {
  PLACEMENT_PAGE,
  awaitsPlacementReingest,
  findPlacementFolderPath,
  listPlacementRows,
  repointPlacementRow,
  tagAwaitingPlacementReingest,
  takeAwaitingPlacementReingest,
  type PlacementRow,
} from '@/lib/documents/placement-repository'

export { PLACEMENT_PAGE }

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

interface Misplaced {
  row: PlacementRow
  target: string
}

/** Moves one placement attempts. Each is a purge and a re-point; the rest is reported `pending`. */
export const PLACEMENT_MOVES = 100

/** Rows one `placement_reingest` slice re-reads. The marks on the rows are the job's place, so it saves no cursor. */
export const PLACEMENT_REINGEST_SLICE = 25

/** How a move came out: re-pointed with its re-read handed to the job, re-pointed alone, or not at all. */
type MoveOutcome = 'handed-off' | 'repointed' | 'failed'

async function moveDocument(organizationId: string, row: PlacementRow, target: string): Promise<MoveOutcome> {
  const ref = collectionFileRef(row)
  if (ref && !(await purgeIngestedChunks(getBackendUrl(), ref, PURGE_TIMEOUT_MS))) return 'failed'
  // A row that owned no chunks (a draft Piloti wrote, never indexed) only needs
  // the pointer, and so does a machine's published document (see the module
  // comment). A person's document with stored bytes is read again, by the job,
  // unless it is quarantined: only a release takes it out of quarantine
  // (ADR-0086), and the release dispatches it into the collection it is in.
  const reingest = Boolean(ref && row.storageKey && row.authoredBy === 'user' && row.status !== 'quarantined')
  if (!(await repointPlacementRow(organizationId, row, target, { reingest }))) return 'failed'
  return reingest ? 'handed-off' : 'repointed'
}

/** Whether a row must wait before it may move: an ingest is writing its chunks. */
const mustWait = (row: PlacementRow): boolean =>
  IN_FLIGHT_DOCUMENT_STATUSES.has(row.status.toLowerCase()) && !awaitsPlacementReingest(row)

/**
 * The misplaced rows with their status brought up to date. An in-flight status
 * is only as fresh as the last read of the row: the job may have ended long
 * ago with nobody listing the folder since, and such a row would otherwise wait
 * for a reader before it could ever move. Fail-open: a backend that cannot
 * answer leaves the statuses as read, so those rows wait.
 */
async function withSettledStatuses(organizationId: string, misplaced: Misplaced[]): Promise<Misplaced[]> {
  const inFlight = misplaced.filter(({ row }) => mustWait(row)).map(({ row }) => row)
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

/** What one call did, and whether it left re-reads for the job. */
interface PlacementRun {
  result: PlacementResult
  handedOff: number
}

/** Move what this page has in the wrong place, within the call's move budget; count the rest as pending. */
async function placePage(organizationId: string, misplaced: Misplaced[], run: PlacementRun): Promise<void> {
  const { result } = run
  const attempted = (): number => result.moved + result.failed.length
  const settled = attempted() < PLACEMENT_MOVES ? await withSettledStatuses(organizationId, misplaced) : misplaced
  for (const { row, target } of settled) {
    if (attempted() >= PLACEMENT_MOVES || mustWait(row)) {
      result.pending += 1
      continue
    }
    const outcome = await moveDocument(organizationId, row, target)
    if (outcome === 'failed') {
      result.failed.push(row.id)
      continue
    }
    result.moved += 1
    if (outcome === 'handed-off') run.handedOff += 1
  }
}

/**
 * Make sure a `placement_reingest` job will take the project's waiting rows,
 * and name it on them.
 *
 * Reuses a job of the project that no worker has claimed yet: it will read the
 * marks from the start. A running one is not reused, because it may already
 * have found nothing left and be finishing; a second job then queues behind it,
 * so a project has at most one waiting. Bulk, like the dispatches it makes.
 *
 * Never throws: the moves have happened and are what the caller reports. A
 * queue that cannot be written leaves the rows at `processing` with no job
 * named, which the stranded-row sweep (`documents/stuck-processing.ts`)
 * re-dispatches, at bulk, after its quarter of an hour.
 */
async function queuePlacementReingest(organizationId: string, projectId: string): Promise<void> {
  try {
    await withTenant({ organizationId }, async () => {
      const kind = 'placement_reingest'
      const open = await findOpenJobId({ kind, organizationId, matching: { projectId }, notStarted: true })
      const payload: PlacementReingestPayload = { projectId }
      const jobId = open ?? (await enqueueJob({ kind, organizationId, payload })).jobId
      await tagAwaitingPlacementReingest(organizationId, projectId, jobId)
    })
  } catch (error) {
    console.warn(`[placement] could not queue the re-read of project ${projectId}; the stranded-row sweep will:`, error)
  }
}

/**
 * Re-read one row placement moved, into the collection its folder puts it in
 * NOW, at bulk priority.
 *
 * The tree may have changed again while the row waited. Its chunks were purged
 * before it was marked and nothing has dispatched it since, so it can go
 * straight to its current collection with no second purge. When that re-point
 * is refused (the name is taken there) it is not dispatched where it stands,
 * which may now be the wrong side of a restriction: it fails with the reason,
 * and the next placement, which sees a settled misplaced row, moves it.
 */
async function reingestPlacedRow(
  organizationId: string,
  projectId: string,
  placement: ProjectFolderAccess,
  row: PlacementRow
): Promise<void> {
  const target = placement.collectionFor(row.folderId)
  if (target !== row.collectionName && !(await repointPlacementRow(organizationId, row, target, { reingest: false }))) {
    await markDocumentIngestFailed(row.id, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    return
  }
  if (!row.storageKey) return
  try {
    await dispatchDocument({
      organizationId,
      projectId,
      documentId: row.id,
      filename: row.filename,
      storageKey: row.storageKey,
      storageBucket: row.storageBucket,
      collectionName: target,
      folderPath: await findPlacementFolderPath(organizationId, projectId, row.folderId),
      // Nobody is waiting on a placement: a colleague's upload goes first, in
      // this office's lane and for provider slots (ADR-0079, ADR-0081).
      priority: 'bulk',
    })
  } catch (error) {
    // The row stays `processing` naming this job; once the job is gone the
    // stranded-row sweep dispatches it again.
    console.warn(`[placement] re-ingest of ${row.id} into ${target} failed:`, error)
  }
}

/**
 * One slice of a `placement_reingest` job: take the next rows of the project
 * waiting for their re-read and dispatch each. Done when a slice takes fewer
 * than a full page, which also covers a project deleted meanwhile (its rows
 * are gone with it).
 */
export async function runPlacementReingestSlice(
  organizationId: string,
  payload: PlacementReingestPayload
): Promise<JobSliceResult<PlacementReingestPayload>> {
  const project = await findProjectInOrg(payload.projectId, organizationId)
  if (!project) return { done: true, payload }
  const { placement } = await projectPlacement(organizationId, payload.projectId, project.collectionName)
  const rows = await takeAwaitingPlacementReingest(organizationId, payload.projectId, PLACEMENT_REINGEST_SLICE)
  for (const row of rows) await reingestPlacedRow(organizationId, payload.projectId, placement, row)
  return { done: rows.length < PLACEMENT_REINGEST_SLICE, payload }
}

/** Which collection each folder of the project puts a document in. Placement does not depend on who asks. */
async function projectPlacement(organizationId: string, projectId: string, projectCollection: string) {
  const tree = await listProjectFolderTree(organizationId, projectId)
  // An all-seeing clearance reads only the "which collection" half of the decision.
  return { tree, placement: computeFolderAccess(tree, { roles: [], seesEverything: true }, projectCollection) }
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
  const run: PlacementRun = { result: { moved: 0, failed: [], pending: 0 }, handedOff: 0 }
  const project = await findProjectInOrg(projectId, organizationId)
  if (!project) return run.result
  const { tree, placement } = await projectPlacement(organizationId, projectId, project.collectionName)
  const restrictedSubtree = tree
    .filter((folder) => placement.collectionFor(folder.id) !== project.collectionName)
    .map((folder) => folder.id)
  // A document in the Papierkorb is not placed: its chunks were purged when it
  // went there, and re-ingesting it anywhere would make a deleted file
  // searchable again. A restore places it (`lib/projects/folder-bin.ts`).
  const deleted = new Set(tree.filter((folder) => folder.deleted).map((folder) => folder.id))
  let afterId: string | null = null
  for (;;) {
    const page = await listPlacementRows(organizationId, projectId, project.collectionName, restrictedSubtree, afterId)
    const misplaced = page
      .filter((row) => row.folderId === null || !deleted.has(row.folderId))
      .map((row) => ({ row, target: placement.collectionFor(row.folderId) }))
      .filter(({ row, target }) => target !== row.collectionName)
    await placePage(organizationId, misplaced, run)
    if (page.length < PLACEMENT_PAGE) break
    afterId = page[page.length - 1].id
  }
  if (run.handedOff > 0) await queuePlacementReingest(organizationId, projectId)
  return run.result
}
