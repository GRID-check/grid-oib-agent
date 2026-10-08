/**
 * What a listing row needs before it leaves the BFF — shared by a project's
 * Dateien and the org-wide Archiv (ADR-0078).
 *
 * Hydrating each shelf separately lets their rows drift apart, so one function
 * serves both: a field added to the listing reaches both shelves or neither.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { listAssignmentsWithoutAccessCheck, type AssignedPerson } from '@/lib/assignments/service'
import { encodeDocumentListCursor } from './list-cursor'
import { reconcileDocumentStatuses, type DocumentMetadata } from './reconcile-status'
import type { DocumentListPage, DocumentListRow } from './repository'

/**
 * One row of a document listing.
 *
 * `assignees` is part of it, so the wire projection sees the field it must
 * serialize and a reader need not re-widen the type to find the faces it
 * renders. A type that left it out would still type-check (nothing rejects an
 * extra property on a spread) and would lie to every caller.
 */
export type ListedDocument = Omit<DocumentListRow, 'metadata'> &
  DocumentMetadata & {
    assignees: AssignedPerson[]
    /**
     * When a folder this report was drawn from was purged (ADR-0081): the
     * purge marks a filed report it finds (`metadata.sourceDeleted`), and the
     * listing shows „Quelle gelöscht am …". Null for every other document.
     */
    sourceDeletedAt?: string | null
  }

/** The purge's mark on a filed report, when it carries a real date. */
function sourceDeletedAtOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const mark = (metadata as { sourceDeleted?: { at?: unknown } }).sourceDeleted
  const at = mark && typeof mark === 'object' ? mark.at : undefined
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null
}

/**
 * What a row needs before it leaves the BFF, whichever query found it: the
 * listing page or a by-name lookup. The CALLER has already authorized the shelf
 * every row was read from.
 */
export async function toListedDocuments(
  session: AuthorizedSession,
  rows: DocumentListRow[],
): Promise<ListedDocument[]> {
  // Pending rows are lazily reconciled with the backend's ingestion state;
  // without this they would stay 'pending' forever (no completion callback).
  const reconciled = await reconcileDocumentStatuses(rows, session.organizationId)

  const listed = reconciled.map(({ metadata, ...row }) => ({ ...row, sourceDeletedAt: sourceDeletedAtOf(metadata) }))

  if (!isCollaborationEnabled(session) || listed.length === 0) {
    return listed.map((row) => ({ ...row, assignees: [] }))
  }

  const grouped = await listAssignmentsWithoutAccessCheck(
    session,
    'document',
    listed.map((row) => row.id),
  )
  return listed.map((row) => ({ ...row, assignees: grouped[row.id] ?? [] }))
}

/** A keyset page as it leaves the service: hydrated rows and the opaque next cursor. */
export async function toListedPage(
  session: AuthorizedSession,
  page: DocumentListPage,
): Promise<{ documents: ListedDocument[]; nextCursor: string | null }> {
  return {
    documents: await toListedDocuments(session, page.rows),
    nextCursor: page.nextCursor ? encodeDocumentListCursor(page.nextCursor) : null,
  }
}
