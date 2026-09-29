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

import { documentStatusFacts } from '@/lib/documents/document-status'
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
  | 'versionState'
  | 'versionCount'
  | 'lifecycle'

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
    // `null`, never a default state: a listing that did not read the version
    // summary is saying "unknown here", and the badge rule renders nothing for
    // it. Defaulting to `published` would put a badge on every Archiv row.
    versionState: row.versionState ?? null,
    versionCount: row.versionCount ?? null,
    // A listing that did not say is a listing of the working set — which is
    // what every listing but the „Archiviert" one is.
    lifecycle: row.lifecycle ?? 'active',
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

/**
 * What ingestion writes after the status: the backend produces these from the
 * collection listing, which the BFF caches, so a read can say `completed` a
 * beat before it carries the summary. Absent in a fresh read means "not seen
 * yet", never "removed".
 */
const TRAILING_METADATA: ReadonlySet<keyof FileItem> = new Set<keyof FileItem>([
  'summary',
  'pageCount',
  'chunkCount',
  'contentTypes',
  'tags',
])

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** What a stale in-flight read would take back along with the status. */
const REGRESSION_FIELDS: ReadonlySet<keyof FileItem> = new Set<keyof FileItem>(['status', 'errorMessage'])

/**
 * A read that would move a TERMINAL row back to an in-flight status, without a
 * new version to explain it, is older than what is held.
 *
 * Two readers follow the same row: the open file's own status poll and the
 * listing behind it, which drains every page and so can answer from a moment
 * before the poll did. Without this the badge flipped back to „Wird gelesen…"
 * after it had said „Bereit", and the poll that had stopped started again. A
 * re-upload is the one honest way back into flight, and it adds a version —
 * so a grown `versionCount` lets the regression through.
 */
function isStaleRegression(
  current: FileItem,
  fresh: Partial<FileItem>,
  fields: readonly (keyof FileItem)[]
): boolean {
  if (!fields.includes('status') || !('status' in fresh)) return false
  if (documentStatusFacts(current.status)?.phase !== 'terminal') return false
  if (documentStatusFacts(fresh.status)?.phase !== 'in-flight') return false
  const grew =
    fresh.versionCount != null && (current.versionCount == null || fresh.versionCount > current.versionCount)
  return !grew
}

/**
 * The patch that brings an OPEN file up to a fresher read of the same
 * document, or `null` when nothing it shows has changed.
 *
 * One rule for every surface that holds a snapshot of a row while the row is
 * still being read (the preview's status poll, a listing refresh behind an
 * open modal), so they cannot disagree about it: a fresh value replaces the
 * held one, except that trailing metadata is never erased by a read that has
 * not caught up with it yet, and a terminal status is never taken back by a
 * stale in-flight read ({@link isStaleRegression}). `null` rather than an empty patch so a poll that
 * learned nothing does not hand every subscriber a new object.
 *
 * @param fields The fields the fresh read is an authority for; defaults to
 *   every field it carries.
 */
export function refreshedFileFields(
  current: FileItem,
  fresh: Partial<FileItem>,
  fields: readonly (keyof FileItem)[] = Object.keys(fresh) as (keyof FileItem)[]
): Partial<FileItem> | null {
  const patch: Record<string, unknown> = {}
  let changed = false
  const heldBack = isStaleRegression(current, fresh, fields)
  for (const field of fields) {
    if (!(field in fresh)) continue
    if (heldBack && REGRESSION_FIELDS.has(field)) continue
    const next = fresh[field]
    if (next == null && TRAILING_METADATA.has(field) && current[field] != null) continue
    if (sameValue(current[field], next)) continue
    patch[field] = next
    changed = true
  }
  return changed ? (patch as Partial<FileItem>) : null
}
