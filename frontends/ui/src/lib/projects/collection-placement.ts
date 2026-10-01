/**
 * Every project document in the retrieval collection its folder puts it in
 * (ADR-0078).
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
 * What a move loses: a Dokumentart or display title set on the backend's
 * metadata row (`document_metadata`, keyed by collection) is not carried over;
 * the BFF's own `display_name` is, and is mirrored again on the next rename.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { getBackendUrl } from '@/lib/backend-proxy'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolders } from '@/lib/db/schema'
import { computeFolderAccess } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { collectionFileRef, purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { dispatchDocument } from '@/lib/documents/service'
import { findProjectInOrg } from '@/lib/projects/repository'

const PURGE_TIMEOUT_MS = 15_000

export interface PlacementResult {
  /** Documents re-pointed to the collection their folder puts them in. */
  moved: number
  /** Documents that could not be moved this time, by id; a later call retries them. */
  failed: string[]
}

interface PlacementRow {
  id: string
  folderId: string | null
  collectionName: string
  filename: string
  authoredBy: (typeof documents.$inferSelect)['authoredBy']
  publishedVersionId: string | null
  storageKey: string | null
  storageBucket: string | null
}

async function listPlacementRows(organizationId: string, projectId: string): Promise<PlacementRow[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        folderId: documents.folderId,
        collectionName: documents.collectionName,
        filename: documents.filename,
        authoredBy: documents.authoredBy,
        publishedVersionId: documents.publishedVersionId,
        storageKey: documents.storageKey,
        storageBucket: documents.storageBucket,
      })
      .from(documents)
      .where(and(eq(documents.organizationId, organizationId), eq(documents.projectId, projectId), eq(documents.scope, 'project')))
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
      .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId)))
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

/** Move every document of the project that is in the wrong collection. Never throws for one document. */
export async function placeProjectDocuments(organizationId: string, projectId: string): Promise<PlacementResult> {
  const project = await findProjectInOrg(projectId, organizationId)
  if (!project) return { moved: 0, failed: [] }
  const tree = await listProjectFolderTree(organizationId, projectId)
  // Placement does not depend on who asks: an all-seeing clearance reads only
  // the "which collection" half of the decision.
  const placement = computeFolderAccess(tree, { roles: [], seesEverything: true }, project.collectionName)
  const rows = await listPlacementRows(organizationId, projectId)
  const result: PlacementResult = { moved: 0, failed: [] }
  for (const row of rows) {
    const target = placement.collectionFor(row.folderId)
    if (target === row.collectionName) continue
    if (await moveDocument(organizationId, projectId, row, target)) result.moved += 1
    else result.failed.push(row.id)
  }
  return result
}
