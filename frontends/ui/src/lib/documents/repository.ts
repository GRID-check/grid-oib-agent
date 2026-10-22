/**
 * Documents repository — the only module that talks to the `documents` table
 * (and the folder-path probe the upload flow needs) for the documents domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no SeaweedFS/backend calls.
 *   - Every query that serves tenant data takes `organizationId` (and, where
 *     applicable, `projectId`) and scopes the WHERE clause with it — tenancy
 *     is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor, DbTransaction } from '@/lib/db/executor'
import { withOptionalTenant, withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { OFFICE_SHELF, documentShelf, projectShelf, shelfDocumentWhere, shelfFolderWhere, type DocumentShelf } from './shelf'
import { publishShelfChanged } from './shelf-live'
import { documentAliasKey, documentNameKey, documentNameVariants } from './name-match'
import { FILENAME_LOOKUP_MAX_NAMES } from './filename-lookup'
import { FILING_CHOICE_METADATA_KEY } from './filing-choice'
import {
  CURSOR_TIMESTAMP_FORMAT,
  type DocumentLevelCursor,
  type DocumentLevelSort,
  type DocumentListCursor,
} from './list-cursor'
import type { DocumentLevelQuery } from './list-query'
import { DOCUMENT_READ_FAMILIES, declaredStatusesIn, type DocumentReadFamily, type DocumentStatus } from './document-status'
import {
  SHELF_SUMMARY_FAILED_LIMIT,
  SHELF_SUMMARY_FOLDER_LIMIT,
  type ShelfFolderTally,
  type ShelfSummary,
} from './shelf-summary-types'
import {
  bffJobQueue,
  documentQuarantineDecisions,
  documents,
  documentVersions,
  projectFolders,
  type Document,
  type DocumentAuthor,
  type DocumentLifecycle,
  type ResourceVisibility,
} from '@/lib/db/schema'
import type { DocumentScope, DocumentScreeningOutcome } from '@/lib/db/schema/documents'
import {
  auditedQuarantineReasons,
  storedQuarantineVerdictOf,
  type StoredQuarantineVerdict,
} from '@/lib/upload-screening/quarantine'
import { documentVisibleTo, heldAtRest, internalRead, SCREENED_ONLY, type DocumentReader } from './visibility'
import { verdictPasses } from './document-reader'
import { CURRENT_INGEST_READER_VERSION, type IngestFailureCategory, type IngestFailureFacts } from './retry-policy'

/**
 * Hard cap on one page of a document listing (project and Archiv alike).
 * A caller that needs the whole corpus follows `nextCursor`
 * (`listProjectDocumentPage`), it never raises this.
 */
export const DOCUMENT_LIST_LIMIT = 500

/** The column subset the list endpoint serves (metadata is stripped later). */
export interface DocumentListRow {
  id: string
  filename: string
  /**
   * The shelf the row is on (`documentShelf`). Read by the status
   * reconciliation, which announces a settled row on its shelf's live channel;
   * a listing row that did not carry it settled for nobody. Not on the wire.
   */
  projectId: string | null
  scope: DocumentScope
  /** The rename, when there is one; NULL means "show `filename`" (0048). */
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string
  /**
   * Whose hand wrote the bytes (migration 0063).
   *
   * On the LIST row and not only on the full document, because "Von Piloti
   * erstellt" is a line in the Files pane and the pane never loads the full
   * row. Serving it here rather than deriving it from `status === 'stored'` in
   * the UI keeps the two facts separate: `stored` is what happened to the
   * INDEXING, `authoredBy` is who wrote it, and a future producer that does get
   * indexed would make the derivation quietly wrong.
   */
  authoredBy: DocumentAuthor
  /**
   * The version the item's storage columns mirror, or `null` (ADR-0054).
   *
   * On the LIST row because `collectionFileRef` REQUIRES it: a machine-authored
   * row owns chunks only once a version of it has been published, and the two
   * sweeps that address the backend from a list — the status/metadata
   * reconcile and the session-document cleanup — build their refs out of these
   * rows. A row type that cannot answer the question cannot be handed to the
   * constructor at all, which is the same argument `authoredBy` makes one line
   * up.
   */
  publishedVersionId: string | null
  /**
   * Whether the item is in the working set (ADR-0054).
   *
   * On the LIST row because the one surface that asks for archived documents
   * shows them MIXED with the active ones — a listing that could not say which
   * is which would be a pane where „archiviert" is invisible again, one layer
   * further in.
   */
  lifecycle: DocumentLifecycle
  collectionName: string
  folderId: string | null
  /**
   * Where the file came from, when a folder upload recorded one (0071).
   * On the list row because the Files pane shows it in the detail rail without
   * a second fetch — and because "go back to the original" is the one thing a
   * reader wants from it, which is a per-file question.
   */
  originPath: string | null
  /**
   * A digest of the stored bytes (`sha256:<hex>`), or null when unknown.
   *
   * On the LIST row because the folder-upload planner runs in the browser: it
   * compares what the reader just dropped against the corpus it already has on
   * screen, and a second request per candidate file would be a round trip to
   * learn that nothing needs uploading.
   */
  contentHash: string | null
  /**
   * Who uploaded it, and the content gate's verdict. On the LIST row for one
   * reader: a listing reconciles its rows after the query, and a row the
   * reconcile turns `quarantined` must be narrowed again by the same rule the
   * query applied (`keepReadable` in `./document-reader`, ADR-0086). Neither
   * leaves the BFF (`toListedDocuments` drops them).
   */
  createdBy: string
  screeningOutcome: DocumentScreeningOutcome | null
  /** The digest the verdict judged (migration 0123); dropped with the two above. */
  screenedHash: string | null
  createdAt: Date
  updatedAt: Date
  errorMessage: string | null
  metadata: unknown
  /**
   * Why the last read failed, and what read it (migration 0134). On the LIST
   * row for one decision: whether the listing offers the document to „Alle
   * erneut lesen“ (`canRetryRow`, `./retry-policy`), which needs `metadata` and
   * `contentHash` beside them. Turned into `retryable` and dropped before the
   * row leaves the BFF (`toListedDocuments`). Optional because rows built by
   * other selects (and the specs' fixtures) predate them; absent reads as
   * "not recorded", which the rule treats as retryable.
   */
  ingestFailureCategory?: IngestFailureCategory | null
  ingestRetryable?: boolean | null
  ingestReaderVersion?: string | null
  /**
   * Why the content gate held it (migration 0148), as stored. Turned into the
   * reader's verdict by `toListedDocuments` (`quarantineVerdictOf`) and only
   * then served, to whoever the listing's reader rule let see the held row.
   * Optional for the same reason as the three above.
   */
  quarantine?: StoredQuarantineVerdict | null
}

/**
 * `authoredBy` narrows the listing to one hand — the query behind the `Von
 * Piloti` chip (agent-authored documents design, decision 9).
 *
 * A trailing optional parameter rather than an options object, so every existing
 * caller keeps compiling and keeps meaning "both hands". Omitted is not the same
 * as `'user'`: the unfiltered listing is the whole project's estate, which is
 * what the Files pane shows by default.
 *
 * It is a column filter and not a folder filter on purpose. How a report is
 * FILED and how it is FOUND are different questions, and tying the second to the
 * first is what turns a folder convention into a load-bearing one — moving,
 * renaming or abandoning `Berichte` later has to cost nothing. The partial index
 * `documents_agent_authored_idx` (migration 0063) is on
 * `(project_id, created_at DESC) WHERE authored_by = 'agent'`, so the `'agent'`
 * case — the one any surface actually asks for — is a point query in the
 * listing's own sort order.
 */
export interface ListProjectDocumentsOptions {
  limit?: number
  /**
   * Rows to skip before the page — the draft-filing veto's paginated scan.
   * Default 0 (first page, as before); bounded below like `limit` so a
   * negative offset cannot widen the listing.
   */
  offset?: number
  authoredBy?: DocumentAuthor
  /**
   * Show the documents somebody archived as well (ADR-0054).
   *
   * Default false, and that default is the point of the column: „archiviert"
   * is a statement that the file has left the working set, and a file that is
   * still in every listing has not left it. The archive gesture already purges
   * the chunks so the agent stops citing it; the listing was the other half and
   * it was missing, which made the whole act read as a no-op with an audit
   * event.
   *
   * An OPTION rather than a second query, because the surface that shows them
   * (the Files filter's „Archiviert" chip) needs the same projection, the same
   * cap and the same assignment hydration as the default one — a second query
   * would be a second definition of what a document listing is.
   */
  includeArchived?: boolean
  /**
   * Folders whose documents this reader may not see (ADR-0087), from
   * `getHiddenFolderIds`. Their rows are left out as if they did not exist.
   */
  hiddenFolderIds?: readonly string[]
  /**
   * Who reads the listing (ADR-0086), from `shelfReaderFor`: a member sees the
   * screened rows and the held rows they uploaded, a reviewer every row.
   * Required, so no listing can forget the hold.
   */
  reader: DocumentReader
}

/**
 * Rows outside every hidden folder; nothing when none is hidden. Exported for
 * the other queries over `documents` that serve a reader (the project
 * overview), so "hidden" has one SQL spelling.
 */
export function outsideHiddenFolders(hiddenFolderIds: readonly string[] | undefined): SQL[] {
  if (!hiddenFolderIds || hiddenFolderIds.length === 0) return []
  const visible = or(isNull(documents.folderId), notInArray(documents.folderId, [...hiddenFolderIds]))
  return visible ? [visible] : []
}

/**
 * The columns a listing serves — one definition for the project listing, its
 * keyset page and the Archiv's, so the three cannot disagree about what a
 * `DocumentListRow` is.
 */
export const documentListColumns = {
  id: documents.id,
  filename: documents.filename,
  projectId: documents.projectId,
  scope: documents.scope,
  displayName: documents.displayName,
  fileSize: documents.fileSize,
  contentType: documents.contentType,
  status: documents.status,
  authoredBy: documents.authoredBy,
  publishedVersionId: documents.publishedVersionId,
  lifecycle: documents.lifecycle,
  collectionName: documents.collectionName,
  folderId: documents.folderId,
  originPath: documents.originPath,
  contentHash: documents.contentHash,
  createdBy: documents.createdBy,
  screeningOutcome: documents.screeningOutcome,
  screenedHash: documents.screenedHash,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  errorMessage: documents.errorMessage,
  quarantine: documents.quarantine,
  metadata: documents.metadata,
  ingestFailureCategory: documents.ingestFailureCategory,
  ingestRetryable: documents.ingestRetryable,
  ingestReaderVersion: documents.ingestReaderVersion,
}

