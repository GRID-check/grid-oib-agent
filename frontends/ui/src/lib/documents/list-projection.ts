/**
 * The wire projection of a document listing — the one place a `listDocuments`
 * row becomes JSON.
 *
 * A listing row must not reach the wire as whatever `JSON.stringify` makes of a
 * `Date`. The Files page reads the same listing on the SERVER and passes it to a
 * client component as a prop, and the RSC boundary does NOT stringify a `Date` —
 * it rebuilds one. Every consumer types `createdAt` as an ISO string, so an
 * unprojected `Date` fails with `toISOString is not a function` on whichever
 * surface touches it first.
 *
 * So the projection is stated rather than implied, and both readers go through
 * it. The return type is the CLIENT's wire type (`@/features/documents/lib`),
 * which is what makes the two agree: adding a field to the listing without
 * projecting it here does not compile.
 */

import 'server-only'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import type { DocumentWireRow } from '@/features/documents/lib/file-item'
import type { ProjectFolderRow } from '@/lib/projects/folder-service'
import type { ListedDocument } from './shelf-listing'
import { summarizeDocumentVersions } from './lifecycle'
import type { DocumentVersionState } from './lifecycle-types'

/**
 * Serialize one listed document.
 *
 * Everything but the two timestamps is already JSON-shaped; `updatedAt` and
 * `collectionName` are carried because existing readers of this endpoint
 * (`use-surfaced-documents`, the knowledge panel, citation targeting) read
 * them, and dropping a field from a shared listing to slim one caller's payload
 * is how the other three start rendering blanks.
 */
export function toDocumentWireRow(
  row: ListedDocument,
  /**
   * The document's editorial state, when the caller has read it
   * (`summarizeDocumentVersions`). Optional because not every listing pays for
   * that second query — the chat's surfaced-documents reader shows no badge —
   * and an absent summary means "not known here", which the badge renders as
   * nothing rather than as `Entwurf`.
   */
  summary?: { versionCount: number; state: DocumentVersionState },
): DocumentWireRow & {
  collectionName: string
  updatedAt: string
} {
  return {
    versionState: summary?.state ?? null,
    versionCount: summary?.versionCount ?? null,
    // The item's own state, beside the version's. A listing that asks for
    // archived rows has to say which they are, or „archiviert" disappears one
    // layer further in.
    lifecycle: row.lifecycle,
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
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    errorMessage: row.errorMessage,
    summary: row.summary ?? null,
    pageCount: row.pageCount ?? null,
    chunkCount: row.chunkCount ?? null,
    contentTypes: row.contentTypes ?? null,
    tags: row.tags ?? null,
    queueAhead: row.queueAhead ?? null,
    assignees: row.assignees,
    sourceDeletedAt: row.sourceDeletedAt ?? null,
  }
}

/**
 * A page of listed documents as the wire carries them: each row through
 * {@link toDocumentWireRow} with its editorial state read in ONE query.
 *
 * The editorial state rides ALONG with the listing rather than being asked for
 * per card: the badge is on every tile, and the Files workspace re-reads the
 * listing on every filter change and settling poll. A listing that carried it
 * once (server render) and not on the re-read would make the badge blink out a
 * second after the page settled.
 *
 * Serialized explicitly rather than left to `JSON.stringify`, because the Files
 * page reads this same listing server-side and hands it across the RSC boundary,
 * which does not stringify a `Date` — see the module header.
 *
 * ONE projection for both shelves (ADR-0078): a project's `GET /api/documents`
 * and the Archiv's `GET /api/archiv/documents` serve the same row, so the
 * browser maps it with one function.
 */
export async function toDocumentWireRows(
  organizationId: string,
  rows: ListedDocument[],
): Promise<Array<ReturnType<typeof toDocumentWireRow>>> {
  const versions = await summarizeDocumentVersions(
    organizationId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => toDocumentWireRow(row, versions.get(row.id)))
}

/**
 * The same treatment for a folder row — two timestamps and nothing else that a
 * `Date` could hide in. The Files page reads `listProjectFolders` beside the
 * document listing, so it crosses the same boundary and needs the same
 * projection.
 */
export function toFolderWireRow(row: ProjectFolderRow): FolderItem {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    // Only ever a folder the reader may read (ADR-0081); the lock needs its
    // list, and the write affordances need what this reader may do here.
    grants: row.grants,
    access: row.access,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
