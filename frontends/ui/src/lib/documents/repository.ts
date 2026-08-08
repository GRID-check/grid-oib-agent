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
import { documents, projectFolders, type Document } from '@/lib/db/schema'

/** Hard cap for unpaginated per-project document lists. */
export const DOCUMENT_LIST_LIMIT = 500

/** The column subset the list endpoint serves (metadata is stripped later). */
export interface DocumentListRow {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string
  collectionName: string
  folderId: string | null
  createdAt: Date
  updatedAt: Date
  errorMessage: string | null
  metadata: unknown
}

export async function listProjectDocuments(
  projectId: string,
  organizationId: string,
  limit = DOCUMENT_LIST_LIMIT,
): Promise<DocumentListRow[]> {
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        fileSize: documents.fileSize,
        contentType: documents.contentType,
        status: documents.status,
        collectionName: documents.collectionName,
        folderId: documents.folderId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        errorMessage: documents.errorMessage,
        metadata: documents.metadata,
      })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId)))
      .orderBy(desc(documents.createdAt))
      .limit(boundedLimit),
  )
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
 * Resolve a document's SeaweedFS storage key from its `(collectionName,
 * filename)` pair — the only identity the Python backend carries. Used by the
 * internal document-file lookup (`/api/internal/document-file`), which is
 * service-token guarded, so tenancy relies on the collection name itself
 * (`proj_<uuid>` / `archiv_<orgId>` are unguessable). When the caller can
 * supply one, `organizationId` narrows the row to that org (belt-and-braces
 * for `archiv_` collections); when omitted the lookup stays collection-only.
 * Soft-deleted rows are never returned, and when a filename is re-uploaded
 * into the same collection, the most-recent row wins.
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
      .where(and(eq(documents.organizationId, organizationId), inArray(documents.projectId, projectIds)))
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