/**
 * The rows a listing of `shelf` shows — the one definition behind a project's
 * Dateien and the org-wide Archiv (ADR-0078), so the two cannot disagree about
 * what a document listing is. The shelf (`shelfDocumentWhere`) names the scope
 * for both, rather than leaving one of them correct by the accident of a NULL
 * project; `authoredBy` and the lifecycle rule are the same predicates on both.
 */
function listingWhere(
  shelf: DocumentShelf,
  organizationId: string,
  {
    authoredBy,
    includeArchived = false,
    hiddenFolderIds,
    reader,
  }: Pick<ListProjectDocumentsOptions, 'authoredBy' | 'includeArchived' | 'hiddenFolderIds' | 'reader'>,
): SQL | undefined {
  return and(
    shelfDocumentWhere(shelf, organizationId),
    ...(authoredBy ? [eq(documents.authoredBy, authoredBy)] : []),
    ...(includeArchived ? [] : [eq(documents.lifecycle, 'active')]),
    ...outsideHiddenFolders(hiddenFolderIds),
    documentVisibleTo(reader),
  )
}

function boundListLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
}

export async function listProjectDocuments(
  projectId: string,
  organizationId: string,
  { limit = DOCUMENT_LIST_LIMIT, offset = 0, authoredBy, includeArchived = false, hiddenFolderIds, reader }: ListProjectDocumentsOptions,
): Promise<DocumentListRow[]> {
  const boundedLimit = boundListLimit(limit)
  const boundedOffset = Math.max(0, Math.trunc(offset))
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(listingWhere(projectShelf(projectId), organizationId, { authoredBy, includeArchived, hiddenFolderIds, reader }))
      // Newest first, with the id as tiebreak: createdAt ties are real (a
      // batch import lands on one timestamp), and under offset pagination an
      // unstable order drops rows from one page and repeats them on the next.
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(boundedLimit)
      .offset(boundedOffset),
  )
}

/** One page of a keyset listing, and where the next one starts. */
export interface DocumentListPage {
  rows: DocumentListRow[]
  /** The position after the last row, or `null` when this page is the last. */
  nextCursor: DocumentListCursor | null
}

/**
 * Rows strictly after `cursor` in the `created_at DESC, id ASC` order.
 *
 * The comparison is against the cursor's microsecond text, parsed as UTC, so
 * it matches the column exactly — see `list-cursor.ts` for why a `Date` would
 * not.
 */
export function afterDocumentListCursor(cursor: DocumentListCursor): SQL {
  const at = sql`(${cursor.createdAt}::timestamp AT TIME ZONE 'UTC')`
  return sql`(${documents.createdAt} < ${at} OR (${documents.createdAt} = ${at} AND ${documents.id} > ${cursor.id}::uuid))`
}

/**
 * Fetch one page of `limit + 1` rows and split off the probe row.
 *
 * The extra row is how "is there more" is answered without a COUNT: a page
 * that came back full is not proof of a next one, and a client that asked
 * again only to receive nothing would pay a round trip to learn it.
 */
export async function readDocumentListPage(
  query: (probeLimit: number) => Promise<Array<DocumentListRow & { cursorCreatedAt: string }>>,
  limit: number,
): Promise<DocumentListPage> {
  const bounded = boundListLimit(limit)
  const fetched = await query(bounded + 1)
  const hasMore = fetched.length > bounded
  const page = hasMore ? fetched.slice(0, bounded) : fetched
  const rows = page.map(({ cursorCreatedAt: _cursor, ...row }) => ({
    ...row,
    // Coerced at the boundary: a raw driver can hand the timestamp back as text.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }))
  const last = page.at(-1)
  return {
    rows,
    nextCursor: hasMore && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
  }
}

/** The microsecond UTC text of `created_at`, which a cursor is built from. */
export const cursorCreatedAtColumn = sql<string>`to_char(${documents.createdAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`

/**
 * One keyset page of a shelf's documents — the listing the Files pane drains,
 * page after page, so no document past the first `DOCUMENT_LIST_LIMIT` falls
 * off it. A project's Dateien and the org-wide Archiv are this one query
 * (ADR-0078): same columns, same order, same lifecycle and author filters.
 *
 * Each query stays bounded; completeness comes from following `nextCursor`,
 * never from a larger limit.
 */
export async function listDocumentPage(
  shelf: DocumentShelf,
  organizationId: string,
  {
    limit = DOCUMENT_LIST_LIMIT,
    cursor,
    authoredBy,
    includeArchived = false,
    hiddenFolderIds,
    reader,
  }: Omit<ListProjectDocumentsOptions, 'offset'> & { cursor?: DocumentListCursor },
): Promise<DocumentListPage> {
  const db = getDb()
  return readDocumentListPage(
    (probeLimit) =>
      withTenant({ organizationId }, () =>
        db
          .select({ ...documentListColumns, cursorCreatedAt: cursorCreatedAtColumn })
          .from(documents)
          .where(
            and(
              listingWhere(shelf, organizationId, { authoredBy, includeArchived, hiddenFolderIds, reader }),
              ...(cursor ? [afterDocumentListCursor(cursor)] : []),
            ),
          )
          .orderBy(desc(documents.createdAt), asc(documents.id))
          .limit(probeLimit),
      ),
    limit,
  )
}

/** One keyset page of a project's documents — see {@link listDocumentPage}. */
export function listProjectDocumentPage(
  projectId: string,
  organizationId: string,
  options: Omit<ListProjectDocumentsOptions, 'offset'> & { cursor?: DocumentListCursor },
): Promise<DocumentListPage> {
  return listDocumentPage(projectShelf(projectId), organizationId, options)
}

// --- A folder level, page by page (ADR-0102) ---------------------------------

/** The filters every read of a shelf shares: what the listing's own WHERE takes. */
export type ShelfReadFilters = Pick<ListProjectDocumentsOptions, 'authoredBy' | 'includeArchived' | 'hiddenFolderIds' | 'reader'>

/** One page of a level read, and where the next one starts. */
export interface DocumentLevelPage {
  rows: DocumentListRow[]
  /** The position after the last row, or `null` when this page is the last. */
  nextCursor: DocumentLevelCursor | null
}

/**
 * The sort key of a level order, as SQL. The cursor's value is read off the
 * row by the same expression ({@link levelCursorValueColumn}) and compared
 * against it ({@link afterDocumentLevelCursor}), so the three cannot disagree
 * about where a row sits: a name case-folded by JavaScript and one case-folded
 * by Postgres need not be the same string.
 */
function levelSortKey(sort: DocumentLevelSort): SQL {
  switch (sort) {
    case 'added':
      return sql`${documents.createdAt}`
    case 'name':
      return sql`lower(coalesce(${documents.displayName}, ${documents.filename}))`
    case 'size':
      // An unknown size sorts as the smallest, never as NULL: a NULL key would
      // need its own arm in every cursor comparison.
      return sql`coalesce(${documents.fileSize}, -1)`
  }
}

/** The sort key as text, for the cursor; `added` at microsecond precision in UTC, like the listing cursor. */
function levelCursorValueColumn(sort: DocumentLevelSort): SQL<string> {
  switch (sort) {
    case 'added':
      return cursorCreatedAtColumn
    case 'name':
      return sql<string>`lower(coalesce(${documents.displayName}, ${documents.filename}))`
    case 'size':
      return sql<string>`coalesce(${documents.fileSize}, -1)::text`
  }
}

/** The cursor's text back as a value of the key's own type. */
function levelCursorBound(cursor: DocumentLevelCursor): SQL {
  switch (cursor.sort) {
    case 'added':
      return sql`(${cursor.value}::timestamp AT TIME ZONE 'UTC')`
    case 'name':
      return sql`${cursor.value}::text`
    case 'size':
      return sql`${cursor.value}::integer`
  }
}

/**
 * Rows strictly after `cursor` in its order: past the key in the cursor's
 * direction, or on the same key with a greater id. The id breaks ties
 * ascending in both directions, so `added DESC` is the drain's own
 * `created_at DESC, id ASC` and the listing index serves it as it stands.
 */
export function afterDocumentLevelCursor(cursor: DocumentLevelCursor): SQL {
  const key = levelSortKey(cursor.sort)
  const bound = levelCursorBound(cursor)
  const past = cursor.dir === 'asc' ? sql`${key} > ${bound}` : sql`${key} < ${bound}`
  return sql`(${past} OR (${key} = ${bound} AND ${documents.id} > ${cursor.id}::uuid))`
}

/**
 * Documents whose file name or rename contains `q`, case-insensitively, in
 * either Unicode form (a name off a Mac is decomposed). `strpos` and not
 * `LIKE`, so a `%` or `_` in what the reader typed is a character, not a
 * wildcard. Nothing for an empty query.
 */
export function nameContains(q: string | undefined): SQL | undefined {
  const needle = q?.trim() ?? ''
  if (needle === '') return undefined
  const variants = [...new Set([needle.normalize('NFC'), needle.normalize('NFD')])]
  return or(
    ...variants.flatMap((variant) => [
      sql`strpos(lower(${documents.filename}), lower(${variant})) > 0`,
      sql`strpos(lower(coalesce(${documents.displayName}, '')), lower(${variant})) > 0`,
    ]),
  )
}

/**
 * Documents in one of `states`, by the family their status belongs to
 * (`documentReadFamily`). `reading` is every status no other family declares,
 * the unknown ones included, exactly as the browser reads them. Nothing when
 * every family, or none, is asked for.
 */
export function readFamilyWhere(states: readonly DocumentReadFamily[] | undefined): SQL | undefined {
  const wanted = [...new Set(states ?? [])]
  if (wanted.length === 0 || wanted.length === DOCUMENT_READ_FAMILIES.length) return undefined
  const lowered = sql`lower(${documents.status})`
  const declaredElsewhere = DOCUMENT_READ_FAMILIES.filter((family) => family !== 'reading').flatMap(declaredStatusesIn)
  return or(
    ...wanted.map((family) =>
      family === 'reading' ? notInArray(lowered, declaredElsewhere) : inArray(lowered, declaredStatusesIn(family)),
    ),
  )
}

/** The level's own predicates: its folder, the name search, the families, the cursor. */
function levelWhere({ folderId, q, states, cursor }: DocumentLevelQuery): SQL[] {
  const where: SQL[] = []
  if (folderId !== undefined) where.push(folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId))
  const named = nameContains(q)
  if (named) where.push(named)
  const family = readFamilyWhere(states)
  if (family) where.push(family)
  if (cursor) where.push(afterDocumentLevelCursor(cursor))
  return where
}

/**
 * Split `limit + 1` fetched rows into the page and its next cursor (the probe
 * row answers "is there more" without a COUNT), coercing at the boundary.
 */
export function readDocumentLevelPage(
  fetched: Array<DocumentListRow & { cursorValue: string }>,
  level: Pick<DocumentLevelQuery, 'sort' | 'dir'>,
  limit: number,
): DocumentLevelPage {
  const bounded = boundListLimit(limit)
  const hasMore = fetched.length > bounded
  const page = hasMore ? fetched.slice(0, bounded) : fetched
  const rows = page.map(({ cursorValue: _cursor, ...row }) => ({
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }))
  const last = page.at(-1)
  return {
    rows,
    nextCursor:
      hasMore && last ? { sort: level.sort, dir: level.dir, value: String(last.cursorValue), id: last.id } : null,
  }
}

/**
 * One page of a folder LEVEL of a shelf, in the order the reader chose — what
 * the Files workspace reads instead of draining the shelf (ADR-0102). The
 * shelf, lifecycle, author, hidden-folder and hold predicates are the
 * listing's own (`listingWhere`); the level adds its folder, the name search,
 * the read-state families and the cursor.
 *
 * Bounded like every listing: `limit` is clamped to {@link DOCUMENT_LIST_LIMIT}
 * and one probe row says whether there is more. The composite indexes of
 * migration 0132 serve `added`; `name` and `size` sort the level's rows, which
 * the same indexes narrow to the folder first.
 */
export async function listDocumentLevelPage(
  shelf: DocumentShelf,
  organizationId: string,
  { level, ...filters }: ShelfReadFilters & { level: DocumentLevelQuery },
): Promise<DocumentLevelPage> {
  const db = getDb()
  const bounded = boundListLimit(level.limit)
  const key = levelSortKey(level.sort)
  const fetched = await withTenant({ organizationId }, () =>
    db
      .select({ ...documentListColumns, cursorValue: levelCursorValueColumn(level.sort) })
      .from(documents)
      .where(and(listingWhere(shelf, organizationId, filters), ...levelWhere(level)))
      .orderBy(level.dir === 'asc' ? asc(key) : desc(key), asc(documents.id))
      .limit(bounded + 1),
  )
  return readDocumentLevelPage(fetched, level, bounded)
}

/**
 * One document of a shelf as a listing row, for a deep link to a document the
 * paged level has not loaded (`GET /api/documents/[id]`, ADR-0102). Archived
 * documents are found when `includeArchived` says so; the hold and the
 * hidden-folder rule are the listing's.
 */
export async function findShelfDocumentListRow(
  shelf: DocumentShelf,
  organizationId: string,
  documentId: string,
  filters: ShelfReadFilters,
): Promise<DocumentListRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(and(eq(documents.id, documentId), listingWhere(shelf, organizationId, filters)))
      .limit(1),
  )
  return row ?? null
}

