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
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, type Document } from '@/lib/db/schema'
import {
  DOCUMENT_LIST_LIMIT,
  afterDocumentListCursor,
  documentNameMatchColumns,
  probeDocumentNames,
  type DocumentNameMatchRow,
  cursorCreatedAtColumn,
  documentListColumns,
  readDocumentListPage,
  type DocumentListPage,
  type DocumentListRow,
} from '@/lib/documents/repository'
import type { DocumentListCursor } from '@/lib/documents/list-cursor'
import { documentNameVariants } from '@/lib/documents/name-match'

/**
 * One keyset page of an organization's Archiv, most-recent first.
 *
 * Bounded per page (`DOCUMENT_LIST_LIMIT`); the whole Archiv is reachable by
 * following `nextCursor`, in the same `created_at DESC, id ASC` order the
 * project listing uses, so the cursor codec is shared.
 */
export async function listArchivDocuments(
  organizationId: string,
  { limit = DOCUMENT_LIST_LIMIT, cursor }: { limit?: number; cursor?: DocumentListCursor } = {},
): Promise<DocumentListPage> {
  const db = getDb()
  return readDocumentListPage(
    (probeLimit) =>
      db
        .select({ ...documentListColumns, cursorCreatedAt: cursorCreatedAtColumn })
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, organizationId),
            eq(documents.scope, 'archiv'),
            ...(cursor ? [afterDocumentListCursor(cursor)] : []),
          ),
        )
        .orderBy(desc(documents.createdAt), asc(documents.id))
        .limit(probeLimit),
    limit,
  )
}

/**
 * The Archiv rows answering to any of `filenames` — the semantic search's
 * join, which must reach a hit whatever page of the listing it would sit on.
 *
 * Bounded by its input: the caller passes the hit names (at most the search's
 * `top_k`), each in both Unicode forms so a row written before admission
 * normalized names is still found.
 */
export async function findArchivDocumentsByFilenames(
  organizationId: string,
  filenames: readonly string[],
): Promise<DocumentListRow[]> {
  const names = [...new Set(filenames.flatMap(documentNameVariants))]
  if (names.length === 0) return []
  const db = getDb()
  return db
    .select(documentListColumns)
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.scope, 'archiv'),
        inArray(documents.filename, names),
      ),
    )
    .orderBy(desc(documents.createdAt), asc(documents.id))
    .limit(DOCUMENT_LIST_LIMIT)
}

/**
 * The Archiv documents answering to any of `names` — the upload planner's
 * name probe, matched the way the upload will match (`probeDocumentNames`).
 */
export async function findArchivDocumentsByNames(
  organizationId: string,
  names: readonly string[],
): Promise<DocumentNameMatchRow[]> {
  const db = getDb()
  return probeDocumentNames(names, (where, limit) =>
    withTenant({ organizationId }, () =>
      db
        .select(documentNameMatchColumns)
        .from(documents)
        .where(and(eq(documents.organizationId, organizationId), eq(documents.scope, 'archiv'), where))
        .orderBy(desc(documents.createdAt), asc(documents.id))
        .limit(limit),
    ),
  )
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
