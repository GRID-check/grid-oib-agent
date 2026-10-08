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
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withOptionalTenant, withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { ARCHIV_SHELF, projectShelf, shelfDocumentWhere, shelfFolderWhere, type DocumentShelf } from './shelf'
import { documentAliasKey, documentNameKey, documentNameVariants } from './name-match'
import { FILENAME_LOOKUP_MAX_NAMES } from './filename-lookup'
import { CURSOR_TIMESTAMP_FORMAT, type DocumentListCursor } from './list-cursor'
import {
  bffJobQueue,
  documents,
  projectFolders,
  type Document,
  type DocumentAuthor,
  type DocumentLifecycle,
  type ResourceVisibility,
} from '@/lib/db/schema'
import type { DocumentScreeningOutcome } from '@/lib/db/schema/documents'

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
  createdAt: Date
  updatedAt: Date
  errorMessage: string | null
  metadata: unknown
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
}

/**
 * The columns a listing serves — one definition for the project listing, its
 * keyset page and the Archiv's, so the three cannot disagree about what a
 * `DocumentListRow` is.
 */
export const documentListColumns = {
  id: documents.id,
  filename: documents.filename,
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
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  errorMessage: documents.errorMessage,
  metadata: documents.metadata,
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
  { authoredBy, includeArchived = false }: Pick<ListProjectDocumentsOptions, 'authoredBy' | 'includeArchived'>,
): SQL | undefined {
  return and(
    shelfDocumentWhere(shelf, organizationId),
    ...(authoredBy ? [eq(documents.authoredBy, authoredBy)] : []),
    ...(includeArchived ? [] : [eq(documents.lifecycle, 'active')]),
  )
}

function boundListLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
}

export async function listProjectDocuments(
  projectId: string,
  organizationId: string,
  { limit = DOCUMENT_LIST_LIMIT, offset = 0, authoredBy, includeArchived = false }: ListProjectDocumentsOptions = {},
): Promise<DocumentListRow[]> {
  const boundedLimit = boundListLimit(limit)
  const boundedOffset = Math.max(0, Math.trunc(offset))
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(listingWhere(projectShelf(projectId), organizationId, { authoredBy, includeArchived }))
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
  }: Omit<ListProjectDocumentsOptions, 'offset'> & { cursor?: DocumentListCursor } = {},
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
              listingWhere(shelf, organizationId, { authoredBy, includeArchived }),
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
  options: Omit<ListProjectDocumentsOptions, 'offset'> & { cursor?: DocumentListCursor } = {},
): Promise<DocumentListPage> {
  return listDocumentPage(projectShelf(projectId), organizationId, options)
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
  { includeArchived = false }: Pick<ListProjectDocumentsOptions, 'includeArchived'> = {},
): Promise<DocumentListRow[]> {
  const byName = filenameLookupWhere(filenames)
  if (!byName) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(and(listingWhere(shelf, organizationId, { includeArchived }), byName))
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(DOCUMENT_LIST_LIMIT),
  )
}

/** The project documents named `filenames` — see {@link findDocumentsByFilenames}. */
export function findProjectDocumentsByFilenames(
  projectId: string,
  organizationId: string,
  filenames: readonly string[],
  options: Pick<ListProjectDocumentsOptions, 'includeArchived'> = {},
): Promise<DocumentListRow[]> {
  return findDocumentsByFilenames(projectShelf(projectId), organizationId, filenames, options)
}

/** One row of a name probe (`name-probe-types.ts` is its wire shape). */
export interface DocumentNameMatchRow {
  id: string
  filename: string
  displayName: string | null
  fileSize: number | null
  contentHash: string | null
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
): Promise<DocumentNameMatchRow[]> {
  const db = getDb()
  return probeDocumentNames(names, (where, limit) =>
    withTenant({ organizationId }, () =>
      db
        .select(documentNameMatchColumns)
        .from(documents)
        .where(and(shelfDocumentWhere(shelf, organizationId), where))
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
): Promise<DocumentNameMatchRow[]> {
  return findDocumentsByNames(projectShelf(projectId), organizationId, names)
}

/**
 * Tenancy probe for authorization — unscoped, like `findConversationTenancy`.
 * The caller decides whether an organization mismatch is a 404.
 */
export async function findDocumentTenancy(
  documentId: string,
): Promise<Pick<
  Document,
  'organizationId' | 'projectId' | 'visibility' | 'createdBy' | 'filename' | 'displayName'
> | null> {
  const db = getDb()
  const [row] = await db
    .select({
      organizationId: documents.organizationId,
      projectId: documents.projectId,
      visibility: documents.visibility,
      createdBy: documents.createdBy,
      filename: documents.filename,
      displayName: documents.displayName,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
  return row ?? null
}

export async function updateDocumentVisibilityInOrg(
  documentId: string,
  organizationId: string,
  visibility: ResourceVisibility,
): Promise<Document | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ visibility, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
      .returning(),
  )
  return row ?? null
}

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

export async function documentIdsExisting(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const db = getDb()
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.id, [...ids]))
  return new Set(rows.map((row) => row.id))
}

/** Load a document by id scoped to an organization. */
export async function findDocumentInOrg(documentId: string, organizationId: string): Promise<Document | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
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
 * `(collection, filename)` pair, and `view_knowledge_image` in the knowledge
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
  status: string | null
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
        status: documents.status,
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
 * Point an existing document row at newly uploaded bytes.
 *
 * The id is deliberately kept. It is what every citation, every chat subject
 * and every folder assignment already references, so replacing the bytes under
 * a stable id is the difference between "this document was updated" and "a
 * second document appeared and the first one stopped working".
 */