// --- What Postgres can say about a whole shelf (ADR-0102) --------------------

/** `count(*)` of the rows in one read-state family, by the status vocabulary's own declaration. */
function familyCount(family: Exclude<DocumentReadFamily, 'reading'>): SQL<number> {
  return sql<number>`count(*) FILTER (WHERE ${inArray(sql`lower(${documents.status})`, declaredStatusesIn(family))})`
}

/** The ISO-8601 the browser compares `createdAt` with (`Date#toISOString`). */
const ISO_MILLISECOND_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'

/**
 * Per folder of a shelf (`null` is the root), the documents filed directly in
 * it, counted by read-state family, and the newest one's `created_at`: the
 * folder tiles and the folder brief, folded up the tree by the browser
 * (`foldTallies`). One aggregate over the listing's own WHERE, so it counts
 * exactly the rows a listing would show this reader, and no backend call:
 * the status is the stored one (rows still `pending` in Postgres are
 * reconciled by the upload sweep, or when a page holding them is read).
 *
 * Bounded by the number of folders ({@link SHELF_SUMMARY_FOLDER_LIMIT}). The
 * reading family is what is left of the total, so a status nobody declared is
 * counted as being read, as the browser counts it.
 */
export async function summarizeShelfFolders(
  shelf: DocumentShelf,
  organizationId: string,
  filters: ShelfReadFilters,
): Promise<ShelfFolderTally[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        folderId: documents.folderId,
        total: sql<number>`count(*)`,
        readable: familyCount('readable'),
        failed: familyCount('failed'),
        held: familyCount('held'),
        unindexed: familyCount('unindexed'),
        latest: sql<string | null>`to_char(max(${documents.createdAt}) AT TIME ZONE 'UTC', ${ISO_MILLISECOND_FORMAT})`,
      })
      .from(documents)
      .where(listingWhere(shelf, organizationId, filters))
      .groupBy(documents.folderId)
      .limit(SHELF_SUMMARY_FOLDER_LIMIT),
  )
  // Coerced at the boundary: `count(*)` is a bigint, which the driver hands back as text.
  return rows.map((row) => {
    const total = Number(row.total)
    const readable = Number(row.readable)
    const failed = Number(row.failed)
    const held = Number(row.held)
    const unindexed = Number(row.unindexed)
    return {
      folderId: row.folderId,
      total,
      readable,
      reading: Math.max(0, total - readable - failed - held - unindexed),
      failed,
      held,
      unindexed,
      latest: row.latest === null ? null : String(row.latest),
    }
  })
}

/**
 * The failed documents of a shelf, newest first, at most
 * {@link SHELF_SUMMARY_FAILED_LIMIT}: what „Alle erneut lesen“ sends back
 * through ingestion. One probe row past the limit says whether it was cut.
 *
 * Only the ones reading again may change ({@link retryAllowedSql}): a file that
 * failed for a lasting reason is counted in the tally and not sent back, so the
 * button counts what it will send.
 */
export async function listShelfFailedDocuments(
  shelf: DocumentShelf,
  organizationId: string,
  filters: ShelfReadFilters,
): Promise<Pick<ShelfSummary, 'failed' | 'failedTruncated'>> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id, folderId: documents.folderId })
      .from(documents)
      .where(
        and(
          listingWhere(shelf, organizationId, filters),
          inArray(sql`lower(${documents.status})`, declaredStatusesIn('failed')),
          retryAllowedSql(),
        ),
      )
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(SHELF_SUMMARY_FAILED_LIMIT + 1),
  )
  return {
    failed: rows.slice(0, SHELF_SUMMARY_FAILED_LIMIT).map((row) => ({ id: row.id, folderId: row.folderId })),
    failedTruncated: rows.length > SHELF_SUMMARY_FAILED_LIMIT,
  }
}

/**
 * Rows whose filename is one of `filenames` — in either Unicode form, and
 * case-insensitively, because every reader of the answer (the citation
 * resolver, the surfaced-documents index, the search join) compares names the
 * way a person does, and a model that spelled `Grundriss.PDF` still means the
 * row called `grundriss.pdf`. The exact list keeps the filename index in play
 * for the common spelling; the folded one catches the rest.
 *
 * At most {@link FILENAME_LOOKUP_MAX_NAMES} names; `undefined` for none, which
 * the callers turn into "ask nothing".
 */
export function filenameLookupWhere(filenames: readonly string[]): SQL | undefined {
  const bounded = [...new Set(filenames.map(documentNameKey).filter((name) => name.length > 0))].slice(
    0,
    FILENAME_LOOKUP_MAX_NAMES,
  )
  if (bounded.length === 0) return undefined
  const exact = [...new Set(bounded.flatMap(documentNameVariants))]
  const folded = [...new Set(bounded.flatMap((name) => documentNameVariants(documentAliasKey(name))))]
  return or(inArray(documents.filename, exact), inArray(sql`lower(${documents.filename})`, folded))
}

/**
 * The documents of a shelf named `filenames` — the rows a listing would show
 * (same shelf, same lifecycle rule), found by name rather than by paging.
 *
 * For the readers that need SPECIFIC documents: the semantic search's join and
 * the by-name resolve behind citations and surfaced-document cards. Reading the
 * first listing page for them dropped every hit past the newest 500 as if it
 * did not exist. Bounded by its input and by `DOCUMENT_LIST_LIMIT`.
 *
 * Folders do not enter into it: a document is unique per filename per
 * collection, so a name finds it wherever it is filed.
 */
export async function findDocumentsByFilenames(
  shelf: DocumentShelf,
  organizationId: string,
  filenames: readonly string[],
  {
    includeArchived = false,
    hiddenFolderIds,
    reader,
  }: Pick<ListProjectDocumentsOptions, 'includeArchived' | 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentListRow[]> {
  const byName = filenameLookupWhere(filenames)
  if (!byName) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(and(listingWhere(shelf, organizationId, { includeArchived, hiddenFolderIds, reader }), byName))
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(DOCUMENT_LIST_LIMIT),
  )
}

/** The project documents named `filenames` — see {@link findDocumentsByFilenames}. */
export function findProjectDocumentsByFilenames(
  projectId: string,
  organizationId: string,
  filenames: readonly string[],
  options: Pick<ListProjectDocumentsOptions, 'includeArchived' | 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentListRow[]> {
  return findDocumentsByFilenames(projectShelf(projectId), organizationId, filenames, options)
}

/** A document a Fassung link may point to, as the resolution needs it. */
export interface RevisionCounterpartRow {
  id: string
  filename: string
  projectId: string | null
  folderId: string | null
  createdAt: Date | null
}

/**
 * The documents of ONE collection named `filenames` that `reader` may see, for
 * resolving a Fassung link's file names to documents (`revision-links-loader.ts`).
 *
 * The link is stored by file name in the backend's index, which knows nothing
 * of who may read what, so this is where a name becomes a document or stays a
 * string nobody sees: held rows (`documentVisibleTo`, ADR-0086) and archived
 * ones are not found. The folder rule (ADR-0087) is the caller's, from the
 * project it reads each row's `projectId` for; a row's folder is returned for
 * exactly that. Person-uploaded rows only: a machine-authored row owns no
 * chunks of its own, so no link of the index can name it.
 *
 * Every name is looked up, in queries of at most {@link FILENAME_LOOKUP_MAX_NAMES}
 * names each: a page of a few hundred documents references more names than one
 * query carries, and a name left out was a link silently lost (the older
 * Fassung shown as current, the count wrong).
 */
export async function findRevisionCounterparts(
  organizationId: string,
  collectionName: string,
  filenames: readonly string[],
  reader: DocumentReader,
): Promise<RevisionCounterpartRow[]> {
  const unique = [...new Set(filenames)]
  const byId = new Map<string, RevisionCounterpartRow>()
  for (let start = 0; start < unique.length; start += FILENAME_LOOKUP_MAX_NAMES) {
    const chunk = unique.slice(start, start + FILENAME_LOOKUP_MAX_NAMES)
    for (const row of await findRevisionCounterpartChunk(organizationId, collectionName, chunk, reader)) byId.set(row.id, row)
  }
  return [...byId.values()]
}

/** One bounded query of {@link findRevisionCounterparts}: at most {@link FILENAME_LOOKUP_MAX_NAMES} names. */
async function findRevisionCounterpartChunk(
  organizationId: string,
  collectionName: string,
  filenames: readonly string[],
  reader: DocumentReader,
): Promise<RevisionCounterpartRow[]> {
  const variants = [...new Set(filenames.flatMap(documentNameVariants))]
  if (variants.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        projectId: documents.projectId,
        folderId: documents.folderId,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.collectionName, collectionName),
          inArray(documents.filename, variants),
          eq(documents.authoredBy, 'user'),
          eq(documents.lifecycle, 'active'),
          documentVisibleTo(reader),
        ),
      )
      .orderBy(asc(documents.id))
      .limit(DOCUMENT_LIST_LIMIT),
  )
}

