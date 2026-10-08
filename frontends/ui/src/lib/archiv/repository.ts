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
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, type Document } from '@/lib/db/schema'
import {
  findDocumentsByFilenames,
  findDocumentsByNames,
  listDocumentPage,
  type DocumentListPage,
  type DocumentListRow,
  type DocumentNameMatchRow,
} from '@/lib/documents/repository'
import { ARCHIV_SHELF } from '@/lib/documents/shelf'
import { documentVisibleTo, type DocumentReader } from '@/lib/documents/visibility'

/**
 * One keyset page of an organization's Archiv, most-recent first — the shared
 * shelf listing (`listDocumentPage`) on the Archiv shelf, so it filters by
 * lifecycle and author, orders, pages and cursors exactly as a project's does
 * (ADR-0078). Bounded per page; the whole Archiv is reachable by following
 * `nextCursor`.
 */
export function listArchivDocuments(
  organizationId: string,
  options: Parameters<typeof listDocumentPage>[2],
): Promise<DocumentListPage> {
  return listDocumentPage(ARCHIV_SHELF, organizationId, options)
}

/**
 * The Archiv rows named `filenames` — the semantic search's join and the
 * by-name resolve, which must reach a document whatever page of the listing it
 * would sit on. Bounded by its input (`filenameLookupWhere`).
 */
export function findArchivDocumentsByFilenames(
  organizationId: string,
  filenames: readonly string[],
  options: Parameters<typeof findDocumentsByFilenames>[3],
): Promise<DocumentListRow[]> {
  return findDocumentsByFilenames(ARCHIV_SHELF, organizationId, filenames, options)
}

/**
 * The Archiv documents answering to any of `names` — the upload planner's
 * name probe, matched the way the upload will match (`probeDocumentNames`).
 */
export function findArchivDocumentsByNames(
  organizationId: string,
  names: readonly string[],
  options: Parameters<typeof findDocumentsByNames>[3],
): Promise<DocumentNameMatchRow[]> {
  return findDocumentsByNames(ARCHIV_SHELF, organizationId, names, options)
}

/** Load one Archiv document by id, scoped to its organization, as `reader` may see it (ADR-0085). */
export async function findArchivDocument(
  documentId: string,
  organizationId: string,
  reader: DocumentReader,
): Promise<Document | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.organizationId, organizationId),
        eq(documents.scope, 'archiv'),
        documentVisibleTo(reader),
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
