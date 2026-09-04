/**
 * The `/api/documents` row, and the one function that turns it into a
 * {@link FileItem}.
 *
 * This existed inline in `loadFiles` and nowhere else, which was fine while
 * the browser was the only thing that ever saw a document row. The Files page
 * now hands the workspace a listing the SERVER already read (no client round
 * trip before the first paint), so the same projection has to run over rows
 * that never crossed a `fetch`. Two copies of "what a null means here" is
 * exactly the drift that makes a server-rendered first paint disagree with the
 * refresh that replaces it a second later.
 */

import type { FileAssignee, FileItem } from '../components/project-file-workspace'

/**
 * A `/api/documents` row as it arrives over the wire — the JSON projection of
 * `listDocuments`. Everything ingestion derives (summary, page/chunk counts,
 * content types, tags) is absent until the backend has produced it, which is
 * why each is normalized to `null` by {@link toFileItem}.
 */
export type DocumentWireRow = Omit<FileItem, OptionalWireField> &
  Partial<Pick<FileItem, OptionalWireField>>

type OptionalWireField =
  | 'authoredBy'
  | 'displayName'
  | 'folderId'
  | 'errorMessage'
  | 'summary'
  | 'pageCount'
  | 'chunkCount'
  | 'contentTypes'
  | 'tags'
  | 'originPath'
  | 'contentHash'
  | 'assignees'

/** Normalize one wire row into the shape every file surface reads. */
export function toFileItem(row: DocumentWireRow): FileItem {
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.displayName ?? null,
    fileSize: row.fileSize,
    contentType: row.contentType,
    status: row.status,
    folderId: row.folderId ?? null,
    originPath: row.originPath ?? null,
    contentHash: row.contentHash ?? null,
    createdAt: row.createdAt,
    errorMessage: row.errorMessage ?? null,
    summary: row.summary ?? null,
    pageCount: row.pageCount ?? null,
    chunkCount: row.chunkCount ?? null,
    contentTypes: row.contentTypes ?? null,
    tags: row.tags ?? null,
    assignees: row.assignees ?? EMPTY_ASSIGNEES,
    authoredBy: row.authoredBy ?? 'user',
  }
}

/**
 * One frozen empty array for every unassigned row, rather than a fresh `[]`
 * per row per load. A listing is re-read on every settling poll, and
 * `AssignmentFaces` and the assignment filter both take this by reference —
 * a new array each time makes every memo downstream miss for a fact that did
 * not change.
 */
const EMPTY_ASSIGNEES: readonly FileAssignee[] = Object.freeze([])