/** One row of a name probe (`name-probe-types.ts` is its wire shape). */
export interface DocumentNameMatchRow {
  id: string
  filename: string
  displayName: string | null
  fileSize: number | null
  contentHash: string | null
  status: string
  folderId: string | null
  authoredBy: DocumentAuthor
  lifecycle: DocumentLifecycle
}

export const documentNameMatchColumns = {
  id: documents.id,
  filename: documents.filename,
  displayName: documents.displayName,
  fileSize: documents.fileSize,
  contentHash: documents.contentHash,
  status: documents.status,
  folderId: documents.folderId,
  authoredBy: documents.authoredBy,
  lifecycle: documents.lifecycle,
}

/** Names per probe query; a longer probe runs several bounded queries. */
const NAME_PROBE_CHUNK = 500
/** Rows per probe query: one identity match per name plus room for aliases. */
const NAME_PROBE_ROW_LIMIT = NAME_PROBE_CHUNK * 4

/**
 * The rows answering to any of `names`, as the upload planner compares them:
 * the filename in either Unicode form (IDENTITY — what the upload replaces),
 * or the filename or rename case-folded (RECOGNITION — the planner's
 * `duplicate`). See `name-match.ts` for the two keys.
 *
 * Person-uploaded rows only, and every lifecycle: exactly the rows
 * `findLiveDocumentByFilename` would version, so the plan cannot promise „Neu"
 * for a file the server is about to put on an archived document.
 */
function nameProbeWhere(names: readonly string[]): SQL | undefined {
  const exact = [...new Set(names.flatMap(documentNameVariants))]
  const folded = [...new Set(names.flatMap((name) => documentNameVariants(documentAliasKey(name))))]
  return and(
    eq(documents.authoredBy, 'user'),
    or(
      inArray(documents.filename, exact),
      inArray(sql`lower(${documents.filename})`, folded),
      inArray(sql`lower(${documents.displayName})`, folded),
    ),
  )
}

/**
 * Run a name probe in bounded chunks and merge the answers (a document can
 * answer to names in two chunks; it is returned once).
 */
export async function probeDocumentNames(
  names: readonly string[],
  query: (where: SQL | undefined, limit: number) => Promise<DocumentNameMatchRow[]>,
): Promise<DocumentNameMatchRow[]> {
  const byId = new Map<string, DocumentNameMatchRow>()
  const unique = [...new Set(names)]
  for (let start = 0; start < unique.length; start += NAME_PROBE_CHUNK) {
    const rows = await query(nameProbeWhere(unique.slice(start, start + NAME_PROBE_CHUNK)), NAME_PROBE_ROW_LIMIT)
    for (const row of rows) byId.set(row.id, row)
  }
  return [...byId.values()]
}

/** The documents of a shelf answering to any of `names` — see {@link nameProbeWhere}. */
export async function findDocumentsByNames(
  shelf: DocumentShelf,
  organizationId: string,
  names: readonly string[],
  { hiddenFolderIds, reader }: Pick<ListProjectDocumentsOptions, 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentNameMatchRow[]> {
  const db = getDb()
  return probeDocumentNames(names, (where, limit) =>
    withTenant({ organizationId }, () =>
      db
        .select(documentNameMatchColumns)
        .from(documents)
        .where(
          and(
            shelfDocumentWhere(shelf, organizationId),
            ...outsideHiddenFolders(hiddenFolderIds),
            // The probe answers with the digest: somebody else's unscreened
            // file would let a member confirm its contents by hash (ADR-0086).
            documentVisibleTo(reader),
            where,
          ),
        )
        .orderBy(desc(documents.createdAt), asc(documents.id))
        .limit(limit),
    ),
  )
}

/** The project documents answering to any of `names` — see {@link nameProbeWhere}. */
export function findProjectDocumentsByNames(
  projectId: string,
  organizationId: string,
  names: readonly string[],
  options: Pick<ListProjectDocumentsOptions, 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentNameMatchRow[]> {
  return findDocumentsByNames(projectShelf(projectId), organizationId, names, options)
}

/**
 * Tenancy probe for authorization — unscoped, like `findConversationTenancy`.
 * The caller decides whether an organization mismatch is a 404.
 *
 * Screened rows only (ADR-0086): this is the sharing registry's probe, and a
 * held file is shared, assigned or named in an inbox row by nobody, its
 * uploader and reviewers included, until its screening passes. Sharing it
 * would hand it to people the hold exists to keep it from.
 */
export async function findDocumentTenancy(
  documentId: string,
): Promise<Pick<
  Document,
  'organizationId' | 'projectId' | 'folderId' | 'visibility' | 'createdBy' | 'filename' | 'displayName'
> | null> {
  const db = getDb()
  const [row] = await db
    .select({
      organizationId: documents.organizationId,
      projectId: documents.projectId,
      folderId: documents.folderId,
      visibility: documents.visibility,
      createdBy: documents.createdBy,
      filename: documents.filename,
      displayName: documents.displayName,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), documentVisibleTo(SCREENED_ONLY)))
    .limit(1)
  return row ?? null
}

export async function updateDocumentVisibilityInOrg(
  documentId: string,
  organizationId: string,
  visibility: ResourceVisibility,
  /** A transaction the caller holds, already in this organization's context. */
  executor?: DbExecutor,
): Promise<Document | null> {
  const write = (handle: DbExecutor) =>
    handle
      .update(documents)
      .set({ visibility, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
      .returning()
  const [row] = executor ? await write(executor) : await withTenant({ organizationId }, () => write(getDb()))
  return row ?? null
}

/**
 * Every document id of a project, held ones included: the project-member
 * cleanup removes a leaver's grants on all of them (allowlisted in
 * `document-visibility.spec.ts`).
 */
export async function listDocumentIdsForProject(
  projectId: string,
  organizationId: string,
  limit = 5_000,
): Promise<string[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId)))
      .limit(limit),
  )
  return rows.map((row) => row.id)
}

/** The statuses a read ended in failure at — the `failed` family of `DOCUMENT_STATUS_FACTS`. */
const READ_FAILED_STATUSES = ['failed'] as const

/**
 * The project's active documents whose read FAILED and that a model may name:
 * screened ones only (ADR-0086, {@link SCREENED_ONLY}) and none in a folder the
 * caller hides (ADR-0087). Newest first, bounded by `limit`.
 *
 * Read for the agent's `documents_unreadable:` block. Without it a file Piloti
 * could not read was indistinguishable from one that does not exist: it has no
 * summary row, so neither the inventory nor any tool lists it, and an answer
 * called it missing.
 */
export async function listUnreadableProjectDocuments(
  projectId: string,
  organizationId: string,
  hiddenFolderIds: readonly string[],
  limit: number,
): Promise<{ filename: string; displayName: string | null; folderId: string | null }[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({ filename: documents.filename, displayName: documents.displayName, folderId: documents.folderId })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.organizationId, organizationId),
          eq(documents.lifecycle, 'active'),
          inArray(documents.status, [...READ_FAILED_STATUSES]),
          ...outsideHiddenFolders(hiddenFolderIds),
          documentVisibleTo(SCREENED_ONLY),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit),
  )
}

/**
 * Which of `ids` exist, held ones included: the orphan sweep deletes the grants
 * of a document that is gone, and a held document is not gone (allowlisted in
 * `document-visibility.spec.ts`).
 */
export async function documentIdsExisting(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const db = getDb()
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.id, [...ids]))
  return new Set(rows.map((row) => row.id))
}

/**
 * Load a document by id scoped to an organization, as `reader` may see it: a
 * held row (ADR-0086) is `null` for a reader who may not see it, exactly as an
 * unknown id is. A session's item paths go through `findDocumentForSession`
 * (`./access`), which asks the reviewer rule for the rest.
 */
export async function findDocumentInOrg(
  documentId: string,
  organizationId: string,
  reader: DocumentReader,
): Promise<Document | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), documentVisibleTo(reader)),
      )
      .limit(1),
  )
  return row ?? null
}

