/**
 * What a listing row needs before it leaves the BFF — shared by a project's
 * Dateien and the org-wide Archiv (ADR-0078).
 *
 * The two used to hydrate their rows separately and ended up serving different
 * rows: the Archiv's had no assignees and no author filter, and the browser
 * carried two row mappers for one table. One function now, so a field added to
 * the listing reaches both shelves or neither.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { listAssignmentsWithoutAccessCheck, type AssignedPerson } from '@/lib/assignments/service'
import { encodeDocumentLevelCursor, encodeDocumentListCursor } from './list-cursor'
import { reconcileDocumentStatuses, type DocumentMetadata } from './reconcile-status'
import type { FassungFacts } from './fassung'
import { loadFassungFacts } from './fassung-facts'
import type { DocumentLevelPage, DocumentListPage, DocumentListRow } from './repository'
import { keepReadable, type ListingReader, type ShelfReader } from './document-reader'
import { canRetryRow } from './retry-policy'
import { quarantineVerdictOf, type QuarantineVerdict } from '@/lib/upload-screening/quarantine'

/**
 * One row of a document listing.
 *
 * `assignees` is part of it. It used to be added by the two `return`s below and
 * left out of the signature, which type-checks (nothing rejects an extra
 * property on a spread) and is a lie every caller then has to work around: the
 * wire projection could not see the field it is required to serialize, and
 * anything reading a listing had to re-widen the type to find the faces it
 * renders.
 */
export type ListedDocument = Omit<
  DocumentListRow,
  | 'projectId'
  | 'scope'
  | 'metadata'
  | 'createdBy'
  | 'screeningOutcome'
  | 'screenedHash'
  | 'ingestFailureCategory'
  | 'ingestRetryable'
  | 'ingestReaderVersion'
  | 'quarantine'
> &
  DocumentMetadata & {
    assignees: AssignedPerson[]
    /**
     * Whether reading the document again may come out differently
     * (`canRetryRow`, `./retry-policy`): false for a file that failed for a
     * lasting reason, which „Alle erneut lesen“ leaves out and whose „Erneut
     * lesen“ says why instead. The failure facts it is decided from stay in
     * the BFF. Optional for rows built without it; absent reads as true.
     */
    retryable?: boolean
    /**
     * Which documents this one replaces or is replaced by (CONTEXT.md,
     * „Fassung"), resolved for THIS reader: a document they may not open is
     * not in it, name and all (`fassung-facts.ts`).
     */
    fassung?: FassungFacts | null
    /**
     * When a folder this report was drawn from was purged (ADR-0088): the
     * purge marks a filed report it finds (`metadata.sourceDeleted`), and the
     * listing shows „Quelle gelöscht am …". Null for every other document.
     */
    sourceDeletedAt?: string | null
    /**
     * Why the content check held it (ADR-0113), read for this build from the
     * stored verdict (`quarantineVerdictOf`); null on every row it did not hold.
     */
    quarantine: QuarantineVerdict | null
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
 * every row was read from, and passes the same reader its query was narrowed by.
 */
export async function toListedDocuments(
  session: AuthorizedSession,
  rows: DocumentListRow[],
  /** The reader the rows' query was narrowed by (`shelfReaderFor`, or `SCREENED_ONLY` for a model, ADR-0086). */
  reader: ListingReader,
): Promise<ListedDocument[]> {
  // Pending rows are lazily reconciled with the backend's ingestion state;
  // without this they would stay 'pending' forever (no completion callback).
  // A row the query let through on an earlier verdict (a re-index of a file
  // that passed before) can come back `quarantined`: it is narrowed again here,
  // by the same rule, after the verdict (ADR-0086).
  const reconciled = keepReadable(await reconcileDocumentStatuses(rows, session.organizationId), reader)

  const fassung = await loadFassungFacts(session, reconciled, reader)
  const listed = reconciled.map(
    ({
      metadata,
      createdBy: _createdBy,
      projectId: _projectId,
      scope: _scope,
      screeningOutcome: _screening,
      screenedHash: _screened,
      ingestFailureCategory,
      ingestRetryable,
      ingestReaderVersion,
      quarantine,
      ...row
    }) => ({
      ...row,
      quarantine: quarantineVerdictOf({ quarantine, errorMessage: row.errorMessage }),
      // Decided here, from the reconciled row, while `metadata` still says
      // which bytes the last dispatch sent; only the answer leaves.
      retryable: canRetryRow({
        status: row.status,
        contentHash: row.contentHash,
        metadata,
        ingestFailureCategory,
        ingestRetryable,
        ingestReaderVersion,
      }),
      sourceDeletedAt: sourceDeletedAtOf(metadata),
      fassung: fassung.get(row.id) ?? null,
    })
  )

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
  reader: ShelfReader,
): Promise<{ documents: ListedDocument[]; nextCursor: string | null }> {
  return {
    documents: await toListedDocuments(session, page.rows, reader),
    nextCursor: page.nextCursor ? encodeDocumentListCursor(page.nextCursor) : null,
  }
}

/**
 * A level page as it leaves the service (ADR-0102): the same hydration as the
 * drain's page, one page at a time, and the level cursor. The backend is asked
 * about the rows of THIS page only, which is the point of reading by level.
 */
export async function toListedLevelPage(
  session: AuthorizedSession,
  page: DocumentLevelPage,
  reader: ShelfReader,
): Promise<{ documents: ListedDocument[]; nextCursor: string | null }> {
  return {
    documents: await toListedDocuments(session, page.rows, reader),
    nextCursor: page.nextCursor ? encodeDocumentLevelCursor(page.nextCursor) : null,
  }
}
