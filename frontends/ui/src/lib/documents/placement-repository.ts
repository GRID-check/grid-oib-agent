/**
 * The SQL of collection placement (ADR-0086, ADR-0017): reading the rows that
 * can be in the wrong collection, re-pointing one, and the hand-off of a moved
 * row's re-read to the `placement_reingest` job. The decisions are
 * `lib/projects/collection-placement.ts`'s; it lives here because it authors a
 * document status, and every status writer sits where `document-status.spec.ts`
 * scans.
 *
 * The hand-off is a mark on the row, not a list in the job: a row placement
 * re-pointed sits at `processing` with `metadata.placementReingest`, and the
 * job takes marked rows of its project until none are left. So a job of the
 * project that is already queued serves rows marked after it was enqueued, and
 * the job's state is nothing but the project it walks.
 */

import 'server-only'
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolders } from '@/lib/db/schema'
import { PLACEMENT_REINGEST_MARKER } from './repository'

export interface PlacementRow {
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

const placementColumns = {
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
}

/** Candidate rows one page of the scan reads. Every page is read; this bounds memory, not coverage. */
export const PLACEMENT_PAGE = 500

const marked = () => sql`${documents.metadata} ->> ${PLACEMENT_REINGEST_MARKER}::text IS NOT NULL`

/** Whether a row as read is one placement moved and whose re-read the job has not taken yet. */
export function awaitsPlacementReingest(row: Pick<PlacementRow, 'status' | 'metadata'>): boolean {
  if (row.status !== 'processing') return false
  const metadata = row.metadata
  return typeof metadata === 'object' && metadata !== null && PLACEMENT_REINGEST_MARKER in metadata
}

/**
 * One page of the rows that can be in the wrong collection, after `afterId`:
 * those outside the project's own collection (filed under a restriction, or
 * left there by one since lifted), and those filed under a restricted folder.
 * Everything else is where it belongs by construction, so a project of ten
 * thousand open documents is not read to move none.
 */
export async function listPlacementRows(
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
      .select(placementColumns)
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

/**
 * Re-point one row, guarded on the collection it was read with. False when it
 * moved meanwhile, or the name is taken there.
 *
 * `reingest` hands the row's re-read to the `placement_reingest` job in the
 * same statement: `processing`, marked, with the previous ingest and queue job
 * ids dropped so nothing reads the old job's outcome as this one's. A row read
 * as waiting for that job is re-pointed only while it still waits, so the job
 * taking it and placement moving it again exclude each other.
 */
export async function repointPlacementRow(
  organizationId: string,
  row: PlacementRow,
  target: string,
  options: { reingest: boolean }
): Promise<boolean> {
  const db = getDb()
  const handOff = options.reingest
    ? {
        status: 'processing',
        errorMessage: null,
        metadata: sql`(coalesce(${documents.metadata}, '{}'::jsonb) - 'ingestJobId' - 'bffJobId') || jsonb_build_object(${PLACEMENT_REINGEST_MARKER}::text, true)`,
      }
    : {}
  try {
    const updated = await withTenant({ organizationId }, () =>
      db
        .update(documents)
        .set({ collectionName: target, updatedAt: new Date(), ...handOff })
        .where(
          and(
            eq(documents.id, row.id),
            eq(documents.organizationId, organizationId),
            eq(documents.collectionName, row.collectionName),
            ...(awaitsPlacementReingest(row) ? [eq(documents.status, 'processing'), marked()] : [])
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

export async function findPlacementFolderPath(
  organizationId: string,
  projectId: string,
  folderId: string | null
): Promise<string | null> {
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

function awaitingInProject(organizationId: string, projectId: string) {
  return and(
    eq(documents.organizationId, organizationId),
    eq(documents.projectId, projectId),
    eq(documents.scope, 'project'),
    eq(documents.status, 'processing'),
    marked()
  )
}

/**
 * Take up to `limit` of the project's rows waiting for their re-read, removing
 * the mark in the same statement. A row is taken once: two workers on the same
 * project skip each other's rows, and a slice that dies after taking leaves its
 * rows at `processing` with no mark, for the stranded-row sweep
 * (`documents/stuck-processing.ts`) once this job is gone.
 */
export async function takeAwaitingPlacementReingest(
  organizationId: string,
  projectId: string,
  limit: number
): Promise<PlacementRow[]> {
  const db = getDb()
  const due = db
    .select({ id: documents.id })
    .from(documents)
    .where(awaitingInProject(organizationId, projectId))
    .orderBy(asc(documents.id))
    .limit(limit)
    .for('update', { skipLocked: true })
  return withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ metadata: sql`${documents.metadata} - ${PLACEMENT_REINGEST_MARKER}::text` })
      .where(and(inArray(documents.id, due), awaitingInProject(organizationId, projectId)))
      .returning(placementColumns)
  )
}

/**
 * Name the job that will re-read the project's waiting rows on each of them
 * (`metadata.bffJobId`), so the stranded-row sweep leaves them alone while that
 * job is queued or running and recovers them if it dies or ends without them.
 */
export async function tagAwaitingPlacementReingest(
  organizationId: string,
  projectId: string,
  jobId: string
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ metadata: sql`${documents.metadata} || jsonb_build_object('bffJobId', ${jobId}::text)` })
      .where(awaitingInProject(organizationId, projectId))
  )
}
