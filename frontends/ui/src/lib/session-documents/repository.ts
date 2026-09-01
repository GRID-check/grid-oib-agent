/**
 * Session-documents repository — the only module that queries the `documents`
 * table for files attached privately to one conversation (rows with
 * `scope = 'session'`, `project_id` NULL, `conversation_id` set).
 *
 * Repository rules (docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no SeaweedFS/backend calls.
 *   - Every query is scoped by `organizationId` in the SQL WHERE clause, and
 *     by `conversationId` where the caller has one — a session document is the
 *     narrowest thing this application stores, so both bounds are in SQL.
 *   - List queries are always bounded (`limit`).
 *
 * Every predicate names `scope = 'session'` explicitly rather than leaning on
 * `project_id IS NULL`. That reading was only ever correct while the Archiv was
 * the sole null-project shelf, and it is what this scope would have broken.
 */

import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, type Document } from '@/lib/db/schema'
import { DOCUMENT_LIST_LIMIT, type DocumentListRow } from '@/lib/documents/repository'

/**
 * Bound for one conversation's attachments. Far below the project/Archiv cap:
 * these are the files a person dragged into a single chat, and a listing that
 * could return five hundred of them is describing a corpus, not a conversation.
 */
export const SESSION_DOCUMENT_LIST_LIMIT = 100

/** List one conversation's private attachments, most-recent first (bounded). */
export async function listSessionDocuments(
  conversationId: string,
  organizationId: string,
  limit = SESSION_DOCUMENT_LIST_LIMIT,
): Promise<DocumentListRow[]> {
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        // Added by 0048 on develop and required by `DocumentListRow`; a session
        // attachment is renameable like any other document.
        displayName: documents.displayName,
        fileSize: documents.fileSize,
        contentType: documents.contentType,
        status: documents.status,
        authoredBy: documents.authoredBy,
        collectionName: documents.collectionName,
        folderId: documents.folderId,
        originPath: documents.originPath,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        errorMessage: documents.errorMessage,
        metadata: documents.metadata,
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.scope, 'session'),
          eq(documents.conversationId, conversationId),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(boundedLimit),
  )
}

/**
 * Every row belonging to a conversation — the full `Document`, because the
 * caller is about to delete the objects these rows point at and needs the
 * storage key and bucket to do it.
 *
 * Bounded like every other list. A conversation past the bound would leave
 * objects behind, so the caller loops until this returns nothing rather than
 * assuming one page is all of them.
 */
export async function listSessionDocumentsForCleanup(
  conversationId: string,
  organizationId: string,
  limit = SESSION_DOCUMENT_LIST_LIMIT,
): Promise<Document[]> {
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.scope, 'session'),
          eq(documents.conversationId, conversationId),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(boundedLimit),
  )
}

/** Load one session document by id, scoped to its organization. */
export async function findSessionDocument(
  documentId: string,
  organizationId: string,
): Promise<Document | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          eq(documents.scope, 'session'),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

/**
 * Recording a session document goes through `insertDocumentWithinQuota`
 * (`@/lib/storage/repository`), like every other shelf. There is no insert here
 * for the reason spelled out in `documents/repository.ts`: a second, ungated
 * way to create a `documents` row is how a storage quota stops being a ceiling.
 * A chat attachment is bytes in the tenant's bucket exactly like a project
 * upload, so it must not be the way around the limit.
 */

/**
 * Hard-delete one session document row (the DB record; SeaweedFS + backend
 * cleanup live in the service). Scoped by organization AND conversation, so a
 * document id from another tenant or another chat can never be deleted through
 * this path.
 */
export async function deleteSessionDocument(
  documentId: string,
  organizationId: string,
  conversationId: string,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .delete(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          eq(documents.scope, 'session'),
          eq(documents.conversationId, conversationId),
        ),
      ),
  )
}

/**
 * Hard-delete the session document rows the caller has just finished erasing
 * externally, by id.
 *
 * By id rather than "everything for this conversation", because the discard
 * path works a bounded page at a time: a statement that deleted the whole
 * conversation would remove rows whose objects the caller has not reached yet,
 * and those bytes would then be unreachable — no row names them, so nothing can
 * ever find them again.
 *
 * Still scoped by organization, scope and conversation on top of the ids: an id
 * list is caller-supplied, and these three predicates are what stop one from
 * reaching another tenant's, another chat's, or a project's row.
 */
export async function deleteSessionDocumentsByIds(
  documentIds: string[],
  organizationId: string,
  conversationId: string,
): Promise<void> {
  if (documentIds.length === 0) return
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .delete(documents)
      .where(
        and(
          inArray(documents.id, documentIds),
          eq(documents.organizationId, organizationId),
          eq(documents.scope, 'session'),
          eq(documents.conversationId, conversationId),
        ),
      ),
  )
}
