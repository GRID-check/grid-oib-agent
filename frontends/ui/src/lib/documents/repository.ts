/**
 * Documents repository — the only module that talks to the `documents` table
 * (and the folder-path probe the upload flow needs) for the documents domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no MinIO/backend calls.
 *   - Every query that serves tenant data takes `organizationId` (and, where
 *     applicable, `projectId`) and scopes the WHERE clause with it — tenancy
 *     is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
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

export async function insertDocument(values: NewDocument): Promise<void> {
  const db = getDb()
  await db.insert(documents).values(values)
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
