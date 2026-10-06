import type { Document } from '@/lib/db/schema'
import { documentShelf, type DocumentShelf } from './shelf'
import { findFolderPathInArchiv, findFolderPathInProject } from './repository'

/**
 * A folder's materialised path on `shelf`, or `null` when no such folder is on
 * it — another project's, another shelf's or another tenant's id is simply not
 * found. The one dispatch between the two shelves' folder lookups.
 */
export function resolveShelfFolderPath(
  shelf: DocumentShelf,
  folderId: string,
  organizationId: string,
): Promise<string | null> {
  return shelf.kind === 'project'
    ? findFolderPathInProject(folderId, shelf.projectId, organizationId)
    : findFolderPathInArchiv(folderId, organizationId)
}

/**
 * The materialised folder path a stored document is filed under, or `null` when
 * it sits at the root of its shelf (or on a shelf that has no folders at all —
 * a session attachment).
 *
 * Every re-run of a dispatch has to re-supply the SAME `folder_path` the upload
 * did (ADR-0049): a re-ingest, a re-index and a publish that omitted it would
 * silently un-file a document somebody had filed, and only the agent would
 * notice. One resolver for all of them, and for both shelves that have folders
 * (ADR-0078) — an Archiv document's folder is read off its own shelf exactly as a
 * project document's is, so a re-ingest does not drop it.
 */
export async function resolveDocumentFolderPath(
  doc: Pick<Document, 'folderId' | 'projectId' | 'scope'>,
  organizationId: string,
): Promise<string | null> {
  const shelf = documentShelf(doc)
  if (!doc.folderId || !shelf) return null
  return resolveShelfFolderPath(shelf, doc.folderId, organizationId)
}
