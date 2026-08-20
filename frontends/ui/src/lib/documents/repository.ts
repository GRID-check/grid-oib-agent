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
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withOptionalTenant, withTenant } from '@/lib/db/tenant-context'
import {
  documents,
  projectFolders,
  type Document,
  type DocumentAuthor,
  type ResourceVisibility,
} from '@/lib/db/schema'

/** Hard cap for unpaginated per-project document lists. */
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
  collectionName: string
  folderId: string | null
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
export async function listProjectDocuments(
  projectId: string,
  organizationId: string,
  limit = DOCUMENT_LIST_LIMIT,
  authoredBy?: DocumentAuthor,
): Promise<DocumentListRow[]> {
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        displayName: documents.displayName,
        fileSize: documents.fileSize,
        contentType: documents.contentType,
        status: documents.status,
        authoredBy: documents.authoredBy,
        collectionName: documents.collectionName,
        folderId: documents.folderId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        errorMessage: documents.errorMessage,
        metadata: documents.metadata,
      })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.organizationId, organizationId),
          // The shelf, stated. This query used to filter on `project_id` alone
          // and be correct by accident: the only other shelf was the Archiv,
          // whose rows carry a NULL project, so `project_id = $1` excluded them
          // without ever saying that was the intent. `session` is a third shelf
          // that also has a NULL project (ADR-0047 Phase 2) — so the accident
          // still holds, and one row that ever carries both a project and a
          // non-project scope would end it silently. A project listing lists
          // project documents; that is now what it asks for.
          eq(documents.scope, 'project'),
          ...(authoredBy ? [eq(documents.authoredBy, authoredBy)] : []),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(boundedLimit),
  )
}

/**
 * Tenancy probe for authorization — unscoped, like `findConversationTenancy`.
 * The caller decides whether an organization mismatch is a 404.
 */
export async function findDocumentTenancy(
  documentId: string,
): Promise<Pick<
  Document,
  'organizationId' | 'projectId' | 'visibility' | 'createdBy' | 'deletedAt' | 'filename' | 'displayName'
> | null> {
  const db = getDb()
  const [row] = await db
    .select({
      organizationId: documents.organizationId,
      projectId: documents.projectId,
      visibility: documents.visibility,
      createdBy: documents.createdBy,
      deletedAt: documents.deletedAt,
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
 * The document a given run already filed, if it filed one.
 *
 * The idempotency probe behind `fileGeneratedDocument`. A report is fetched
 * every time its tab is opened, so without this a multi-minute run's single
 * artifact would appear once per re-read — and a duplicate of a report is
 * indistinguishable from a second run's, which is precisely the thing an
 * office cannot untangle later.
 *
 * `authored_by_run_id` is the key because it is the one identifier the producer
 * and the row already share. Scoped by organization like every other read here,
 * so a run id guessed from another tenant finds nothing.
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
 * `uniq_documents_authored_run_producer_per_project` is the half that holds under
 * concurrency, and it is keyed on exactly the four columns this function filters
 * by — `(organization_id, project_id, authored_by_run_id, authored_by_producer)`
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
export async function findDocumentAuthoredByRun(
  runId: string,
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
          eq(documents.authoredByRunId, runId),
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.authoredByProducer, producer),
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
            isNull(documents.deletedAt),
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
 * writes nothing for an in-flight row the backend has never heard of, so the
 * status survives until extraction sets a real one.
 */
export async function markDocumentProcessing(
  documentId: string,
  organizationId: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
  )
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
 * Resolve a folder's storage path, scoped to the project so a folder id from
 * another project can never redirect an upload.
 */
export async function findFolderPathInProject(
  folderId: string,
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId)))
      .limit(1),
  )
  return row?.path ?? null
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
  resolution: { status: string; errorMessage: string | null },
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: resolution.status, errorMessage: resolution.errorMessage, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId))),
  )
}
