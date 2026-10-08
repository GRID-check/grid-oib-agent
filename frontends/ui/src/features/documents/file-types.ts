import type { DocumentAuthor } from '@/lib/db/schema'
import type { FolderGrantItem } from '@/adapters/api/folder-access-client'
import type {
  DocumentLifecycle,
  DocumentVersionState,
} from '@/lib/documents/lifecycle-types'

export interface FolderItem {
  id: string
  parentId: string | null
  name: string
  path: string
  createdAt?: string
  updatedAt?: string
  /**
   * The folder's own access list (ADR-0087): roles (and `*`, every project
   * member), each with `read` or `write`. Null/absent when it inherits its
   * parent's. The listing only carries folders the reader may read. A
   * project's folders only: the Archiv's carry none.
   */
  grants?: FolderGrantItem[] | null
  /**
   * What THIS reader may do here, as the listing reported it: `read` hides the
   * write affordances. Absent reads as `write`. The server decides every write
   * again; this only shapes the UI.
   */
  access?: 'read' | 'write'
}

export interface FileItem {
  id: string
  /**
   * The file's own name — its identity, and what its format is read from.
   * What to SHOW is `documentDisplayName(file)`, never this directly.
   */
  filename: string
  /** The rename, when somebody has given the document one; else null. */
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string | null
  folderId: string | null
  /**
   * Where the file sat before it was uploaded, for a folder upload — e.g.
   * `Wohnbau Nord/03_Einreichung/EG.pdf`. Null for a picked file, and null for
   * everything uploaded before this was recorded.
   *
   * NOT `folderId`: that is Piloti's own filing, which somebody here chose and
   * can change. This is a fact about the original, and it is what a person
   * needs in order to go back and work on that original instead of editing a
   * downloaded duplicate.
   */
  originPath?: string | null
  /**
   * A digest of the stored bytes (`sha256:<hex>`), or null when unknown.
   *
   * Read by the folder-upload planner and by nothing else on screen. It is on
   * the row so the plan can be computed from the listing the reader is already
   * looking at, instead of a request per candidate file to discover that
   * nothing needs uploading.
   */
  contentHash?: string | null
  createdAt: string
  /** Server-persisted reason a document is in `failed` status, if any. */
  errorMessage: string | null
  /** One-sentence summary of the document content, if the backend generated one. */
  summary: string | null
  /** Number of pages the backend indexed for this document. */
  pageCount: number | null
  /** Number of retrieval chunks the backend produced for this document. */
  chunkCount: number | null
  /** Content categories present in the document (e.g. text, table, chart, image). */
  contentTypes: string[] | null
  /** Controlled ingestion-generated tags (document type + OIB discipline). */
  tags: string[] | null
  /**
   * How many of this office's uploads wait ahead of this one in the ingest
   * queue, or null when it is not waiting there (`DocumentMetadata.queueAhead`).
   */
  queueAhead?: number | null
  /** Who is on the hook. Empty = Unvergeben. Absent when collaboration is off. */
  assignees?: readonly FileAssignee[]
  /**
   * Whose hand wrote the bytes — `agent` for a report Piloti produced on a
   * commissioned run. PROVENANCE, never responsibility: an agent-authored file
   * has no assignees and its footer says `Unvergeben` like any other unclaimed
   * file. Absent on a listing served before the column existed, which means
   * exactly what the column's default means — a person uploaded it.
   */
  authoredBy?: DocumentAuthor
  /**
   * The NEWEST version's editorial state, and how many versions there are
   * (ADR-0054). Both come from the listing, together, because the badge rule
   * reads both: a plain upload has one published version and shows nothing.
   *
   * `null` means "this listing did not read it" — not „Entwurf". The chat's
   * surfaced-documents reader and the Archiv listing do not pay for the second
   * query, and a badge must not appear where nobody asked the question.
   */
  versionState?: DocumentVersionState | null
  versionCount?: number | null
  /**
   * Whether the ITEM is still in the working set (ADR-0054).
   *
   * Absent everywhere the listing has no reason to say — the default listing
   * carries active rows only, so „was fehlt hier" is answered by the filter and
   * not by a field on every row. It is present, and `archived`, exactly when
   * the reader asked for archived documents and is looking at a mixed list.
   */
  lifecycle?: DocumentLifecycle | null
  /**
   * A filed report drawn from a folder that was purged since (ADR-0087): when
   * the purge ran, for „Quelle gelöscht am …". Null for every other document.
   */
  sourceDeletedAt?: string | null
}

export interface FileAssignee {
  userId: string
  name: string | null
  email: string | null
  profilePictureUrl: string | null
}