/**
 * The document a given reference already filed, if it filed one.
 *
 * The idempotency probe behind `fileGeneratedDocument`. A report is fetched
 * every time its tab is opened, so without this a multi-minute run's single
 * artifact would appear once per re-read — and a duplicate of a report is
 * indistinguishable from a second run's, which is precisely the thing an
 * office cannot untangle later.
 *
 * `authored_by_ref` is the key because it is the one identifier the producer
 * and the row already share — a backend job id for a research run, the answer
 * an artifact was drawn in for a diagram (migration 0066, which renamed the
 * column off the first of those two after it had stopped being the only one).
 * Scoped by organization like every other read here, so a reference guessed from
 * another tenant finds nothing.
 *
 * `authored_by_ref_kind` is deliberately NOT filtered on, and the index does not
 * carry it either. The kind is a function of the producer — the filing path
 * derives one from the other — and the producer is already in the key, so asking
 * for it as well would be a column in the index that this probe does not filter
 * by, which is the index-wider-than-the-probe failure 0064 names.
 *
 * Scoped by PRODUCER since migration 0065, because a run can owe more than one
 * FILE. A diagram is two artifacts that are not substitutes — an SVG that
 * previews and carries its own source, and a PDF that is what gets attached to
 * an Einreichung — and under 0064's key the second call found the first row and
 * answered "already filed", so a diagram could be one or the other and never
 * both. The producer is the right discriminator because that is what a producer
 * has meant since 0063: a KIND OF DELIVERABLE, not a piece of software. A run
 * owes at most one of each kind, which is the rule 0065's index states. The
 * alternative — two synthetic run ids, `{run}:svg` and `{run}:pdf` — needed no
 * migration and was rejected: the column exists so somebody can later ask what
 * wrote a file and in which run, and a key that joins back to no real run is
 * what the schema calls "an audit trail in appearance only".
 *
 * This is the CHEAP half of "once per run", never the guarantee. A lookup cannot
 * see a concurrent caller that has not inserted yet: two report tabs both probe,
 * both miss, and both file. Migration 0065's partial unique index
 * `uniq_documents_authored_ref_producer_per_project` is the half that holds under
 * concurrency, and it is keyed on exactly the four columns this function filters
 * by — `(organization_id, project_id, authored_by_ref, authored_by_producer)`
 * WHERE `authored_by <> 'user'`. THAT AGREEMENT IS LOAD-BEARING IN BOTH DIRECTIONS: a
 * narrower index rejects rows this probe would accept (and the caller's recovery
 * finds no winner to return), a wider one admits duplicates this probe was meant
 * to prevent. Changing the columns here means changing the index in the same
 * commit.
 *
 * Scoped by PROJECT as well, and that is not symmetry for its own sake. The
 * filing target comes from the report request's own `projectId`, so an
 * org-wide probe answered "already filed" for a run whose report went to a
 * DIFFERENT project — handing back the other project's document id and folder,
 * so the second project silently never received the report and the client's
 * Öffnen/Zuweisen actions pointed somewhere the reader may not even be. The
 * probe has to ask the question the caller is actually asking: has this run
 * filed into THIS project.
 */
export async function findDocumentAuthoredByRef(
  ref: string,
  organizationId: string,
  projectId: string,
  producer: string,
): Promise<Pick<Document, 'id' | 'filename' | 'folderId'> | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        folderId: documents.folderId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.authoredByRef, ref),
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.authoredByProducer, producer),
          // The index's own predicate, restated. 0064 argues the probe and the
          // index must be the same clause, and until now that agreement held
          // over the KEY COLUMNS only: the index is partial on
          // `authored_by <> 'user'` and the probe filtered on all four columns
          // and no authorship at all — so the probe was WIDER than the rule the
          // index enforces, which is the direction 0064 names as dangerous.
          //
          // What that admits is not hypothetical: 0063's CHECK is one-
          // directional on purpose, so a `user` row MAY carry a producer and a
          // reference (a person saving an artefact a run showed them), and the
          // index is partial precisely so two colleagues doing that do not
          // collide. Such a row would answer this probe. The caller would be
          // told `alreadyFiled` and handed a HUMAN document's id, filename and
          // folder: the report is never filed, and the banner's „Im Projekt
          // öffnen" opens somebody else's upload.
          ne(documents.authoredBy, 'user'),
          // Every row, held or not: the unique index this probe mirrors sees
          // them all, and a published report the gate quarantined is still filed.
          documentVisibleTo(internalRead('identity')),
        ),
      )
      .limit(1),
  )
  return rows[0] ?? null
}

/**
 * Resolve a document's SeaweedFS storage key from its `(collectionName,
 * filename)` pair — the only identity the Python backend carries. Used by the
 * internal document-file lookup (`/api/internal/document-file`), which is
 * service-token guarded, so tenancy relies on the collection name itself
 * (`proj_<uuid>` / `archiv_<orgId>` are unguessable). When the caller can
 * supply one, `organizationId` narrows the row to that org (belt-and-braces
 * for `archiv_` collections); when omitted the lookup stays collection-only.
 * Soft-deleted rows are never returned, and when a filename is re-uploaded
 * into the same collection, the most-recent row wins.
 *
 * ## Machine-authored rows are never resolved here, and that is the invariant
 *
 * `authored_by = 'user'` is not belt-and-braces. This is the second path by
 * which a document's BYTES reach the agent tier, and until it was added it was
 * the open one.
 *
 * The design's safety argument is that a document Piloti wrote is never
 * retrievable by Piloti, enforced by never creating chunks for it —
 * `dispatchDocument` refuses a non-`user` row, and `fileGeneratedDocument`
 * notes that "the safety comes from the dispatch that does not happen, never
 * from this string" about the project collection name it writes. This function
 * is what made that string load-bearing after all: it resolves any
 * `(collection, filename)` pair, and `look` in the knowledge
 * layer calls the internal route with a file name and collection the MODEL
 * supplies, fetches the object, renders a page with pdfium and hands it back
 * as "the actual page the retrieved chunk describes".
 *
 * Two changes turned that from theory into a path. Filing the report as a PDF
 * made it a format that tool renders — a `.docx` was excluded by extension and
 * unrenderable by pdfium — and `generatedFilename` is deterministic
 * (`slug(title)-YYYY-MM-DD.pdf`) from a title that IS the H1 the writer agent
 * wrote. So the model does not have to guess the name of its own filed report;
 * it derived it.
 *
 * Chunk-free was only ever half of "unrepresentable". This is the other half,
 * and it is enforced the same way the dispatcher is: by reading the row, not by
 * trusting the caller.
 */
/**
 * The live document a re-upload of this filename would collide with, if any.
 *
 * A RE-UPLOAD USED TO LEAVE A GHOST. `uploadDocument` minted a fresh id and
 * inserted unconditionally — there is no unique index on (collection, filename)
 * — while the ingest pipeline's `_replace_previous_versions` deletes chunks by
 * filename. So the SECOND upload's chunks replaced the FIRST's, and the first
 * row survived: listed, downloadable, cited by nothing, findable by nothing,
 * and charged to the organization's quota twice.
 *
 * Scoped to one collection — a project's, the Archiv's or a conversation's,
 * all three shelves replace the same way. The comparison is exact, matching `_replace_previous_versions`'
 * own identity rule ("a NEW name is a new document, even when its content
 * supersedes an old one") — a looser match here would let this tier and that
 * one disagree about what the same file is.
 *
 * Only rows a PERSON uploaded. A machine-authored row (`fileGeneratedDocument`)
 * carries a filename the model chose and owns no chunks, so a person dropping a
 * file of the same name is not correcting Piloti's report — and pointing the
 * agent's row at their bytes would leave a human file wearing the agent's
 * authorship. The two coexist; only human uploads replace human uploads.
 *
 * `uniq_documents_live_name_per_collection` (migration 0074, restated by 0077
 * without the never-written `deleted_at`) is this probe's WHERE clause as a
 * constraint, so a concurrent first upload of one name cannot
 * slip past it and recreate the ghost this exists to stop.
 */
export async function findLiveDocumentByFilename(
  organizationId: string,
  collectionName: string,
  filename: string,
): Promise<{
  id: string
  storageKey: string
  storageBucket: string | null
  fileSize: number | null
  contentHash: string | null
  folderId: string | null
  status: string
  authoredBy: DocumentAuthor
  screeningOutcome: DocumentScreeningOutcome | null
  screenedHash: string | null
  createdBy: string
  scope: Document['scope']
  projectId: string | null
} | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        storageBucket: documents.storageBucket,
        fileSize: documents.fileSize,
        contentHash: documents.contentHash,
        folderId: documents.folderId,
        // What `assertMayReplaceHeld` needs to answer a held row (ADR-0086).
        status: documents.status,
        authoredBy: documents.authoredBy,
        screeningOutcome: documents.screeningOutcome,
        screenedHash: documents.screenedHash,
        createdBy: documents.createdBy,
        scope: documents.scope,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.collectionName, collectionName),
          /*
           * Either Unicode form of the name, not just the one the caller holds.
           *
           * A name off a Mac is decomposed and the same name typed here is
           * composed; they render identically, and `= $1` matches one of them.
           * Rows written since `documentNameKey` reached the upload path are all
           * composed, but the ones written before it are whatever arrived — and
           * a miss here is not a null result, it is a SECOND document under a
           * name a person cannot tell apart from the first.
           *
           * Two exact candidates rather than `normalize(filename, NFC) = $1`,
           * which no index can serve.
           */
          inArray(documents.filename, documentNameVariants(filename)),
          eq(documents.authoredBy, 'user'),
          // Every row, held or not: the unique index refuses a second live
          // name whoever holds the first, and the caller answers a held row
          // its uploader may not see as a taken name (ADR-0086).
          documentVisibleTo(internalRead('identity')),
        ),
      )
      // Newest wins if history already left more than one — this function is
      // also how that history stops growing.
      .orderBy(desc(documents.createdAt))
      .limit(1),
  )
  return row ?? null
}

/**
 * The retrieval collections of this project that already hold a live,
 * person-uploaded document of this name — either Unicode form, as
 * {@link findLiveDocumentByFilename} reads it. A project keeps one document
 * per name across all its collections (ADR-0087); the database only enforces
 * it per collection.
 */
export async function findProjectCollectionsHoldingFilename(
  organizationId: string,
  projectId: string,
  filename: string,
): Promise<string[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .selectDistinct({ collectionName: documents.collectionName })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.scope, 'project'),
          inArray(documents.filename, documentNameVariants(filename)),
          eq(documents.authoredBy, 'user'),
          // A held file takes its name too; the upload refuses it without
          // saying whose, as it does a hidden folder's (ADR-0086, ADR-0087).
          documentVisibleTo(internalRead('identity')),
        ),
      )
      .limit(DOCUMENT_LIST_LIMIT),
  )
  return rows.map((row) => row.collectionName)
}

/** Where a document's current bytes are, and which Fassung they are (`versionId`, null before a publish). */
export interface StoredDocumentFile {
  id: string
  storageKey: string
  storageBucket: string | null
  contentType: string | null
  versionId: string | null
}

export async function findStorageKeyByCollectionAndFilename(
  collectionName: string,
  filename: string,
  organizationId?: string,
): Promise<StoredDocumentFile | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-file lookup: the service-token caller identifies the row by its ' +
      'unguessable collection name and carries no organization',
    () =>
      db
        .select({
          // The id lets a tool that resolved a file by name act on the
          // document through the routes keyed by id (its Anmerkungen).
          id: documents.id,
          storageKey: documents.storageKey,
          // The agent tier calls get_object directly (ADR-0039), so it needs
          // the bucket as well as the key — recomputing it there would be a
          // second implementation of the naming rule in a third language.
          storageBucket: documents.storageBucket,
          contentType: documents.contentType,
          // The Fassung these bytes are: the published version the item's
          // storage columns mirror. A look card records it, so an old answer
          // keeps showing the Fassung that was read (ADR-0128); null before
          // anything was published.
          versionId: documents.publishedVersionId,
        })
        .from(documents)
        .where(
          and(
            eq(documents.collectionName, collectionName),
            eq(documents.filename, filename),
            // See the note above: this is a byte-serving path reachable with
            // model-supplied arguments. A machine-authored row must not resolve.
            eq(documents.authoredBy, 'user'),
            // Nor one the content gate has not passed (ADR-0086): a held file
            // has not reached a model, and a name the model was told must not
            // reach it through here either. Nobody's own uploads count.
            documentVisibleTo(SCREENED_ONLY),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(1),
  )
  return row ?? null
}

