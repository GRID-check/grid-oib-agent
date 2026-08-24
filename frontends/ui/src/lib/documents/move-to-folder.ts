/**
 * Re-file a project document into another folder — or out of every folder.
 *
 * Folders could be created, renamed, moved and deleted, and a document could be
 * filed into one AT UPLOAD and never again: `documents.folder_id` was written
 * once and had no other writer. A file dropped into the wrong folder, or
 * uploaded before the folder existed, stayed where it landed for good. That is
 * the one dead end left in the filing model, and it gets worse the more the
 * folder tree can be reorganised.
 *
 * Deliberately its own module and its own route rather than a field on
 * `PATCH /api/documents/{id}`: that route is SCOPE-AWARE (it renames an org-wide
 * Archiv document too, resolving the permission from the row), and folders are a
 * project-only concept. An Archiv document has no folder to move it to, and a
 * request to move one is a mistake worth refusing rather than quietly ignoring.
 */

import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, projectFolders } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { AuthorizedSession } from '@/lib/auth/types'

/** Same ceiling the other backend mirrors in `@/lib/documents/service` use. */
const BACKEND_MIRROR_TIMEOUT_MS = 10_000

export interface MoveDocumentInput {
  documentId: string
  /** The destination. `null` files the document at the project root. */
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

  // The document is read FIRST and without an FGA check, because the project it
  // belongs to is what the permission is checked against — and it is read
  // org-scoped, so a document in another tenant is simply not found.
  const [document] = await db
    .select({
      id: documents.id,
      projectId: documents.projectId,
      folderId: documents.folderId,
      filename: documents.filename,
      collectionName: documents.collectionName,
    })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.organizationId, session.organizationId)))
    .limit(1)

  if (!document) return { ok: false, error: 'Document not found.' }
  if (!document.projectId) {
    // A session attachment or an org-wide Archiv document. Neither is filed.
    return { ok: false, error: 'Only project documents live in folders.' }
  }

  await requireProjectAccess(session, document.projectId, ['project:documents:write', 'project:edit'])

  // The destination has to belong to the SAME project. Without this the folder
  // id is an unguessable-but-forgeable pointer into another project's tree, and
  // the document would vanish from the listing that filters by folder.
  let destinationPath: string | null = null
  if (input.folderId) {
    const [folder] = await db
      .select({ id: projectFolders.id, path: projectFolders.path })
      .from(projectFolders)
      .where(
        and(eq(projectFolders.id, input.folderId), eq(projectFolders.projectId, document.projectId)),
      )
      .limit(1)
    if (!folder) return { ok: false, error: 'Folder not found in this project.' }
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

  await mirrorDocumentFolderPath(document.collectionName, document.filename, destinationPath)

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
 * The subtree mirror in `@/lib/projects/folder-service` cannot express this:
 * that one rewrites a path PREFIX, and a document leaving `Brandschutz` for
 * `Statik` shares no prefix with where it was. Hence the per-document endpoint.
 *
 * Best-effort, with the same ordering argument as the display-title and
 * subtree mirrors: `documents.folder_id` above is the durable record of where
 * the file lives, and a backend that is down must not fail a move the user is
 * entitled to. The bounded cost is that the agent keeps the old folder until
 * the next move or re-ingest.
 */
async function mirrorDocumentFolderPath(
  collectionName: string,
  filename: string,
  folderPath: string | null,
): Promise<void> {
  try {
    await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents/${encodeURIComponent(
        filename,
      )}/folder-path`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: folderPath }),
        signal: AbortSignal.timeout(BACKEND_MIRROR_TIMEOUT_MS),
      },
    )
  } catch {
    // ignore — see the note above; `documents.folder_id` is the durable truth.
  }
}
