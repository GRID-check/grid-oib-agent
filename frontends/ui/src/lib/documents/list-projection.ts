/**
 * The wire projection of a document listing — the one place a `listDocuments`
 * row becomes JSON.
 *
 * `GET /api/documents` used to hand its rows straight to the response and let
 * `JSON.stringify` decide what a `Date` looks like. That was invisible and
 * correct exactly once: the Files page now reads the same listing on the SERVER
 * and passes it to a client component as a prop, and the RSC boundary does NOT
 * stringify a `Date` — it rebuilds one. The first paint would have carried
 * `createdAt` as a `Date` where every consumer types it as an ISO string, and
 * `toISOString is not a function` would have arrived on whichever surface
 * touched it first.
 *
 * So the projection is stated rather than implied, and both readers go through
 * it. The return type is the CLIENT's wire type (`@/features/documents/lib`),
 * which is what makes the two agree: adding a field to the listing without
 * projecting it here does not compile.
 */

import 'server-only'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import type { DocumentWireRow } from '@/features/documents/lib/file-item'
import type { FolderRow } from '@/lib/projects/folder-service'
import type { ListedDocument } from './service'

/**
 * Serialize one listed document.
 *
 * Everything but the two timestamps is already JSON-shaped; `updatedAt` and
 * `collectionName` are carried because existing readers of this endpoint
 * (`use-surfaced-documents`, the knowledge panel, citation targeting) read
 * them, and dropping a field from a shared listing to slim one caller's payload
 * is how the other three start rendering blanks.
 */
export function toDocumentWireRow(row: ListedDocument): DocumentWireRow & {
  collectionName: string
  updatedAt: string
} {
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.displayName,
    fileSize: row.fileSize,
    contentType: row.contentType,
    status: row.status,
    authoredBy: row.authoredBy,
    collectionName: row.collectionName,
    folderId: row.folderId,
    originPath: row.originPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    errorMessage: row.errorMessage,
    summary: row.summary ?? null,
    pageCount: row.pageCount ?? null,
    chunkCount: row.chunkCount ?? null,
    contentTypes: row.contentTypes ?? null,
    tags: row.tags ?? null,
    assignees: row.assignees,
  }
}

/**
 * The same treatment for a folder row — two timestamps and nothing else that a
 * `Date` could hide in. The Files page reads `listProjectFolders` beside the
 * document listing, so it crosses the same boundary and needs the same
 * projection.
 */
export function toFolderWireRow(row: FolderRow): FolderItem {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