/**
 * The storage location of a document the ingest pipeline is working on,
 * addressed the way the pipeline knows it: by the `document_id` the dispatch
 * sent AND the collection it was sent for. Both must match — the id alone is
 * unguessable, but requiring the collection means a caller holding one
 * document's id cannot mint derived objects under it from another shelf's
 * ingest. Same row filters as {@link findStorageKeyByCollectionAndFilename}:
 * live, user-authored (this feeds a presigned WRITE under the document's
 * prefix), and org-narrowed when the caller carries one.
 */
export async function findStorageKeyByIdAndCollection(
  documentId: string,
  collectionName: string,
  organizationId?: string,
): Promise<{ storageKey: string; storageBucket: string | null } | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-image presign: the service-token caller identifies the row by its ' +
      'unguessable document id and collection name and carries no organization',
    () =>
      db
        .select({ storageKey: documents.storageKey, storageBucket: documents.storageBucket })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.collectionName, collectionName),
            eq(documents.authoredBy, 'user'),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
            // The pipeline asks about the file it is reading, which is held
            // until it finishes; the job writes a raster only after its screen.
            documentVisibleTo(internalRead('ingest')),
          ),
        )
        .limit(1),
  )
  return row ?? null
}

/**
 * Whether the document an ingest was dispatched for still exists, addressed
 * the way {@link findStorageKeyByIdAndCollection} addresses it: by id AND
 * collection, org-narrowed when the caller carries one. Asked by the ingest
 * pipeline once a file is indexed, so it can take back out the chunks of a
 * document deleted while it ran (`document_presence` in the knowledge layer).
 *
 * No authorship predicate, unlike the presign lookup. A published
 * machine-authored version IS ingested (ADR-0054's publish door), and
 * answering "gone" for it would have the pipeline discard a live document.
 *
 * A document filed in a folder that is in the Papierkorb (or purged) is gone
 * for this question: its chunks were purged when the folder went to the bin,
 * and an ingest that was still running then must take back out what it
 * inserted afterwards. A restore dispatches it again.
 */
export async function documentExistsInCollection(
  documentId: string,
  collectionName: string,
  organizationId?: string,
): Promise<boolean> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-exists: the ingest pipeline identifies the row by its unguessable ' +
      'document id and collection name, and carries no organization for a project collection',
    () =>
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.collectionName, collectionName),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
            sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`,
            // The pipeline asks about the file it just indexed, still held.
            documentVisibleTo(internalRead('ingest')),
          ),
        )
        .limit(1),
  )
  return row !== undefined
}

/**
 * Recording a document goes through `insertDocumentWithinQuota`
 * (`@/lib/storage/repository`), not through a plain insert here.
 *
 * There used to be an `insertDocument` in this module. It is gone on purpose: an
 * organization's storage quota is only a ceiling if EVERY insert of a `documents`
 * row is gated by it, and a second, ungated way in is how a ceiling stops being
 * one. Anything that needs to create a document row calls the admitting insert
 * and handles its refusal.
 */

/**
 * Hard-delete a project document row (the DB record; SeaweedFS + backend
 * cleanup live in the service). Scoped by `organizationId` AND `projectId` so a
 * document id from another tenant or project can never be deleted through this
 * path — tenancy and project ownership are both enforced in SQL.
 */
export async function deleteProjectDocument(
  documentId: string,
  organizationId: string,
  projectId: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .delete(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
        ),
      ),
  )
}

/**
 * Persist a rename.
 *
 * Writes `display_name` and nothing else — `filename` is the join key to the
 * stored object and to the document's chunks in the retrieval index, so a
 * rename must not touch it (migration 0048 has the full reasoning). `null`
 * clears the rename, restoring the file's own name.
 *
 * Scoped by organization alone, deliberately: this serves both a project
 * document and an org-wide Archiv document (which has no project), and the
 * caller has already established which of the two access rules applies —
 * `getAccessibleDocument` in the service is where project FGA vs
 * `org:office_shelf:manage` is decided.
 */
export async function setDocumentDisplayName(
  documentId: string,
  organizationId: string,
  displayName: string | null,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ displayName, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
  )
}

/**
 * A row the content gate quarantined keeps its status through every write but
 * a reviewer's release (`markScreeningReleased`) and a delete (ADR-0086). A
 * dispatch, a local conversion or a failure does not clear a held state: a new
 * screening produces a new verdict, written by the reconcile, never a reset to
 * `pending` that the next reader takes for an ordinary upload. Every status
 * writer below carries it; migration 0122's trigger refuses any other write
 * that tries.
 */
const notQuarantined = ne(documents.status, 'quarantined')

/**
 * Persist the backend ingest job id so status reads can reconcile the row
 * with the backend's ingestion state (see lib/documents/reconcile-status.ts).
 * Returns whether the row took it: a quarantined row does not
 * ({@link notQuarantined}).
 *
 * Beside the job id, the digest of the bytes this job reads
 * (`ingestContentHash`): the verdict it brings back is about those bytes, and
 * the reconcile writes it to `screened_hash` from here (migration 0123), not
 * from whatever the row holds when the verdict lands. And the filing choice
 * the dispatch carried, which is about those same bytes.
 */
export async function setDocumentIngestJob(
  documentId: string,
  organizationId: string,
  ingestJobId: string,
  /**
   * What the person filing these bytes chose (`filingChoiceRecord`), kept so a
   * reviewer's release of a held file still carries it (`./filing-choice`).
   * Null records none, and a dispatch without one drops the last.
   */
  filingChoice: Record<string, string> | null = null,
): Promise<boolean> {
  const db = getDb()
  const moved = await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({
        status: 'pending',
        metadata: sql`jsonb_strip_nulls(jsonb_build_object('ingestJobId', ${ingestJobId}::text, 'ingestContentHash', ${documents.contentHash}, ${FILING_CHOICE_METADATA_KEY}::text, ${filingChoice === null ? null : JSON.stringify(filingChoice)}::jsonb))`,
        // A new attempt: the previous one's failure no longer describes the
        // row, and the job's own verdict replaces it when it ends (migration
        // 0134). The reader version stays until then: it is the last reader
        // that read the row, which is still true.
        ingestFailureCategory: null,
        ingestRetryable: null,
        ingestAttempts: sql`coalesce(${documents.ingestAttempts}, 0) + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), notQuarantined))
      .returning({ id: documents.id }),
  )
  return moved.length > 0
}

/**
 * Say that the row's bytes are deliberately not in the index: an archived
 * document, whose chunks `archiveDocument` purged, and a re-upload onto one,
 * which `dispatchDocument` does not send. `stored` is the status for "the bytes
 * are here and nothing reads them", which is what the row now is; leaving it
 * `completed` showed a document Piloti can no longer cite as „Zitierbar“.
 *
 * A held row keeps `quarantined`: the hold is what keeps it from every reader
 * but its uploader and the reviewers (ADR-0086), and archiving it decides
 * nothing about its content.
 */
export async function markDocumentNotIndexed(documentId: string, organizationId: string): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: 'stored', updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), notQuarantined)),
  )
}

/**
 * The `documents.metadata` key of a row placement purged and re-pointed whose
 * re-read into its new collection is the `placement_reingest` job's to do
 * (`lib/projects/collection-placement.ts`, ADR-0087). Only ever set beside
 * `status = 'processing'`; the job removes it when it takes the row, and every
 * other writer of `processing` or of an ingest job id drops it.
 */
export const PLACEMENT_REINGEST_MARKER = 'placementReingest'

/**
 * Mark a document as being worked on locally, before any backend job exists.
 *
 * The IFC path needs this: extraction happens in THIS process and can take
 * tens of seconds, during which there is no ingest job to reconcile against.
 * Leaving the row at 'uploaded' would render a green "Ready" for a model that
 * cannot be opened yet. 'processing' is an in-flight status, and reconciliation
 * leaves a `processing` row alone, so the status survives until extraction
 * sets a real one.
 *
 * The previous ingest job id is dropped here. A retried or re-ingested document
 * still carried it, and every reader that consults the job (the reconcile and
 * the re-ingest heal) then answered with the OLD job's outcome — a retry of a
 * failed file flipped back to failed while its new conversion was running.
 * Clearing it at the one writer of `processing` fixes both readers at once.
 * The queue job of the previous round goes with it ({@link setDocumentBackgroundJob}),
 * and so does the placement mark ({@link PLACEMENT_REINGEST_MARKER}): a row this
 * marks is owned by the work that marked it, not waiting for placement's job.
 */
export async function markDocumentProcessing(
  documentId: string,
  organizationId: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({
        status: 'processing',
        errorMessage: null,
        metadata: sql`coalesce(${documents.metadata}, '{}'::jsonb) - 'ingestJobId' - 'bffJobId' - ${PLACEMENT_REINGEST_MARKER}::text`,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), notQuarantined)),
  )
}

/**
 * Remember which `bff_job_queue` job is working on a document that sits at
 * `processing` (IFC extraction, office conversion).
 *
 * The sweep that recovers stranded rows ({@link listStuckProcessingDocuments})
 * joins on this id: a row whose job is queued or running is waiting its turn,
 * not lost, and without the id telling the two apart a backlog of thousands of
 * waiting rows would crowd the lost ones out of every sweep's batch. The id
 * leaves with the status: `setDocumentIngestJob` replaces the metadata when the
 * dispatch succeeds, and `markDocumentProcessing` drops it for the next round.
 */
export async function setDocumentBackgroundJob(
  documentId: string,
  organizationId: string,
  jobId: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ metadata: sql`coalesce(${documents.metadata}, '{}'::jsonb) || ${JSON.stringify({ bffJobId: jobId })}::text::jsonb` })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          eq(documents.status, 'processing'),
        ),
      ),
  )
}

/** A document left at `processing` with no live job behind it. */
export interface StuckProcessingDocument {
  id: string
  organizationId: string
  /** `dead` when its job failed every attempt, `null` when it has none (a row from before jobs, or a lost enqueue). */
  jobStatus: 'dead' | null
  lastError: string | null
}