export async function replaceDocumentContents(
  organizationId: string,
  documentId: string,
  next: {
    storageKey: string
    storageBucket: string | null
    fileSize: number
    contentType: string | null
    folderId: string | null
    createdBy: string
  },
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({
        storageKey: next.storageKey,
        storageBucket: next.storageBucket,
        fileSize: next.fileSize,
        contentType: next.contentType,
        folderId: next.folderId,
        // The uploader of the CURRENT bytes: "who brought this file in" is a
        // question about what is there now, and the audit trail keeps both.
        createdBy: next.createdBy,
        status: 'uploaded',
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId))),
  )
}

export async function findStorageKeyByCollectionAndFilename(
  collectionName: string,
  filename: string,
  organizationId?: string,
): Promise<{ storageKey: string; storageBucket: string | null; contentType: string | null } | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-file lookup: the service-token caller identifies the row by its ' +
      'unguessable collection name and carries no organization',
    () =>
      db
        .select({
          storageKey: documents.storageKey,
          // The agent tier calls get_object directly (ADR-0039), so it needs
          // the bucket as well as the key — recomputing it there would be a
          // second implementation of the naming rule in a third language.
          storageBucket: documents.storageBucket,
          contentType: documents.contentType,
        })
        .from(documents)
        .where(
          and(
            eq(documents.collectionName, collectionName),
            eq(documents.filename, filename),
            // See the note above: this is a byte-serving path reachable with
            // model-supplied arguments. A machine-authored row must not resolve.
            eq(documents.authoredBy, 'user'),
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
 * `org:archiv:manage` is decided.
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
 * Persist the backend ingest job id so status reads can reconcile the row
 * with the backend's ingestion state (see lib/documents/reconcile-status.ts).
 */
export async function setDocumentIngestJob(
  documentId: string,
  organizationId: string,
  ingestJobId: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: 'pending', metadata: { ingestJobId }, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
  )
}

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
 * The queue job of the previous round goes with it ({@link setDocumentBackgroundJob}).
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
        metadata: sql`coalesce(${documents.metadata}, '{}'::jsonb) - 'ingestJobId' - 'bffJobId'`,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
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
 * the batch is always rows that need something done.
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
 */
export async function markDocumentIngestFailed(
  documentId: string,
  organizationId: string,
  errorMessage: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: 'failed', errorMessage, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
  )
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
export function findFolderPathInArchiv(folderId: string, organizationId: string): Promise<string | null> {
  return findFolderPathOnShelf(ARCHIV_SHELF, folderId, organizationId)
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
 */
export async function countDocumentsByProject(
  organizationId: string,
  projectIds: string[],
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
        ),
      )
      .groupBy(documents.projectId),
  )
  return Object.fromEntries(rows.map((row) => [row.projectId, Number(row.total)]))
}

/**
 * Persist a reconciled ingestion status.
 *
 * Lives here rather than in `reconcile-status.ts` because a repository is the
 * only module that queries for this domain — the reconciler decides WHAT the
 * status should be, and this writes it.
 */
export async function setDocumentReconciledStatus(
  documentId: string,
  organizationId: string,
  resolution: { status: string; errorMessage: string | null; screeningOutcome?: DocumentScreeningOutcome },
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({
        status: resolution.status,
        errorMessage: resolution.errorMessage,
        // Only when the job said something (ADR-0085): an unscreened job must
        // not erase a reviewer's `released`.
        ...(resolution.screeningOutcome ? { screeningOutcome: resolution.screeningOutcome } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
  )
}

/**
 * A reviewer's release of a quarantined document (ADR-0085): who, when, and
 * which bytes. Guarded on the row still being quarantined with the bytes the
 * reviewer saw, so a release that raced a re-upload releases nothing. Returns
 * whether it took.
 */
export async function markScreeningReleased(
  documentId: string,
  organizationId: string,
  release: { contentHash: string; releasedBy: string; releasedAt: Date },
): Promise<boolean> {
  const db = getDb()
  const updated = await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({
        status: 'uploaded',
        errorMessage: null,
        screeningOutcome: 'released',
        screeningReleasedHash: release.contentHash,
        screeningReleasedBy: release.releasedBy,
        screeningReleasedAt: release.releasedAt,
        updatedAt: release.releasedAt,
      })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          eq(documents.status, 'quarantined'),
          eq(documents.contentHash, release.contentHash),
        ),
      )
      .returning({ id: documents.id }),
  )
  return updated.length > 0
}

/** Bound on one read of the quarantine queue. A queue longer than this is a policy problem, not a list. */
export const QUARANTINE_LIST_LIMIT = 200

/** Where the next page of the quarantine starts: the last row of the previous one. */
export interface QuarantineCursor {
  updatedAt: Date
  id: string
}

/**
 * One page of the organization's quarantined documents, newest first, after
 * `cursor`. Authorization is the caller's, which is why it pages: a reviewer of
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
      .where(and(eq(documents.organizationId, organizationId), eq(documents.status, 'quarantined'), after))
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
 */
export const FAILED_INGEST_RESCAN_STATUSES = ['failed', 'error', 'uploaded'] as const

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
