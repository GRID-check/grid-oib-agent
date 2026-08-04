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
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, projectFolders, type Document, type NewDocument } from '@/lib/db/schema'

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
  const db = getDb()
  return db
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
    .limit(limit)
}

/** Load a document by id scoped to an organization. */
export async function findDocumentInOrg(documentId: string, organizationId: string): Promise<Document | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
    .limit(1)
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
): Promise<{ storageKey: string; contentType: string | null } | null> {
  const db = getDb()
  const [row] = await db
    .select({ storageKey: documents.storageKey, contentType: documents.contentType })
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
    .limit(1)
  return row ?? null
}

export async function insertDocument(values: NewDocument): Promise<void> {
  const db = getDb()
  await db.insert(documents).values(values)
}

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
  await db
    .delete(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.organizationId, organizationId),
        eq(documents.projectId, projectId),
      ),
    )
}

/**
 * Persist the backend ingest job id so status reads can reconcile the row
 * with the backend's ingestion state (see lib/documents/reconcile-status.ts).
 */
export async function setDocumentIngestJob(documentId: string, ingestJobId: string): Promise<void> {
  const db = getDb()
  await db
    .update(documents)
    .set({ status: 'pending', metadata: { ingestJobId }, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
}

/**
 * Persist an ingestion failure so status reads tell the truth. Without this a
 * document whose ingest dispatch never started would sit at 'uploaded' — which
 * the UI renders as a green "Ready" — forever (reconciliation only revisits
 * in-flight statuses, and there is no job id to reconcile against).
 */
export async function markDocumentIngestFailed(documentId: string, errorMessage: string): Promise<void> {
  const db = getDb()
  await db
    .update(documents)
    .set({ status: 'failed', errorMessage, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
}

/**
 * Resolve a folder's storage path, scoped to the project so a folder id from
 * another project can never redirect an upload.
 */
export async function findFolderPathInProject(folderId: string, projectId: string): Promise<string | null> {
  const db = getDb()
  const [row] = await db
    .select({ path: projectFolders.path })
    .from(projectFolders)
    .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId)))
    .limit(1)
  return row?.path ?? null
}
