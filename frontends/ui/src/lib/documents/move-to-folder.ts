/**
 * Re-file a document into another folder — or out of every folder.
 *
 * Folders could be created, renamed, moved and deleted, and a document could be
 * filed into one AT UPLOAD and never again: `documents.folder_id` was written
 * once and had no other writer. A file dropped into the wrong folder, or
 * uploaded before the folder existed, stayed where it landed for good. That is
 * the one dead end left in the filing model, and it gets worse the more the
 * folder tree can be reorganised.
 *
 * One path for both shelves that have folders (ADR-0078): a project's Dateien
 * and the org-wide Archiv. The document's own row says which shelf it is on, the
 * shelf says who may move it (`@/lib/documents/shelf-authz`) and which folders
 * are valid destinations (`findShelfFolder`), and nothing else differs. A
 * session attachment is on neither and is refused.
 *
 * Deliberately its own module and its own route rather than a field on
 * `PATCH /api/documents/{id}`: that route renames and tags, resolving the
 * permission from the row, and a filing move needs the destination check and
 * the backend mirror below.
 */

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { getProjectFolderAccess, requireFolderWrite } from '@/lib/authz/folder-access'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { AuthorizedSession } from '@/lib/auth/types'
import { collectionFileRef, collectionFileUrl, type CollectionFileRef } from '@/lib/documents/collection-file-ref'
import { placeProjectDocuments } from '@/lib/projects/collection-placement'
import { assertIfcMayBeFiledIn } from '@/lib/projects/ifc-folder-guard'
import { findProjectInOrg } from '@/lib/projects/repository'
import { findDocumentForSession } from './access'
import { documentShelf, type DocumentShelf } from './shelf'
import { requireShelfWrite } from './shelf-authz'
import { findShelfFolder } from './shelf-folders'

/** Same ceiling the other backend mirrors in `@/lib/documents/service` use. */
const BACKEND_MIRROR_TIMEOUT_MS = 10_000

/** What the caller is told when the destination is not a folder of the document's shelf. */
const FOLDER_NOT_FOUND: Record<DocumentShelf['kind'], string> = {
  project: 'Folder not found in this project.',
  archiv: 'Folder not found in the Archiv.',
}

export interface MoveDocumentInput {
  documentId: string
  /** The destination. `null` files the document at the shelf root. */
  folderId: string | null
}

export interface MoveDocumentResult {
  id: string
  folderId: string | null
}

export async function moveDocumentToFolder(
  input: MoveDocumentInput,
  session: AuthorizedSession,
): Promise<{ ok: true; document: MoveDocumentResult } | { ok: false; error: string }> {
  const db = getDb()

  // The document is read FIRST and without a shelf permission check, because
  // the shelf it is on is what the permission is checked against. It is read
  // org-scoped and through the hold (ADR-0085), so a document in another
  // tenant, or a held file this session neither uploaded nor reviews, is
  // simply not found.
  const document = await findDocumentForSession(session, input.documentId)

  if (!document) return { ok: false, error: 'Document not found.' }
  const shelf = documentShelf(document)
  if (!shelf) {
    // A session attachment. It is filed nowhere, and the database agrees.
    return { ok: false, error: 'Only project and Archiv documents live in folders.' }
  }

  await requireShelfWrite(session, shelf)

  // A project's folders have access per role (ADR-0087, ADR-0088); the
  // Archiv's do not. Both ends must be visible to the mover: a document in a
  // folder they may not read does not exist for them, and neither does such a
  // destination. Moving out of a folder and into another is a write on both: a
  // read-only end refuses (403), whichever it is. Restricted folders do not
  // hold IFC models until their building data is partitioned: a 409, thrown,
  // because the route turns `ok: false` into 400.
  // The collection the destination's access calls for; the Archiv has one.
  let targetCollection = document.collectionName
  if (shelf.kind === 'project') {
    const project = await findProjectInOrg(shelf.projectId, session.organizationId)
    if (!project) return { ok: false, error: 'Document not found.' }
    const access = await getProjectFolderAccess(session, shelf.projectId, project.collectionName)
    if (!access.isVisible(document.folderId)) return { ok: false, error: 'Document not found.' }
    if (!access.isVisible(input.folderId)) return { ok: false, error: FOLDER_NOT_FOUND.project }
    await requireFolderWrite(session, shelf.projectId, [document.folderId, input.folderId])
    targetCollection = access.collectionFor(input.folderId)
    assertIfcMayBeFiledIn(document.filename, targetCollection, project.collectionName)
  }

  // The destination has to be a folder of the SAME shelf (and tenant). Without
  // this the folder id is an unguessable-but-forgeable pointer into another
  // tree, and the document would vanish from the listing that filters by folder.
  let destinationPath: string | null = null
  if (input.folderId) {
    const folder = await findShelfFolder(shelf, session.organizationId, input.folderId)
    if (!folder) return { ok: false, error: FOLDER_NOT_FOUND[shelf.kind] }
    destinationPath = folder.path
  }

  if (document.folderId === input.folderId) {
    return { ok: true, document: { id: document.id, folderId: document.folderId } }
  }

  const [updated] = await db
    .update(documents)
    .set({ folderId: input.folderId, updatedAt: new Date() })
    .where(eq(documents.id, document.id))
    .returning({ id: documents.id, folderId: documents.folderId })

  // Across a restriction boundary the document belongs in another collection:
  // placement purges it from this one first, then re-reads it into the right
  // one under its new path, so the path mirror below has nothing to add.
  if (shelf.kind === 'project' && targetCollection !== document.collectionName) {
    await placeProjectDocuments(session.organizationId, shelf.projectId)
    return { ok: true, document: { id: updated.id, folderId: updated.folderId } }
  }

  const backendRef = collectionFileRef({
    collectionName: document.collectionName,
    filename: document.filename,
    authoredBy: document.authoredBy,
    publishedVersionId: document.publishedVersionId,
  })
  if (backendRef) {
    await mirrorDocumentFolderPath(backendRef, destinationPath)
  }

  return { ok: true, document: { id: updated.id, folderId: updated.folderId } }
}

/**
 * Tell the backend where this document now lives (ADR-0049).
 *
 * The Python side files documents under the materialised PATH, so a move that
 * only wrote `documents.folder_id` would leave the agent's inventory and its
 * `knowledge_search folder=` filter naming the folder the file just left — a
 * document findable under a folder it is no longer in.
 *
 * The subtree mirror in `@/lib/documents/shelf-folders` cannot express this:
 * that one rewrites a path PREFIX, and a document leaving `Brandschutz` for
 * `Statik` shares no prefix with where it was. Hence the per-document endpoint.
 *
 * Best-effort, with the same ordering argument as the display-title and
 * subtree mirrors: `documents.folder_id` above is the durable record of where
 * the file lives, and a backend that is down must not fail a move the user is
 * entitled to. The bounded cost is that the agent keeps the old folder until
 * the next move or re-ingest.
 */
async function mirrorDocumentFolderPath(ref: CollectionFileRef, folderPath: string | null): Promise<void> {
  try {
    await fetch(collectionFileUrl(getBackendUrl(), ref, '/folder-path'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
      signal: AbortSignal.timeout(BACKEND_MIRROR_TIMEOUT_MS),
    })
  } catch {
    // ignore — see the note above; `documents.folder_id` is the durable truth.
  }
}