/**
 * Documents at `processing` since before `before` whose job is gone or dead,
 * oldest first. Platform scope by nature: the caller is a sweep over every
 * organization, and acts on each row inside its own.
 *
 * A row whose job is still `queued` or `claimed` is left out in the query, so
 * the batch is always rows that need something done. So is a row in a folder
 * that went to the Papierkorb (ADR-0088): it is hidden and its chunks were
 * purged, and restoring the folder marks it `processing` for the restore's
 * job again; a job queued for it here would only parse or convert a document
 * nobody may see. Once restored, a row that job never reached (it died, or its
 * requester lost access) is found here like any other.
 */
export async function listStuckProcessingDocuments(
  before: Date,
  limit: number,
): Promise<StuckProcessingDocument[]> {
  const db = getDb()
  const rows = await withPlatformAccess('document sweep: finding rows left at processing without a live job', () =>
    db
      .select({
        id: documents.id,
        organizationId: documents.organizationId,
        jobStatus: bffJobQueue.status,
        lastError: bffJobQueue.lastError,
      })
      .from(documents)
      .leftJoin(
        bffJobQueue,
        sql`${bffJobQueue.jobId} = nullif(${documents.metadata}->>'bffJobId', '')::uuid`,
      )
      .where(
        and(
          eq(documents.status, 'processing'),
          lt(documents.updatedAt, before),
          or(isNull(bffJobQueue.jobId), eq(bffJobQueue.status, 'dead')),
          sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`,
        ),
      )
      .orderBy(asc(documents.updatedAt))
      .limit(limit),
  )
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    jobStatus: row.jobStatus === 'dead' ? 'dead' : null,
    lastError: row.lastError ?? null,
  }))
}

/**
 * Persist an ingestion failure so status reads tell the truth. Without this a
 * document whose ingest dispatch never started would sit at 'uploaded' — which
 * the UI renders as a green "Ready" — forever (reconciliation only revisits
 * in-flight statuses, and there is no job id to reconcile against).
 *
 * A failure the BFF records itself (the dispatch did not start, the office
 * conversion or the IFC parse failed) carries no backend category, so it
 * clears the last one (migration 0134): a dispatch that never reached the
 * backend says nothing about the bytes, and an earlier `deterministic` left
 * standing would refuse the retry this failure deserves.
 */
export async function markDocumentIngestFailed(
  documentId: string,
  organizationId: string,
  errorMessage: string,
): Promise<void> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: 'failed', errorMessage, ingestFailureCategory: null, ingestRetryable: null, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), notQuarantined))
      .returning({ projectId: documents.projectId, scope: documents.scope }),
  )
  // The one door every hard failure goes through (a dispatch refused, an IFC
  // extraction that failed, a row stuck in processing): the badge turns red
  // for everyone reading the shelf, not only for a tab that happens to poll it.
  if (row) publishShelfChanged(organizationId, documentShelf(row))
}

/** Several folders' paths in one project, keyed by folder id; folders not in the project are absent. */
export async function findFolderPathsInProject(
  folderIds: readonly string[],
  projectId: string,
  organizationId: string,
): Promise<Map<string, string>> {
  if (folderIds.length === 0) return new Map()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: projectFolders.id, path: projectFolders.path })
      .from(projectFolders)
      .where(
        and(
          inArray(projectFolders.id, [...folderIds]),
          eq(projectFolders.projectId, projectId),
          isNull(projectFolders.deletedAt),
        ),
      ),
  )
  return new Map(rows.map((row) => [row.id, row.path]))
}

/**
 * A folder's path on a shelf, scoped to it so a folder id from another project,
 * another shelf or another tenant can never redirect an upload or re-file a
 * document under a tree it is not in.
 */
async function findFolderPathOnShelf(
  shelf: DocumentShelf,
  folderId: string,
  organizationId: string,
): Promise<string | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(and(eq(projectFolders.id, folderId), shelfFolderWhere(shelf, organizationId)))
      .limit(1),
  )
  return row?.path ?? null
}

/** A project folder's path — see {@link findFolderPathOnShelf}. */
export function findFolderPathInProject(
  folderId: string,
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  return findFolderPathOnShelf(projectShelf(projectId), folderId, organizationId)
}

/** An Archiv folder's path — see {@link findFolderPathOnShelf}. */
export function findFolderPathInOfficeShelf(folderId: string, organizationId: string): Promise<string | null> {
  return findFolderPathOnShelf(OFFICE_SHELF, folderId, organizationId)
}

/**
 * Document counts per project, for the projects grid.
 *
 * Takes the project ids the caller is allowed to see rather than counting
 * org-wide: the grid is fed by `listProjects`, which filters to the projects
 * this member can actually reach (ADR-0038), so counting across the whole
 * organization would put a row count against projects the caller was never
 * shown — and hand back the size of the tenant's estate to someone scoped to
 * one project. Returns a plain id → count map; projects with no documents are
 * simply absent.
 *
 * `hiddenFolderIds` are the folders the viewer may not read in any of those
 * projects (`getHiddenFolderIds`; folder ids are unique, so one list serves
 * all). Their documents are left out as `listProjectDocuments` leaves them out:
 * a number on the grid that counts a file the viewer cannot see tells them it
 * exists.
 */
export async function countDocumentsByProject(
  organizationId: string,
  projectIds: string[],
  hiddenFolderIds: readonly string[] | undefined,
  /** Whose count: a held file moves the number for its uploader and its reviewers only (ADR-0086). */
  reader: DocumentReader,
): Promise<Record<string, number>> {
  if (projectIds.length === 0) return {}
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ projectId: documents.projectId, total: count() })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.projectId, projectIds),
          // Same reason as `listProjectDocuments`: the grid's number must be
          // the count of what the project list shows, and the two must agree by
          // asking the same question rather than by both happening to exclude
          // the other shelves.
          eq(documents.scope, 'project'),
          ...outsideHiddenFolders(hiddenFolderIds),
          documentVisibleTo(reader),
        ),
      )
      .groupBy(documents.projectId),
  )
  return Object.fromEntries(rows.map((row) => [row.projectId, Number(row.total)]))
}

/** What a reconciling read saw: the row's status, and the dispatch (ingest job) it resolved. */
export interface ReconciledFrom {
  status: string
  jobId: string | null
}

/** The row still carries the dispatch the read resolved: that job, or none. */
const sameDispatch = (jobId: string | null): SQL =>
  jobId
    ? sql`${documents.metadata} ->> 'ingestJobId' = ${jobId}`
    : sql`(${documents.metadata} ->> 'ingestJobId') IS NULL`

/** The digest the dispatch of the job being reconciled recorded, or the row's earlier one. */
const screenedHashOfDispatch = sql<string | null>`coalesce(${documents.metadata} ->> 'ingestContentHash', ${documents.screenedHash})`

/** The digest the dispatch of the job being reconciled recorded, and nothing else. */
const dispatchedHash = sql<string | null>`${documents.metadata} ->> 'ingestContentHash'`

/**
 * A verdict recorded on the versions that hold the bytes it judged (migration
 * 0131, ADR-0086): the one writer of `document_versions.screened_hash`, called
 * only inside the transaction that records the item's verdict, so the item and
 * its versions never disagree about the same bytes.
 *
 * `document_versions.screened_hash` is what keeps an earlier upload readable
 * once a re-upload replaces it: the item's own `screened_hash` names the
 * current bytes and is reset by the replace. A pass sets it on every version of
 * this document holding `judgedHash`; a verdict that holds those bytes
 * (a quarantine) clears it, so the latest verdict about the bytes is the one on
 * record. No judged digest (a dispatch from before migration 0123 with nothing
 * on the item either) records nothing, and those versions stay refused.
 */
async function recordVersionVerdict(
  tx: DbTransaction,
  documentId: string,
  organizationId: string,
  verdict: { judgedHash: string | null; passed: boolean },
): Promise<void> {
  if (!verdict.judgedHash) return
  await tx
    .update(documentVersions)
    .set({ screenedHash: verdict.passed ? verdict.judgedHash : null })
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
        eq(documentVersions.contentHash, verdict.judgedHash),
      ),
    )
}

/**
 * Persist a reconciled ingestion status.
 *
 * Lives here rather than in `reconcile-status.ts` because a repository is the
 * only module that queries for this domain — the reconciler decides WHAT the
 * status should be, and this writes it.
 *
 * Guarded on what the caller read (`from`): the status AND the dispatch.
 * Returns whether this call moved the row. Reconciliation runs on reads, so two
 * reads (or a read and the re-ingest heal) can resolve the same in-flight row
 * at once, and only the one whose write lands may settle it. The status alone
 * is not enough: a release between two reads puts the row back in flight under
 * a NEW job, and a read that resolved the old one would write the old verdict
 * over it. A write keyed on the job lands only on the dispatch it is about.
 *
 * A quarantine is the content gate's decision (ADR-0086), and the same
 * transaction records it in `document_quarantine_decisions`, keyed on the
 * dispatch, for the audit trail: a moved row and its decision exist together
 * or not at all, and one job is one decision. Its verdict is written to
 * `documents.quarantine` with the status (migration 0148, ADR-0113), and every
 * other status writes NULL there: only a quarantined row carries one (CHECK).
 * `quarantine` is the job's typed verdict; a resolution without it (a job from
 * before the field) is read through `storedQuarantineVerdictOf`, the one
 * reader of the legacy message.
 *
 * `failure` is what the job said about the file (migration 0134): its failure
 * category, whether the same bytes may read again, and the reader that read
 * it, written with the status they explain, so the retry rule never reads one
 * outcome's category beside another outcome's status. Absent (a row going
 * back to `pending`) leaves all three as they are.
 */
export async function setDocumentReconciledStatus(
  documentId: string,
  organizationId: string,
  resolution: {
    status: DocumentStatus
    errorMessage: string | null
    screeningOutcome?: DocumentScreeningOutcome
    /** The job's typed verdict (ADR-0113); read only for a `quarantined` status. */
    quarantine?: StoredQuarantineVerdict | null
    failure?: IngestFailureFacts
  },
  from: ReconciledFrom,
): Promise<boolean> {
  const { failure } = resolution
  const verdict = resolution.status === 'quarantined' ? storedQuarantineVerdictOf(resolution) : null
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const [moved] = await tx
        .update(documents)
        .set({
          status: resolution.status,
          errorMessage: resolution.errorMessage,
          quarantine: verdict,
          // Only when the job said something (ADR-0086): an unscreened job must
          // not erase a reviewer's `released`.
          ...(resolution.screeningOutcome ? { screeningOutcome: resolution.screeningOutcome } : {}),
          // A job that read its bytes to the end vouches for THOSE bytes
          // (migration 0123): the digest its dispatch recorded, never the row's
          // current one, which a version swap may have moved since. A job
          // dispatched before 0122 recorded none and keeps the backfilled value.
          ...(resolution.status === 'completed' ? { screenedHash: screenedHashOfDispatch } : {}),
          ...(failure
            ? {
                ingestFailureCategory: failure.category,
                ingestRetryable: failure.retryable,
                ingestReaderVersion: failure.readerVersion,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.organizationId, organizationId),
            // The status the read saw, compared as text: a guard, never a write.
            sql`${documents.status} = ${from.status}`,
            sameDispatch(from.jobId),
          ),
        )
        .returning({
          scope: documents.scope,
          projectId: documents.projectId,
          folderId: documents.folderId,
          filename: documents.filename,
          createdBy: documents.createdBy,
          status: documents.status,
          screeningOutcome: documents.screeningOutcome,
          screenedHash: documents.screenedHash,
          dispatchedHash,
        })
      if (!moved) return false
      // The versions holding the bytes this job judged take the same verdict
      // (migration 0131). A read that ended without one (`failed`), or that was
      // stopped before it could judge them (`cancelled`), says nothing.
      if (resolution.status !== 'failed' && resolution.status !== 'cancelled') {
        await recordVersionVerdict(tx, documentId, organizationId, {
          judgedHash: resolution.status === 'completed' ? moved.screenedHash : moved.dispatchedHash,
          passed: resolution.status === 'completed' && verdictPasses(moved),
        })
      }
      if (resolution.status === 'quarantined') {
        await tx
          .insert(documentQuarantineDecisions)
          .values({
            organizationId,
            documentId,
            jobId: from.jobId,
            scope: moved.scope,
            projectId: moved.projectId,
            folderId: moved.folderId,
            filename: moved.filename.slice(0, 500),
            reasons: auditedQuarantineReasons(verdict),
            reasonsOmitted: verdict?.omitted ?? 0,
            checked: verdict?.checked ?? '',
            uploadedBy: moved.createdBy,
          })
          .onConflictDoNothing({ target: [documentQuarantineDecisions.documentId, documentQuarantineDecisions.jobId] })
      }
      return true
    }),
  )
}

/**
 * A reviewer's release of a held document (ADR-0086): who, when, and which
 * bytes. Guarded on the row still being held at rest with the bytes the
 * reviewer saw, so a release that raced a re-upload releases nothing. Returns
 * whether it took. A quarantine is released this way, and so is a file the gate
 * never reached a verdict on (its reading failed): before 2026-10-08 that file
 * stayed held with no way out.
 */
export async function markScreeningReleased(
  documentId: string,
  organizationId: string,
  release: { contentHash: string; releasedBy: string; releasedAt: Date },
): Promise<boolean> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(documents)
        .set({
          status: 'uploaded',
          errorMessage: null,
          // Only a quarantined row carries a verdict (migration 0148's CHECK),
          // and the release is how a row stops being one.
          quarantine: null,
          // The held verdict (`quarantined`, or a reading that failed) is the
          // reviewer's to lift, and they lifted it (migration 0134).
          ingestFailureCategory: null,
          ingestRetryable: null,
          screeningOutcome: 'released',
          // The release is a verdict about these bytes (migration 0123).
          screenedHash: release.contentHash,
          screeningReleasedHash: release.contentHash,
          screeningReleasedBy: release.releasedBy,
          screeningReleasedAt: release.releasedAt,
          updatedAt: release.releasedAt,
        })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.organizationId, organizationId),
            // Held and at rest: a quarantine, or a file the gate never reached a
            // verdict on (ADR-0086). A file in flight is the job's, not a reviewer's.
            heldAtRest(),
            eq(documents.contentHash, release.contentHash),
          ),
        )
        .returning({ id: documents.id })
      if (updated.length === 0) return false
      // The versions holding the released bytes are released with them (migration 0131).
      await recordVersionVerdict(tx, documentId, organizationId, { judgedHash: release.contentHash, passed: true })
      return true
    }),
  )
}

/** Bound on one read of the quarantine queue. A queue longer than this is a policy problem, not a list. */
export const QUARANTINE_LIST_LIMIT = 200

/** Where the next page of the quarantine starts: the last row of the previous one. */
export interface QuarantineCursor {
  updatedAt: Date
  id: string
}

/**
 * One page of the organization's held documents at rest (`heldAtRest`: a
 * quarantine, or a file whose reading ended without a verdict), newest first,
 * after `cursor`. Authorization is the caller's, which is why it pages: a reviewer of
 * one project must not lose their documents behind a page of another project's
 * (`listQuarantineQueue` reads on until its own list is full).
 */
export async function listQuarantinedDocuments(
  organizationId: string,
  cursor: QuarantineCursor | null = null,
): Promise<Document[]> {
  const db = getDb()
  const after = cursor
    ? or(
        lt(documents.updatedAt, cursor.updatedAt),
        and(eq(documents.updatedAt, cursor.updatedAt), lt(documents.id, cursor.id)),
      )
    : undefined
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(and(eq(documents.organizationId, organizationId), heldAtRest(), after))
      .orderBy(desc(documents.updatedAt), desc(documents.id))
      .limit(QUARANTINE_LIST_LIMIT),
  )
}

/**
 * Documents whose ingestion failed and is worth retrying, org-wide, a keyset
 * page at a time.
 *
 * The rescan behind "Rescan failed ingestions" in Organization > Enterprise:
 * every row stuck at `failed`/`error` - plus rows stranded at the `uploaded`
 * birth status that never dispatched - is a file that was stored but never
 * read. Bounded like every other list query; the rescan job re-dispatches each
 * id through `reingestDocument`, so access checks and status guards stay in one
 * place instead of being restated here.
 *
 * A failure the retry rule refuses ({@link retryAllowedSql}) is left out here,
 * not skipped later: the walk never pays a request for a file that would fail
 * the same way, and the audit's counts say what was actually sent back.
 */
export const FAILED_INGEST_RESCAN_STATUSES = ['failed', 'uploaded'] as const

/**
 * `canRetry` (`./retry-policy`) in SQL, for the queries that choose what a bulk
 * retry sends: true unless the row is FAILED for a reason reading it again will
 * not change. Kept beside the TypeScript rule rather than replacing it, because
 * a single document's retry decides on the row it already holds and a walk
 * must not fetch the rows it will not send; `retry-policy.spec.ts` states the
 * rule and `retry-policy.integration.spec.ts` holds this SQL to it row by row.
 *
 *   - not in the failed family: the rule says nothing (`uploaded` rows of the
 *     rescan pass);
 *   - `deterministic`: refused unless the bytes changed since the dispatch
 *     that failed (`ingestContentHash`, both sides known) or the deployed
 *     reader is newer than the one that failed (dotted numbers compared as
 *     integer arrays; a version missing or not dotted numbers counts as older,
 *     as `isNewerReader` counts it);
 *   - no category: refused only when the flag says `false`, so every row from
 *     before migration 0134 passes;
 *   - any other category: refused only for `quarantined`.
 *
 * Each branch is a non-null boolean, and the whole is `coalesce`d besides:
 * `NOT NULL` in a WHERE drops the row, which would quietly withhold exactly the
 * rows the rule means to keep.
 */
export function retryAllowedSql(): SQL {
  const failedStatuses = sql.join(
    declaredStatusesIn('failed').map((status) => sql`${status}`),
    sql`, `,
  )
  const version = documents.ingestReaderVersion
  const readerIsNewer = sql`CASE
      WHEN ${version} IS NULL THEN true
      WHEN ${version} ~ '^[0-9]+([.][0-9]+)*$'
        THEN string_to_array(${version}, '.')::int[] < string_to_array(${CURRENT_INGEST_READER_VERSION}::text, '.')::int[]
      ELSE ${version} <> ${CURRENT_INGEST_READER_VERSION}::text
    END`
  const bytesChanged = sql`(${dispatchedHash} IS NOT NULL AND ${documents.contentHash} IS NOT NULL AND ${documents.contentHash} <> ${dispatchedHash})`
  const refused = sql`(lower(${documents.status}) IN (${failedStatuses}) AND CASE
      WHEN ${documents.ingestFailureCategory} = 'deterministic' THEN NOT (${bytesChanged} OR ${readerIsNewer})
      WHEN ${documents.ingestFailureCategory} IS NULL THEN coalesce(${documents.ingestRetryable}, true) = false
      ELSE ${documents.ingestFailureCategory} = 'quarantined'
    END)`
  return sql`NOT coalesce(${refused}, false)`
}

/** Most ids one page of the failed-ingestion walk returns. */
export const FAILED_INGEST_PAGE_LIMIT = 100

/**
 * The rows AFTER `cursor` in the failed walk's order: oldest first, id as the
 * tiebreak. Ascending twin of {@link afterDocumentListCursor}, with the same
 * microsecond text so a row the cursor was built from is never served twice.
 */
function afterFailedWalkCursor(cursor: DocumentListCursor): SQL {
  const at = sql`(${cursor.createdAt}::timestamp AT TIME ZONE 'UTC')`
  return sql`(${documents.createdAt} > ${at} OR (${documents.createdAt} = ${at} AND ${documents.id} > ${cursor.id}::uuid))`
}

export interface FailedDocumentPage {
  ids: string[]
  /** Where the next page starts, or `null` when the failed set is exhausted. */
  nextCursor: DocumentListCursor | null
}

/**
 * One page of the failed set. A keyset rather than an exclusion list: rows that
 * stay failed after a retry cannot starve the rows behind them, and the walk's
 * state stays one position however many rows there are, so a job can keep it
 * in its payload and resume from it.
 */
export async function listFailedDocumentPageInOrg(
  organizationId: string,
  { limit = FAILED_INGEST_PAGE_LIMIT, cursor }: { limit?: number; cursor?: DocumentListCursor | null } = {},
): Promise<FailedDocumentPage> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), FAILED_INGEST_PAGE_LIMIT)
  const db = getDb()
  const fetched = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id, cursorCreatedAt: cursorCreatedAtColumn })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.status, [...FAILED_INGEST_RESCAN_STATUSES]),
          retryAllowedSql(),
          ...(cursor ? [afterFailedWalkCursor(cursor)] : []),
        ),
      )
      .orderBy(asc(documents.createdAt), asc(documents.id))
      // One more than asked, which is how "is there more" is answered without a COUNT.
      .limit(bounded + 1),
  )
  const hasMore = fetched.length > bounded
  const page = hasMore ? fetched.slice(0, bounded) : fetched
  const last = page.at(-1)
  return {
    ids: page.map((row) => row.id),
    nextCursor: hasMore && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
  }
}
