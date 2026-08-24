/**
 * Archiv repository — the only module that queries the `documents` table for
 * the org-wide Archiv domain (rows with `scope = 'archiv'`, `project_id` NULL).
 *
 * Repository rules (docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no SeaweedFS/backend calls.
 *   - Every query is scoped by `organizationId` in the SQL WHERE clause — the
 *     Archiv is a per-tenant store, so tenancy is enforced here, not in JS.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, type Document } from '@/lib/db/schema'
import { DOCUMENT_LIST_LIMIT, type DocumentListRow } from '@/lib/documents/repository'

/** List an organization's Archiv documents, most-recent first (bounded). */
export async function listArchivDocuments(
  organizationId: string,
  limit = DOCUMENT_LIST_LIMIT,
): Promise<DocumentListRow[]> {
  const db = getDb()
  return db
    .select({
      id: documents.id,
      filename: documents.filename,
      displayName: documents.displayName,
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
    .where(and(eq(documents.organizationId, organizationId), eq(documents.scope, 'archiv')))
    .orderBy(desc(documents.createdAt))
    .limit(limit)
}

/** Load one Archiv document by id, scoped to its organization. */
export async function findArchivDocument(documentId: string, organizationId: string): Promise<Document | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.organizationId, organizationId),
        eq(documents.scope, 'archiv'),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Recording an Archiv document goes through `insertDocumentWithinQuota`
 * (`@/lib/storage/repository`), which applies the organization's quota in the
 * same transaction as the insert.
 *
 * `insertArchivDocument` is gone for the reason given in
 * `documents/repository.ts`: a second, ungated insert is how a ceiling stops
 * being one. The caller now states `scope: 'archiv'` and `projectId: null`
 * itself — those defaults were the only thing this function added.
 */

/** Hard-delete an Archiv row (the DB record; SeaweedFS + backend cleanup live in the service). */
export async function deleteArchivDocument(documentId: string, organizationId: string): Promise<void> {
  const db = getDb()
  await db
    .delete(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.organizationId, organizationId),
        eq(documents.scope, 'archiv'),
      ),
    )
}
